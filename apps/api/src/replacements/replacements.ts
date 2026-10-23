import {
  BadRequestException, Body, Controller, Get, Inject, Module, NotFoundException, Param, Post, Query,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { fitTasksToJobs } from '../absence/absence.service';
import { SettingsModule, SettingsService } from '../settings/settings';
import { AssignmentsModule, AssignmentsService } from '../assignments/assignments';
import { PlanningModule, PlanningService } from '../planning/planning';
import { audit, parseDate } from '../common/validate';
import { subtractSpans } from '../domain/spans';
import { startOfDay } from '../domain/status';

const DAY = 86_400_000;
const OPEN_TASK = ['OPEN', 'ESCALATED', 'CANDIDATE_PROPOSED'];
const URGENCY_RANK: Record<string, number> = { CRITICAL: 0, HIGH: 1, NORMAL: 2 };
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(startOfDay(d).getTime() + n * DAY);

/** Section 16: every event that empties a seat becomes a task here, worked from most urgent down. */
@Controller('replacements')
class ReplacementsController {
  constructor(
    @Inject(PrismaService) private prisma: PrismaService,
    @Inject(SettingsService) private settings: SettingsService,
    @Inject(AssignmentsService) private assignments: AssignmentsService,
    @Inject(PlanningService) private planning: PlanningService,
  ) {}

  /**
   * Tasks whose first uncovered day is close (setting replacements.escalateWithinDays) become escalated. Runs whenever
   * the list is read, so no background job is needed.
   */
  private async escalateDue() {
    const within = (await this.settings.all())['replacements.escalateWithinDays'] as number;
    const due = await this.prisma.replacementTask.findMany({ where: { status: { in: ['OPEN', 'CANDIDATE_PROPOSED'] }, deadline: { lte: addDays(new Date(), within) } }, select: { id: true } });
    if (due.length) await this.prisma.replacementTask.updateMany({ where: { id: { in: due.map(d => d.id) } }, data: { status: 'ESCALATED', escalatedAt: new Date() } });
    return { escalated: due.length, within };
  }

  private async mustLoad(id: string) {
    const t = await this.prisma.replacementTask.findUnique({
      where: { id }, include: { seat: { include: { position: true, unit: { select: { code: true, homeBaseId: true } }, base: { select: { code: true } } } }, candidate: { select: { id: true, firstName: true, lastName: true } } },
    });
    if (!t) throw new NotFoundException('Replacement task not found');
    return t;
  }

  private shape(t: Awaited<ReturnType<ReplacementsController['mustLoad']>>, today: Date) {
    return {
      id: t.id, status: t.status, urgency: t.urgency, trigger: t.trigger, from: iso(t.fromDate), to: iso(t.toDate),
      days: Math.round((startOfDay(t.toDate).getTime() - startOfDay(t.fromDate).getTime()) / DAY) + 1,
      // Countdown to the first uncovered day; negative means the seat is already uncovered.
      daysUntilStart: t.deadline ? Math.round((startOfDay(t.deadline).getTime() - today.getTime()) / DAY) : null,
      seatId: t.seatId, seat: `${t.seat.unit?.code ?? `${t.seat.base?.code} base`} · ${t.seat.position.name} #${t.seat.index}`,
      candidate: t.candidate ? { id: t.candidate.id, name: `${t.candidate.firstName} ${t.candidate.lastName}` } : null,
      escalatedAt: t.escalatedAt, assignmentId: t.assignmentId, closedAt: t.closedAt,
    };
  }

  // ---------- reads

  @Get()
  async list(@Query() q: { status?: string; urgency?: string; baseId?: string; all?: string; recent?: string }) {
    const scope = q.baseId ? [q.baseId] : undefined;
    await fitTasksToJobs(this.prisma); // no warnings for units that are not on a job
    await this.escalateDue();
    // Open tasks only, unless `recent=true`: then also the ones fixed in the last week (a person was placed), so the screen can show the problem is solved.
    const weekAgo = new Date(Date.now() - 7 * DAY);
    const where: Record<string, unknown> = q.status ? { status: q.status } : q.all === 'true' ? {} : q.recent !== 'true' ? { status: { in: OPEN_TASK } } : { OR: [{ status: { in: OPEN_TASK } }, { status: 'CLOSED', assignmentId: { not: null }, closedAt: { gte: weekAgo } }] };
    if (q.urgency) where.urgency = q.urgency;
    if (scope) where.seat = { OR: [{ baseId: { in: scope } }, { unit: { homeBaseId: { in: scope } } }] };
    const rows = await this.prisma.replacementTask.findMany({
      where: where as never,
      include: { seat: { include: { position: true, unit: { select: { code: true, homeBaseId: true } }, base: { select: { code: true } } } }, candidate: { select: { id: true, firstName: true, lastName: true } } },
    });
    const today = startOfDay(new Date());
    return rows.sort((a, b) => URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency] || a.fromDate.getTime() - b.fromDate.getTime()).map(t => this.shape(t, today));
  }

  @Get(':id')
  async detail(@Param('id') id: string) { return this.shape(await this.mustLoad(id), startOfDay(new Date())); }

  /** One click to the best people for this task, with the reasons (16). */
  @Get(':id/candidates')
  async candidates(@Param('id') id: string, @Query('top') top?: string) {
    const t = await this.mustLoad(id);
    const maxConsec = (await this.settings.all())['rules.maxConsecutiveDays'] as number;
    // A long gap is filled in stretches no longer than the maximum consecutive days.
    const to = t.toDate < addDays(t.fromDate, maxConsec - 1) ? t.toDate : addDays(t.fromDate, maxConsec - 1);
    return { task: this.shape(t, startOfDay(new Date())), ...(await this.planning.suggest(t.seatId, t.fromDate, to, Math.min(parseInt(top ?? '5', 10) || 5, 20))) };
  }

  // ---------- workflow: Open -> Candidate proposed -> Candidate confirmed (closed) / Escalated

  @Post(':id/propose')
  async propose(@Param('id') id: string, @Body() body: { employeeId?: string }) {
    const t = await this.mustLoad(id);
    if (!OPEN_TASK.includes(t.status)) throw new BadRequestException(`A ${t.status.toLowerCase()} task cannot take a proposal`);
    if (!body?.employeeId) throw new BadRequestException('employeeId is required');
    if (!(await this.prisma.employee.findFirst({ where: { id: body.employeeId, active: true }, select: { id: true } }))) throw new BadRequestException('Employee does not exist or is archived');
    await this.prisma.replacementTask.update({ where: { id }, data: { status: 'CANDIDATE_PROPOSED', candidateId: body.employeeId } });
    await audit(this.prisma, 'ReplacementTask', id, 'propose', null, { employeeId: body.employeeId });
    return { status: 'CANDIDATE_PROPOSED' };
  }

  /**
   * Confirm: the person is placed on the seat for the chosen days (all of the rules apply, a hard breach needs an
   * override reason). Days not covered stay as an open task.
   */
  @Post(':id/confirm')
  async confirm(
    @Param('id') id: string,
    @Body() body: { employeeId?: string; start?: string; end?: string; overrideReason?: string },
  ) {
    const t = await this.mustLoad(id);
    if (!OPEN_TASK.includes(t.status)) throw new BadRequestException(`A ${t.status.toLowerCase()} task cannot be confirmed`);
    const employeeId = body?.employeeId ?? t.candidateId;
    if (!employeeId) throw new BadRequestException('employeeId is required (or propose someone first)');

    const maxConsec = (await this.settings.all())['rules.maxConsecutiveDays'] as number;
    const start = startOfDay(body.start ? parseDate(body.start) : t.fromDate);
    const defaultEnd = t.toDate < addDays(start, maxConsec - 1) ? t.toDate : addDays(start, maxConsec - 1);
    const end = startOfDay(body.end ? parseDate(body.end) : defaultEnd);
    if (end < start) throw new BadRequestException('end must not be before start');
    if (start < startOfDay(t.fromDate) || end > startOfDay(t.toDate)) throw new BadRequestException(`The days must lie within the task (${iso(t.fromDate)} to ${iso(t.toDate)})`);

    await this.assignments.assertSeatFree(t.seatId, start, end, []);
    const prev = await this.prisma.assignment.findFirst({ where: { seatId: t.seatId, status: { in: ['CONFIRMED', 'ACTIVE', 'COMPLETED'] }, plannedEnd: { lt: start } }, orderBy: { plannedEnd: 'desc' } });
    const ev = await this.assignments.evaluate([{ employeeId, seatId: t.seatId, start, end, replacesId: prev?.id }]);
    await this.assignments.requireOverride(ev, body?.overrideReason);

    const today = startOfDay(new Date());
    const out = await this.prisma.$transaction(async tx => {
      const a = await tx.assignment.create({
        data: { employeeId, seatId: t.seatId, start, plannedEnd: end, type: 'REPLACEMENT', status: start <= today ? 'ACTIVE' : 'CONFIRMED', replacesId: prev?.id, overrideReason: ev.hard > 0 ? body.overrideReason?.trim() : undefined },
      });
      const rest = subtractSpans({ start: t.fromDate, end: t.toDate }, [{ start, end }]);
      if (rest.length === 0) {
        await tx.replacementTask.update({ where: { id }, data: { status: 'CLOSED', closedAt: new Date(), candidateId: employeeId, assignmentId: a.id } });
      } else {
        await tx.replacementTask.update({ where: { id }, data: { fromDate: rest[0].start, toDate: rest[0].end, status: 'OPEN', candidateId: null, deadline: rest[0].start } });
        for (const extra of rest.slice(1)) {
          await tx.replacementTask.create({ data: { seatId: t.seatId, fromDate: extra.start, toDate: extra.end, trigger: t.trigger, urgency: t.urgency, sourceId: t.sourceId, deadline: extra.start } });
        }
      }
      return { a, rest };
    });
    await audit(this.prisma, 'ReplacementTask', id, 'confirm', null, { assignmentId: out.a.id, employeeId }, body?.overrideReason);
    return {
      assignment: out.a, closed: out.rest.length === 0,
      remaining: out.rest.map(r => ({ from: iso(r.start), to: iso(r.end) })), violations: ev.violations,
    };
  }

  @Post(':id/escalate')
  async escalate(@Param('id') id: string) {
    const t = await this.mustLoad(id);
    if (!OPEN_TASK.includes(t.status) || t.status === 'ESCALATED') throw new BadRequestException(`A ${t.status.toLowerCase()} task cannot be escalated`);
    await this.prisma.replacementTask.update({ where: { id }, data: { status: 'ESCALATED', escalatedAt: new Date() } });
    await audit(this.prisma, 'ReplacementTask', id, 'escalate');
    return { status: 'ESCALATED' };
  }

  /** Escalate everything still unanswered whose first uncovered day is close (setting: replacements.escalateWithinDays). */
  @Post('escalate-due')
  async escalateNow() {
    const result = await this.escalateDue();
    await audit(this.prisma, 'ReplacementTask', 'batch', 'escalate_due', null, { count: result.escalated });
    return result;
  }

  /** The task is no longer needed (unit stood down, job cancelled...). */
  @Post(':id/close')
  async close(@Param('id') id: string, @Body() body: { reason?: string }) {
    const t = await this.mustLoad(id);
    if (!OPEN_TASK.includes(t.status)) throw new BadRequestException(`A ${t.status.toLowerCase()} task is already finished`);
    if (!body?.reason?.trim()) throw new BadRequestException('A reason is required to close a task without a replacement');
    await this.prisma.replacementTask.update({ where: { id }, data: { status: 'CLOSED', closedAt: new Date() } });
    await audit(this.prisma, 'ReplacementTask', id, 'close', null, null, body.reason);
    return { status: 'CLOSED' };
  }

  /**
   * Find seats that will be uncovered (new job, crew change with nobody incoming) and open tasks for them.
   * Safe to repeat: spans that already have an open task are skipped.
   */
  @Post('scan')
  async scan(@Body() body: { start?: string; end?: string; baseIds?: string[] }) {
    const start = body?.start ? parseDate(body.start) : new Date();
    const end = body?.end ? parseDate(body.end) : addDays(start, 27);
    const world = await this.planning.loadWorld({ baseIds: await this.planning.scopeFor(body?.baseIds), start, end, mode: 'full' });
    const today = startOfDay(new Date());
    let created = 0, skipped = 0;
    for (const s of world.input.slots.filter(x => x.required)) {
      const open = await this.prisma.replacementTask.findMany({ where: { seatId: s.seat.id, status: { in: OPEN_TASK }, fromDate: { lte: s.to }, toDate: { gte: s.from } } });
      for (const sp of subtractSpans({ start: s.from, end: s.to }, open.map(o => ({ start: o.fromDate, end: o.toDate })))) {
        const away = Math.round((sp.start.getTime() - today.getTime()) / DAY);
        // Nobody held the seat before => a unit that is starting a job; otherwise a crew change with no one incoming.
        await this.prisma.replacementTask.create({
          data: { seatId: s.seat.id, fromDate: sp.start, toDate: sp.end, trigger: s.previousHolderId ? 'crew_change_gap' : 'unit_deployed', urgency: away <= 0 ? 'CRITICAL' : away <= 7 ? 'HIGH' : 'NORMAL', deadline: sp.start },
        });
        created++;
      }
      if (open.length) skipped++;
    }
    await audit(this.prisma, 'ReplacementTask', 'scan', 'scan', null, { created, skipped, start: iso(start), end: iso(end) });
    return { created, alreadyOpen: skipped };
  }
}

@Module({ imports: [SettingsModule, AssignmentsModule, PlanningModule], controllers: [ReplacementsController] })
export class ReplacementsModule {}
