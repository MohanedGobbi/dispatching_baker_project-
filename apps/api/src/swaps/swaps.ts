import {
  BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpException, HttpStatus, Inject, Module,
  NotFoundException, Param, Post, Query, Req,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Require, AuthedRequest } from '../auth/auth.module';
import { can } from '../auth/permissions';
import { AssignmentsModule, AssignmentsService, assertSeatScope } from '../assignments/assignments';
import { NotificationsService } from '../notifications/notifications';
import { audit } from '../common/validate';
import { startOfDay } from '../domain/status';

const LIVE = ['CONFIRMED', 'ACTIVE'] as const;
const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Shift swaps from the portal (plan 18 "Requests"): the person asks a colleague, the colleague accepts, a manager
 * approves, and only then do the two people change seats. Every step is checked against the rules again.
 */
@Controller('swaps')
class SwapsController {
  constructor(
    @Inject(PrismaService) private prisma: PrismaService,
    @Inject(AssignmentsService) private assignments: AssignmentsService,
    @Inject(NotificationsService) private notifier: NotificationsService,
  ) {}

  private me(req: AuthedRequest) {
    if (!req.user?.employeeId) throw new BadRequestException('Your account is not linked to an employee');
    return req.user.employeeId;
  }

  private async assignmentOrFail(id: string) {
    const a = await this.prisma.assignment.findUnique({ where: { id }, include: { seat: true, employee: { select: { id: true, firstName: true, lastName: true } } } });
    if (!a) throw new NotFoundException('Assignment not found');
    return a;
  }

  private async shape(rows: { id: string; requesterId: string; colleagueId: string; requesterAssignmentId: string; colleagueAssignmentId: string; status: string; note: string | null; decisionNote: string | null; createdAt: Date }[], viewer: { employeeId?: string | null; manager: boolean }) {
    const asg = await this.prisma.assignment.findMany({
      where: { id: { in: rows.flatMap(r => [r.requesterAssignmentId, r.colleagueAssignmentId]) } },
      include: { employee: { select: { id: true, firstName: true, lastName: true } } },
    });
    const out = [];
    for (const r of rows) {
      const a = asg.find(x => x.id === r.requesterAssignmentId), b = asg.find(x => x.id === r.colleagueAssignmentId);
      if (!a || !b) continue;
      out.push({
        id: r.id, status: r.status, note: r.note, decisionNote: r.decisionNote, createdAt: r.createdAt,
        requester: { id: r.requesterId, name: `${a.employee.firstName} ${a.employee.lastName}` },
        colleague: { id: r.colleagueId, name: `${b.employee.firstName} ${b.employee.lastName}` },
        a: { assignmentId: a.id, seat: await this.notifier.seatLabel(a.seatId), from: iso(a.start), to: iso(a.plannedEnd) },
        b: { assignmentId: b.id, seat: await this.notifier.seatLabel(b.seatId), from: iso(b.start), to: iso(b.plannedEnd) },
        canRespond: r.status === 'PENDING' && viewer.employeeId === r.colleagueId,
        canCancel: ['PENDING', 'ACCEPTED'].includes(r.status) && viewer.employeeId === r.requesterId,
        canDecide: r.status === 'ACCEPTED' && viewer.manager,
      });
    }
    return out;
  }

  private isManager(req: AuthedRequest) { return can((req.user?.roles ?? []).map(r => r.role).filter(r => r !== 'EMPLOYEE'), 'assignments', 'edit'); }

  /** My swaps; for managers also the accepted ones waiting for a decision. */
  @Get()
  async list(@Req() req: AuthedRequest, @Query('status') status?: string) {
    const employeeId = req.user?.employeeId ?? undefined;
    const manager = this.isManager(req);
    const rows = await this.prisma.swapRequest.findMany({
      where: {
        ...(status ? { status } : {}),
        OR: [...(employeeId ? [{ requesterId: employeeId }, { colleagueId: employeeId }] : []), ...(manager ? [{ status: 'ACCEPTED' }] : [])],
      },
      orderBy: { createdAt: 'desc' }, take: 100,
    });
    return this.shape(rows, { employeeId, manager });
  }

  /** Upcoming assignments I could swap with: same position, overlapping days, held by someone else. */
  @Get('candidates')
  async candidates(@Req() req: AuthedRequest, @Query('assignmentId') assignmentId?: string) {
    const me = this.me(req);
    if (!assignmentId) throw new BadRequestException('assignmentId is required');
    const mine = await this.assignmentOrFail(assignmentId);
    if (mine.employeeId !== me) throw new ForbiddenException('That is not your assignment');
    if (mine.start <= startOfDay(new Date())) return [];
    const rows = await this.prisma.assignment.findMany({
      where: { status: { in: [...LIVE] }, employeeId: { not: me }, seat: { positionId: mine.seat.positionId }, start: { gt: startOfDay(new Date()), lte: mine.plannedEnd }, plannedEnd: { gte: mine.start } },
      include: { employee: { select: { id: true, firstName: true, lastName: true } } }, orderBy: { start: 'asc' }, take: 40,
    });
    const out = [];
    for (const b of rows) out.push({ assignmentId: b.id, employee: { id: b.employee.id, name: `${b.employee.firstName} ${b.employee.lastName}` }, seat: await this.notifier.seatLabel(b.seatId), from: iso(b.start), to: iso(b.plannedEnd) });
    return out;
  }

