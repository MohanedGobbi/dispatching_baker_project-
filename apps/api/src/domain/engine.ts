// Planning engine (plan section 15.4): hardest seat first, hard-rule filter, weighted scoring, gap detection.
// Pure and deterministic: all facts come in as arguments, nothing is read from the database.
import {
  crewViolations, CandidateFacts, CrewSeat, personViolations, SeatFacts, seniorityAtLeast, Violation,
} from './rules';
import { isRotationOn, Seniority, startOfDay } from './status';

const DAY = 86_400_000;
const addDays = (d: Date, n: number) => new Date(startOfDay(d).getTime() + n * DAY);
const days = (a: Date, b: Date) => Math.round((startOfDay(b).getTime() - startOfDay(a).getTime()) / DAY) + 1;

export interface EngineSlot {
  key: string; seat: SeatFacts; unitId: string | null; required: boolean;
  from: Date; to: Date; fromTask: boolean; previousHolderId: string | null;
}
export interface UnitCrewDef { unitId: string; seats: { seatId: string; positionName: string; required: boolean }[] }
export interface CrewAssignment { unitId: string; seatId: string; employeeId: string; start: Date; end: Date }
export interface Weights {
  backToBack: number; fairness: number; sameBase: number; crewStability: number;
  seniorityMix: number; mentoring: number; baseStaffFirst: number; preferences: number;
}
export interface EngineInput {
  slots: EngineSlot[];
  candidates: CandidateFacts[];
  balance: Map<string, number>;                 // days-off balance per employee
  seniority: Map<string, Seniority>;            // for everyone who can sit in a crew, incl. current holders
  baseCodes: Map<string, string>;
  units: UnitCrewDef[];
  crew: CrewAssignment[];                       // existing live assignments on those units
  idleSeatIds: Set<string>;                     // seats of units with no job in the period
  maxConsecutiveDays: number;
  minExperienced: number;
  chiefRequired: boolean;
  weights: Weights;
}

export interface Placement {
  slotKey: string; seatId: string; employeeId: string; start: Date; end: Date;
  score: number; explanation: string; fromTask: boolean;
}
export type FixKind = 'move_from_idle_unit' | 'extend_outgoing' | 'postpone_leave' | 'recall_from_days_off' | 'hire';
export interface FixOption { kind: FixKind; employeeId?: string; days?: number; needsOverride?: boolean; detail: string }
export interface Gap { slotKey: string; seatId: string; required: boolean; from: Date; to: Date; options: FixOption[] }
export interface EngineResult {
  placements: Placement[]; gaps: Gap[];
  stats: { slots: number; placements: number; gaps: number; coveredDays: number; gapDays: number; requiredGapDays: number };
}

// Rules that do not depend on dates; used to build each seat's candidate pool once.
const STATIC_RULES = new Set(['position', 'work_mode', 'qualification', 'seat_seniority']);
const KIND_ORDER: FixKind[] = ['move_from_idle_unit', 'extend_outgoing', 'postpone_leave', 'recall_from_days_off', 'hire'];

