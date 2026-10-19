import { Inject, Injectable, Module } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsModule, SettingsService } from '../settings/settings';
import { EmployeeInsightsService, InsightsModule } from '../employees/insights';
import { CalendarCoreModule, CalendarService, DayCell, addDays, iso } from '../calendar/calendar.service';
import { buildForecast, Counts, Forecast, profileLabel, profilesOf } from '../domain/forecast';
import { computeUnitStatus } from '../domain/derived';
import { overlapDays } from '../domain/absence';
import { mergeSpans, spanDays } from '../domain/spans';
import { Seniority, startOfDay } from '../domain/status';
import { seniorityAtLeast } from '../domain/rules';

const DAY = 86_400_000;
const WORKING = new Set(['ON_UNIT', 'EXTENDED', 'ON_BASE_POST', 'STANDBY']);
const OPEN_WO = ['OPEN', 'IN_PROGRESS', 'WAITING_PARTS'];
const LIVE = ['CONFIRMED', 'ACTIVE'] as const;
const EFFECTIVE_LEAVE = ['APPROVED', 'RECORDED', 'ACTIVE', 'COMPLETED'];
const TYPE_KEY: Record<string, string> = { 'Open Hole': 'oh', 'Cased Hole': 'ch' };

export interface Person {
  id: string; name: string; employeeNo: string; baseId: string; baseCode: string; position: string; category: string
  qualifications: string[]; seniority: Seniority; fieldDays: number; fieldDaysYear: number; yearsOfService: number
  profiles: string[]; mandatoryCertTypeIds: string[]; certs: { typeId: string }[]
}

@Injectable()
export class AnalyticsService {
  constructor(
    @Inject(PrismaService) private prisma: PrismaService,
    @Inject(SettingsService) private settings: SettingsService,
    @Inject(EmployeeInsightsService) private insights: EmployeeInsightsService,
    @Inject(CalendarService) private cal: CalendarService,
  ) {}

  async people(baseId?: string): Promise<Person[]> {
    const today = startOfDay(new Date());
    const rows = await this.prisma.employee.findMany({
      where: { active: true, position: { category: { in: ['FIELD_CREW', 'BASE_STAFF'] } }, ...(baseId ? { homeBaseId: baseId } : {}) },
      include: { position: { include: { requiredCertTypes: true } }, homeBase: { select: { id: true, code: true } }, qualifications: { include: { qualification: true } }, certifications: true, rotationPattern: true },
    });
    const sen = await this.insights.enrich(rows.map(r => ({ ...r })), today);
    return rows.map(r => {
      const c = sen.get(r.id)!;
      const quals = r.qualifications.map(q => q.qualification.name);
      return {
        id: r.id, name: `${r.firstName} ${r.lastName}`, employeeNo: r.employeeNo, baseId: r.homeBaseId, baseCode: r.homeBase.code,
        position: r.position.name, category: r.position.category, qualifications: quals, seniority: c.seniority, fieldDays: c.fieldDays,
        fieldDaysYear: c.fieldDaysYear, yearsOfService: c.yearsOfService,
        profiles: profilesOf({ position: r.position.name, category: r.position.category, qualifications: quals, experienced: seniorityAtLeast(c.seniority, 'EXPERIENCED') }),
        mandatoryCertTypeIds: r.position.requiredCertTypes.map(t => t.id),
        certs: r.certifications.map(x => ({ typeId: x.typeId })),
      };
    });
  }

  async calendars(people: Person[], from: Date, to: Date) {
    return this.cal.buildDays(people.map(p => p.id), from, to, { canSeeMedical: () => false });
  }

  // ---------------------------------------------------------------- coverage forecast

