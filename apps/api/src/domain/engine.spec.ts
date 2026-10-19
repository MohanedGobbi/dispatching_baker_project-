import { describe, it, expect } from 'vitest';
import { runEngine, EngineInput, EngineSlot, Weights } from './engine';
import type { CandidateFacts, SeatFacts } from './rules';
import type { Seniority } from './status';

const d = (s: string) => new Date(s + 'T00:00:00Z');
const iso = (x: Date) => x.toISOString().slice(0, 10);
const W: Weights = { backToBack: 10, fairness: 8, sameBase: 5, crewStability: 6, seniorityMix: 6, mentoring: 3, baseStaffFirst: 4, preferences: 2 };

const seatOf = (id: string, pos = 'Field Operator', extra: Partial<SeatFacts> = {}): SeatFacts => ({
  id, holderType: 'UNIT', positionId: pos, positionName: pos, baseId: 'hmd', requirements: { qualification: 'Open Hole' },
  positionQualifications: [], positionCertTypeIds: [], ...extra,
});
let n = 0;
const person = (o: Partial<CandidateFacts> & { level?: Seniority; anchor?: string } = {}): CandidateFacts => ({
  id: o.id ?? `p${++n}`, positionId: 'Field Operator', workMode: 'FIELD', homeBaseId: 'hmd', backToBackId: null, seniority: o.level ?? 'JUNIOR',
  qualifications: ['Open Hole'], certs: [], restrictions: [], rotation: { type: 'cycle', daysOn: 28, daysOff: 28 },
  rotationAnchor: d(o.anchor ?? '2026-10-01'), unavailable: [], otherAssignments: [], ...o,
});
const slot = (seat: SeatFacts, from: string, to: string, extra: Partial<EngineSlot> = {}): EngineSlot => ({
  key: `${seat.id}:${from}`, seat, unitId: 'u1', required: true, from: d(from), to: d(to), fromTask: false, previousHolderId: null, ...extra,
});
function input(slots: EngineSlot[], candidates: CandidateFacts[], over: Partial<EngineInput> = {}): EngineInput {
  return {
    slots, candidates, balance: new Map(), seniority: new Map(candidates.map(c => [c.id, c.seniority])), baseCodes: new Map([['hmd', 'HMD']]),
    units: [{ unitId: 'u1', seats: [{ seatId: 's1', positionName: 'Field Operator', required: true }] }], crew: [], idleSeatIds: new Set(),
    maxConsecutiveDays: 35, minExperienced: 0, chiefRequired: false, weights: W, ...over,
  };
}

