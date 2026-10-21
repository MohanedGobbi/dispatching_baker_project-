import {
  BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpException, HttpStatus,
  Inject, Injectable, Module, NotFoundException, Param, Post, Put, Query, Req,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { Require, AuthedRequest } from '../auth/auth.module';
import { can } from '../auth/permissions';
import { SettingsModule, SettingsService } from '../settings/settings';
import { EmployeeInsightsService, InsightsModule } from '../employees/insights';
import { audit, mapDbError, page, parseDate } from '../common/validate';
import { AbsenceModule, AbsenceService } from '../absence/absence.service';
import { NotificationsService } from '../notifications/notifications';
import { Seniority, startOfDay } from '../domain/status';
import { buildCandidate, buildSeatFacts } from './facts';
import {
  backToBackNote, crewViolations, CrewSeat, CrewSummary, personViolations, summarizeCrew, Violation,
} from '../domain/rules';

const DAY = 86_400_000;
const LIVE = ['CONFIRMED', 'ACTIVE'] as const;
const COUNTS = ['CONFIRMED', 'ACTIVE', 'COMPLETED'] as const;
const iso = (d: Date) => d.toISOString().slice(0, 10);

export interface Proposal { employeeId: string; seatId: string; start: Date; end: Date; replacesId?: string | null }
export interface Evaluation {
  violations: (Violation & { employeeId?: string; seatId?: string })[];
  hard: number; soft: number;
  crews: { unitId: string; unitCode: string; before: CrewSummary; after: CrewSummary }[];
}

@Injectable()
export class AssignmentsService {
  constructor(
    @Inject(PrismaService) private prisma: PrismaService,
    @Inject(SettingsService) private settings: SettingsService,
    @Inject(EmployeeInsightsService) private insights: EmployeeInsightsService,
  ) {}

  /**
   * Check a set of proposed placements together (a swap proposes two). `ignoreIds` are assignments being replaced.
   * `assumed` are placements already accepted earlier in the same batch (a plan being published): they count as
   * existing for double-booking and crew rules even though they are not saved yet. `personRulesOnly` skips the
   * crew-level rules, for checking a batch one item at a time where the crew is only complete at the end.
   */
  async evaluate(proposals: Proposal[], ignoreIds: string[] = [], assumed: Proposal[] = [], personRulesOnly = false): Promise<Evaluation> {
    const settings = await this.settings.all();
    const rule = { maxConsecutiveDays: settings['rules.maxConsecutiveDays'] as number };
    const clearanceAfter = settings['rules.clearanceRequiredAfterDays'] as number;
    const now = startOfDay(new Date());

    const employees = await this.prisma.employee.findMany({
      where: { id: { in: proposals.map(p => p.employeeId) } },
      include: {
        qualifications: { include: { qualification: true } }, certifications: true, rotationPattern: true,
        restrictions: true,
      },
    });
    const seats = await this.prisma.seat.findMany({
      where: { id: { in: proposals.map(p => p.seatId) } },
      include: { position: { include: { requiredQualifications: true, requiredCertTypes: true } }, unit: true },
    });
    const seniority = await this.insights.enrich(employees.map(e => ({ ...e })), now);
    const out: Evaluation = { violations: [], hard: 0, soft: 0, crews: [] };

    for (const p of proposals) {
      const e = employees.find(x => x.id === p.employeeId);
      const s = seats.find(x => x.id === p.seatId);
      if (!e) throw new BadRequestException('Employee does not exist');
      if (!e.active) throw new BadRequestException('Employee is archived');
      if (!s) throw new BadRequestException('Seat does not exist');
      const range = { start: p.start, end: p.end };

      const [leaves, mine] = await Promise.all([
        this.prisma.leave.findMany({
          where: { employeeId: e.id, status: { in: ['APPROVED', 'ACTIVE', 'COMPLETED', 'RECORDED'] } },
          include: { type: true, fitForDuty: true },
        }),
        this.prisma.assignment.findMany({
          where: { employeeId: e.id, status: { in: [...COUNTS] }, id: { notIn: ignoreIds } },
          select: { seatId: true, start: true, plannedEnd: true, actualEnd: true },
        }),
      ]);
      const facts = buildCandidate(e, seniority.get(e.id)!.seniority, leaves, [
        ...mine.map(a => ({ seatId: a.seatId, start: a.start, end: a.actualEnd ?? a.plannedEnd })),
        // The other proposals in this batch and the assumed ones also occupy the person.
        ...proposals.filter(o => o !== p && o.employeeId === e.id).map(o => ({ seatId: o.seatId, start: o.start, end: o.end })),
        ...assumed.filter(o => o.employeeId === e.id).map(o => ({ seatId: o.seatId, start: o.start, end: o.end })),
      ], clearanceAfter);
      const seatFacts = buildSeatFacts(s);
      const tag = (v: Violation) => ({ ...v, employeeId: e.id, seatId: s.id });
      out.violations.push(...personViolations(facts, seatFacts, range, rule).map(tag));

      if (p.replacesId) {
        const outgoing = await this.prisma.assignment.findUnique({ where: { id: p.replacesId }, include: { employee: true } });
        const note = outgoing ? backToBackNote(e.id, outgoing.employee.backToBackId) : null;
        if (note) out.violations.push(tag(note));
      }
    }

    // Crew-level rules per unit, with all proposals applied together.
    const unitIds = personRulesOnly ? [] : [...new Set(seats.filter(s => s.unitId).map(s => s.unitId!))];
    for (const unitId of unitIds) {
      const unitSeats = await this.prisma.seat.findMany({
        where: { unitId, holderType: 'UNIT' }, include: { position: true, unit: true },
        // assignments overlapping any proposal on this unit
      });
      const rel = proposals.filter(p => seats.find(s => s.id === p.seatId)?.unitId === unitId);
      const winStart = new Date(Math.min(...rel.map(p => p.start.getTime())));
      const winEnd = new Date(Math.max(...rel.map(p => p.end.getTime())));
      // `current` is the real crew today (baseline); `existing` drops the assignments this change replaces.
      type Row = { id: string; seatId: string; employeeId: string; start: Date; plannedEnd: Date; actualEnd: Date | null };
      const saved: Row[] = await this.prisma.assignment.findMany({
        where: { seatId: { in: unitSeats.map(s => s.id) }, status: { in: [...LIVE] }, start: { lte: winEnd }, plannedEnd: { gte: winStart } },
      });
      const seatIdSet = new Set(unitSeats.map(s => s.id));
      const current: Row[] = [
        ...saved,
        ...assumed.filter(a => seatIdSet.has(a.seatId) && a.start <= winEnd && a.end >= winStart)
          .map((a, i) => ({ id: `assumed-${i}`, seatId: a.seatId, employeeId: a.employeeId, start: a.start, plannedEnd: a.end, actualEnd: null })),
      ];
      const existing = current.filter(a => !ignoreIds.includes(a.id));
      const people = new Set([...current.map(a => a.employeeId), ...proposals.map(p => p.employeeId)]);
      const sen = await this.seniorityOf([...people], seniority, now);

      // Dates worth checking: the window start and every change inside it (capped).
      const dates = new Set<number>([startOfDay(winStart).getTime()]);
      for (const a of [...current.map(x => ({ start: x.start, end: x.actualEnd ?? x.plannedEnd })), ...rel]) {
        for (const t of [startOfDay(a.start).getTime(), startOfDay(a.end).getTime() + DAY]) {
          if (t >= startOfDay(winStart).getTime() && t <= winEnd.getTime()) dates.add(t);
        }
      }
      const checkDates = [...dates].sort().slice(0, 16).map(t => new Date(t));

      const crewAt = (date: Date, mode: 'before' | 'after'): CrewSeat[] => unitSeats.map(s => {
        const cover = (r: { start: Date; end: Date }) => r.start <= date && date <= r.end;
        const prop = mode === 'after' ? rel.find(p => p.seatId === s.id && cover(p)) : undefined;
        const pool = mode === 'after' ? existing : current;
        const ex = pool.find(a => a.seatId === s.id && cover({ start: a.start, end: a.actualEnd ?? a.plannedEnd }));
        const holderId = prop?.employeeId ?? ex?.employeeId;
        return { seatId: s.id, positionName: s.position.name, required: s.requiredFlag, holder: holderId ? { id: holderId, seniority: sen.get(holderId) ?? 'JUNIOR' } : null };
      });

      const minExp = settings['rules.minExperiencedPerCrew'] as number, chiefReq = settings['rules.chiefRequired'] as boolean;
      const seen = new Set<string>();
      for (const date of checkDates) {
        // A problem the crew already had before this change must not block it; it is shown as a warning.
        const beforeRules = new Set(crewViolations(crewAt(date, 'before'), date, minExp, chiefReq).map(v => v.rule));
        for (const v of crewViolations(crewAt(date, 'after'), date, minExp, chiefReq)) {
          if (seen.has(v.rule)) continue;
          seen.add(v.rule);
          const already = v.severity === 'hard' && beforeRules.has(v.rule);
          out.violations.push({
            ...v, seatId: rel[0].seatId,
            ...(already ? { severity: 'soft' as const, message: `${v.message} (already the case before this change)` } : {}),
          });
        }
      }
      out.crews.push({
        unitId, unitCode: unitSeats[0].unit?.code ?? '', before: summarizeCrew(crewAt(checkDates[0], 'before')), after: summarizeCrew(crewAt(checkDates[0], 'after')),
      });
    }
    out.hard = out.violations.filter(v => v.severity === 'hard').length;
    out.soft = out.violations.length - out.hard;
    return out;
  }

  private async seniorityOf(ids: string[], knownMap: Map<string, { seniority: Seniority }>, now: Date) {
    const map = new Map<string, Seniority>();
    for (const [id, v] of knownMap) map.set(id, v.seniority);
    const missing = ids.filter(i => !map.has(i));
    if (missing.length) {
      const rows = await this.prisma.employee.findMany({ where: { id: { in: missing } }, include: { rotationPattern: true } });
      for (const [id, v] of await this.insights.enrich(rows, now)) map.set(id, v.seniority);
    }
    return map;
  }

  /** The seat may hold one person at a time. This is a data-integrity error, not an overridable rule. */
  async assertSeatFree(seatId: string, start: Date, end: Date, ignoreIds: string[]) {
    const clash = await this.prisma.assignment.findFirst({
      where: { seatId, status: { in: [...COUNTS] }, id: { notIn: ignoreIds }, start: { lte: end }, plannedEnd: { gte: start } },
      include: { employee: { select: { firstName: true, lastName: true } } },
    });
    if (clash) {
      throw new ConflictException(`Seat already held by ${clash.employee.firstName} ${clash.employee.lastName} (${iso(clash.start)} to ${iso(clash.plannedEnd)})`);
    }
  }

  /**
   * Hard violations block unless the caller gives a reason. The reason and what it overrode are logged.
   * With `rules.overrideReasonRequired` off they are warnings only: everything saves except a double booking
   * (one person on two seats at once), which still needs a reason.
   */
  async requireOverride(ev: Evaluation, reason?: string) {
    const strict = (await this.settings.all())['rules.overrideReasonRequired'] !== false;
    const blocking = strict ? ev.hard : ev.violations.filter(v => v.severity === 'hard' && v.rule === 'double_booking').length;
    if (blocking > 0 && !reason?.trim()) {
      throw new HttpException({
        statusCode: 422, error: 'Rule violation', message: 'Hard rules are broken; pass overrideReason to proceed',
        violations: ev.violations, crews: ev.crews,
      }, HttpStatus.UNPROCESSABLE_ENTITY);
    }
  }
}

/** End an assignment from `from` (cancel it if it has not started) and open a replacement task for a required seat. */
async function releaseAssignment(
  tx: Prisma.TransactionClient, a: { id: string; seatId: string; start: Date; plannedEnd: Date; seat: { requiredFlag: boolean } }, from: Date, today: Date,
) {
  const cancelled = from <= startOfDay(a.start);
  const upd = cancelled
    ? await tx.assignment.update({ where: { id: a.id }, data: { status: 'CANCELLED' } })
    : await tx.assignment.update({ where: { id: a.id }, data: { plannedEnd: new Date(from.getTime() - DAY) } });
  const gapFrom = cancelled ? startOfDay(a.start) : from;
  let task = null;
  if (a.seat.requiredFlag) {
    const daysAway = Math.round((gapFrom.getTime() - today.getTime()) / DAY);
    task = await tx.replacementTask.create({
      data: { seatId: a.seatId, fromDate: gapFrom, toDate: a.plannedEnd, trigger: 'unassigned', urgency: daysAway <= 0 ? 'CRITICAL' : daysAway <= 7 ? 'HIGH' : 'NORMAL', deadline: gapFrom },
    });
  }
  return { upd, task };
}

/** Base Managers may only touch base posts at their own base (plan section 3). Everyone else with edit access is unscoped. */
export async function assertSeatScope(prisma: PrismaService, req: AuthedRequest, seatIds: string[]) {
  const roles = req.user?.roles ?? [];
  if (roles.some(r => can([r.role], 'assignments', 'full'))) return;
  const scoped = roles.filter(r => r.role === 'BASE_MANAGER');
  if (!scoped.length) throw new ForbiddenException('No permission to change assignments');
  const seats = await prisma.seat.findMany({ where: { id: { in: seatIds } }, include: { base: true } });
  const ok = seats.every(s => s.holderType === 'BASE' && scoped.some(r => r.baseScope && (r.baseScope === s.baseId || r.baseScope === s.base?.code)));
  if (!ok) throw new ForbiddenException('Base managers can only change base posts at their own base');
}

function parseRange(body: { start?: string; end?: string }, fallbackStart?: Date, fallbackEnd?: Date) {
  const start = body.start ? parseDate(body.start) : fallbackStart;
  const end = body.end ? parseDate(body.end) : fallbackEnd;
  if (!start || !end) throw new BadRequestException('start and end are required');
  if (end < start) throw new BadRequestException('end must not be before start');
  return { start: startOfDay(start), end: startOfDay(end) };
}

@Controller()
class AssignmentsController {
  constructor(
    @Inject(PrismaService) private prisma: PrismaService,
    @Inject(AssignmentsService) private svc: AssignmentsService,
    @Inject(AbsenceService) private absence: AbsenceService,
    @Inject(NotificationsService) private notifier: NotificationsService,
  ) {}

  /** Tell the person their assignment changed; they must acknowledge (plan 19). The person who made the change is not told. */
  private async tell(employeeId: string, seatId: string, from: Date, to: Date, action: 'assigned' | 'moved' | 'released' | 'swapped', actor?: string) {
    await this.notifier.notify({
      type: 'assignment_changed', to: [{ employeeId }], except: actor,
      payload: { seat: await this.notifier.seatLabel(seatId), from: iso(from), to: iso(to), action },
    });
  }

  private assertScope(req: AuthedRequest, seatIds: string[]) { return assertSeatScope(this.prisma, req, seatIds); }

  private async load(id: string) {
    const a = await this.prisma.assignment.findUnique({ where: { id }, include: { seat: true } });
    if (!a) throw new NotFoundException('Assignment not found');
    return a;
  }

  @Get('assignments') @Require('assignments', 'view')
  async list(@Req() req: AuthedRequest, @Query() q: { employeeId?: string; seatId?: string; unitId?: string; baseId?: string; status?: string; from?: string; to?: string; limit?: string; offset?: string }) {
    const where: Record<string, unknown> = {};
    // An employee only ever sees their own assignments (plan section 3: "Own"); an account with no employee sees none.
    if ((req.user?.roles ?? []).every(r => r.role === 'EMPLOYEE')) {
      if (!req.user?.employeeId) return { total: 0, items: [] };
      q = { ...q, employeeId: req.user.employeeId, seatId: undefined, unitId: undefined, baseId: undefined };
    }
    if (q.employeeId) where.employeeId = q.employeeId;
    if (q.seatId) where.seatId = q.seatId;
    if (q.status) where.status = q.status;
    if (q.unitId) where.seat = { unitId: q.unitId };
    if (q.baseId) where.seat = { OR: [{ baseId: q.baseId }, { unit: { homeBaseId: q.baseId } }] };
    if (q.from) where.plannedEnd = { gte: parseDate(q.from) };
    if (q.to) where.start = { lte: parseDate(q.to) };
    const { take, skip } = page(q);
    const [total, items] = await Promise.all([
      this.prisma.assignment.count({ where: where as never }),
      this.prisma.assignment.findMany({
        where: where as never, orderBy: { start: 'asc' }, take, skip,
        include: {
          employee: { select: { id: true, firstName: true, lastName: true, employeeNo: true } },
          seat: { include: { position: { select: { name: true } }, unit: { select: { code: true } }, base: { select: { code: true } } } },
        },
      }),
    ]);
    return { total, items };
  }

  /** Seats of a unit or base with who holds each on a date. */
  @Get('seats') @Require('assignments', 'view')
  async seats(@Req() req: AuthedRequest, @Query() q: { unitId?: string; baseId?: string; date?: string }) {
    if ((req.user?.roles ?? []).every(r => r.role === 'EMPLOYEE')) throw new ForbiddenException('Employees see their own crew in the portal');
    if (!q.unitId && !q.baseId) throw new BadRequestException('unitId or baseId is required');
    const date = parseDate(q.date);
    const seats = await this.prisma.seat.findMany({
      where: q.unitId ? { unitId: q.unitId } : { baseId: q.baseId, holderType: 'BASE' },
      orderBy: [{ positionId: 'asc' }, { index: 'asc' }],
      include: {
        position: { select: { name: true } },
        assignments: {
          where: { status: { in: [...LIVE] }, start: { lte: date }, plannedEnd: { gte: date } },
          include: { employee: { select: { id: true, firstName: true, lastName: true, employeeNo: true } } },
        },
      },
    });
    return seats.map(s => ({
      id: s.id, position: s.position.name, index: s.index, required: s.requiredFlag, requirements: s.requirements,
      holder: s.assignments[0] ? { ...s.assignments[0].employee, assignmentId: s.assignments[0].id, until: s.assignments[0].plannedEnd } : null,
    }));
  }

  /** Impact preview (10): what would break if this person took this seat? Writes nothing. */
  @Post('assignments/preview') @Require('assignments', 'view')
  async preview(@Body() body: { employeeId?: string; seatId?: string; start?: string; end?: string; replacesId?: string; ignoreAssignmentId?: string }) {
    if (!body?.employeeId || !body?.seatId) throw new BadRequestException('employeeId and seatId are required');
    const r = parseRange(body);
    const ignore = [body.ignoreAssignmentId, body.replacesId].filter(Boolean) as string[];
    const ev = await this.svc.evaluate([{ employeeId: body.employeeId, seatId: body.seatId, ...r, replacesId: body.replacesId }], ignore);
    let seatTaken: string | null = null;
    try { await this.svc.assertSeatFree(body.seatId, r.start, r.end, ignore); } catch (e) { seatTaken = (e as Error).message; }
    // If someone else takes the seat later inside the range, the seat is only free until the day before.
    const later = await this.prisma.assignment.findFirst({
      where: { seatId: body.seatId, status: { in: [...COUNTS] }, id: { notIn: ignore }, start: { gt: r.start, lte: r.end } }, orderBy: { start: 'asc' },
    });
    const freeUntil = later ? iso(new Date(startOfDay(later.start).getTime() - DAY)) : null;
    return { ...ev, seatTaken, freeUntil, needsOverride: ev.hard > 0, allowed: !seatTaken };
  }

  @Post('assignments') @Require('assignments', 'edit')
  async create(
    @Body() body: { employeeId?: string; seatId?: string; start?: string; end?: string; type?: string; replacesId?: string; overrideReason?: string },
    @Req() req: AuthedRequest,
  ) {
    if (!body?.employeeId || !body?.seatId) throw new BadRequestException('employeeId and seatId are required');
    await this.assertScope(req, [body.seatId]);
    const r = parseRange(body);
    const type = body.type ?? 'NORMAL';
    if (!['NORMAL', 'REPLACEMENT', 'EXTENSION_COVER', 'TEMPORARY_COVER'].includes(type)) throw new BadRequestException('Invalid assignment type');
    const ignore = body.replacesId ? [body.replacesId] : [];
    await this.svc.assertSeatFree(body.seatId, r.start, r.end, ignore);
    const ev = await this.svc.evaluate([{ employeeId: body.employeeId, seatId: body.seatId, ...r, replacesId: body.replacesId }], ignore);
    await this.svc.requireOverride(ev, body.overrideReason);

    const a = await this.prisma.assignment.create({
      data: {
        employeeId: body.employeeId, seatId: body.seatId, start: r.start, plannedEnd: r.end, type: type as never,
        status: r.start <= startOfDay(new Date()) ? 'ACTIVE' : 'CONFIRMED', replacesId: body.replacesId,
      },
    }).catch(e => { throw mapDbError(e, 'Assignment'); });
    // Filling days that an open replacement task was waiting for finishes (or shrinks) that task.
    await this.absence.coverTasks(this.prisma, a.seatId, { start: r.start, end: r.end }, a.employeeId, a.id);
    await audit(this.prisma, req.user?.sub, 'Assignment', a.id, 'assign', null, { ...a, overridden: ev.violations.filter(v => v.severity === 'hard') }, body.overrideReason);
    await this.tell(a.employeeId, a.seatId, a.start, a.plannedEnd, 'assigned', req.user?.sub);
    return { assignment: a, violations: ev.violations, crews: ev.crews };
  }

  @Put('assignments/:id/move') @Require('assignments', 'edit')
  async move(
    @Param('id') id: string,
    @Body() body: { seatId?: string; start?: string; end?: string; overrideReason?: string },
    @Req() req: AuthedRequest,
  ) {
    const a = await this.load(id);
    if (!['CONFIRMED', 'ACTIVE', 'DRAFT'].includes(a.status)) throw new BadRequestException(`A ${a.status.toLowerCase()} assignment cannot be moved`);
    const seatId = body.seatId ?? a.seatId;
    await this.assertScope(req, [a.seatId, seatId]);
    const r = parseRange(body, a.start, a.plannedEnd);
    const today = startOfDay(new Date());
    if ((seatId !== a.seatId || r.start.getTime() !== startOfDay(a.start).getTime()) && a.start <= today) {
      throw new BadRequestException('This assignment has already started; use split to hand over, or change only the end date');
    }
    await this.svc.assertSeatFree(seatId, r.start, r.end, [id]);
    const ev = await this.svc.evaluate([{ employeeId: a.employeeId, seatId, ...r }], [id]);
    await this.svc.requireOverride(ev, body.overrideReason);
    const after = await this.prisma.assignment.update({ where: { id }, data: { seatId, start: r.start, plannedEnd: r.end } });
    await audit(this.prisma, req.user?.sub, 'Assignment', id, 'move', a, after, body.overrideReason);
    return { assignment: after, violations: ev.violations, crews: ev.crews };
  }

  /** End an assignment from a date. The vacated days of a required seat become a replacement task. */
  @Post('assignments/:id/unassign') @Require('assignments', 'edit')
  async unassign(@Param('id') id: string, @Body() body: { from?: string; reason?: string }, @Req() req: AuthedRequest) {
    const a = await this.load(id);
    await this.assertScope(req, [a.seatId]);
    if (!['CONFIRMED', 'ACTIVE', 'DRAFT'].includes(a.status)) throw new BadRequestException(`A ${a.status.toLowerCase()} assignment cannot be unassigned`);
    const today = startOfDay(new Date());
    const from = startOfDay(body?.from ? parseDate(body.from) : today);
    if (from > a.plannedEnd) throw new BadRequestException('from is after the assignment end; nothing to remove');

    const cancelled = from <= startOfDay(a.start);
    const result = await this.prisma.$transaction(tx => releaseAssignment(tx, a, from, today));
    await audit(this.prisma, req.user?.sub, 'Assignment', id, 'unassign', a, result.upd, body?.reason);
    await this.tell(a.employeeId, a.seatId, cancelled ? a.start : from, a.plannedEnd, 'released', req.user?.sub);
    return { assignment: result.upd, gap: { seatId: a.seatId, from: iso(cancelled ? a.start : from), to: iso(a.plannedEnd) }, replacementTask: result.task };
  }

  /**
   * Put someone else in a person's seat from a date, in one step: the holder leaves the seat the day before and the
   * new person holds it until the holder's planned end, or nothing changes. No replacement task is opened, since
   * the seat never stands empty. `reason` (optional) is kept in the audit log.
   */
  @Post('assignments/:id/replace') @Require('assignments', 'edit')
  async replace(
    @Param('id') id: string,
    @Body() body: { employeeId?: string; from?: string; reason?: string; overrideReason?: string },
    @Req() req: AuthedRequest,
  ) {
    const a = await this.load(id);
    if (!body?.employeeId) throw new BadRequestException('employeeId is required');
    if (body.employeeId === a.employeeId) throw new BadRequestException('That person already holds this seat');
    await this.assertScope(req, [a.seatId]);
    if (!['CONFIRMED', 'ACTIVE'].includes(a.status)) throw new BadRequestException(`A ${a.status.toLowerCase()} assignment cannot be replaced`);
    const today = startOfDay(new Date());
    const asked = startOfDay(body.from ? parseDate(body.from) : today);
    // Replacing before the stretch starts hands over the whole stretch.
    const start = asked < startOfDay(a.start) ? startOfDay(a.start) : asked;
    const end = startOfDay(a.plannedEnd);
    if (start > end) throw new BadRequestException('The person is no longer on this seat on that date');
    await this.svc.assertSeatFree(a.seatId, start, end, [id]);
    const ev = await this.svc.evaluate([{ employeeId: body.employeeId, seatId: a.seatId, start, end, replacesId: id }], [id]);
    await this.svc.requireOverride(ev, body.overrideReason);

    const out = await this.prisma.$transaction(async tx => {
      const old = start <= startOfDay(a.start)
        ? await tx.assignment.update({ where: { id }, data: { status: 'CANCELLED' } })
        : await tx.assignment.update({ where: { id }, data: { plannedEnd: new Date(start.getTime() - DAY) } });
      const created = await tx.assignment.create({
        data: {
          employeeId: body.employeeId!, seatId: a.seatId, start, plannedEnd: end, type: 'REPLACEMENT', replacesId: id,
          status: start <= today ? 'ACTIVE' : 'CONFIRMED', overrideReason: ev.hard > 0 ? body.overrideReason?.trim() : undefined,
        },
      }).catch(e => { throw mapDbError(e, 'Assignment'); });
      await this.absence.coverTasks(tx, a.seatId, { start, end }, created.employeeId, created.id);
      return { old, created };
    });
    const why = [body.reason?.trim(), ev.hard > 0 && body.overrideReason?.trim() ? `override: ${body.overrideReason.trim()}` : ''].filter(Boolean).join(' · ') || undefined;
    await audit(this.prisma, req.user?.sub, 'Assignment', id, 'replace', a, { by: body.employeeId, from: iso(start), assignment: out.created.id, previous: out.old }, why);
    await this.tell(a.employeeId, a.seatId, start, end, 'released', req.user?.sub);
    await this.tell(body.employeeId, a.seatId, start, end, 'assigned', req.user?.sub);
    return { assignment: out.created, released: out.old, violations: ev.violations, crews: ev.crews };
  }

  /**
   * Move a person to a different seat in one step: the old assignment ends and the new one starts together, or
   * nothing changes. (Two separate calls could leave the person released from the old seat but not placed.)
   */
  @Post('assignments/:id/transfer') @Require('assignments', 'edit')
  async transfer(
    @Param('id') id: string,
    @Body() body: { seatId?: string; start?: string; end?: string; overrideReason?: string },
    @Req() req: AuthedRequest,
  ) {
    const a = await this.load(id);
    if (!body?.seatId) throw new BadRequestException('seatId is required');
    if (body.seatId === a.seatId) throw new BadRequestException('That is the seat the person is already on');
    await this.assertScope(req, [a.seatId, body.seatId]);
    if (!['CONFIRMED', 'ACTIVE'].includes(a.status)) throw new BadRequestException(`A ${a.status.toLowerCase()} assignment cannot be moved`);
    const r = parseRange(body);
    if (r.start > startOfDay(a.plannedEnd)) throw new BadRequestException('The person is no longer on the old seat on that date');
    await this.svc.assertSeatFree(body.seatId, r.start, r.end, []);
    // The old assignment no longer blocks the person from the move date on, so it is ignored for the double-booking check.
    const ev = await this.svc.evaluate([{ employeeId: a.employeeId, seatId: body.seatId, ...r }], [id]);
    await this.svc.requireOverride(ev, body.overrideReason);

    const today = startOfDay(new Date());
    const out = await this.prisma.$transaction(async tx => {
      const released = await releaseAssignment(tx, a, r.start, today);
      const created = await tx.assignment.create({
        data: { employeeId: a.employeeId, seatId: body.seatId!, start: r.start, plannedEnd: r.end, type: 'NORMAL', status: r.start <= today ? 'ACTIVE' : 'CONFIRMED', overrideReason: ev.hard > 0 ? body.overrideReason?.trim() : undefined },
      });
      await this.absence.coverTasks(tx, created.seatId, { start: r.start, end: r.end }, created.employeeId, created.id);
      return { released, created };
    });
    await audit(this.prisma, req.user?.sub, 'Assignment', id, 'transfer', a, { to: body.seatId, assignment: out.created.id }, body.overrideReason);
    await this.tell(a.employeeId, body.seatId, r.start, r.end, 'moved', req.user?.sub);
    return { assignment: out.created, released: out.released.upd, replacementTask: out.released.task, violations: ev.violations, crews: ev.crews };
  }

  /** Swap two people between their two assignments. Both new placements are checked together. */
  @Post('assignments/swap') @Require('assignments', 'edit')
  async swap(@Body() body: { firstId?: string; secondId?: string; overrideReason?: string }, @Req() req: AuthedRequest) {
    if (!body?.firstId || !body?.secondId || body.firstId === body.secondId) throw new BadRequestException('firstId and secondId must be two different assignments');
    const [a, b] = await Promise.all([this.load(body.firstId), this.load(body.secondId)]);
    for (const x of [a, b]) if (!['CONFIRMED', 'ACTIVE'].includes(x.status)) throw new BadRequestException('Only confirmed or active assignments can be swapped');
    if (a.employeeId === b.employeeId) throw new BadRequestException('Both assignments belong to the same person');
    await this.assertScope(req, [a.seatId, b.seatId]);
    const ev = await this.svc.evaluate([
      { employeeId: b.employeeId, seatId: a.seatId, start: a.start, end: a.plannedEnd, replacesId: a.id },
      { employeeId: a.employeeId, seatId: b.seatId, start: b.start, end: b.plannedEnd, replacesId: b.id },
    ], [a.id, b.id]);
    await this.svc.requireOverride(ev, body.overrideReason);
    await this.prisma.$transaction([
      this.prisma.assignment.update({ where: { id: a.id }, data: { employeeId: b.employeeId } }),
      this.prisma.assignment.update({ where: { id: b.id }, data: { employeeId: a.employeeId } }),
    ]);
    await audit(this.prisma, req.user?.sub, 'Assignment', `${a.id},${b.id}`, 'swap', { a: a.employeeId, b: b.employeeId }, { a: b.employeeId, b: a.employeeId }, body.overrideReason);
    // After the swap each person holds the other's seat.
    await this.tell(b.employeeId, a.seatId, a.start, a.plannedEnd, 'swapped', req.user?.sub);
    await this.tell(a.employeeId, b.seatId, b.start, b.plannedEnd, 'swapped', req.user?.sub);
    return { swapped: [a.id, b.id], violations: ev.violations, crews: ev.crews };
  }

  /**
   * Split at a date (someone leaves mid-rotation). The first part keeps the person; the tail goes to
   * `employeeId` as a replacement, or becomes a replacement task when nobody is given.
   */
  @Post('assignments/:id/split') @Require('assignments', 'edit')
  async split(@Param('id') id: string, @Body() body: { at?: string; employeeId?: string; overrideReason?: string }, @Req() req: AuthedRequest) {
    const a = await this.load(id);
    await this.assertScope(req, [a.seatId]);
    if (!body?.at) throw new BadRequestException('at is required');
    const at = startOfDay(parseDate(body.at));
    if (!['CONFIRMED', 'ACTIVE'].includes(a.status)) throw new BadRequestException('Only confirmed or active assignments can be split');
    if (at <= startOfDay(a.start) || at > a.plannedEnd) throw new BadRequestException('at must fall after the start and not after the end');
    const tailEnd = a.plannedEnd;
    const today = startOfDay(new Date());

    let ev: Evaluation | null = null;
    if (body.employeeId) {
      await this.svc.assertSeatFree(a.seatId, at, tailEnd, [id]);
      ev = await this.svc.evaluate([{ employeeId: body.employeeId, seatId: a.seatId, start: at, end: tailEnd, replacesId: id }], [id]);
      await this.svc.requireOverride(ev, body.overrideReason);
    }
    const result = await this.prisma.$transaction(async tx => {
      const head = await tx.assignment.update({ where: { id }, data: { plannedEnd: new Date(at.getTime() - DAY) } });
      if (body.employeeId) {
        const tail = await tx.assignment.create({
          data: { employeeId: body.employeeId, seatId: a.seatId, start: at, plannedEnd: tailEnd, type: 'REPLACEMENT', replacesId: id, status: at <= today ? 'ACTIVE' : 'CONFIRMED' },
        });
        await this.absence.coverTasks(tx, a.seatId, { start: at, end: tailEnd }, body.employeeId, tail.id);
        return { head, tail, task: null };
      }
      const daysAway = Math.round((at.getTime() - today.getTime()) / DAY);
      const task = a.seat.requiredFlag ? await tx.replacementTask.create({
        data: { seatId: a.seatId, fromDate: at, toDate: tailEnd, trigger: 'split', urgency: daysAway <= 0 ? 'CRITICAL' : daysAway <= 7 ? 'HIGH' : 'NORMAL', deadline: at },
      }) : null;
      return { head, tail: null, task };
    });
    await audit(this.prisma, req.user?.sub, 'Assignment', id, 'split', a, result, body.overrideReason);
    if (result.tail) await this.tell(result.tail.employeeId, a.seatId, result.tail.start, result.tail.plannedEnd, 'assigned', req.user?.sub);
    return { ...result, violations: ev?.violations ?? [], crews: ev?.crews ?? [] };
  }
}

@Module({ imports: [SettingsModule, InsightsModule, AbsenceModule], controllers: [AssignmentsController], providers: [AssignmentsService], exports: [AssignmentsService] })
export class AssignmentsModule {}
