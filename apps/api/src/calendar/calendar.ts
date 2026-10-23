import {
  BadRequestException, Controller, ForbiddenException, Get, Inject, Module, NotFoundException, Param, Query, Req,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Require, AuthedRequest } from '../auth/auth.module';
import { can } from '../auth/permissions';
import { SettingsModule, SettingsService } from '../settings/settings';
import { parseDate } from '../common/validate';
import { startOfDay } from '../domain/status';
import { addDays, CalendarCoreModule, CalendarService, DayCell, iso, toBlocks, Viewer } from './calendar.service';

const DAY = 86_400_000;
const LIVE = ['CONFIRMED', 'ACTIVE'] as const;
const rolesOf = (req: AuthedRequest) => (req.user?.roles ?? []).map(r => r.role);
const employeeOnly = (roles: string[]) => roles.length > 0 && roles.every(r => r === 'EMPLOYEE');

/** Staff with medical access (HR, Ops, Admin) and the person themself may see why someone is unavailable. */
export function viewerFor(req: AuthedRequest): Viewer {
  const staff = can(rolesOf(req).filter(r => r !== 'EMPLOYEE'), 'medical', 'view');
  return { canSeeMedical: id => staff || req.user?.employeeId === id };
}

function range(q: { from?: string; to?: string }, defaultDays: number, maxDays: number) {
  const from = startOfDay(q.from ? parseDate(q.from) : new Date());
  const to = startOfDay(q.to ? parseDate(q.to) : addDays(from, defaultDays - 1));
  if (to < from) throw new BadRequestException('to must not be before from');
  if (Math.round((to.getTime() - from.getTime()) / DAY) + 1 > maxDays) throw new BadRequestException(`At most ${maxDays} days at a time`);
  return { from, to };
}

@Controller('calendar')
class CalendarController {
  constructor(
    @Inject(PrismaService) private prisma: PrismaService,
    @Inject(CalendarService) private cal: CalendarService,
    @Inject(SettingsService) private settings: SettingsService,
  ) {}

  /** Personal calendar (11.3): every day of the range with its status, plus what the person asks first. */
  @Get('employees/:id') @Require('assignments', 'view')
  async personal(@Param('id') id: string, @Req() req: AuthedRequest, @Query() q: { from?: string; to?: string; month?: string }) {
    if (employeeOnly(rolesOf(req)) && req.user?.employeeId !== id) throw new ForbiddenException('Employees can only see their own calendar');
    let r: { from: Date; to: Date };
    if (q.month) {
      const m = /^(\d{4})-(\d{2})$/.exec(q.month);
      if (!m) throw new BadRequestException('month must look like 2026-10');
      r = { from: new Date(Date.UTC(+m[1], +m[2] - 1, 1)), to: new Date(Date.UTC(+m[1], +m[2], 0)) };
    } else r = range(q, 31, 190);
    const emp = await this.prisma.employee.findUnique({ where: { id }, select: { id: true, firstName: true, lastName: true, employeeNo: true, homeBase: { select: { code: true } } } });
    if (!emp) throw new NotFoundException('Employee not found');

    const viewer = viewerFor(req);
    const days = (await this.cal.buildDays([id], r.from, r.to, viewer)).get(id) ?? [];

    // "Today", the next crew change and the next days off, looked up over the next ~6 months.
    const today = startOfDay(new Date());
    const ahead = (await this.cal.buildDays([id], today, addDays(today, 180), viewer)).get(id) ?? [];
    const working = new Set(['ON_UNIT', 'EXTENDED', 'ON_BASE_POST', 'STANDBY']);
    const nextOff = ahead.find(c => c.status === 'DAYS_OFF');
    const nextOn = ahead.find((c, i) => i > 0 && working.has(c.status) && !working.has(ahead[i - 1].status));
    const nextSeat = ahead.find((c, i) => c.seatId && (i === 0 || ahead[i - 1].seatId !== c.seatId));
    return {
      employee: emp, from: iso(r.from), to: iso(r.to), days, blocks: toBlocks(days),
      summary: { today: ahead[0] ?? null, nextDaysOff: nextOff?.date ?? null, nextBackOn: nextOn?.date ?? null, nextSeatChange: nextSeat && nextSeat.date !== iso(today) ? { date: nextSeat.date, label: nextSeat.label } : null },
    };
  }

