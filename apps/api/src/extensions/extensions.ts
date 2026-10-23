import {
  BadRequestException, Body, ConflictException, Controller, Get, HttpException, HttpStatus, Inject, Module,
  NotFoundException, Param, Post, Query,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsModule, SettingsService } from '../settings/settings';
import { audit, MANAGER, page, parseDate } from '../common/validate';
import { extensionLimitBreaches, inclusiveDays, quarterOf } from '../domain/absence';
import { startOfDay } from '../domain/status';

const DAY = 86_400_000;
const REASONS = ['no_replacement', 'urgent_job', 'replacement_late', 'medical_replacement', 'other'];
const EFFECTIVE_LEAVE = ['APPROVED', 'RECORDED'];
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(startOfDay(d).getTime() + n * DAY);

@Controller('extensions')
class ExtensionsController {
  constructor(
    @Inject(PrismaService) private prisma: PrismaService,
    @Inject(SettingsService) private settings: SettingsService,
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

  @Get()
  async list(@Query() q: { status?: string; employeeId?: string; baseId?: string; limit?: string; offset?: string }) {
    const where: Record<string, unknown> = {};
    if (q.status) where.status = q.status;
    if (q.employeeId) where.employeeId = q.employeeId;
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
  @Get('balances')
  async balances(@Query() q: { baseId?: string; minDays?: string }) {
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
  @Get('report')
  async report(@Query() q: { groupBy?: string; from?: string; to?: string; status?: string }) {
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

  /** Request an extension (13). The request itself never moves anyone. */
  @Post()
  async request(@Body() body: { assignmentId?: string; days?: number; reason?: string }) {
    if (!body?.assignmentId) throw new BadRequestException('assignmentId is required');
    if (!Number.isInteger(body.days) || body.days! < 1 || body.days! > 30) throw new BadRequestException('days must be a whole number from 1 to 30');
    if (!REASONS.includes(body.reason ?? '')) throw new BadRequestException(`reason must be one of ${REASONS.join(', ')}`);
    const a = await this.prisma.assignment.findUnique({ where: { id: body.assignmentId }, include: { employee: { include: { homeBase: true } } } });
    if (!a) throw new NotFoundException('Assignment not found');
    if (!['CONFIRMED', 'ACTIVE'].includes(a.status)) throw new BadRequestException('Only a confirmed or active assignment can be extended');
    const today = startOfDay(new Date());
    if (a.plannedEnd < today) throw new BadRequestException('The assignment has already ended');
    if (a.openEnded) throw new BadRequestException('This stay has no crew change date yet, so there is nothing to extend: set the date instead');

    if (await this.prisma.extension.findFirst({ where: { assignmentId: a.id, status: 'REQUESTED' } })) {
      throw new ConflictException('There is already a pending extension request for this assignment');
    }
    const lim = await this.limits();
    const breaches = extensionLimitBreaches(body.days!, await this.usage(a.employeeId, a.id, today), lim);
    const ext = await this.prisma.extension.create({
      data: { assignmentId: a.id, employeeId: a.employeeId, days: body.days!, reason: body.reason!, requestedBy: MANAGER },
    });
    await audit(this.prisma, 'Extension', ext.id, 'request', null, ext);
    return { extension: ext, breaches, needsOverride: breaches.length > 0 };
  }

  /**
   * Approve: the assignment is extended, a pending replacement for those days is dropped, and the
   * days-off balance grows (or the next on-period shifts, per setting). Beyond a limit it needs an override reason.
   */
  @Post(':id/approve')
  async approve(@Param('id') id: string, @Body() body: { overrideReason?: string; shiftSuccessor?: boolean }) {
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
      await tx.extension.update({ where: { id }, data: { status: 'APPROVED', approvedBy: MANAGER, overrideReason: body?.overrideReason?.trim() } });

      // The seat is covered for these days, so a replacement task for them is no longer needed.
      const tasks = await tx.replacementTask.findMany({ where: { seatId: a.seatId, status: { in: ['OPEN', 'CANDIDATE_PROPOSED'] }, fromDate: { lte: window.end }, toDate: { gte: window.start } } });
      for (const t of tasks) {
        if (t.fromDate >= window.start && t.toDate <= window.end) await tx.replacementTask.update({ where: { id: t.id }, data: { status: 'CLOSED', closedAt: new Date() } });
        else if (t.fromDate >= window.start) await tx.replacementTask.update({ where: { id: t.id }, data: { fromDate: addDays(window.end, 1) } });
      }

      if (lim.shift) {
        // The next on-period starts later by the extra days, so the full rest period is kept and nothing is owed.
        if (ext.employee.rotationAnchorDate) await tx.employee.update({ where: { id: ext.employeeId }, data: { rotationAnchorDate: addDays(ext.employee.rotationAnchorDate, ext.days) } });
      } else {
        await tx.daysOffLedger.create({ data: { employeeId: ext.employeeId, days: ext.days, reason: 'extension', refId: id, createdBy: MANAGER, note: ext.reason } });
      }
      return { closedTasks: tasks.length };
    });
    await audit(this.prisma, 'Extension', id, 'approve', { plannedEnd: a.plannedEnd }, { plannedEnd: window.end, breaches }, body?.overrideReason);
    return { status: 'APPROVED', newEnd: iso(window.end), balanceChange: lim.shift ? 0 : ext.days, rotationShifted: lim.shift, breaches, ...result };
  }

  @Post(':id/reject')
  async reject(@Param('id') id: string, @Body() body: { reason?: string }) {
    const ext = await this.mustLoad(id);
    if (ext.status !== 'REQUESTED') throw new BadRequestException('Only requested extensions can be rejected');
    if (!body?.reason?.trim()) throw new BadRequestException('A reason is required to reject');
    await this.prisma.extension.update({ where: { id }, data: { status: 'REJECTED', approvedBy: MANAGER, overrideReason: body.reason.trim() } });
    await audit(this.prisma, 'Extension', id, 'reject', { status: ext.status }, { status: 'REJECTED' }, body.reason);
    return { status: 'REJECTED' };
  }

  /** Manual correction of the balance, always with a note. */
  @Post('balance-adjust')
  async adjust(@Body() body: { employeeId?: string; days?: number; note?: string }) {
    if (!body?.employeeId || !Number.isInteger(body.days) || body.days === 0) throw new BadRequestException('employeeId and a non-zero whole number of days are required');
    if (!body.note?.trim()) throw new BadRequestException('A note is required');
    if (!(await this.prisma.employee.findUnique({ where: { id: body.employeeId }, select: { id: true } }))) throw new NotFoundException('Employee not found');
    const row = await this.prisma.daysOffLedger.create({ data: { employeeId: body.employeeId, days: body.days!, reason: 'adjustment', note: body.note.trim(), createdBy: MANAGER } });
    await audit(this.prisma, 'Employee', body.employeeId, 'balance_adjust', null, row, body.note);
    return row;
  }
}

@Module({ imports: [SettingsModule], controllers: [ExtensionsController] })
export class ExtensionsModule {}