  /** Required against available people per day, per base and profile (20.1 page 2). */
  async forecast(opts: { days?: number; baseId?: string; from?: Date } = {}): Promise<Forecast & { profiles: { key: string; label: string }[] }> {
    const from = startOfDay(opts.from ?? new Date());
    const n = Math.min(Math.max(opts.days ?? 90, 7), 180);
    const to = addDays(from, n - 1);
    const dates = Array.from({ length: n }, (_, i) => iso(addDays(from, i)));
    const settings = await this.settings.all();
    const minExp = settings['rules.minExperiencedPerCrew'] as number;
    const workingDays = settings['org.workingDays'] as string;

    const bases = await this.prisma.base.findMany({ where: { active: true, ...(opts.baseId ? { id: opts.baseId } : {}) }, orderBy: { code: 'asc' }, select: { id: true, code: true } });
    const baseIds = bases.map(b => b.id);
    const required: Counts = {}, available: Counts = {};
    for (const b of bases) { required[b.id] = {}; available[b.id] = {}; }
    const bump = (m: Counts, base: string, profile: string, i: number, by = 1) => {
      const arr = (m[base][profile] ??= new Array(n).fill(0));
      arr[i] += by;
    };

    // ---- demand: crews of units that have a job, minus days in the workshop; plus base minimums
    const units = await this.prisma.unit.findMany({
      where: { homeBaseId: { in: baseIds }, status: { not: 'OUT_OF_SERVICE' } },
      include: {
        unitType: true,
        seats: { where: { holderType: 'UNIT', requiredFlag: true }, include: { position: { select: { name: true } } } },
        deployments: { where: { start: { lte: to }, end: { gte: from } } },
        workOrders: { where: { status: { in: OPEN_WO }, plannedStart: { lte: to }, expectedReturn: { gte: from } } },
      },
    });
    for (const u of units) {
      const chiefs = u.seats.filter(s => s.position.name === 'Chief of Unit').length;
      const ops = u.seats.filter(s => s.position.name === 'Field Operator').length;
      const tk = TYPE_KEY[u.unitType.name];
      for (let i = 0; i < n; i++) {
        const d = addDays(from, i);
        const deployed = u.deployments.some(p => startOfDay(p.start) <= d && d <= p.end);
        const inShop = u.workOrders.some(w => startOfDay(w.plannedStart) <= d && d <= w.expectedReturn);
        if (!deployed || inShop) continue;
        if (chiefs) bump(required, u.homeBaseId, 'chief', i, chiefs);
        if (tk && ops) { bump(required, u.homeBaseId, `op_${tk}`, i, ops); bump(required, u.homeBaseId, `exp_${tk}`, i, Math.min(minExp, ops)); }
      }
    }
    const rules = await this.prisma.baseStaffingRule.findMany({ where: { baseId: { in: baseIds } }, include: { position: { select: { name: true } } } });
    for (const r of rules) {
      for (let i = 0; i < n; i++) {
        if (r.scheduleWindow === 'working_days' && workingDays[addDays(from, i).getUTCDay()] !== '1') continue;
        bump(required, r.baseId, `post:${r.position.name}`, i, r.minCount);
      }
    }

    // ---- supply: people on rotation and not on leave, counted for every profile they fit
    const people = await this.people(opts.baseId);
    const days = await this.calendars(people, from, to);
    for (const p of people) {
      const cells = days.get(p.id) ?? [];
      cells.forEach((c, i) => { if (WORKING.has(c.status)) for (const prof of p.profiles) bump(available, p.baseId, prof, i); });
    }

    const f = buildForecast({ dates, scopes: bases, required, available });
    const used = new Set<string>([...Object.keys(f.total)]);
    return { ...f, profiles: [...used].sort().map(key => ({ key, label: profileLabel(key) })) };
  }

  // ---------------------------------------------------------------- today's picture