  @Post()
  async create(@Body() body: { requesterAssignmentId?: string; colleagueAssignmentId?: string; note?: string }, @Req() req: AuthedRequest) {
    const me = this.me(req);
    if (!body?.requesterAssignmentId || !body.colleagueAssignmentId) throw new BadRequestException('requesterAssignmentId and colleagueAssignmentId are required');
    const [a, b] = await Promise.all([this.assignmentOrFail(body.requesterAssignmentId), this.assignmentOrFail(body.colleagueAssignmentId)]);
    if (a.employeeId !== me) throw new ForbiddenException('You can only offer your own assignment');
    if (b.employeeId === me) throw new BadRequestException('Pick a colleague\'s assignment, not your own');
    const today = startOfDay(new Date());
    for (const x of [a, b]) {
      if (!(LIVE as readonly string[]).includes(x.status)) throw new BadRequestException('Only confirmed or active assignments can be swapped');
      // Only stretches that have not started: swapping a running one would rewrite days already worked.
      if (x.start <= today) throw new BadRequestException('Only upcoming assignments can be swapped. For one that has started, ask your dispatcher to arrange a handover.');
    }
    const busy = await this.prisma.swapRequest.findFirst({
      where: { status: { in: ['PENDING', 'ACCEPTED'] }, OR: [{ requesterAssignmentId: { in: [a.id, b.id] } }, { colleagueAssignmentId: { in: [a.id, b.id] } }] },
    });
    if (busy) throw new ConflictException('One of these assignments is already part of a swap request');

    // The people cannot override rules, so a swap that would break one is refused now instead of wasting a manager's time.
    const ev = await this.assignments.evaluate([
      { employeeId: b.employeeId, seatId: a.seatId, start: a.start, end: a.plannedEnd },
      { employeeId: a.employeeId, seatId: b.seatId, start: b.start, end: b.plannedEnd },
    ], [a.id, b.id]);
    if (ev.hard > 0) {
      throw new HttpException({ statusCode: 422, error: 'Swap not possible', message: 'This swap would break a rule, so it cannot be requested', violations: ev.violations.filter(v => v.severity === 'hard') }, HttpStatus.UNPROCESSABLE_ENTITY);
    }
    const s = await this.prisma.swapRequest.create({
      data: { requesterId: me, colleagueId: b.employeeId, requesterAssignmentId: a.id, colleagueAssignmentId: b.id, note: body.note?.trim() || null },
    });
    const payload = { requester: `${a.employee.firstName} ${a.employee.lastName}`, colleague: `${b.employee.firstName} ${b.employee.lastName}`, seatA: await this.notifier.seatLabel(a.seatId), seatB: await this.notifier.seatLabel(b.seatId), stage: 'colleague' };
    await this.notifier.notify({ type: 'swap_requested', to: [{ employeeId: b.employeeId }], payload });
    await audit(this.prisma, req.user!.sub, 'SwapRequest', s.id, 'create', null, s);
    return { id: s.id, status: s.status, softWarnings: ev.violations.filter(v => v.severity === 'soft').map(v => v.message) };
  }

  @Post(':id/respond')
  async respond(@Param('id') id: string, @Body() body: { accept?: boolean; note?: string }, @Req() req: AuthedRequest) {
    const me = this.me(req);
    const s = await this.prisma.swapRequest.findUnique({ where: { id } });
    if (!s) throw new NotFoundException('Swap request not found');
    if (s.colleagueId !== me) throw new ForbiddenException('Only the colleague who was asked can answer');
    if (s.status !== 'PENDING') throw new BadRequestException(`This request is already ${s.status.toLowerCase()}`);
    if (typeof body?.accept !== 'boolean') throw new BadRequestException('accept must be true or false');
    const [a, b] = await Promise.all([this.assignmentOrFail(s.requesterAssignmentId), this.assignmentOrFail(s.colleagueAssignmentId)]);
    const seatA = await this.notifier.seatLabel(a.seatId), seatB = await this.notifier.seatLabel(b.seatId);
    const names = { requester: `${a.employee.firstName} ${a.employee.lastName}`, colleague: `${b.employee.firstName} ${b.employee.lastName}`, seatA, seatB };
    await this.prisma.swapRequest.update({ where: { id }, data: { status: body.accept ? 'ACCEPTED' : 'DECLINED', decisionNote: body.note?.trim() || null } });
    await this.notifier.notify({ type: 'swap_decided', to: [{ employeeId: s.requesterId }], payload: { ...names, decision: body.accept ? 'accepted' : 'declined', note: body.note?.trim() } });
    if (body.accept) {
      const baseId = a.seat.baseId ?? undefined;
      await this.notifier.notify({ type: 'swap_requested', to: [{ role: 'OPS_MANAGER' }, { role: 'DISPATCHER' }, ...(baseId ? [{ role: 'BASE_MANAGER', baseId }] : [])], payload: { ...names, stage: 'manager' } });
    }
    await audit(this.prisma, req.user!.sub, 'SwapRequest', id, body.accept ? 'accept' : 'decline');
    return { status: body.accept ? 'ACCEPTED' : 'DECLINED' };
  }

