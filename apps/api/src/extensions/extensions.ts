import {
  BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpException, HttpStatus, Inject, Module,
  NotFoundException, Param, Post, Query, Req,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications';
import { Require, AuthedRequest } from '../auth/auth.module';
import { can } from '../auth/permissions';
import { SettingsModule, SettingsService } from '../settings/settings';
import { audit, page, parseDate } from '../common/validate';
import { extensionLimitBreaches, inclusiveDays, quarterOf } from '../domain/absence';
import { startOfDay } from '../domain/status';

const DAY = 86_400_000;
const REASONS = ['no_replacement', 'urgent_job', 'replacement_late', 'medical_replacement', 'other'];
const EFFECTIVE_LEAVE = ['APPROVED', 'RECORDED'];
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(startOfDay(d).getTime() + n * DAY);
const rolesOf = (req: AuthedRequest) => (req.user?.roles ?? []).map(r => r.role);

@Controller('extensions')
class ExtensionsController {
  constructor(
    @Inject(PrismaService) private prisma: PrismaService,
    @Inject(SettingsService) private settings: SettingsService,
    @Inject(NotificationsService) private notifier: NotificationsService,
  ) {}

  private async mustLoad(id: string) {
    const e = await this.prisma.extension.findUnique({
      where: { id }, include: { assignment: { include: { seat: { include: { unit: { select: { code: true } }, base: { select: { code: true } } } } } }, employee: { include: { homeBase: true } } },
    });
    if (!e) throw new NotFoundException('Extension not found');
    return e;
  }

  /** Extension days already approved for this person: on this assignment (the rotation) and in the quarter. */
  private async usage(employeeId: string, assignmentId: string, asOf: Date) {
    const q = quarterOf(asOf);
    const approved = await this.prisma.extension.findMany({ where: { employeeId, status: 'APPROVED' } });
    return {
      rotationDays: approved.filter(x => x.assignmentId === assignmentId).reduce((n, x) => n + x.days, 0),
      quarterDays: approved.filter(x => x.createdAt >= q.start && x.createdAt <= addDays(q.end, 1)).reduce((n, x) => n + x.days, 0),
    };
  }

  private async limits() {
    const s = await this.settings.all();
    return { perRotation: s['rules.maxExtensionDaysPerRotation'] as number, perQuarter: s['rules.maxExtensionDaysPerQuarter'] as number, maxConsecutive: s['rules.maxConsecutiveDays'] as number, shift: s['rules.shiftNextRotationOnExtension'] === true };
  }

  // ---------- reads

  @Get() @Require('extensions', 'view')
  async list(@Req() req: AuthedRequest, @Query() q: { status?: string; employeeId?: string; baseId?: string; limit?: string; offset?: string }) {
    const roles = rolesOf(req);
    const employeeOnly = roles.every(r => r === 'EMPLOYEE');
    const where: Record<string, unknown> = {};
    if (q.status) where.status = q.status;
    if (employeeOnly) {
      if (!req.user?.employeeId) return { total: 0, items: [] };
      where.employeeId = req.user.employeeId;
    } else if (q.employeeId) where.employeeId = q.employeeId;
    if (q.baseId) where.employee = { homeBaseId: q.baseId };
    const { take, skip } = page(q);
    const [total, items] = await Promise.all([
      this.prisma.extension.count({ where: where as never }),
      this.prisma.extension.findMany({
        where: where as never, orderBy: { createdAt: 'desc' }, take, skip,
        include: {
          employee: { select: { id: true, firstName: true, lastName: true, employeeNo: true } },
          assignment: { select: { start: true, plannedEnd: true, seat: { select: { unit: { select: { code: true } }, base: { select: { code: true } } } } } },
        },
      }),
    ]);
    return { total, items };
  }

  /** Days-off balance ranking: who is owed the most rest, so relief goes there first (15.3 fairness). */
  @Get('balances') @Require('extensions', 'view')
  async balances(@Req() req: AuthedRequest, @Query() q: { baseId?: string; minDays?: string }) {
    if (rolesOf(req).every(r => r === 'EMPLOYEE')) throw new ForbiddenException('Not available to employees');
    const sums = await this.prisma.daysOffLedger.groupBy({ by: ['employeeId'], _sum: { days: true } });
    const emps = await this.prisma.employee.findMany({
      where: { id: { in: sums.map(s => s.employeeId) }, active: true, ...(q.baseId ? { homeBaseId: q.baseId } : {}) },
      select: { id: true, firstName: true, lastName: true, employeeNo: true, homeBase: { select: { code: true } } },
    });
    const min = parseInt(q.minDays ?? '1', 10);
    return emps.map(e => ({ ...e, balance: sums.find(s => s.employeeId === e.id)?._sum.days ?? 0 }))
      .filter(r => r.balance >= min).sort((a, b) => b.balance - a.balance);
  }

  /** Reports (13): approved extensions by employee, base, reason or month. */
  @Get('report') @Require('extensions', 'view')
  async report(@Req() req: AuthedRequest, @Query() q: { groupBy?: string; from?: string; to?: string; status?: string }) {
    if (rolesOf(req).every(r => r === 'EMPLOYEE')) throw new ForbiddenException('Not available to employees');
    const groupBy = q.groupBy ?? 'reason';
    if (!['employee', 'base', 'reason', 'month'].includes(groupBy)) throw new BadRequestException('groupBy must be employee, base, reason or month');
    const rows = await this.prisma.extension.findMany({
      where: { status: q.status ?? 'APPROVED', ...(q.from ? { createdAt: { gte: parseDate(q.from) } } : {}), ...(q.to ? { createdAt: { lte: parseDate(q.to) } } : {}) },
      include: { employee: { select: { firstName: true, lastName: true, homeBase: { select: { code: true } } } } },
    });
    const keyOf = (r: (typeof rows)[number]) =>
      groupBy === 'employee' ? `${r.employee.firstName} ${r.employee.lastName}` : groupBy === 'base' ? r.employee.homeBase.code : groupBy === 'month' ? r.createdAt.toISOString().slice(0, 7) : r.reason;
    const out = new Map<string, { key: string; count: number; days: number }>();
    for (const r of rows) {
      const k = keyOf(r);
      const g = out.get(k) ?? { key: k, count: 0, days: 0 };
      g.count++; g.days += r.days; out.set(k, g);
    }
    return [...out.values()].sort((a, b) => b.days - a.days);
  }

  // ---------- workflow

  /** Request: dispatcher / base manager / chief of unit (13). The request itself never moves anyone. */
  @Post() @Require('extensions', 'edit')
  async request(@Body() body: { assignmentId?: string; days?: number; reason?: string }, @Req() req: AuthedRequest) {
    if (!body?.assignmentId) throw new BadRequestException('assignmentId is required');
    if (!Number.isInteger(body.days) || body.days! < 1 || body.days! > 30) throw new BadRequestException('days must be a whole number from 1 to 30');
    if (!REASONS.includes(body.reason ?? '')) throw new BadRequestException(`reason must be one of ${REASONS.join(', ')}`);
    const a = await this.prisma.assignment.findUnique({ where: { id: body.assignmentId }, include: { employee: { include: { homeBase: true } } } });
    if (!a) throw new NotFoundException('Assignment not found');
    if (!['CONFIRMED', 'ACTIVE'].includes(a.status)) throw new BadRequestException('Only a confirmed or active assignment can be extended');
    const today = startOfDay(new Date());
    if (a.plannedEnd < today) throw new BadRequestException('The assignment has already ended');

    const roles = req.user?.roles ?? [];
    const broad = roles.some(r => can([r.role], 'extensions', 'full') || r.role === 'DISPATCHER' || r.role === 'CHIEF_OF_UNIT');
    const scoped = roles.some(r => r.role === 'BASE_MANAGER' && r.baseScope && (r.baseScope === a.employee.homeBaseId || r.baseScope === a.employee.homeBase.code));
    if (!broad && !scoped) throw new ForbiddenException('Base managers can only request extensions for staff of their own base');

    if (await this.prisma.extension.findFirst({ where: { assignmentId: a.id, status: 'REQUESTED' } })) {
      throw new ConflictException('There is already a pending extension request for this assignment');
    }
    const lim = await this.limits();
    const breaches = extensionLimitBreaches(body.days!, await this.usage(a.employeeId, a.id, today), lim);
    const ext = await this.prisma.extension.create({
      data: { assignmentId: a.id, employeeId: a.employeeId, days: body.days!, reason: body.reason!, requestedBy: req.user?.sub },
    });
    await audit(this.prisma, req.user?.sub, 'Extension', ext.id, 'request', null, ext);
    await this.notifier.notify({
      type: 'extension_requested', to: [{ role: 'OPS_MANAGER' }], except: req.user?.sub,
      payload: { employee: `${a.employee.firstName} ${a.employee.lastName}`, days: body.days, seat: await this.notifier.seatLabel(a.seatId), extensionId: ext.id },
    });
    return { extension: ext, breaches, needsOverride: breaches.length > 0 };
  }

  /**
   * Approve (Ops Manager): the assignment is extended, a pending replacement for those days is dropped, and the
   * days-off balance grows (or the next on-period shifts, per setting). Beyond a limit it needs an override reason.
   */
  @Post(':id/approve') @Require('extensions', 'full')
  async approve(@Param('id') id: string, @Body() body: { overrideReason?: string; shiftSuccessor?: boolean }, @Req() req: AuthedRequest) {
    const ext = await this.mustLoad(id);
    if (ext.status !== 'REQUESTED') throw new BadRequestException(`Only requested extensions can be approved (this one is ${ext.status.toLowerCase()})`);
    const a = ext.assignment;
    if (!['CONFIRMED', 'ACTIVE'].includes(a.status)) throw new BadRequestException('The assignment is no longer active');

    const lim = await this.limits();
    const window = { start: addDays(a.plannedEnd, 1), end: addDays(a.plannedEnd, ext.days) };
    const breaches = extensionLimitBreaches(ext.days, await this.usage(ext.employeeId, a.id, new Date()), lim);
    if (inclusiveDays({ start: a.start, end: window.end }) > lim.maxConsecutive) {
      breaches.push(`${inclusiveDays({ start: a.start, end: window.end })} consecutive days exceeds the ${lim.maxConsecutive}-day maximum`);
    }
    if (breaches.length && !body?.overrideReason?.trim()) {
      throw new HttpException({ statusCode: 422, error: 'Extension limit', message: 'Limits are exceeded; pass overrideReason to approve', breaches }, HttpStatus.UNPROCESSABLE_ENTITY);
    }

    const leave = await this.prisma.leave.findFirst({ where: { employeeId: ext.employeeId, status: { in: EFFECTIVE_LEAVE }, start: { lte: window.end }, end: { gte: window.start } } });
    if (leave) throw new ConflictException(`Employee is unavailable ${iso(leave.start < window.start ? window.start : leave.start)} to ${iso(leave.end > window.end ? window.end : leave.end)}`);

    const successor = await this.prisma.assignment.findFirst({
      where: { seatId: a.seatId, id: { not: a.id }, status: { in: ['CONFIRMED', 'ACTIVE'] }, start: { lte: window.end }, plannedEnd: { gte: window.start } },
      include: { employee: { select: { firstName: true, lastName: true } } },
    });
    if (successor && !body?.shiftSuccessor) {
      throw new ConflictException(`${successor.employee.firstName} ${successor.employee.lastName} takes over this seat from ${iso(successor.start)}; set shiftSuccessor to delay their start`);
    }
    if (successor && addDays(window.end, 1) > successor.plannedEnd) throw new ConflictException('The extension would swallow the incoming person\'s whole assignment');

    const result = await this.prisma.$transaction(async tx => {
      if (successor) await tx.assignment.update({ where: { id: successor.id }, data: { start: addDays(window.end, 1) } });
      await tx.assignment.update({ where: { id: a.id }, data: { plannedEnd: window.end, originalEnd: a.originalEnd ?? a.plannedEnd } });
      await tx.extension.update({ where: { id }, data: { status: 'APPROVED', approvedBy: req.user?.sub, overrideReason: body?.overrideReason?.trim() } });

      // The seat is covered for these days, so a replacement task for them is no longer needed.
      const tasks = await tx.replacementTask.findMany({ where: { seatId: a.seatId, status: { in: ['OPEN', 'CANDIDATE_PROPOSED'] }, fromDate: { lte: window.end }, toDate: { gte: window.start } } });
      for (const t of tasks) {
        if (t.fromDate >= window.start && t.toDate <= window.end) await tx.replacementTask.update({ where: { id: t.id }, data: { status: 'CLOSED' } });
        else if (t.fromDate >= window.start) await tx.replacementTask.update({ where: { id: t.id }, data: { fromDate: addDays(window.end, 1) } });
      }

      if (lim.shift) {
        // The next on-period starts later by the extra days, so the full rest period is kept and nothing is owed.
        if (ext.employee.rotationAnchorDate) await tx.employee.update({ where: { id: ext.employeeId }, data: { rotationAnchorDate: addDays(ext.employee.rotationAnchorDate, ext.days) } });
      } else {
        await tx.daysOffLedger.create({ data: { employeeId: ext.employeeId, days: ext.days, reason: 'extension', refId: id, createdBy: req.user?.sub, note: ext.reason } });
      }
      return { closedTasks: tasks.length };
    });
    await audit(this.prisma, req.user?.sub, 'Extension', id, 'approve', { plannedEnd: a.plannedEnd }, { plannedEnd: window.end, breaches }, body?.overrideReason);
    // The person must acknowledge the extra days (13, 19); acknowledging the notice also marks the extension.
    await this.notifier.notify({
      type: 'extension_approved', to: [{ employeeId: ext.employeeId }], except: req.user?.sub,
      payload: { days: ext.days, seat: await this.notifier.seatLabel(a.seatId), newEnd: iso(window.end), extensionId: ext.id },
    });
    return { status: 'APPROVED', newEnd: iso(window.end), balanceChange: lim.shift ? 0 : ext.days, rotationShifted: lim.shift, breaches, ...result };
  }

  @Post(':id/reject') @Require('extensions', 'full')
  async reject(@Param('id') id: string, @Body() body: { reason?: string }, @Req() req: AuthedRequest) {
    const ext = await this.mustLoad(id);
    if (ext.status !== 'REQUESTED') throw new BadRequestException('Only requested extensions can be rejected');
    if (!body?.reason?.trim()) throw new BadRequestException('A reason is required to reject');
    await this.prisma.extension.update({ where: { id }, data: { status: 'REJECTED', approvedBy: req.user?.sub, overrideReason: body.reason.trim() } });
    await audit(this.prisma, req.user?.sub, 'Extension', id, 'reject', { status: ext.status }, { status: 'REJECTED' }, body.reason);
    return { status: 'REJECTED' };
  }

  /** The employee confirms they have seen the approved extension (13, 19). */
  @Post(':id/acknowledge') @Require('extensions', 'view')
  async acknowledge(@Param('id') id: string, @Req() req: AuthedRequest) {
    const ext = await this.mustLoad(id);
    if (!req.user?.employeeId || req.user.employeeId !== ext.employeeId) throw new ForbiddenException('Only the employee concerned can acknowledge');
    if (ext.status !== 'APPROVED') throw new BadRequestException('Only approved extensions need acknowledging');
    if (ext.acknowledgedAt) return { acknowledgedAt: ext.acknowledgedAt };
    const upd = await this.prisma.extension.update({ where: { id }, data: { acknowledgedAt: new Date() } });
    await audit(this.prisma, req.user.sub, 'Extension', id, 'acknowledge');
    return { acknowledgedAt: upd.acknowledgedAt };
  }

  /** Manual correction of the balance, always with a note. */
  @Post('balance-adjust') @Require('extensions', 'full')
  async adjust(@Body() body: { employeeId?: string; days?: number; note?: string }, @Req() req: AuthedRequest) {
    if (!body?.employeeId || !Number.isInteger(body.days) || body.days === 0) throw new BadRequestException('employeeId and a non-zero whole number of days are required');
    if (!body.note?.trim()) throw new BadRequestException('A note is required');
    if (!(await this.prisma.employee.findUnique({ where: { id: body.employeeId }, select: { id: true } }))) throw new NotFoundException('Employee not found');
    const row = await this.prisma.daysOffLedger.create({ data: { employeeId: body.employeeId, days: body.days!, reason: 'adjustment', note: body.note.trim(), createdBy: req.user?.sub } });
    await audit(this.prisma, req.user?.sub, 'Employee', body.employeeId, 'balance_adjust', null, row, body.note);
    return row;
  }
}

@Module({ imports: [SettingsModule], controllers: [ExtensionsController] })
export class ExtensionsModule {}