  /** Crew state of every unit with a job today: filled required seats, chief, experienced. */
  async crewStates(date: Date, baseId?: string) {
    const settings = await this.settings.all();
    const minExp = settings['rules.minExperiencedPerCrew'] as number;
    const chiefRequired = settings['rules.chiefRequired'] as boolean;
    const units = await this.prisma.unit.findMany({
      where: { ...(baseId ? { homeBaseId: baseId } : {}), status: { not: 'OUT_OF_SERVICE' } },
      include: {
        unitType: true, homeBase: { select: { code: true } },
        deployments: { where: { start: { lte: date }, end: { gte: date } } },
        workOrders: { where: { status: { in: OPEN_WO }, plannedStart: { lte: date }, expectedReturn: { gte: date } } },
        seats: { where: { holderType: 'UNIT' }, include: { position: { select: { name: true } }, assignments: { where: { status: { in: [...LIVE] }, start: { lte: date }, plannedEnd: { gte: date } }, select: { employeeId: true } } } },
      },
    });
    const holderIds = units.flatMap(u => u.seats.flatMap(s => s.assignments.map(a => a.employeeId)));
    const emps = await this.prisma.employee.findMany({ where: { id: { in: holderIds } }, include: { rotationPattern: true } });
    const sen = await this.insights.enrich(emps.map(e => ({ ...e })), date);
    return units.filter(u => computeUnitStatus({ manualStatus: u.status, workOrders: u.workOrders, deployments: u.deployments }, date) === 'DEPLOYED').map(u => {
      const required = u.seats.filter(s => s.requiredFlag);
      const filled = required.filter(s => s.assignments.length > 0).length;
      const hasChief = u.seats.some(s => s.position.name === 'Chief of Unit' && s.assignments.length > 0);
      const experienced = u.seats.filter(s => s.assignments.length > 0 && seniorityAtLeast(sen.get(s.assignments[0].employeeId)?.seniority ?? 'JUNIOR', 'EXPERIENCED')).length;
      const ops = required.filter(s => s.position.name === 'Field Operator');
      const issues: string[] = [];
      if (filled < required.length) issues.push(`${required.length - filled} seat(s) empty`);
      if (chiefRequired && !hasChief) issues.push('no chief of unit');
      if (ops.every(s => s.assignments.length > 0) && experienced < minExp) issues.push('no experienced operator');
      return { id: u.id, code: u.code, base: u.homeBase.code, type: u.unitType.name, required: required.length, filled, compliant: issues.length === 0, issues };
    });
  }

  async overview(baseId?: string) {
    const today = startOfDay(new Date());
    const people = await this.people(baseId);
    const days = await this.calendars(people, today, today);
    const headcount: Record<string, number> = {};
    for (const p of people) { const s = days.get(p.id)?.[0]?.status ?? 'STANDBY'; headcount[s] = (headcount[s] ?? 0) + 1; }

    const unitRows = await this.prisma.unit.findMany({
      where: baseId ? { homeBaseId: baseId } : {},
      include: { homeBase: { select: { code: true } }, workOrders: { where: { status: { in: OPEN_WO } } }, deployments: { where: { start: { lte: today }, end: { gte: today } } } },
    });
    const unitsByBase: Record<string, Record<string, number>> = {};
    for (const u of unitRows) {
      const st = computeUnitStatus({ manualStatus: u.status, workOrders: u.workOrders, deployments: u.deployments }, today);
      const row = (unitsByBase[u.homeBase.code] ??= {});
      row[st] = (row[st] ?? 0) + 1;
    }

    const crews = await this.crewStates(today, baseId);
    const staffing = await this.baseStaffingToday(people, days, baseId);
    const tasks = await this.prisma.replacementTask.groupBy({ by: ['urgency'], where: { status: { in: ['OPEN', 'ESCALATED', 'CANDIDATE_PROPOSED'] } }, _count: true });
    const ending = await this.prisma.assignment.count({ where: { status: { in: [...LIVE] }, plannedEnd: { gte: today, lte: addDays(today, 6) }, ...(baseId ? { seat: { OR: [{ baseId }, { unit: { homeBaseId: baseId } }] } } : {}) } });
    return {
      date: iso(today), headcount, unitsByBase,
      crews: { deployed: crews.length, compliant: crews.filter(c => c.compliant).length, nonCompliant: crews.filter(c => !c.compliant) },
      basePostsBelowMin: staffing.filter(s => s.present < s.min), basePostsTotal: staffing.length,
      openTasks: Object.fromEntries(tasks.map(t => [t.urgency, t._count])), crewChangesNext7Days: ending,
    };
  }