describe('runEngine', () => {
  it('fills a seat with the only valid candidate and explains why', () => {
    const r = runEngine(input([slot(seatOf('s1'), '2026-10-05', '2026-10-12')], [person({ id: 'a' }), person({ id: 'b', qualifications: ['Cased Hole'] })]));
    expect(r.placements).toHaveLength(1);
    expect(r.placements[0].employeeId).toBe('a');
    expect(r.placements[0].explanation).toContain('covers 8 days');
    expect(r.gaps).toEqual([]);
  });

  it('prefers the back-to-back partner of the previous holder', () => {
    const outgoing = person({ id: 'out', backToBackId: 'partner' });
    const partner = person({ id: 'partner', backToBackId: 'out' });
    const other = person({ id: 'other' });
    const r = runEngine(input([slot(seatOf('s1'), '2026-10-05', '2026-10-12', { previousHolderId: 'out' })], [other, partner, { ...outgoing, unavailable: [{ start: d('2026-09-01'), end: d('2027-01-01'), reason: 'leave' }] }]));
    expect(r.placements[0].employeeId).toBe('partner');
    expect(r.placements[0].explanation).toContain('back-to-back partner');
  });

  it('fairness: avoids someone who is owed a lot of rest', () => {
    const tired = person({ id: 'tired' }), rested = person({ id: 'rested' });
    const r = runEngine(input([slot(seatOf('s1'), '2026-10-05', '2026-10-12')], [tired, rested], { balance: new Map([['tired', 9]]) }));
    expect(r.placements[0].employeeId).toBe('rested');
  });

  it('splits a long period across rotations without overlap or double booking', () => {
    // A is on 1-28 Oct, B is on 29 Oct - 25 Nov (anchors offset by 28 days); the slot is 50 days.
    const A = person({ id: 'A', anchor: '2026-10-01' }), B = person({ id: 'B', anchor: '2026-10-29' });
    const r = runEngine(input([slot(seatOf('s1'), '2026-10-05', '2026-11-23')], [A, B]));
    const ps = r.placements.map(p => `${p.employeeId}:${iso(p.start)}..${iso(p.end)}`);
    expect(ps).toEqual(['A:2026-10-05..2026-10-28', 'B:2026-10-29..2026-11-23']);
    expect(r.gaps).toEqual([]);
  });

  it('reports a gap when nobody is on, with a hire option and the outgoing person as an extension option', () => {
    // C works 1-28 Oct. Seat needs cover 29 Oct - 3 Nov and the only other person is unavailable.
    const C = person({ id: 'C', anchor: '2026-10-01' });
    const D = person({ id: 'D', anchor: '2026-10-29', unavailable: [{ start: d('2026-10-25'), end: d('2026-12-31'), reason: 'leave' }] });
    const r = runEngine(input([slot(seatOf('s1'), '2026-10-29', '2026-11-03', { previousHolderId: 'C' })], [C, D]));
    expect(r.placements).toEqual([]);
    expect(r.gaps).toHaveLength(1);
    const kinds = r.gaps[0].options.map(o => o.kind);
    expect(kinds).toContain('extend_outgoing');
    expect(kinds).toContain('postpone_leave');
    expect(kinds[kinds.length - 1]).toBe('hire');
    expect(iso(r.gaps[0].from)).toBe('2026-10-29');
    expect(r.stats.requiredGapDays).toBe(6);
  });

  it('suggests moving someone from a unit that has no job', () => {
    const E = person({ id: 'E', otherAssignments: [{ seatId: 'idle-seat', start: d('2026-10-01'), end: d('2026-10-28') }] });
    const r = runEngine(input([slot(seatOf('s1'), '2026-10-05', '2026-10-10')], [E], { idleSeatIds: new Set(['idle-seat']) }));
    expect(r.gaps[0].options[0]).toMatchObject({ kind: 'move_from_idle_unit', employeeId: 'E' });
  });

  it('never puts one person in two seats on the same day', () => {
    const only = person({ id: 'only' });
    const two = [slot(seatOf('s1'), '2026-10-05', '2026-10-12'), slot(seatOf('s2'), '2026-10-05', '2026-10-12')];
    const r = runEngine(input(two, [only], { units: [{ unitId: 'u1', seats: [{ seatId: 's1', positionName: 'Field Operator', required: true }, { seatId: 's2', positionName: 'Field Operator', required: true }] }] }));
    expect(r.placements).toHaveLength(1);
    expect(r.gaps).toHaveLength(1);
  });

  it('keeps crews safe: does not complete a crew with nobody experienced when it can be avoided', () => {
    const units = [{ unitId: 'u1', seats: [
      { seatId: 's1', positionName: 'Field Operator', required: true }, { seatId: 's2', positionName: 'Field Operator', required: true }] }];
    const people = [person({ id: 'j1', level: 'JUNIOR' }), person({ id: 'j2', level: 'JUNIOR' }), person({ id: 'x', level: 'EXPERIENCED' })];
    const r = runEngine(input([slot(seatOf('s1'), '2026-10-05', '2026-10-12'), slot(seatOf('s2'), '2026-10-05', '2026-10-12')], people, { units, minExperienced: 1 }));
    expect(r.placements).toHaveLength(2);
    expect(r.placements.map(p => p.employeeId)).toContain('x');
  });

  it('respects base-only restriction and rotation days off', () => {
    const restricted = person({ id: 'r', restrictions: [{ kind: 'base_only', start: d('2026-09-01'), end: null }] });
    const off = person({ id: 'off', anchor: '2026-09-01' }); // on 1-28 Sep, off 29 Sep - 26 Oct
    const r = runEngine(input([slot(seatOf('s1'), '2026-10-05', '2026-10-12')], [restricted, off]));
    expect(r.placements).toEqual([]);
    expect(r.gaps[0].options.some(o => o.kind === 'recall_from_days_off' && o.employeeId === 'off')).toBe(true);
  });

  it('is deterministic', () => {
    const mk = () => runEngine(input([slot(seatOf('s1'), '2026-10-05', '2026-11-20')], [person({ id: 'A', anchor: '2026-10-01' }), person({ id: 'B', anchor: '2026-10-29' }), person({ id: 'C', anchor: '2026-10-01' })]));
    expect(JSON.stringify(mk())).toBe(JSON.stringify(mk()));
  });
});