  @Post(':id/cancel')
  async cancel(@Param('id') id: string, @Req() req: AuthedRequest) {
    const me = this.me(req);
    const s = await this.prisma.swapRequest.findUnique({ where: { id } });
    if (!s) throw new NotFoundException('Swap request not found');
    if (s.requesterId !== me) throw new ForbiddenException('Only the person who asked can cancel');
    if (!['PENDING', 'ACCEPTED'].includes(s.status)) throw new BadRequestException(`This request is already ${s.status.toLowerCase()}`);
    await this.prisma.swapRequest.update({ where: { id }, data: { status: 'CANCELLED' } });
    await audit(this.prisma, req.user!.sub, 'SwapRequest', id, 'cancel');
    return { status: 'CANCELLED' };
  }

  /** The manager's decision. Approving swaps the two people in one step, after checking the rules against today's facts. */
  @Post(':id/decide') @Require('assignments', 'edit')
  async decide(@Param('id') id: string, @Body() body: { approve?: boolean; note?: string; overrideReason?: string }, @Req() req: AuthedRequest) {
    const s = await this.prisma.swapRequest.findUnique({ where: { id } });
    if (!s) throw new NotFoundException('Swap request not found');
    if (s.status !== 'ACCEPTED') throw new BadRequestException('Only a swap the colleague has accepted can be decided');
    if (typeof body?.approve !== 'boolean') throw new BadRequestException('approve must be true or false');
    const [a, b] = await Promise.all([this.assignmentOrFail(s.requesterAssignmentId), this.assignmentOrFail(s.colleagueAssignmentId)]);
    await assertSeatScope(this.prisma, req, [a.seatId, b.seatId]);
    const names = { requester: `${a.employee.firstName} ${a.employee.lastName}`, colleague: `${b.employee.firstName} ${b.employee.lastName}`, seatA: await this.notifier.seatLabel(a.seatId), seatB: await this.notifier.seatLabel(b.seatId) };
    const both = [{ employeeId: s.requesterId }, { employeeId: s.colleagueId }];

    if (!body.approve) {
      if (!body.note?.trim()) throw new BadRequestException('A reason is required to reject');
      await this.prisma.swapRequest.update({ where: { id }, data: { status: 'REJECTED', decidedBy: req.user!.sub, decisionNote: body.note.trim() } });
      await this.notifier.notify({ type: 'swap_decided', to: both, payload: { ...names, decision: 'rejected', note: body.note.trim() } });
      await audit(this.prisma, req.user!.sub, 'SwapRequest', id, 'reject', null, null, body.note);
      return { status: 'REJECTED' };
    }

    for (const x of [a, b]) if (!(LIVE as readonly string[]).includes(x.status)) throw new ConflictException('One of the assignments changed since the request was made');
    if (a.employeeId !== s.requesterId || b.employeeId !== s.colleagueId) throw new ConflictException('One of the assignments changed hands since the request was made');
    const ev = await this.assignments.evaluate([
      { employeeId: b.employeeId, seatId: a.seatId, start: a.start, end: a.plannedEnd },
      { employeeId: a.employeeId, seatId: b.seatId, start: b.start, end: b.plannedEnd },
    ], [a.id, b.id]);
    await this.assignments.requireOverride(ev, body.overrideReason);
    await this.prisma.$transaction([
      this.prisma.assignment.update({ where: { id: a.id }, data: { employeeId: b.employeeId } }),
      this.prisma.assignment.update({ where: { id: b.id }, data: { employeeId: a.employeeId } }),
      this.prisma.swapRequest.update({ where: { id }, data: { status: 'APPROVED', decidedBy: req.user!.sub, decisionNote: body.note?.trim() || null } }),
    ]);
    await this.notifier.notify({ type: 'swap_decided', to: both, payload: { ...names, decision: 'approved', note: body.note?.trim() } });
    await audit(this.prisma, req.user!.sub, 'SwapRequest', id, 'approve', { a: a.employeeId, b: b.employeeId }, { a: b.employeeId, b: a.employeeId }, body.overrideReason);
    return { status: 'APPROVED', violations: ev.violations };
  }
}

@Module({ imports: [AssignmentsModule], controllers: [SwapsController] })
export class SwapsModule {}