  /** Present against minimum for each base post type today. */
  async baseStaffingToday(people: Person[], days: Map<string, DayCell[]>, baseId?: string) {
    const settings = await this.settings.all();
    const today = startOfDay(new Date());
    const workingDays = settings['org.workingDays'] as string;
    const rules = await this.prisma.baseStaffingRule.findMany({ where: baseId ? { baseId } : {}, include: { base: { select: { code: true, active: true } }, position: { select: { name: true } } } });
    const holders = await this.prisma.assignment.findMany({ where: { status: { in: [...LIVE] }, start: { lte: today }, plannedEnd: { gte: today }, seat: { holderType: 'BASE', ...(baseId ? { baseId } : {}) } }, select: { employeeId: true, seat: { select: { baseId: true, positionId: true } } } });
    void people;
    const out = [];
    for (const r of rules) {
      if (!r.base.active) continue;
      if (r.scheduleWindow === 'working_days' && workingDays[today.getUTCDay()] !== '1') continue;
      const ids = new Set(holders.filter(h => h.seat.baseId === r.baseId && h.seat.positionId === r.positionId).map(h => h.employeeId));
      const present = [...ids].filter(id => days.get(id)?.[0]?.status === 'ON_BASE_POST').length;
      out.push({ base: r.base.code, position: r.position.name, min: r.minCount, target: r.targetCount, present });
    }
    return out;
  }

  // ---------------------------------------------------------------- KPI catalog (20.2)