  /** Team timeline / Gantt (11.3): rows are people, blocks are status stretches. */
  @Get('timeline') @Require('assignments', 'view')
  async timeline(
    @Req() req: AuthedRequest,
    @Query() q: { from?: string; to?: string; baseId?: string; positionId?: string; unitId?: string; q?: string; groupBy?: string; status?: string },
  ) {
    if (employeeOnly(rolesOf(req))) throw new ForbiddenException('Not available to employees');
    const { from, to } = range(q, 28, 120);
    const groupBy = q.groupBy ?? 'base';
    if (!['base', 'position', 'unit'].includes(groupBy)) throw new BadRequestException('groupBy must be base, position or unit');

    const where: Record<string, unknown> = { active: true, position: { category: { in: ['FIELD_CREW', 'BASE_STAFF'] } } };
    if (q.baseId) where.homeBaseId = q.baseId;
    if (q.positionId) where.positionId = q.positionId;
    if (q.q) where.OR = ['firstName', 'lastName', 'employeeNo'].map(f => ({ [f]: { contains: q.q } }));
    if (q.unitId) where.assignments = { some: { seat: { unitId: q.unitId }, status: { in: ['CONFIRMED', 'ACTIVE', 'COMPLETED'] }, start: { lte: to }, plannedEnd: { gte: from } } };
    const emps = await this.prisma.employee.findMany({
      where: where as never, orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }], take: 300,
      select: { id: true, firstName: true, lastName: true, employeeNo: true, homeBase: { select: { code: true } }, position: { select: { name: true } } },
    });
    const days = await this.cal.buildDays(emps.map(e => e.id), from, to, viewerFor(req));
    const rows = emps.map(e => {
      const cells = days.get(e.id) ?? [];
      return {
        employeeId: e.id, name: `${e.firstName} ${e.lastName}`, employeeNo: e.employeeNo, base: e.homeBase.code, position: e.position.name,
        group: groupBy === 'position' ? e.position.name : groupBy === 'base' ? e.homeBase.code : (cells.find(c => c.label && c.status === 'ON_UNIT')?.label?.split(' · ')[0] ?? 'No unit'),
        blocks: toBlocks(cells),
      };
    }).filter(r => !q.status || r.blocks.some(b => b.status === q.status));
    return { from: iso(from), to: iso(to), groupBy, rows };
  }

  /** Crew-change list (11.3): who leaves which seat, who arrives, and whether that is settled. */
  @Get('crew-changes') @Require('assignments', 'view')
  async crewChanges(@Req() req: AuthedRequest, @Query() q: { days?: string; baseId?: string; from?: string }) {
    if (employeeOnly(rolesOf(req))) throw new ForbiddenException('Not available to employees');
    const horizonDays = [7, 14, 30].includes(parseInt(q.days ?? '', 10)) ? parseInt(q.days!, 10) : 14;
    const today = startOfDay(q.from ? parseDate(q.from) : new Date());
    const horizon = addDays(today, horizonDays);

    const seatWhere = q.baseId ? { OR: [{ baseId: q.baseId }, { unit: { homeBaseId: q.baseId } }] } : {};
    const include = {
      employee: { select: { id: true, firstName: true, lastName: true } },
      seat: { include: { position: { select: { name: true } }, unit: { select: { id: true, code: true, homeBaseId: true } }, base: { select: { code: true } } } },
    } as const;
    const live = await this.prisma.assignment.findMany({
      where: { status: { in: [...LIVE] }, seat: seatWhere, plannedEnd: { gte: addDays(today, -1) }, start: { lte: addDays(horizon, 2) } }, include,
    });
    const drafts = await this.prisma.assignment.findMany({ where: { status: 'DRAFT', seat: seatWhere, start: { gte: today, lte: addDays(horizon, 2) } }, include });
    const deployments = await this.prisma.unitDeployment.findMany({
      where: { end: { gte: today }, start: { lte: addDays(horizon, 30) } }, include: { job: { include: { site: { select: { name: true, travelHours: true } } } } },
    });

    const name = (e: { firstName: string; lastName: string }) => `${e.firstName} ${e.lastName}`;
    const seatLabel = (a: (typeof live)[number]) => `${a.seat.unit?.code ?? `${a.seat.base?.code} base`} · ${a.seat.position.name} #${a.seat.index}`;
    const unitOf = (a: (typeof live)[number]) => ({ unitId: a.seat.unit?.id ?? null, unitCode: a.seat.unit?.code ?? null });
    const stillNeeded = (a: (typeof live)[number], on: Date) => a.seat.unit
      ? a.seat.requiredFlag && deployments.some(d => d.unitId === a.seat.unit!.id && d.start <= on && on <= d.end)
      : a.seat.requiredFlag;
    const travel = (a: (typeof live)[number], on: Date) => {
      const d = deployments.find(x => x.unitId === a.seat.unit?.id && x.start <= addDays(on, 1) && addDays(on, 1) <= x.end) ?? deployments.find(x => x.unitId === a.seat.unit?.id);
      return d ? { site: d.job.site.name, hours: d.job.site.travelHours } : null;
    };

    const out: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    for (const a of live) {
      const changeDate = addDays(a.plannedEnd, 1);
      if (changeDate < today || changeDate > horizon) continue;
      const next = live.find(b => b.id !== a.id && b.seatId === a.seatId && b.start <= changeDate && (b.actualEnd ?? b.plannedEnd) >= changeDate);
      const draft = !next ? drafts.find(b => b.seatId === a.seatId && b.start <= changeDate && b.plannedEnd >= changeDate) : undefined;
      if (!next && !draft && !stillNeeded(a, changeDate)) continue; // nobody is needed there afterwards
      seen.add(a.seatId + iso(changeDate));
      out.push({
        date: iso(changeDate), daysAway: Math.round((changeDate.getTime() - today.getTime()) / DAY), seatId: a.seatId, seat: seatLabel(a), ...unitOf(a),
        outgoing: { id: a.employee.id, name: name(a.employee) },
        incoming: next ? { id: next.employee.id, name: name(next.employee) } : draft ? { id: draft.employee.id, name: name(draft.employee) } : null,
        status: next ? 'confirmed' : draft ? 'suggested' : 'missing', travel: travel(a, changeDate),
      });
    }
    // People arriving on a seat nobody is leaving (first crew of a new job).
    for (const b of live) {
      if (b.start <= today || b.start > horizon || seen.has(b.seatId + iso(b.start))) continue;
      if (live.some(a => a.id !== b.id && a.seatId === b.seatId && addDays(a.plannedEnd, 1).getTime() === startOfDay(b.start).getTime())) continue;
      out.push({
        date: iso(b.start), daysAway: Math.round((startOfDay(b.start).getTime() - today.getTime()) / DAY), seatId: b.seatId, seat: seatLabel(b), ...unitOf(b),
        outgoing: null, incoming: { id: b.employee.id, name: name(b.employee) }, status: 'confirmed', travel: travel(b, addDays(b.start, -1)),
      });
    }
    out.sort((x, y) => String(x.date).localeCompare(String(y.date)) || String(x.seat).localeCompare(String(y.seat)));
    return { from: iso(today), days: horizonDays, changes: out, counts: { confirmed: out.filter(c => c.status === 'confirmed').length, suggested: out.filter(c => c.status === 'suggested').length, missing: out.filter(c => c.status === 'missing').length } };
  }

  /** Base roster (11.3): each post, each day, and how many are present against the minimum. */
  @Get('base-roster') @Require('assignments', 'view')
  async baseRoster(@Req() req: AuthedRequest, @Query() q: { baseId?: string; from?: string; to?: string }) {
    if (employeeOnly(rolesOf(req))) throw new ForbiddenException('Not available to employees');
    if (!q.baseId) throw new BadRequestException('baseId is required');
    const { from, to } = range(q, 14, 62);
    const [base, seats, rules] = await Promise.all([
      this.prisma.base.findUnique({ where: { id: q.baseId }, select: { id: true, code: true, name: true } }),
      this.prisma.seat.findMany({
        where: { holderType: 'BASE', baseId: q.baseId }, orderBy: [{ positionId: 'asc' }, { index: 'asc' }],
        include: { position: { select: { id: true, name: true } }, assignments: { where: { status: { in: ['CONFIRMED', 'ACTIVE', 'COMPLETED'] }, start: { lte: to }, plannedEnd: { gte: from } }, include: { employee: { select: { id: true, firstName: true, lastName: true } } }, orderBy: { start: 'asc' } } },
      }),
      this.prisma.baseStaffingRule.findMany({ where: { baseId: q.baseId }, include: { position: { select: { name: true } } } }),
    ]);
    if (!base) throw new NotFoundException('Base not found');

    const people = [...new Set(seats.flatMap(s => s.assignments.map(a => a.employee.id)))];
    const days = await this.cal.buildDays(people, from, to, viewerFor(req));
    const present = (employeeId: string, date: string) => days.get(employeeId)?.find(c => c.date === date)?.status === 'ON_BASE_POST';

    const dates: string[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) dates.push(iso(d));
    const coverage = dates.map(date => ({
      date,
      positions: rules.map(r => {
        const present_ = new Set(seats.filter(s => s.positionId === r.positionId).flatMap(s => s.assignments.filter(a => a.start <= new Date(date) && new Date(date) <= (a.actualEnd ?? a.plannedEnd) && present(a.employee.id, date)).map(a => a.employee.id))).size;
        return { position: r.position.name, present: present_, min: r.minCount, target: r.targetCount };
      }),
    }));
    return {
      base, from: iso(from), to: iso(to),
      posts: seats.map(s => ({
        seatId: s.id, position: s.position.name, index: s.index, required: s.requiredFlag,
        blocks: s.assignments.map(a => ({ from: iso(a.start), to: iso(a.actualEnd ?? a.plannedEnd), employee: { id: a.employee.id, name: `${a.employee.firstName} ${a.employee.lastName}` } })),
      })),
      coverage,
    };
  }
}

@Module({ imports: [SettingsModule, CalendarCoreModule], controllers: [CalendarController] })
export class CalendarModule {}
