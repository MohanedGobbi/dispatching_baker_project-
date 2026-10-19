import {
  BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, HttpException, HttpStatus,
  Inject, Injectable, Module, NotFoundException, Param, Post, Put, Query, Req,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications';
import { Require, AuthedRequest } from '../auth/auth.module';
import { SettingsModule, SettingsService } from '../settings/settings';
import { EmployeeInsightsService, InsightsModule } from '../employees/insights';
import { AssignmentsModule, AssignmentsService, Proposal } from '../assignments/assignments';
import { buildCandidate, buildSeatFacts } from '../assignments/facts';
import { audit, parseDate } from '../common/validate';
import { createEngine, EngineInput, EngineSlot, FixOption, Weights } from '../domain/engine';
import { intersect, mergeSpans, Span, subtractSpans } from '../domain/spans';
import { Seniority, startOfDay } from '../domain/status';

const DAY = 86_400_000;
const LIVE = ['CONFIRMED', 'ACTIVE'] as const;
const COUNTS = ['CONFIRMED', 'ACTIVE', 'COMPLETED'] as const;
const OPEN_WORK_ORDER = ['OPEN', 'IN_PROGRESS', 'WAITING_PARTS'];
const OPEN_TASK = ['OPEN', 'ESCALATED', 'CANDIDATE_PROPOSED'];
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(startOfDay(d).getTime() + n * DAY);

export type PlanMode = 'full' | 'repair' | 'none';
/** Changes applied to a copy of the world for "what if" runs; nothing is written to the database (plan 18). */
export interface WhatIfChanges {
  deployUnitIds?: string[];
  removeEmployeeIds?: string[];
  absences?: { employeeId: string; start: Date; end: Date }[];
}
export interface ProfileFilter { baseId?: string; position?: string; qualification?: string; experienced?: boolean }
export interface WhatIfBody {
  start?: string; days?: number; deployUnitIds?: string[]
  lose?: (ProfileFilter & { count: number })[]
  absent?: (ProfileFilter & { count: number; days: number; startDay?: number })[]
}
export interface WorldArgs { baseIds: string[] | null; start: Date; end: Date; mode: PlanMode; seatId?: string; changes?: WhatIfChanges }

export interface World {
  input: EngineInput;
  baseIds: string[];
  seatLabel: Map<string, string>;
  employeeName: Map<string, string>;
  seatFacts: Map<string, ReturnType<typeof buildSeatFacts>>;
  unitBySeat: Map<string, string>;
}

const rolesOf = (req: AuthedRequest) => (req.user?.roles ?? []);

const SEAT_INCLUDE = { position: { include: { requiredQualifications: true, requiredCertTypes: true } }, unit: true, base: true } as const;

@Injectable()
export class PlanningService {
  constructor(
    @Inject(PrismaService) private prisma: PrismaService,
    @Inject(SettingsService) private settings: SettingsService,
    @Inject(EmployeeInsightsService) private insights: EmployeeInsightsService,
  ) {}

  async resolveBases(ids: string[] | null | undefined): Promise<string[]> {
    const bases = await this.prisma.base.findMany({ where: { active: true } });
    if (!ids?.length) return bases.map(b => b.id);
    const out = ids.map(x => bases.find(b => b.id === x || b.code === x)?.id);
    if (out.some(x => !x)) throw new BadRequestException('Unknown base in scope');
    return [...new Set(out as string[])];
  }

  /** Everything the engine needs, read once. Keeps the engine itself free of database access. */
  async loadWorld(args: WorldArgs): Promise<World> {
    const settings = await this.settings.all();
    const baseIds = await this.resolveBases(args.baseIds);
    const period: Span = { start: startOfDay(args.start), end: startOfDay(args.end) };
    const now = startOfDay(new Date());

    // ---- seats
    const units = await this.prisma.unit.findMany({
      where: { homeBaseId: { in: baseIds }, ...(args.mode === 'none' ? {} : { status: { not: 'OUT_OF_SERVICE' as const } }) },
      include: {
        seats: { where: { holderType: 'UNIT' }, include: SEAT_INCLUDE, orderBy: [{ positionId: 'asc' }, { index: 'asc' }] },
        deployments: { where: { start: { lte: period.end }, end: { gte: period.start } } },
        workOrders: { where: { status: { in: OPEN_WORK_ORDER }, plannedStart: { lte: period.end }, expectedReturn: { gte: period.start } } },
      },
    });
    const baseSeats = await this.prisma.seat.findMany({ where: { holderType: 'BASE', baseId: { in: baseIds } }, include: SEAT_INCLUDE });
    const allSeats = [...units.flatMap(u => u.seats), ...baseSeats];
    const seatIds = allSeats.map(s => s.id);

    const seatLabel = new Map<string, string>();
    const seatFacts = new Map<string, ReturnType<typeof buildSeatFacts>>();
    const unitBySeat = new Map<string, string>();
    for (const u of units) for (const s of u.seats) { seatLabel.set(s.id, `${u.code} · ${s.position.name} #${s.index}`); unitBySeat.set(s.id, u.id); }
    for (const s of baseSeats) seatLabel.set(s.id, `${s.base?.code} base · ${s.position.name} #${s.index}`);
    for (const s of allSeats) seatFacts.set(s.id, buildSeatFacts(s as never));

    // ---- who already sits where
    const ch = args.changes;
    const gone = new Set(ch?.removeEmployeeIds ?? []);
    let seatAssignments = (await this.prisma.assignment.findMany({
      where: { seatId: { in: seatIds }, status: { in: [...LIVE] }, plannedEnd: { gte: addDays(period.start, -120) }, start: { lte: period.end } },
    })).filter(a => !gone.has(a.employeeId));
    // An absence in a what-if cuts the person out of the seats they would have held during it.
    for (const ab of ch?.absences ?? []) {
      seatAssignments = seatAssignments.flatMap(a => {
        const e = a.actualEnd ?? a.plannedEnd;
        if (a.employeeId !== ab.employeeId || e < ab.start || a.start > ab.end) return [a];
        const pieces = [];
        if (a.start < ab.start) pieces.push({ ...a, plannedEnd: addDays(ab.start, -1), actualEnd: null });
        if (e > ab.end) pieces.push({ ...a, start: addDays(ab.end, 1) });
        return pieces;
      });
    }
    const end = (a: { actualEnd: Date | null; plannedEnd: Date }) => a.actualEnd ?? a.plannedEnd;
    const coverage = (seatId: string): Span[] => seatAssignments.filter(a => a.seatId === seatId).map(a => ({ start: a.start, end: end(a) }));
    const previousHolder = (seatId: string, from: Date): string | null => {
      const prev = seatAssignments.filter(a => a.seatId === seatId && end(a) < from).sort((a, b) => end(b).getTime() - end(a).getTime())[0];
      return prev?.employeeId ?? null;
    };

    // ---- slots: the days that still need a person
    const slots: EngineSlot[] = [];
    const addSlots = (seatId: string, spans: Span[], required: boolean, fromTask: boolean) => {
      const facts = seatFacts.get(seatId)!;
      for (const sp of spans.flatMap(s => subtractSpans(s, coverage(seatId)))) {
        slots.push({ key: `${seatId}:${iso(sp.start)}`, seat: facts, unitId: unitBySeat.get(seatId) ?? null, required, from: sp.start, to: sp.end, fromTask, previousHolderId: previousHolder(seatId, sp.start) });
      }
    };
    if (args.mode === 'full') {
      for (const u of units) {
        // A unit only needs its crew while it has a job, and not on days it is in the workshop (plan 17).
        const spans = u.deployments.map(d => ({ start: d.start, end: d.end }));
        if (ch?.deployUnitIds?.includes(u.id)) spans.push(period);
        const jobSpans = mergeSpans(spans.map(d => intersect(d, period)).filter((x): x is Span => !!x));
        const maintenance = u.workOrders.map(w => ({ start: w.plannedStart, end: w.expectedReturn }));
        const deployed = jobSpans.flatMap(j => subtractSpans(j, maintenance));
        for (const s of u.seats.filter(x => x.requiredFlag)) addSlots(s.id, deployed, true, false);
      }
      for (const s of baseSeats) addSlots(s.id, [period], s.requiredFlag, false);
    } else if (args.mode === 'repair') {
      const tasks = await this.prisma.replacementTask.findMany({
        where: { seatId: { in: seatIds }, status: { in: OPEN_TASK }, fromDate: { lte: period.end }, toDate: { gte: period.start } },
      });
      for (const t of tasks) {
        const sp = intersect({ start: t.fromDate, end: t.toDate }, period);
        if (sp) addSlots(t.seatId, [sp], true, true);
      }
    }

    // ---- candidates
    const employees = await this.prisma.employee.findMany({
      where: { active: true, ...(gone.size ? { id: { notIn: [...gone] } } : {}) },
      include: { qualifications: { include: { qualification: true } }, certifications: true, rotationPattern: true, restrictions: true },
    });
    const empIds = employees.map(e => e.id);
    const [leaves, assignments, ledger, sen] = await Promise.all([
      this.prisma.leave.findMany({
        where: { employeeId: { in: empIds }, status: { in: ['APPROVED', 'ACTIVE', 'COMPLETED', 'RECORDED'] }, end: { gte: addDays(period.start, -400) } },
        include: { type: true, fitForDuty: true },
      }),
      this.prisma.assignment.findMany({
        where: { employeeId: { in: empIds }, status: { in: [...COUNTS] }, plannedEnd: { gte: period.start } },
        select: { employeeId: true, seatId: true, start: true, plannedEnd: true, actualEnd: true },
      }),
      this.prisma.daysOffLedger.groupBy({ by: ['employeeId'], _sum: { days: true } }),
      this.insights.enrich(employees.map(e => ({ ...e })), now),
    ]);
    const clearanceAfter = settings['rules.clearanceRequiredAfterDays'] as number;
    const candidates = employees.map(e => buildCandidate(
      e, sen.get(e.id)!.seniority, leaves.filter(l => l.employeeId === e.id),
      assignments.filter(a => a.employeeId === e.id).map(a => ({ seatId: a.seatId, start: a.start, end: a.actualEnd ?? a.plannedEnd })),
      clearanceAfter,
    ));
    for (const ab of ch?.absences ?? []) candidates.find(c => c.id === ab.employeeId)?.unavailable.push({ start: ab.start, end: ab.end, reason: 'leave' });
    const seniority = new Map<string, Seniority>(employees.map(e => [e.id, sen.get(e.id)!.seniority]));

    const idleSeatIds = new Set(units.filter(u => u.deployments.length === 0).flatMap(u => u.seats.map(s => s.id)));
    const w = (k: string) => settings[`engine.weight.${k}`] as number;
    const weights: Weights = { backToBack: w('backToBack'), fairness: w('fairness'), sameBase: w('sameBase'), crewStability: w('crewStability'), seniorityMix: w('seniorityMix'), mentoring: w('mentoring'), baseStaffFirst: w('baseStaffFirst'), preferences: w('preferences') };

    const bases = await this.prisma.base.findMany({ select: { id: true, code: true } });
    const input: EngineInput = {
      slots, candidates, seniority,
      balance: new Map(ledger.map(l => [l.employeeId, l._sum.days ?? 0])),
      baseCodes: new Map(bases.map(b => [b.id, b.code])),
      units: units.map(u => ({ unitId: u.id, seats: u.seats.map(s => ({ seatId: s.id, positionName: s.position.name, required: s.requiredFlag })) })),
      crew: seatAssignments.filter(a => unitBySeat.has(a.seatId)).map(a => ({ unitId: unitBySeat.get(a.seatId)!, seatId: a.seatId, employeeId: a.employeeId, start: a.start, end: end(a) })),
      idleSeatIds,
      maxConsecutiveDays: settings['rules.maxConsecutiveDays'] as number,
      minExperienced: settings['rules.minExperiencedPerCrew'] as number,
      chiefRequired: settings['rules.chiefRequired'] as boolean,
      weights,
    };
    return { input, baseIds, seatLabel, employeeName: new Map(employees.map(e => [e.id, `${e.firstName} ${e.lastName}`])), seatFacts, unitBySeat };
  }

  /** Admin, Ops and Dispatcher plan anywhere; a Base Manager only inside their own base(s) (plan section 3). */
  async scopeFor(req: AuthedRequest, requested?: string[]): Promise<string[] | null> {
    const roles = rolesOf(req);
    if (roles.some(r => ['SUPER_ADMIN', 'OPS_MANAGER', 'DISPATCHER'].includes(r.role))) return requested?.length ? await this.resolveBases(requested) : null;
    const own = roles.filter(r => r.role === 'BASE_MANAGER' && r.baseScope).map(r => r.baseScope!);
    if (!own.length) throw new ForbiddenException('No planning scope');
    const ownIds = await this.resolveBases(own);
    if (requested?.length) {
      const ids = await this.resolveBases(requested);
      if (ids.some(i => !ownIds.includes(i))) throw new ForbiddenException('Base managers can only plan their own base');
      return ids;
    }
    return ownIds;
  }

  /** Run the engine and store the result as a draft plan (15.6). */
  async createPlan(args: { baseIds: string[] | null; start: Date; end: Date; mode: 'full' | 'repair' }, userId?: string) {
    const settings = await this.settings.all();
    const maxDays = settings['planning.maxPeriodDays'] as number;
    const span = Math.round((startOfDay(args.end).getTime() - startOfDay(args.start).getTime()) / DAY) + 1;
    if (span < 1) throw new BadRequestException('end must not be before start');
    if (span > maxDays) throw new BadRequestException(`A plan covers at most ${maxDays} days`);

    const world = await this.loadWorld(args);
    const t0 = Date.now();
    const result = createEngine(world.input).run();
    const ms = Date.now() - t0;

    const d = (n?: number) => `${n} day${n === 1 ? '' : 's'}`;
    const label = (id?: string) => (id ? world.employeeName.get(id) ?? 'Unknown' : '');
    const optionLabel = (o: FixOption) => {
      const n = label(o.employeeId);
      switch (o.kind) {
        case 'move_from_idle_unit': return `Move ${n} from a unit with no job (${d(o.days)})`;
        case 'extend_outgoing': return `Extend ${n} by ${o.days} day${o.days === 1 ? '' : 's'}`;
        case 'postpone_leave': return `Ask ${n} to postpone leave (${d(o.days)})`;
        case 'recall_from_days_off': return `Call ${n} back from days off (${d(o.days)})`;
        default: return o.detail;
      }
    };
    const gaps = result.gaps.map(g => ({
      seatId: g.seatId, seat: world.seatLabel.get(g.seatId), from: iso(g.from), to: iso(g.to), required: g.required,
      options: g.options.map(o => ({ kind: o.kind, employeeId: o.employeeId, employee: label(o.employeeId) || undefined, days: o.days, needsOverride: o.needsOverride ?? false, label: optionLabel(o) })),
    }));

    const last = await this.prisma.plan.aggregate({ _max: { version: true } });
    const plan = await this.prisma.$transaction(async tx => {
      const p = await tx.plan.create({
        data: {
          scope: world.baseIds, periodStart: startOfDay(args.start), periodEnd: startOfDay(args.end), status: 'DRAFT',
          version: (last._max.version ?? 0) + 1, createdBy: userId,
          summary: { mode: args.mode, stats: result.stats, gaps, engineMs: ms } as never,
        },
      });
      await tx.assignment.createMany({
        data: result.placements.map(pl => ({
          employeeId: pl.employeeId, seatId: pl.seatId, start: pl.start, plannedEnd: pl.end, status: 'DRAFT' as const,
          type: pl.fromTask ? 'REPLACEMENT' as const : 'NORMAL' as const, planId: p.id, explanation: pl.explanation,
        })),
      });
      return p;
    });
    await audit(this.prisma, userId, 'Plan', plan.id, 'create', null, { mode: args.mode, stats: result.stats });
    return this.planDetail(plan.id);
  }

  async planDetail(id: string) {
    const plan = await this.prisma.plan.findUnique({ where: { id } });
    if (!plan) throw new NotFoundException('Plan not found');
    const assignments = await this.prisma.assignment.findMany({
      where: { planId: id }, orderBy: [{ start: 'asc' }],
      include: {
        employee: { select: { id: true, firstName: true, lastName: true, employeeNo: true } },
        seat: { include: { position: { select: { name: true } }, unit: { select: { code: true } }, base: { select: { code: true } } } },
      },
    });
    return {
      ...plan,
      assignments: assignments.map(a => ({
        id: a.id, status: a.status, type: a.type, start: a.start, end: a.plannedEnd, explanation: a.explanation, overrideReason: a.overrideReason,
        employee: a.employee, seatId: a.seatId,
        seat: `${a.seat.unit?.code ?? `${a.seat.base?.code} base`} · ${a.seat.position.name} #${a.seat.index}`,
      })),
    };
  }

  /** Idle units, bases and profiles a what-if can touch. */
  async whatIfOptions(baseIds: string[] | null) {
    const ids = await this.resolveBases(baseIds);
    const now = startOfDay(new Date());
    const [units, bases, positions, quals] = await Promise.all([
      this.prisma.unit.findMany({ where: { homeBaseId: { in: ids }, status: { not: 'OUT_OF_SERVICE' }, deployments: { none: { end: { gte: now } } } }, include: { unitType: true, homeBase: true }, orderBy: { code: 'asc' } }),
      this.prisma.base.findMany({ where: { id: { in: ids } }, orderBy: { code: 'asc' } }),
      this.prisma.position.findMany({ orderBy: { name: 'asc' } }),
      this.prisma.qualification.findMany({ orderBy: { name: 'asc' } }),
    ]);
    return {
      idleUnits: units.map(u => ({ id: u.id, code: u.code, type: u.unitType.name, base: u.homeBase.code })),
      bases: bases.map(b => ({ id: b.id, code: b.code })), positions: positions.map(p => p.name), qualifications: quals.map(q => q.name),
    };
  }

  /**
   * Run the planner on a modified copy of the world and compare it with today's (plan 18). Changes are described by
   * profile ("lose 3 experienced Cased Hole operators at INA"), so the user never has to pick individuals.
   */
  async whatIf(body: WhatIfBody, allowed: string[] | null) {
    const settings = await this.settings.all();
    const start = body.start ? startOfDay(parseDate(body.start)) : startOfDay(new Date());
    const days = Math.min(Math.max(Math.round(body.days ?? 28), 7), settings['planning.maxPeriodDays'] as number);
    const end = addDays(start, days - 1);
    const baseIds = await this.resolveBases(allowed);
    const baseline = await this.loadWorld({ baseIds, start, end, mode: 'full' });

    const pickPool = async (f: ProfileFilter) => {
      const scopeBases = f.baseId ? [f.baseId] : baseIds;
      const people = await this.prisma.employee.findMany({
        where: { active: true, homeBaseId: { in: scopeBases }, ...(f.position ? { position: { name: f.position } } : {}), ...(f.qualification ? { qualifications: { some: { qualification: { name: f.qualification } } } } : {}) },
        select: { id: true, firstName: true, lastName: true, employeeNo: true }, orderBy: { employeeNo: 'desc' },
      });
      if (!f.experienced) return people;
      return people.filter(p => ['EXPERIENCED', 'SENIOR'].includes(baseline.input.seniority.get(p.id) ?? ''));
    };
    const changes: WhatIfChanges = { deployUnitIds: [], removeEmployeeIds: [], absences: [] };
    const applied: string[] = [];
    const used = new Set<string>();
    const take = async (f: ProfileFilter, n: number) => (await pickPool(f)).filter(p => !used.has(p.id)).slice(0, Math.max(0, Math.min(n, 200))).map(p => { used.add(p.id); return p; });
    const describe = (f: ProfileFilter) => [f.experienced ? 'experienced' : '', f.qualification ?? '', f.position ?? 'people'].filter(Boolean).join(' ') + (f.baseId ? ` at ${baseline.input.baseCodes.get(f.baseId) ?? ''}` : '');

    const idle = await this.whatIfOptions(baseIds);
    for (const id of body.deployUnitIds ?? []) {
      const u = idle.idleUnits.find(x => x.id === id);
      if (!u) throw new BadRequestException('Only units without a job can be deployed in a what-if');
      changes.deployUnitIds!.push(id); applied.push(`Deploy ${u.code} (${u.type}, ${u.base}) for the whole period`);
    }
    for (const l of body.lose ?? []) {
      const got = await take(l, l.count);
      changes.removeEmployeeIds!.push(...got.map(g => g.id)); applied.push(`Lose ${got.length} ${describe(l)}${got.length < l.count ? ` (only ${got.length} available)` : ''}`);
    }
    for (const a of body.absent ?? []) {
      const got = await take(a, a.count);
      const from = addDays(start, a.startDay ?? 0), to = addDays(from, Math.max(1, a.days) - 1);
      for (const g of got) changes.absences!.push({ employeeId: g.id, start: from, end: to });
      applied.push(`${got.length} ${describe(a)} absent for ${a.days} days from ${iso(from)}`);
    }
    if (!applied.length) throw new BadRequestException('Describe at least one change');
    const scenario = await this.loadWorld({ baseIds, start, end, mode: 'full', changes });

    const summarize = (w: World) => {
      const r = createEngine(w.input).run();
      const byBase = new Map<string, { gapDays: number; gaps: number }>();
      let gapDaysReq = 0;
      for (const g of r.gaps) {
        const base = w.input.baseCodes.get(w.seatFacts.get(g.seatId)?.baseId ?? '') ?? '?';
        const n = Math.round((g.to.getTime() - g.from.getTime()) / DAY) + 1;
        const cur = byBase.get(base) ?? { gapDays: 0, gaps: 0 };
        cur.gaps++; cur.gapDays += n; byBase.set(base, cur);
        if (g.required) gapDaysReq += n;
      }
      return {
        stats: r.stats, requiredGapDays: gapDaysReq,
        byBase: [...byBase.entries()].map(([base, v]) => ({ base, ...v })).sort((a, b) => a.base.localeCompare(b.base)),
        gaps: r.gaps.map(g => ({
          seatId: g.seatId, seat: w.seatLabel.get(g.seatId) ?? '', from: iso(g.from), to: iso(g.to), required: g.required,
          days: Math.round((g.to.getTime() - g.from.getTime()) / DAY) + 1,
          options: g.options.slice(0, 2).map(o => o.detail ?? o.kind),
        })),
      };
    };
    const a = summarize(baseline), b = summarize(scenario);
    const baseKeys = new Set(a.gaps.map(g => `${g.seatId}:${g.from}`));
    const newGaps = b.gaps.filter(g => !baseKeys.has(`${g.seatId}:${g.from}`)).sort((x, y) => y.days - x.days);
    const delta = b.requiredGapDays - a.requiredGapDays;
    const bases = new Set([...a.byBase, ...b.byBase].map(x => x.base));
    return {
      period: { from: iso(start), to: iso(end), days }, applied,
      baseline: { ...a, gaps: a.gaps.slice(0, 20) }, scenario: { ...b, gaps: b.gaps.slice(0, 40) },
      byBase: [...bases].sort().map(base => ({ base, before: a.byBase.find(x => x.base === base)?.gapDays ?? 0, after: b.byBase.find(x => x.base === base)?.gapDays ?? 0 })),
      newGaps: newGaps.slice(0, 20), deltaRequiredGapDays: delta,
      verdict: delta <= 0 && b.stats.gaps <= a.stats.gaps ? 'ok' : delta > 0 ? 'worse' : 'ok',
    };
  }

  /** "Fill one seat" (15.5): the best people for one seat and span, explained, with why others were ruled out. */
  async suggest(seatId: string, start: Date, end: Date, top = 5) {
    const seat = await this.prisma.seat.findUnique({ where: { id: seatId }, include: { unit: true } });
    if (!seat) throw new NotFoundException('Seat not found');
    const baseId = seat.holderType === 'UNIT' ? seat.unit?.homeBaseId : seat.baseId;
    const world = await this.loadWorld({ baseIds: baseId ? [baseId] : null, start, end, mode: 'none' });
    const facts = world.seatFacts.get(seatId);
    if (!facts) throw new NotFoundException('Seat is not available for planning');
    const slot: EngineSlot = { key: seatId, seat: facts, unitId: world.unitBySeat.get(seatId) ?? null, required: true, from: startOfDay(start), to: startOfDay(end), fromTask: false, previousHolderId: null };
    // The previous holder drives back-to-back scoring.
    const prev = await this.prisma.assignment.findFirst({ where: { seatId, status: { in: [...COUNTS] }, plannedEnd: { lt: startOfDay(start) } }, orderBy: { plannedEnd: 'desc' } });
    slot.previousHolderId = prev?.employeeId ?? null;
    const r = createEngine(world.input).rank(slot, slot.from, slot.to, top);
    return {
      seat: world.seatLabel.get(seatId), from: iso(slot.from), to: iso(slot.to), validCandidates: r.valid,
      candidates: r.candidates.map(c => ({ ...c, employee: world.employeeName.get(c.employeeId) })),
      ruledOut: r.blocked.map(b => ({ employeeId: b.employeeId, employee: world.employeeName.get(b.employeeId), because: b.rules })),
    };
  }
}

// ---------------------------------------------------------------- controller

@Controller('planning')
class PlanningController {
  constructor(
    @Inject(PrismaService) private prisma: PrismaService,
    @Inject(SettingsService) private settings: SettingsService,
    @Inject(PlanningService) private svc: PlanningService,
    @Inject(AssignmentsService) private assignments: AssignmentsService,
    @Inject(NotificationsService) private notifier: NotificationsService,
  ) {}

  private scopeFor(req: AuthedRequest, requested?: string[]) { return this.svc.scopeFor(req, requested); }

  private async assertPlanScope(req: AuthedRequest, plan: { scope: string[] }) {
    const allowed = await this.scopeFor(req);
    if (allowed && plan.scope.some(s => !allowed.includes(s))) throw new ForbiddenException('This plan covers bases outside your scope');
  }

  private async mustPlan(id: string) {
    const p = await this.prisma.plan.findUnique({ where: { id } });
    if (!p) throw new NotFoundException('Plan not found');
    return p;
  }

  // ----- reads
  @Get('plans') @Require('planning', 'view')
  list(@Query('status') status?: string) {
    return this.prisma.plan.findMany({ where: status ? { status } : {}, orderBy: { createdAt: 'desc' }, take: 100 });
  }

  @Get('plans/:id') @Require('planning', 'view')
  detail(@Param('id') id: string) { return this.svc.planDetail(id); }

  /** Compare two plans by what each seat gets (15.6). Default: the plan published just before this one. */
  @Get('plans/:id/diff') @Require('planning', 'view')
  async diff(@Param('id') id: string, @Query('against') against?: string) {
    const plan = await this.mustPlan(id);
    const other = against
      ? await this.mustPlan(against)
      : await this.prisma.plan.findFirst({ where: { status: 'PUBLISHED', version: { lt: plan.version } }, orderBy: { version: 'desc' } });
    if (!other) throw new BadRequestException('There is no earlier plan to compare with');
    const load = (planId: string) => this.prisma.assignment.findMany({
      where: { planId, status: { not: 'CANCELLED' } },
      include: { employee: { select: { firstName: true, lastName: true } }, seat: { include: { position: { select: { name: true } }, unit: { select: { code: true } }, base: { select: { code: true } } } } },
    });
    const [a, b] = await Promise.all([load(other.id), load(plan.id)]);
    const key = (x: (typeof a)[number]) => `${x.seatId}|${iso(x.start)}`;
    const row = (x: (typeof a)[number]) => ({ seat: `${x.seat.unit?.code ?? `${x.seat.base?.code} base`} · ${x.seat.position.name} #${x.seat.index}`, from: iso(x.start), to: iso(x.plannedEnd), employee: `${x.employee.firstName} ${x.employee.lastName}` });
    const before = new Map(a.map(x => [key(x), x])), after = new Map(b.map(x => [key(x), x]));
    const added = [...after].filter(([k]) => !before.has(k)).map(([, x]) => row(x));
    const removed = [...before].filter(([k]) => !after.has(k)).map(([, x]) => row(x));
    const changed = [...after].filter(([k, x]) => before.has(k) && (before.get(k)!.employeeId !== x.employeeId || iso(before.get(k)!.plannedEnd) !== iso(x.plannedEnd)))
      .map(([k, x]) => ({ ...row(x), was: row(before.get(k)!) }));
    return { from: { id: other.id, version: other.version }, to: { id: plan.id, version: plan.version }, added, removed, changed, unchanged: [...after].filter(([k, x]) => before.has(k) && before.get(k)!.employeeId === x.employeeId && iso(before.get(k)!.plannedEnd) === iso(x.plannedEnd)).length };
  }

  @Get('what-if/options') @Require('planning', 'view')
  async whatIfOptions(@Req() req: AuthedRequest) { return this.svc.whatIfOptions(await this.scopeFor(req)); }

  /** Simulate changes (deploy idle units, lose people, extra absences) without touching real data. */
  @Post('what-if') @Require('planning', 'view')
  async whatIf(@Body() body: WhatIfBody, @Req() req: AuthedRequest) { return this.svc.whatIf(body ?? {}, await this.scopeFor(req)); }

  /** Days of required seats nobody covers yet, without running the engine. */
  @Get('open-slots') @Require('planning', 'view')
  async openSlots(@Req() req: AuthedRequest, @Query() q: { start?: string; end?: string; baseIds?: string }) {
    const start = parseDate(q.start), end = q.end ? parseDate(q.end) : addDays(start, 27);
    const world = await this.svc.loadWorld({ baseIds: await this.scopeFor(req, q.baseIds?.split(',').filter(Boolean)), start, end, mode: 'full' });
    return world.input.slots.map(s => ({ seatId: s.seat.id, seat: world.seatLabel.get(s.seat.id), from: iso(s.from), to: iso(s.to), required: s.required }));
  }

  @Get('seats/:seatId/suggestions') @Require('planning', 'view')
  suggestions(@Param('seatId') seatId: string, @Query() q: { start?: string; end?: string; top?: string }) {
    if (!q.start || !q.end) throw new BadRequestException('start and end are required');
    const start = parseDate(q.start), end = parseDate(q.end);
    if (end < start) throw new BadRequestException('end must not be before start');
    return this.svc.suggest(seatId, start, end, Math.min(parseInt(q.top ?? '5', 10) || 5, 20));
  }

  // ----- create
  /** Plan a period (full) or re-plan only what open replacement tasks need (repair). Always a draft; nothing goes live. */
  @Post('plans') @Require('planning', 'edit')
  async create(@Body() body: { start?: string; end?: string; baseIds?: string[]; mode?: string }, @Req() req: AuthedRequest) {
    if (!body?.start || !body?.end) throw new BadRequestException('start and end are required');
    const mode = body.mode ?? 'full';
    if (!['full', 'repair'].includes(mode)) throw new BadRequestException('mode must be full or repair');
    const baseIds = await this.scopeFor(req, body.baseIds);
    return this.svc.createPlan({ baseIds, start: parseDate(body.start), end: parseDate(body.end), mode: mode as 'full' | 'repair' }, req.user?.sub);
  }

  @Delete('plans/:id') @Require('planning', 'edit')
  async discard(@Param('id') id: string, @Req() req: AuthedRequest) {
    const plan = await this.mustPlan(id);
    await this.assertPlanScope(req, plan);
    if (!['DRAFT', 'REVIEW'].includes(plan.status)) throw new BadRequestException(`A ${plan.status.toLowerCase()} plan cannot be discarded`);
    await this.prisma.$transaction([this.prisma.assignment.deleteMany({ where: { planId: id, status: 'DRAFT' } }), this.prisma.plan.delete({ where: { id } })]);
    await audit(this.prisma, req.user?.sub, 'Plan', id, 'discard');
    return { discarded: id };
  }

  // ----- manual edits of a draft
  private async checkDraft(planId: string, draft: Proposal, ignoreDraftId: string | null, overrideReason?: string) {
    const others = await this.prisma.assignment.findMany({ where: { planId, status: 'DRAFT', ...(ignoreDraftId ? { id: { not: ignoreDraftId } } : {}) } });
    const clash = others.find(o => o.seatId === draft.seatId && o.start <= draft.end && o.plannedEnd >= draft.start);
    if (clash) throw new ConflictException(`Another draft assignment already covers this seat ${iso(clash.start)} to ${iso(clash.plannedEnd)}`);
    await this.assignments.assertSeatFree(draft.seatId, draft.start, draft.end, []);
    const assumed = others.map(o => ({ employeeId: o.employeeId, seatId: o.seatId, start: o.start, end: o.plannedEnd }));
    const ev = await this.assignments.evaluate([draft], [], assumed);
    this.assignments.requireOverride(ev, overrideReason);
    return ev;
  }

  @Post('plans/:id/assignments') @Require('planning', 'edit')
  async addDraft(@Param('id') id: string, @Body() body: { employeeId?: string; seatId?: string; start?: string; end?: string; overrideReason?: string }, @Req() req: AuthedRequest) {
    const plan = await this.mustPlan(id);
    await this.assertPlanScope(req, plan);
    if (plan.status !== 'DRAFT') throw new BadRequestException('Only a draft plan can be edited');
    if (!body?.employeeId || !body.seatId || !body.start || !body.end) throw new BadRequestException('employeeId, seatId, start and end are required');
    const draft = { employeeId: body.employeeId, seatId: body.seatId, start: startOfDay(parseDate(body.start)), end: startOfDay(parseDate(body.end)) };
    if (draft.end < draft.start) throw new BadRequestException('end must not be before start');
    const ev = await this.checkDraft(id, draft, null, body.overrideReason);
    const a = await this.prisma.assignment.create({
      data: { employeeId: draft.employeeId, seatId: draft.seatId, start: draft.start, plannedEnd: draft.end, status: 'DRAFT', planId: id, explanation: 'Added by hand', overrideReason: body.overrideReason?.trim() || undefined },
    });
    await audit(this.prisma, req.user?.sub, 'Plan', id, 'draft_add', null, a, body.overrideReason);
    return { assignment: a, violations: ev.violations };
  }

  @Put('plans/:id/assignments/:aid') @Require('planning', 'edit')
  async editDraft(@Param('id') id: string, @Param('aid') aid: string, @Body() body: { employeeId?: string; start?: string; end?: string; overrideReason?: string }, @Req() req: AuthedRequest) {
    const plan = await this.mustPlan(id);
    await this.assertPlanScope(req, plan);
    if (plan.status !== 'DRAFT') throw new BadRequestException('Only a draft plan can be edited');
    const a = await this.prisma.assignment.findFirst({ where: { id: aid, planId: id, status: 'DRAFT' } });
    if (!a) throw new NotFoundException('Draft assignment not found');
    const draft = {
      employeeId: body.employeeId ?? a.employeeId, seatId: a.seatId,
      start: body.start ? startOfDay(parseDate(body.start)) : a.start, end: body.end ? startOfDay(parseDate(body.end)) : a.plannedEnd,
    };
    if (draft.end < draft.start) throw new BadRequestException('end must not be before start');
    const ev = await this.checkDraft(id, draft, aid, body.overrideReason);
    const after = await this.prisma.assignment.update({
      where: { id: aid },
      data: { employeeId: draft.employeeId, start: draft.start, plannedEnd: draft.end, explanation: 'Edited by hand', overrideReason: body.overrideReason?.trim() || null },
    });
    await audit(this.prisma, req.user?.sub, 'Plan', id, 'draft_edit', a, after, body.overrideReason);
    return { assignment: after, violations: ev.violations };
  }

  @Delete('plans/:id/assignments/:aid') @Require('planning', 'edit')
  async removeDraft(@Param('id') id: string, @Param('aid') aid: string, @Req() req: AuthedRequest) {
    const plan = await this.mustPlan(id);
    await this.assertPlanScope(req, plan);
    if (plan.status !== 'DRAFT') throw new BadRequestException('Only a draft plan can be edited');
    const { count } = await this.prisma.assignment.deleteMany({ where: { id: aid, planId: id, status: 'DRAFT' } });
    if (!count) throw new NotFoundException('Draft assignment not found');
    await audit(this.prisma, req.user?.sub, 'Plan', id, 'draft_remove', { aid });
    return { removed: aid };
  }

  // ----- lifecycle: Draft -> Under review -> Approved -> Published
  @Post('plans/:id/submit') @Require('planning', 'edit')
  async submit(@Param('id') id: string, @Req() req: AuthedRequest) {
    const plan = await this.mustPlan(id);
    await this.assertPlanScope(req, plan);
    if (plan.status !== 'DRAFT') throw new BadRequestException(`Only a draft can be submitted (this one is ${plan.status.toLowerCase()})`);
    const n = await this.prisma.assignment.count({ where: { planId: id, status: 'DRAFT' } });
    if (n === 0) throw new BadRequestException('The plan has no assignments to review');
    await this.prisma.plan.update({ where: { id }, data: { status: 'REVIEW', submittedBy: req.user?.sub } });
    await audit(this.prisma, req.user?.sub, 'Plan', id, 'submit');
    return { status: 'REVIEW' };
  }

  @Post('plans/:id/approve') @Require('planning', 'full')
  async approve(@Param('id') id: string, @Body() body: { note?: string }, @Req() req: AuthedRequest) {
    const plan = await this.mustPlan(id);
    if (plan.status !== 'REVIEW') throw new BadRequestException(`Only a plan under review can be approved (this one is ${plan.status.toLowerCase()})`);
    if (plan.submittedBy && plan.submittedBy === req.user?.sub && !(req.user?.roles ?? []).some(r => r.role === 'SUPER_ADMIN')) {
      throw new ForbiddenException('A plan cannot be approved by the person who submitted it');
    }
    await this.prisma.plan.update({ where: { id }, data: { status: 'APPROVED', approvedBy: req.user?.sub, decisionNote: body?.note } });
    await audit(this.prisma, req.user?.sub, 'Plan', id, 'approve');
    return { status: 'APPROVED' };
  }

  /** The reviewer sends it back to the dispatcher with a reason. */
  @Post('plans/:id/reject') @Require('planning', 'full')
  async reject(@Param('id') id: string, @Body() body: { reason?: string }, @Req() req: AuthedRequest) {
    const plan = await this.mustPlan(id);
    if (!['REVIEW', 'APPROVED'].includes(plan.status)) throw new BadRequestException('Only a plan under review or approved can be sent back');
    if (!body?.reason?.trim()) throw new BadRequestException('A reason is required');
    await this.prisma.plan.update({ where: { id }, data: { status: 'DRAFT', approvedBy: null, decisionNote: body.reason.trim() } });
    await audit(this.prisma, req.user?.sub, 'Plan', id, 'reject', { status: plan.status }, { status: 'DRAFT' }, body.reason);
    return { status: 'DRAFT' };
  }

  /**
   * Publish: every draft is checked again against the live state, because things change between drafting and
   * approval. Valid drafts become confirmed assignments and the replacement tasks they cover are closed.
   */
  @Post('plans/:id/publish') @Require('planning', 'full')
  async publish(@Param('id') id: string, @Body() body: { skipInvalid?: boolean }, @Req() req: AuthedRequest) {
    const plan = await this.mustPlan(id);
    // Without the review step (the default: one manager runs everything) a draft is published as it is.
    const requireApproval = (await this.settings.all())['workflow.requireApproval'] === true;
    const publishable = requireApproval ? ['APPROVED'] : ['DRAFT', 'REVIEW', 'APPROVED'];
    if (!publishable.includes(plan.status)) throw new BadRequestException(requireApproval ? `Only an approved plan can be published (this one is ${plan.status.toLowerCase()})` : `A ${plan.status.toLowerCase()} plan cannot be published`);
    const drafts = await this.prisma.assignment.findMany({ where: { planId: id, status: 'DRAFT' }, orderBy: [{ start: 'asc' }, { seatId: 'asc' }] });

    const accepted: typeof drafts = [];
    const problems: { assignmentId: string; seatId: string; employeeId: string; start: string; end: string; reasons: string[] }[] = [];
    for (const d of drafts) {
      const reasons: string[] = [];
      const p: Proposal = { employeeId: d.employeeId, seatId: d.seatId, start: d.start, end: d.plannedEnd };
      try { await this.assignments.assertSeatFree(d.seatId, d.start, d.plannedEnd, []); } catch (e) { reasons.push((e as Error).message); }
      if (accepted.some(a => a.seatId === d.seatId && a.start <= d.plannedEnd && a.plannedEnd >= d.start)) reasons.push('Overlaps another assignment in this plan');
      if (reasons.length === 0) {
        try {
          // Person-level rules only: a crew is only complete once the whole batch is in, and the crew rules were
          // already applied by the engine and when the draft was edited.
          const ev = await this.assignments.evaluate([p], [], accepted.map(a => ({ employeeId: a.employeeId, seatId: a.seatId, start: a.start, end: a.plannedEnd })), true);
          // A hard rule that someone knowingly overrode while editing the draft stays overridden.
          if (ev.hard > 0 && !d.overrideReason) reasons.push(...ev.violations.filter(v => v.severity === 'hard').map(v => v.message));
        } catch (e) { reasons.push((e as Error).message); }
      }
      if (reasons.length) problems.push({ assignmentId: d.id, seatId: d.seatId, employeeId: d.employeeId, start: iso(d.start), end: iso(d.plannedEnd), reasons });
      else accepted.push(d);
    }
    if (problems.length && !body?.skipInvalid) {
      throw new HttpException({ statusCode: 422, error: 'Plan no longer valid', message: 'Some drafts break rules now; fix them or publish with skipInvalid', problems }, HttpStatus.UNPROCESSABLE_ENTITY);
    }

    const today = startOfDay(new Date());
    const out = await this.prisma.$transaction(async tx => {
      for (const d of accepted) {
        await tx.assignment.update({ where: { id: d.id }, data: { status: d.start <= today ? 'ACTIVE' : 'CONFIRMED' } });
        // Close or shrink the replacement tasks this assignment covers.
        const tasks = await tx.replacementTask.findMany({ where: { seatId: d.seatId, status: { in: OPEN_TASK }, fromDate: { lte: d.plannedEnd }, toDate: { gte: d.start } } });
        for (const t of tasks) {
          const rest = subtractSpans({ start: t.fromDate, end: t.toDate }, [{ start: d.start, end: d.plannedEnd }]);
          if (rest.length === 0) await tx.replacementTask.update({ where: { id: t.id }, data: { status: 'CLOSED', candidateId: d.employeeId, assignmentId: d.id } });
          else {
            await tx.replacementTask.update({ where: { id: t.id }, data: { fromDate: rest[0].start, toDate: rest[0].end } });
            for (const extra of rest.slice(1)) {
              await tx.replacementTask.create({ data: { seatId: t.seatId, fromDate: extra.start, toDate: extra.end, trigger: t.trigger, urgency: t.urgency, sourceId: t.sourceId, deadline: extra.start } });
            }
          }
        }
      }
      for (const p of problems) {
        await tx.assignment.update({ where: { id: p.assignmentId }, data: { status: 'CANCELLED', explanation: `Not published: ${p.reasons.join('; ')}`.slice(0, 500) } });
        // A skipped draft must not leave its days silently uncovered: make sure an open task exists for them.
        const seat = await tx.seat.findUnique({ where: { id: p.seatId }, select: { requiredFlag: true } });
        const from = startOfDay(new Date(p.start)), to = startOfDay(new Date(p.end));
        const open = await tx.replacementTask.findFirst({ where: { seatId: p.seatId, status: { in: OPEN_TASK }, fromDate: { lte: to }, toDate: { gte: from } } });
        if (seat?.requiredFlag && !open) {
          const away = Math.round((from.getTime() - today.getTime()) / DAY);
          await tx.replacementTask.create({ data: { seatId: p.seatId, fromDate: from, toDate: to, trigger: 'plan_skipped', urgency: away <= 0 ? 'CRITICAL' : away <= 7 ? 'HIGH' : 'NORMAL', deadline: from, sourceId: id } });
        }
      }
      await tx.plan.update({ where: { id }, data: { status: 'PUBLISHED', publishedAt: new Date() } });
      return { published: accepted.length, skipped: problems.length };
    });
    await audit(this.prisma, req.user?.sub, 'Plan', id, 'publish', null, out);
    // Everyone who got a new stretch is told once, with their first one spelled out, and must acknowledge (plan 19).
    const byPerson = new Map<string, typeof accepted>();
    for (const a of accepted) (byPerson.get(a.employeeId) ?? byPerson.set(a.employeeId, []).get(a.employeeId)!).push(a);
    for (const [employeeId, list] of byPerson) {
      const first = [...list].sort((x, y) => x.start.getTime() - y.start.getTime())[0];
      await this.notifier.notify({
        type: 'plan_published', to: [{ employeeId }], except: req.user?.sub,
        payload: { version: plan.version, count: list.length, seat: await this.notifier.seatLabel(first.seatId), from: iso(first.start), to: iso(first.plannedEnd) },
      });
    }
    return { status: 'PUBLISHED', ...out, problems };
  }
}

@Module({
  imports: [SettingsModule, InsightsModule, AssignmentsModule],
  controllers: [PlanningController],
  providers: [PlanningService],
  exports: [PlanningService],
})
export class PlanningModule {}