  async kpis(opts: { baseId?: string; from?: Date; to?: Date; includeMedical?: boolean }) {
    const today = startOfDay(new Date());
    const to = startOfDay(opts.to ?? today), from = startOfDay(opts.from ?? addDays(to, -29));
    const periodDays = spanDays({ start: from, end: to });
    const people = await this.people(opts.baseId);
    const field = people.filter(p => p.category === 'FIELD_CREW');
    const ids = people.map(p => p.id);
    const todayDays = await this.calendars(people, today, today);

    const crews = await this.crewStates(today, opts.baseId);
    const staffing = await this.baseStaffingToday(people, todayDays, opts.baseId);
    const requiredSeats = crews.reduce((n, c) => n + c.required, 0) + staffing.reduce((n, s) => n + s.min, 0);
    const filledSeats = crews.reduce((n, c) => n + c.filled, 0) + staffing.reduce((n, s) => n + Math.min(s.present, s.min), 0);

    // extensions in the period
    const exts = await this.prisma.extension.findMany({ where: { status: 'APPROVED', createdAt: { gte: from, lte: addDays(to, 1) }, ...(opts.baseId ? { employee: { homeBaseId: opts.baseId } } : {}) }, select: { days: true, employeeId: true } });
    const perPerson = new Map<string, number>();
    for (const e of exts) perPerson.set(e.employeeId, (perPerson.get(e.employeeId) ?? 0) + e.days);
    const extVals = field.map(p => perPerson.get(p.id) ?? 0);
    const mean = extVals.length ? extVals.reduce((a, b) => a + b, 0) / extVals.length : 0;
    const std = extVals.length ? Math.sqrt(extVals.reduce((a, b) => a + (b - mean) ** 2, 0) / extVals.length) : 0;

    // days-off balance
    const ledger = await this.prisma.daysOffLedger.groupBy({ by: ['employeeId'], where: { employeeId: { in: field.map(p => p.id) } }, _sum: { days: true } });
    const avgBalance = field.length ? ledger.reduce((n, l) => n + (l._sum.days ?? 0), 0) / field.length : 0;

    // absence: effective leave person-days against scheduled person-days
    const leaves = await this.prisma.leave.findMany({ where: { employeeId: { in: ids }, status: { in: EFFECTIVE_LEAVE }, start: { lte: to }, end: { gte: from } }, include: { type: { select: { category: true } } } });
    const scheduled = Math.max(people.length * periodDays, 1);
    const byCat: Record<string, number> = {};
    for (const l of leaves) byCat[l.type.category] = (byCat[l.type.category] ?? 0) + overlapDays(l, { start: from, end: to });
    const absentDays = Object.entries(byCat).filter(([c]) => c !== 'training').reduce((n, [, d]) => n + d, 0);

    // replacement lead time: confirmation to the day the replacement starts
    const confirms = await this.prisma.auditLog.findMany({ where: { entity: 'ReplacementTask', action: 'confirm', at: { gte: from, lte: addDays(to, 1) } }, select: { at: true, after: true } });
    const aIds = confirms.map(c => (c.after as { assignmentId?: string } | null)?.assignmentId).filter((x): x is string => !!x);
    const started = await this.prisma.assignment.findMany({ where: { id: { in: aIds } }, select: { id: true, start: true } });
    const lead = confirms.flatMap(c => { const a = started.find(s => s.id === (c.after as { assignmentId?: string } | null)?.assignmentId); return a ? [(a.start.getTime() - c.at.getTime()) / DAY] : []; });

    // units: utilisation and downtime over the period
    const units = await this.prisma.unit.findMany({
      where: { ...(opts.baseId ? { homeBaseId: opts.baseId } : {}), status: { not: 'OUT_OF_SERVICE' } },
      include: { deployments: { where: { start: { lte: to }, end: { gte: from } } }, workOrders: { where: { plannedStart: { lte: to }, expectedReturn: { gte: from }, status: { not: 'CANCELLED' } } } },
    });
    const clip = (s: Date, e: Date) => ({ start: s < from ? from : s, end: e > to ? to : e });
    const util = units.map(u => mergeSpans(u.deployments.map(d => clip(d.start, d.end))).reduce((n, s) => n + spanDays(s), 0) / periodDays);
    const down = units.map(u => mergeSpans(u.workOrders.map(w => clip(w.plannedStart, w.expectedReturn))).reduce((n, s) => n + spanDays(s), 0) / periodDays);
    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

    // rotation staffing ratio: crew people per crew seat (28/28 needs about 2.0)
    const crewSeats = await this.prisma.seat.count({ where: { holderType: 'UNIT', requiredFlag: true, unit: { status: { not: 'OUT_OF_SERVICE' }, ...(opts.baseId ? { homeBaseId: opts.baseId } : {}) } } });
    const crewPeople = people.filter(p => p.position === 'Chief of Unit' || p.position === 'Field Operator').length;

    const fc = await this.forecast({ days: 90, baseId: opts.baseId });

    const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
    const r1 = (x: number) => Math.round(x * 10) / 10;
    const list: { key: string; label: string; value: number | null; unit: string; detail?: string }[] = [
      { key: 'crewCompliance', label: 'Crew compliance rate', value: pct(crews.filter(c => c.compliant).length, crews.length), unit: '%', detail: `${crews.filter(c => c.compliant).length} of ${crews.length} deployed units` },
      { key: 'seatFill', label: 'Seat fill rate', value: pct(filledSeats, requiredSeats), unit: '%', detail: `${filledSeats} of ${requiredSeats} required seats` },
      { key: 'replacementLead', label: 'Replacement lead time', value: lead.length ? r1(avg(lead)) : null, unit: 'days', detail: `${lead.length} replacement(s) confirmed in the period` },
      { key: 'unplannedExtensions', label: 'Unplanned extension days', value: exts.reduce((n, e) => n + e.days, 0), unit: 'days', detail: `${exts.length} approved extension(s)` },
      { key: 'extensionFairness', label: 'Extension fairness (std deviation)', value: r1(std), unit: 'days', detail: 'lower is fairer' },
      { key: 'avgBalance', label: 'Average days-off balance', value: r1(avgBalance), unit: 'days' },
      { key: 'absenceRate', label: 'Absence rate', value: pct(absentDays, scheduled), unit: '%', detail: `${absentDays} absent person-days` },
      { key: 'coverageRatio', label: 'Lowest coverage ratio, next 90 days', value: fc.minRatio.value, unit: 'x', detail: fc.minRatio.profile ? `${profileLabel(fc.minRatio.profile)} on ${fc.minRatio.date}` : 'no shortage' },
      { key: 'rotationRatio', label: 'Rotation staffing ratio', value: crewSeats ? r1(crewPeople / crewSeats) : null, unit: 'people per seat', detail: '28/28 rotations need about 2.0' },
      { key: 'utilization', label: 'Unit utilization', value: r1(avg(util) * 100), unit: '%', detail: `${units.length} units, ${periodDays} days` },
      { key: 'downtime', label: 'Unit downtime', value: r1(avg(down) * 100), unit: '%' },
      { key: 'baseStaffing', label: 'Base staffing rate', value: pct(staffing.reduce((n, s) => n + Math.min(s.present, s.min), 0), staffing.reduce((n, s) => n + s.min, 0)), unit: '%' },
    ];
    // Medical absence is shown only as an aggregate rate, and only to those allowed to see medical statistics.
    if (opts.includeMedical) list.splice(7, 0, { key: 'medicalAbsence', label: 'Medical absence rate (aggregate)', value: pct(byCat['medical'] ?? 0, scheduled), unit: '%' });
    return { from: iso(from), to: iso(to), kpis: list };
  }