export function createEngine(input: EngineInput) {
  const rule = { maxConsecutiveDays: input.maxConsecutiveDays };
  const byId = new Map(input.candidates.map(c => [c.id, c]));
  const unitDefs = new Map(input.units.map(u => [u.unitId, u]));
  const crew = [...input.crew];
  const placements: Placement[] = [];
  const gaps: Gap[] = [];

  const staticPool = (slot: EngineSlot) =>
    input.candidates.filter(c => personViolations(c, slot.seat, { start: slot.from, end: slot.from }, rule)
      .every(v => v.severity !== 'hard' || !STATIC_RULES.has(v.rule)));

  // ---- crew helpers
  const crewAt = (unitId: string, date: Date, extra?: { seatId: string; employeeId: string }): CrewSeat[] => {
    const def = unitDefs.get(unitId);
    if (!def) return [];
    return def.seats.map(s => {
      const cur = crew.find(a => a.seatId === s.seatId && a.start <= date && date <= a.end);
      const holderId = extra && extra.seatId === s.seatId ? extra.employeeId : cur?.employeeId;
      return {
        seatId: s.seatId, positionName: s.positionName, required: s.required,
        holder: holderId ? { id: holderId, seniority: input.seniority.get(holderId) ?? byId.get(holderId)?.seniority ?? 'JUNIOR' } : null,
      };
    });
  };
  const hardCrew = (vs: Violation[]) => new Set(vs.filter(v => v.severity === 'hard').map(v => v.rule));

  /** Longest run [cur, end] this person could work without breaking a date-dependent rule. */
  const limitEnd = (c: CandidateFacts, seat: SeatFacts, cur: Date, to: Date): Date => {
    let end = to < addDays(cur, input.maxConsecutiveDays - 1) ? to : addDays(cur, input.maxConsecutiveDays - 1);
    if (c.rotation?.type === 'cycle' && c.rotationAnchor) {
      for (let d = startOfDay(cur); d <= end; d = addDays(d, 1)) {
        if (!isRotationOn(c.rotation, c.rotationAnchor, d)) { end = addDays(d, -1); break; }
      }
    }
    const cut = (t: Date) => { if (t > cur && t <= end) end = addDays(t, -1); };
    c.unavailable.forEach(u => cut(u.start));
    c.otherAssignments.forEach(o => cut(o.start));
    c.restrictions.forEach(r => cut(r.start));
    for (const typeId of seat.positionCertTypeIds) {
      const cert = c.certs.filter(x => x.typeId === typeId).sort((a, b) => b.expiresAt.getTime() - a.expiresAt.getTime())[0];
      if (cert && cert.expiresAt >= cur && cert.expiresAt < end) end = cert.expiresAt;
    }
    return end;
  };

  const explain = (c: CandidateFacts, slot: EngineSlot, len: number, b2b: boolean, bal: number): string => {
    const parts: string[] = [];
    if (b2b) parts.push('back-to-back partner');
    parts.push({ NEW_RECRUIT: 'New recruit', JUNIOR: 'Junior', EXPERIENCED: 'Experienced', SENIOR: 'Senior' }[c.seniority]);
    if (bal >= 3) parts.push(`owed ${bal} rest days`); else if (bal <= 0) parts.push('no rest owed');
    parts.push(slot.seat.baseId && c.homeBaseId === slot.seat.baseId ? 'same base' : `from ${input.baseCodes.get(c.homeBaseId) ?? 'another base'} (travel)`);
    if (c.workMode === 'FLEXIBLE') parts.push('flexible staff');
    parts.push(`covers ${len} day${len === 1 ? '' : 's'}`);
    return parts.join(' · ');
  };

  const score = (c: CandidateFacts, slot: EngineSlot, cur: Date, end: Date, remaining: number): { total: number; b2b: boolean; bal: number } => {
    const w = input.weights;
    const prev = slot.previousHolderId ? byId.get(slot.previousHolderId) : undefined;
    const b2b = !!slot.previousHolderId && (c.backToBackId === slot.previousHolderId || prev?.backToBackId === c.id);
    const bal = input.balance.get(c.id) ?? 0;
    // Someone owed rest should not be pulled in: the more they are owed, the lower the fairness score.
    const fairness = 1 - Math.min(Math.max(bal, 0), 10) / 10;
    const same = slot.seat.baseId && c.homeBaseId === slot.seat.baseId ? 1 : 0;
    const stability = days(cur, end) / Math.max(remaining, 1);
    let mix = 0.5, mentoring = 0.5;
    if (slot.unitId) {
      const seats = crewAt(slot.unitId, cur);
      const experienced = seats.filter(s => s.holder && seniorityAtLeast(s.holder.seniority, 'EXPERIENCED')).length;
      if (experienced < input.minExperienced) mix = seniorityAtLeast(c.seniority, 'EXPERIENCED') ? 1 : 0;
      else if (c.seniority === 'NEW_RECRUIT' && experienced <= 1) mix = 0.2;
      if (c.seniority === 'NEW_RECRUIT') mentoring = seats.some(s => s.holder && seniorityAtLeast(s.holder.seniority, 'SENIOR')) ? 1 : 0.3;
    }
    const wanted = slot.seat.holderType === 'BASE' ? 'BASE' : 'FIELD';
    const staffFit = c.workMode === wanted ? 1 : c.workMode === 'FLEXIBLE' ? 0.3 : 0;
    const total = w.backToBack * (b2b ? 1 : 0) + w.fairness * fairness + w.sameBase * same + w.crewStability * stability
      + w.seniorityMix * mix + w.mentoring * mentoring + w.baseStaffFirst * staffFit + w.preferences * 0.5;
    return { total: Math.round(total * 100) / 100, b2b, bal };
  };

  const run = (): void => {
    // ---- order: hardest seat (fewest valid candidates) first
    const pools = new Map<string, CandidateFacts[]>();
    for (const s of input.slots) pools.set(s.key, staticPool(s));
    const ordered = [...input.slots].sort((a, b) =>
      (a.required === b.required ? 0 : a.required ? -1 : 1) || pools.get(a.key)!.length - pools.get(b.key)!.length || a.from.getTime() - b.from.getTime());

    for (const slot of ordered) {
      const pool = pools.get(slot.key)!;
      let cur = startOfDay(slot.from);
      const last = startOfDay(slot.to);

      while (cur <= last) {
        const remaining = days(cur, last);
        let best: { c: CandidateFacts; end: Date; total: number; b2b: boolean; bal: number } | null = null;

        for (const c of pool) {
          const end = limitEnd(c, slot.seat, cur, last);
          if (end < cur) continue;
          if (personViolations(c, slot.seat, { start: cur, end }, rule).some(v => v.severity === 'hard')) continue;
          if (slot.unitId) {
            // A placement must not create a crew problem that was not there before (e.g. a crew with nobody experienced).
            const before = hardCrew(crewViolations(crewAt(slot.unitId, cur), cur, input.minExperienced, input.chiefRequired));
            const after = hardCrew(crewViolations(crewAt(slot.unitId, cur, { seatId: slot.seat.id, employeeId: c.id }), cur, input.minExperienced, input.chiefRequired));
            if ([...after].some(r => !before.has(r))) continue;
          }
          const s = score(c, slot, cur, end, remaining);
          if (!best || s.total > best.total || (s.total === best.total && c.id < best.c.id)) best = { c, end, ...s };
        }

        if (best) {
          const p: Placement = {
            slotKey: slot.key, seatId: slot.seat.id, employeeId: best.c.id, start: cur, end: best.end, score: best.total,
            explanation: explain(best.c, slot, days(cur, best.end), best.b2b, best.bal), fromTask: slot.fromTask,
          };
          placements.push(p);
          best.c.otherAssignments.push({ seatId: slot.seat.id, start: cur, end: best.end });
          if (slot.unitId) crew.push({ unitId: slot.unitId, seatId: slot.seat.id, employeeId: best.c.id, start: cur, end: best.end });
          cur = addDays(best.end, 1);
          continue;
        }

        // No one fits at `cur`: the gap lasts until the first day anybody could start.
        let gapEnd = last;
        for (let d = addDays(cur, 1); d <= last; d = addDays(d, 1)) {
          if (pool.some(c => !personViolations(c, slot.seat, { start: d, end: d }, rule).some(v => v.severity === 'hard'))) { gapEnd = addDays(d, -1); break; }
        }
        gaps.push({ slotKey: slot.key, seatId: slot.seat.id, required: slot.required, from: cur, to: gapEnd, options: fixOptions(slot, cur, gapEnd, pool) });
        cur = addDays(gapEnd, 1);
      }
    }
  };

  function fixOptions(slot: EngineSlot, from: Date, to: Date, pool: CandidateFacts[]): FixOption[] {
    // Judge near-misses over at most one maximum-length stretch so every candidate is not just "too long".
    const probeEnd = to < addDays(from, input.maxConsecutiveDays - 1) ? to : addDays(from, input.maxConsecutiveDays - 1);
    const opts: FixOption[] = [];
    const nDays = days(from, to);
    for (const c of pool) {
      const hard = personViolations(c, slot.seat, { start: from, end: probeEnd }, rule).filter(v => v.severity === 'hard');
      if (hard.length === 0) continue;
      const rules = new Set(hard.map(v => v.rule));
      if (rules.size !== 1) continue;
      const only = hard[0];
      if (only.rule === 'double_booking') {
        const o = c.otherAssignments.find(a => a.start <= probeEnd && a.end >= from);
        if (o && input.idleSeatIds.has(o.seatId)) opts.push({ kind: 'move_from_idle_unit', employeeId: c.id, days: nDays, detail: 'Assigned to a unit that has no job in this period' });
      } else if (only.rule === 'availability' && only.message.startsWith('On leave')) {
        opts.push({ kind: 'postpone_leave', employeeId: c.id, days: nDays, needsOverride: true, detail: only.message });
      } else if (only.rule === 'rotation_off') {
        opts.push({ kind: 'recall_from_days_off', employeeId: c.id, days: nDays, needsOverride: true, detail: only.message });
      }
    }
    // Keeping the person who is leaving a little longer costs them extension days.
    const outgoing = slot.previousHolderId ? byId.get(slot.previousHolderId) : undefined;
    if (outgoing) {
      const hard = personViolations(outgoing, slot.seat, { start: from, end: probeEnd }, rule).filter(v => v.severity === 'hard');
      const allowed = hard.every(v => v.rule === 'rotation_off' || v.rule === 'max_consecutive');
      if (allowed) opts.push({ kind: 'extend_outgoing', employeeId: outgoing.id, days: nDays, needsOverride: nDays > 7 || hard.some(v => v.rule === 'max_consecutive'), detail: `Extend the outgoing person by ${nDays} day${nDays === 1 ? '' : 's'}` });
    }
    opts.push({ kind: 'hire', detail: `No one available for ${slot.seat.positionName}: consider temporary reinforcement or hiring` });
    const rank = (o: FixOption) => KIND_ORDER.indexOf(o.kind);
    const counted = new Map<FixKind, number>();
    return opts.sort((a, b) => rank(a) - rank(b) || (a.employeeId ?? '').localeCompare(b.employeeId ?? ''))
      .filter(o => { const n = (counted.get(o.kind) ?? 0) + 1; counted.set(o.kind, n); return n <= 2; });
  }

  const sum = (xs: { from?: Date; to?: Date; start?: Date; end?: Date }[]) => xs.reduce((n, x) => n + days((x.from ?? x.start)!, (x.to ?? x.end)!), 0);

  // The loop is wrapped in a function so the same scoring can also answer 'who fits this one seat?'.
  const finish = (): EngineResult => ({
    placements, gaps,
    stats: {
      slots: input.slots.length, placements: placements.length, gaps: gaps.length,
      coveredDays: sum(placements), gapDays: sum(gaps), requiredGapDays: sum(gaps.filter(g => g.required)),
    },
  });

  /** Best candidates to cover the whole of [from, to] on one seat, scored exactly like a plan run. */
  const rank = (slot: EngineSlot, from: Date, to: Date, top = 5) => {
    const pool = staticPool({ ...slot, from, to });
    const out: { employeeId: string; score: number; explanation: string }[] = [];
    const blocked: { employeeId: string; rules: string[] }[] = [];
    for (const c of pool) {
      const vs = personViolations(c, slot.seat, { start: from, end: to }, rule).filter(v => v.severity === 'hard');
      if (vs.length) { blocked.push({ employeeId: c.id, rules: [...new Set(vs.map(v => v.rule))] }); continue; }
      if (slot.unitId) {
        const before = hardCrew(crewViolations(crewAt(slot.unitId, from), from, input.minExperienced, input.chiefRequired));
        const after = hardCrew(crewViolations(crewAt(slot.unitId, from, { seatId: slot.seat.id, employeeId: c.id }), from, input.minExperienced, input.chiefRequired));
        if ([...after].some(r => !before.has(r))) { blocked.push({ employeeId: c.id, rules: ['crew'] }); continue; }
      }
      const s = score(c, { ...slot, from, to }, from, to, days(from, to));
      out.push({ employeeId: c.id, score: s.total, explanation: explain(c, slot, days(from, to), s.b2b, s.bal) });
    }
    out.sort((x, y) => y.score - x.score || x.employeeId.localeCompare(y.employeeId));
    return { candidates: out.slice(0, top), valid: out.length, blocked: blocked.slice(0, 10), poolSize: pool.length };
  };

  return { run: () => { run(); return finish(); }, rank };
}

export function runEngine(input: EngineInput): EngineResult { return createEngine(input).run(); }