  // ---------------------------------------------------------------- dashboard pages

  async peoplePage(opts: { baseId?: string; from?: Date; to?: Date }) {
    const to = startOfDay(opts.to ?? new Date()), from = startOfDay(opts.from ?? addDays(to, -364));
    const people = await this.people(opts.baseId);
    const field = people.filter(p => p.category === 'FIELD_CREW');
    const exts = await this.prisma.extension.findMany({ where: { status: 'APPROVED', createdAt: { gte: from, lte: addDays(to, 1) }, employeeId: { in: field.map(p => p.id) } }, select: { days: true, employeeId: true } });
    const extBy = new Map<string, number>();
    for (const e of exts) extBy.set(e.employeeId, (extBy.get(e.employeeId) ?? 0) + e.days);
    const buckets = [['0', 0, 0], ['1-3', 1, 3], ['4-7', 4, 7], ['8-14', 8, 14], ['15+', 15, Infinity]] as const;
    const extensionHistogram = buckets.map(([label, lo, hi]) => ({ label, people: field.filter(p => { const d = extBy.get(p.id) ?? 0; return d >= lo && d <= hi; }).length }));
    const ledger = await this.prisma.daysOffLedger.groupBy({ by: ['employeeId'], _sum: { days: true } });
    const balances = ledger.map(l => ({ id: l.employeeId, days: l._sum.days ?? 0 })).filter(b => field.some(p => p.id === b.id));
    const named = (id: string) => people.find(p => p.id === id);
    const fieldBuckets = [['0-29', 0, 29], ['30-89', 30, 89], ['90-179', 90, 179], ['180-269', 180, 269], ['270+', 270, Infinity]] as const;
    const mix: Record<string, Record<string, number>> = {};
    for (const p of field) { const row = (mix[p.baseCode] ??= { NEW_RECRUIT: 0, JUNIOR: 0, EXPERIENCED: 0, SENIOR: 0 }); row[p.seniority]++; }
    return {
      extensionHistogram,
      topExtensions: [...extBy].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id, days]) => ({ name: named(id)?.name ?? '?', base: named(id)?.baseCode, days })),
      balanceRanking: balances.filter(b => b.days !== 0).sort((a, b) => b.days - a.days).slice(0, 10).map(b => ({ name: named(b.id)?.name ?? '?', base: named(b.id)?.baseCode, days: b.days })),
      fieldDaysHistogram: fieldBuckets.map(([label, lo, hi]) => ({ label, people: field.filter(p => p.fieldDaysYear >= lo && p.fieldDaysYear <= hi).length })),
      seniorityMix: Object.entries(mix).map(([base, v]) => ({ base, ...v })),
    };
  }

  async leavePage(opts: { baseId?: string; months?: number; includeMedical: boolean }) {
    const months = Math.min(Math.max(opts.months ?? 6, 1), 24);
    const today = startOfDay(new Date());
    const first = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - (months - 1), 1));
    const last = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0));
    const people = await this.people(opts.baseId);
    const leaves = await this.prisma.leave.findMany({
      where: { employeeId: { in: people.map(p => p.id) }, status: { in: EFFECTIVE_LEAVE }, start: { lte: last }, end: { gte: first } },
      include: { type: { select: { name: true, category: true } }, employee: { select: { homeBase: { select: { code: true } } } } },
    });
    const byMonth: { month: string; types: Record<string, number> }[] = [];
    for (let m = new Date(first); m <= last; m = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1))) {
      const span = { start: m, end: new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 0)) };
      const types: Record<string, number> = {};
      for (const l of leaves) {
        const d = overlapDays(l, span);
        if (!d) continue;
        // Medical leave appears only as one aggregate bar, and only for people allowed to see medical statistics.
        const name = l.type.category === 'medical' ? (opts.includeMedical ? 'Medical (aggregate)' : null) : l.type.name;
        if (name) types[name] = (types[name] ?? 0) + d;
      }
      byMonth.push({ month: m.toISOString().slice(0, 7), types });
    }
    const baseCodes = [...new Set(people.map(p => p.baseCode))].sort();
    const headcount = (code: string) => people.filter(p => p.baseCode === code).length;
    const periodDays = spanDays({ start: first, end: today });
    const absenceByBase = baseCodes.map(code => {
      const d = leaves.filter(l => l.employee.homeBase.code === code && (opts.includeMedical || l.type.category !== 'medical') && !['training'].includes(l.type.category)).reduce((n, l) => n + overlapDays(l, { start: first, end: today }), 0);
      return { base: code, rate: Math.round((d / Math.max(headcount(code) * periodDays, 1)) * 1000) / 10 };
    });
    return {
      byMonth, absenceByBase,
      longTermAbsences: opts.includeMedical ? leaves.filter(l => l.longTerm && l.end >= today).length : null,
      awaitingClearance: opts.includeMedical ? await this.prisma.leave.count({ where: { type: { category: 'medical' }, status: 'RECORDED', end: { lt: today }, fitForDuty: null } }) : null,
    };
  }

  async unitsPage(opts: { baseId?: string; days?: number }) {
    const to = startOfDay(new Date()), n = Math.min(Math.max(opts.days ?? 90, 7), 365);
    const from = addDays(to, -(n - 1));
    const units = await this.prisma.unit.findMany({
      where: opts.baseId ? { homeBaseId: opts.baseId } : {}, orderBy: { code: 'asc' },
      include: { unitType: true, homeBase: { select: { code: true } }, deployments: { where: { start: { lte: to }, end: { gte: from } } }, workOrders: { where: { plannedStart: { lte: to }, expectedReturn: { gte: from }, status: { not: 'CANCELLED' } } } },
    });
    const clip = (s: Date, e: Date) => ({ start: s < from ? from : s, end: e > to ? to : e });
    const rows = units.map(u => ({
      code: u.code, base: u.homeBase.code, type: u.unitType.name, jobs: u.deployments.length,
      utilization: Math.round((mergeSpans(u.deployments.map(d => clip(d.start, d.end))).reduce((x, s) => x + spanDays(s), 0) / n) * 1000) / 10,
      downtime: Math.round((mergeSpans(u.workOrders.map(w => clip(w.plannedStart, w.expectedReturn))).reduce((x, s) => x + spanDays(s), 0) / n) * 1000) / 10,
    }));
    const open = await this.prisma.workOrder.findMany({ where: { status: { in: OPEN_WO }, ...(opts.baseId ? { baseId: opts.baseId } : {}) }, include: { base: { select: { code: true } }, assignees: { include: { employee: { select: { firstName: true, lastName: true } } } } } });
    const byBase: Record<string, number> = {};
    for (const w of open) byBase[w.base.code] = (byBase[w.base.code] ?? 0) + 1;
    const load = new Map<string, number>();
    for (const w of open) for (const a of w.assignees) { const k = `${a.employee.firstName} ${a.employee.lastName}`; load.set(k, (load.get(k) ?? 0) + 1); }
    return { days: n, units: rows, openWorkOrdersByBase: Object.entries(byBase).map(([base, count]) => ({ base, count })), mechanicWorkload: [...load].map(([name, orders]) => ({ name, orders })).sort((a, b) => b.orders - a.orders) };
  }

  /** Filled against minimum and target for every base post type, day by day (20.1 page 6). */
  async baseStaffingPage(opts: { baseId?: string; back?: number; ahead?: number }) {
    const today = startOfDay(new Date());
    const from = addDays(today, -(opts.back ?? 14)), to = addDays(today, opts.ahead ?? 14);
    const n = spanDays({ start: from, end: to });
    const rules = await this.prisma.baseStaffingRule.findMany({ where: opts.baseId ? { baseId: opts.baseId } : {}, include: { base: { select: { code: true } }, position: { select: { name: true } } } });
    const holders = await this.prisma.assignment.findMany({
      where: { status: { in: [...LIVE, 'COMPLETED'] }, start: { lte: to }, plannedEnd: { gte: from }, seat: { holderType: 'BASE', ...(opts.baseId ? { baseId: opts.baseId } : {}) } },
      select: { employeeId: true, seat: { select: { baseId: true, positionId: true } } },
    });
    const ids = [...new Set(holders.map(h => h.employeeId))];
    const days = await this.cal.buildDays(ids, from, to, { canSeeMedical: () => false });
    const out = rules.map(r => {
      const mine = [...new Set(holders.filter(h => h.seat.baseId === r.baseId && h.seat.positionId === r.positionId).map(h => h.employeeId))];
      const series = Array.from({ length: n }, (_, i) => ({ date: iso(addDays(from, i)), present: mine.filter(id => days.get(id)?.[i]?.status === 'ON_BASE_POST').length }));
      return { base: r.base.code, position: r.position.name, min: r.minCount, target: r.targetCount, series };
    });
    return { from: iso(from), to: iso(to), rows: out };
  }

  /** Bases, sites and unit pins for the Algeria map (20.1 page 8). */
  async map() {
    const today = startOfDay(new Date());
    const bases = await this.prisma.base.findMany({ where: { active: true } });
    const people = await this.people();
    const days = await this.calendars(people, today, today);
    const units = await this.prisma.unit.findMany({
      include: { unitType: true, homeBase: true, workOrders: { where: { status: { in: OPEN_WO } } }, deployments: { where: { start: { lte: today }, end: { gte: today } }, include: { job: { include: { site: true } } } }, seats: { where: { holderType: 'UNIT', requiredFlag: true }, include: { assignments: { where: { status: { in: [...LIVE] }, start: { lte: today }, plannedEnd: { gte: today } }, select: { id: true } } } } },
    });
    return {
      bases: bases.map(b => {
        const ppl = people.filter(p => p.baseId === b.id);
        const st: Record<string, number> = {};
        for (const p of ppl) { const s = days.get(p.id)?.[0]?.status ?? 'STANDBY'; st[s] = (st[s] ?? 0) + 1; }
        return { id: b.id, code: b.code, name: b.name, lat: b.lat, lng: b.lng, people: ppl.length, standby: st['STANDBY'] ?? 0, onUnit: st['ON_UNIT'] ?? 0, units: units.filter(u => u.homeBaseId === b.id).length };
      }),
      sites: [...new Map(units.flatMap(u => u.deployments.map(d => [d.job.site.id, { id: d.job.site.id, name: d.job.site.name, lat: d.job.site.lat, lng: d.job.site.lng, well: d.job.wellName, rig: d.job.rigName, client: d.job.client }]))).values()],
      units: units.map(u => {
        const status = computeUnitStatus({ manualStatus: u.status, workOrders: u.workOrders, deployments: u.deployments }, today);
        const site = u.deployments[0]?.job.site;
        const filled = u.seats.filter(s => s.assignments.length > 0).length;
        return { code: u.code, type: u.unitType.name, status, base: u.homeBase.code, lat: site?.lat ?? u.homeBase.lat, lng: site?.lng ?? u.homeBase.lng, atSite: !!site, site: site?.name ?? null, crew: `${filled}/${u.seats.length}` };
      }),
    };
  }
}

@Module({ imports: [SettingsModule, InsightsModule, CalendarCoreModule], providers: [AnalyticsService], exports: [AnalyticsService] })
export class AnalyticsCoreModule {}
