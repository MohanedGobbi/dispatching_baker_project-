import {
  BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, Inject, Injectable, Module,
  NotFoundException, Param, Post, Query, Req,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications';
import { Require, AuthedRequest } from '../auth/auth.module';
import { can } from '../auth/permissions';
import { SettingsModule, SettingsService } from '../settings/settings';
import { AbsenceModule, AbsenceService } from '../absence/absence.service';
import { audit, page, parseDate, pickFields } from '../common/validate';
import { inclusiveDays, isLongTerm, offDaysIn, overlapDays } from '../domain/absence';
import { Pattern, startOfDay } from '../domain/status';

const DAY = 86_400_000;
const FAR_FUTURE = new Date('9999-12-31T00:00:00Z');
const EFFECTIVE = ['APPROVED', 'RECORDED'];            // statuses that actually remove the person
const PENDING_OR_EFFECTIVE = ['SUBMITTED', ...EFFECTIVE];
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(startOfDay(d).getTime() + n * DAY);

const rolesOf = (req: AuthedRequest) => (req.user?.roles ?? []).map(r => r.role);
const employeeOnly = (roles: string[]) => roles.length > 0 && roles.every(r => r === 'EMPLOYEE');

type LeaveWithType = Awaited<ReturnType<LeaveService['loadLeave']>>;

@Injectable()
export class LeaveService {
  constructor(
    @Inject(PrismaService) public prisma: PrismaService,
    @Inject(SettingsService) public settings: SettingsService,
    @Inject(AbsenceService) public absence: AbsenceService,
    @Inject(NotificationsService) public notifier: NotificationsService,
  ) {}

  /** Tell the right people about a new leave. A medical leave never reveals the reason, only that someone is away. */
  async announceCreated(l: NonNullable<LeaveWithType>, actorId?: string) {
    const name = `${l.employee.firstName} ${l.employee.lastName}`;
    const medical = l.type.category === 'medical';
    const payload = { employee: name, type: l.type.name, from: iso(l.start), to: iso(l.end) };
    const baseId = l.employee.homeBaseId;
    if (l.status === 'SUBMITTED') {
      await this.notifier.notify({
        type: 'leave_submitted', payload, except: actorId,
        to: medical ? [{ role: 'HR' }] : [{ role: 'OPS_MANAGER' }, { role: 'HR' }, { role: 'BASE_MANAGER', baseId }],
      });
    } else if (EFFECTIVE.includes(l.status)) {
      if (medical) await this.announceUnavailable(l, actorId);
      else if (l.employeeId) await this.notifier.notify({ type: 'leave_decided', to: [{ employeeId: l.employeeId }], payload: { ...payload, decision: 'approved' }, except: actorId });
    }
  }

  async announceUnavailable(l: NonNullable<LeaveWithType>, actorId?: string) {
    await this.notifier.notify({
      type: 'employee_unavailable', except: actorId, payload: { employee: `${l.employee.firstName} ${l.employee.lastName}`, from: iso(l.start), to: iso(l.end) },
      to: [{ role: 'HR' }, { role: 'DISPATCHER' }, { role: 'BASE_MANAGER', baseId: l.employee.homeBaseId }],
    });
  }

  async announceDecision(l: NonNullable<LeaveWithType>, decision: 'approved' | 'rejected', note: string | undefined, actorId?: string) {
    await this.notifier.notify({
      type: 'leave_decided', to: [{ employeeId: l.employeeId }], except: actorId,
      payload: { type: l.type.name, from: iso(l.start), to: iso(l.end), decision, note },
    });
    if (decision === 'approved' && l.type.category === 'medical') await this.announceUnavailable(l, actorId);
  }

  loadLeave(id: string) {
    return this.prisma.leave.findUnique({ where: { id }, include: { type: true, employee: { include: { homeBase: true, rotationPattern: true } }, fitForDuty: true } });
  }

  /** Staff (non-employee roles) with medical edit: HR and Super Admin. Ops can only view medical data. */
  staffMedicalEdit(req: AuthedRequest) { return can(rolesOf(req).filter(r => r !== 'EMPLOYEE'), 'medical', 'edit'); }
  staffMedicalView(req: AuthedRequest) { return can(rolesOf(req).filter(r => r !== 'EMPLOYEE'), 'medical', 'view'); }
  isSelf(req: AuthedRequest, employeeId: string) { return !!req.user?.employeeId && req.user.employeeId === employeeId; }

  /** HR / Ops / Admin for anyone; a Base Manager only for staff based at their own base (plan section 3). */
  canManage(req: AuthedRequest, emp: { homeBaseId: string; homeBase?: { code: string } | null }) {
    const roles = req.user?.roles ?? [];
    if (roles.some(r => can([r.role], 'leave', 'full'))) return true;
    return roles.some(r => r.role === 'BASE_MANAGER' && r.baseScope && (r.baseScope === emp.homeBaseId || r.baseScope === emp.homeBase?.code));
  }

  /** The rows a viewer may see. Medical reasons, certificates and notes stay with HR, Ops and the employee (12.3). */
  async view(l: NonNullable<LeaveWithType>, req: AuthedRequest, detail = false) {
    const medical = l.type.category === 'medical';
    const showReasonSetting = (await this.settings.all())['org.showLeaveReasonToDispatcher'] === true;
    const privileged = this.staffMedicalView(req) || this.isSelf(req, l.employeeId);
    const base = { id: l.id, employeeId: l.employeeId, start: l.start, end: l.end, status: l.status, longTerm: l.longTerm };
    if (medical && !privileged) {
      return { ...base, type: showReasonSetting ? { id: l.type.id, name: l.type.name, category: 'medical' } : { id: l.type.id, name: 'Unavailable', category: 'unavailable' } };
    }
    const full = { ...base, type: { id: l.type.id, name: l.type.name, category: l.type.category }, decisionNote: l.decisionNote, approvedBy: l.approvedBy, enteredBy: l.enteredBy };
    if (!detail) return full;
    // Notes and documents: the person, or staff allowed to see that kind of record.
    const seesNotes = medical ? privileged : (this.isSelf(req, l.employeeId) || can(rolesOf(req), 'leave', 'edit'));
    return { ...full, ...(seesNotes ? { notes: l.notes, documentUrl: l.documentUrl } : {}), fitForDuty: l.fitForDuty ?? undefined };
  }

  async balance(employeeId: string) {
    const [settings, rows] = await Promise.all([
      this.settings.all(),
      this.prisma.daysOffLedger.findMany({ where: { employeeId }, orderBy: { at: 'desc' } }),
    ]);
    const year = new Date().getUTCFullYear();
    const yearSpan = { start: new Date(Date.UTC(year, 0, 1)), end: new Date(Date.UTC(year, 11, 31)) };
    const annual = await this.prisma.leave.findMany({
      where: { employeeId, type: { name: 'Annual leave' }, status: { in: PENDING_OR_EFFECTIVE }, start: { lte: yearSpan.end }, end: { gte: yearSpan.start } },
    });
    const taken = annual.filter(l => EFFECTIVE.includes(l.status)).reduce((n, l) => n + overlapDays(l, yearSpan), 0);
    const pending = annual.filter(l => l.status === 'SUBMITTED').reduce((n, l) => n + overlapDays(l, yearSpan), 0);
    const entitled = settings['leave.annualEntitlementDays'] as number;
    return {
      annualLeave: { year, entitled, taken, pending, remaining: entitled - taken - pending },
      daysOffBalance: rows.reduce((n, r) => n + r.days, 0),
      ledger: rows.slice(0, 50),
    };
  }

  /** Everything that follows from a leave becoming effective (12.2 step 1-4, 12.3 impact handling). */
  async applyEffects(leaveId: string, userId?: string, onlyFrom?: Date) {
    const l = await this.loadLeave(leaveId);
    if (!l) throw new NotFoundException('Leave not found');
    const settings = await this.settings.all();
    const medical = l.type.category === 'medical';
    const window = { start: onlyFrom ?? l.start, end: l.end };
    const longTerm = medical && isLongTerm(l, settings['rules.longTermAbsenceDays'] as number);

    const released = await this.prisma.$transaction(async tx => {
      const r = await this.absence.releaseSeats(tx, l.employeeId, window, { trigger: medical ? 'medical_leave' : 'leave', sourceId: l.id });
      if (longTerm !== l.longTerm) await tx.leave.update({ where: { id: l.id }, data: { longTerm } });
      await this.syncLedger(tx, l, settings, userId);
      return r;
    });
    // A seat that needs someone today is critical: tell the people who can fix it (plan 16, 19).
    const taskIds = released.map(r => r.taskId).filter((x): x is string => !!x);
    if (taskIds.length) {
      for (const t of await this.prisma.replacementTask.findMany({ where: { id: { in: taskIds }, urgency: 'CRITICAL' } })) {
        await this.notifier.notify({
          type: 'task_critical', to: [{ role: 'DISPATCHER' }, { role: 'OPS_MANAGER' }], key: `crit:${t.id}`,
          payload: { seat: await this.notifier.seatLabel(t.seatId), from: iso(t.fromDate), to: iso(t.toDate) },
        });
      }
    }
    return { released, longTerm };
  }

  /** Recovery days consume the balance; lost off-days on medical leave are credited back when the setting says so. */
  async syncLedger(tx: Pick<PrismaService, 'daysOffLedger'>, l: NonNullable<LeaveWithType>, settings: Record<string, unknown>, userId?: string) {
    const effective = EFFECTIVE.includes(l.status);
    await tx.daysOffLedger.deleteMany({ where: { refId: l.id, reason: { in: ['recovery', 'medical_credit'] } } });
    if (!effective) return;
    if (l.type.name === 'Recovery days') {
      await tx.daysOffLedger.create({ data: { employeeId: l.employeeId, days: -inclusiveDays(l), reason: 'recovery', refId: l.id, createdBy: userId } });
    }
    if (l.type.category === 'medical' && settings['rules.creditLostOffDaysOnMedical'] === true) {
      const rp = l.employee.rotationPattern;
      const pattern: Pattern | null = rp ? { type: rp.type as Pattern['type'], daysOn: rp.daysOn ?? undefined, daysOff: rp.daysOff ?? undefined, weeklyMask: rp.weeklyMask ?? undefined } : null;
      const lost = offDaysIn(pattern, l.employee.rotationAnchorDate, l);
      if (lost > 0) await tx.daysOffLedger.create({ data: { employeeId: l.employeeId, days: lost, reason: 'medical_credit', refId: l.id, note: `${lost} off-day(s) lost to medical leave`, createdBy: userId } });
    }
  }
}

@Controller('leaves')
class LeaveController {
  constructor(
    @Inject(PrismaService) private prisma: PrismaService,
    @Inject(LeaveService) private svc: LeaveService,
    @Inject(AbsenceService) private absence: AbsenceService,
  ) {}

  private async mustLoad(id: string) {
    const l = await this.svc.loadLeave(id);
    if (!l) throw new NotFoundException('Leave not found');
    return l;
  }

  // ---------- reads (static routes first so ':id' does not swallow them)

  @Get() @Require('leave', 'view')
  async list(
    @Req() req: AuthedRequest,
    @Query() q: { employeeId?: string; baseId?: string; status?: string; category?: string; from?: string; to?: string; limit?: string; offset?: string },
  ) {
    const roles = rolesOf(req);
    const where: Record<string, unknown> = {};
    // Employees only ever see their own rows; an account not linked to an employee sees nothing.
    if (employeeOnly(roles)) {
      if (!req.user?.employeeId) return { total: 0, items: [] };
      where.employeeId = req.user.employeeId;
    } else if (q.employeeId) where.employeeId = q.employeeId;
    if (q.baseId) where.employee = { homeBaseId: q.baseId };
    if (q.status) where.status = q.status;
    if (q.category) where.type = { category: q.category };
    if (q.from) where.end = { gte: parseDate(q.from) };
    if (q.to) where.start = { lte: parseDate(q.to) };
    const { take, skip } = page(q);
    const [total, rows] = await Promise.all([
      this.prisma.leave.count({ where: where as never }),
      this.prisma.leave.findMany({
        where: where as never, orderBy: { start: 'desc' }, take, skip,
        include: { type: true, employee: { include: { homeBase: true, rotationPattern: true } }, fitForDuty: true },
      }),
    ]);
    const items = await Promise.all(rows.map(async r => ({ ...(await this.svc.view(r, req)), employee: { id: r.employee.id, firstName: r.employee.firstName, lastName: r.employee.lastName, homeBase: r.employee.homeBase.code } })));
    return { total, items };
  }

  /** Medical leaves that ended and are waiting for HR to clear the person (12.3). */
  @Get('clearance/queue') @Require('medical', 'view')
  async clearanceQueue(@Req() req: AuthedRequest) {
    if (!this.svc.staffMedicalView(req)) throw new ForbiddenException('Medical records are restricted');
    const after = (await this.svc.settings.all())['rules.clearanceRequiredAfterDays'] as number;
    const today = startOfDay(new Date());
    const rows = await this.prisma.leave.findMany({
      where: { type: { category: 'medical' }, status: 'RECORDED', end: { lt: today }, fitForDuty: null },
      include: { employee: { select: { id: true, firstName: true, lastName: true, employeeNo: true, homeBase: { select: { code: true } } } } },
      orderBy: { end: 'asc' },
    });
    return rows.filter(l => inclusiveDays(l) > after).map(l => ({
      leaveId: l.id, employee: l.employee, endedOn: iso(l.end), waitingDays: Math.round((today.getTime() - l.end.getTime()) / DAY), leaveDays: inclusiveDays(l),
    }));
  }

  /** Employees absent in the same week who share a profile: warns before a team empties out (12.4). */
  @Get('overlaps') @Require('leave', 'view')
  async overlaps(@Query() q: { baseId?: string; from?: string; weeks?: string; threshold?: string }) {
    const settings = await this.svc.settings.all();
    const threshold = parseInt(q.threshold ?? '', 10) || (settings['leave.overlapWarningThreshold'] as number);
    const start = startOfDay(q.from ? parseDate(q.from) : new Date());
    const weeks = Math.min(Math.max(parseInt(q.weeks ?? '12', 10) || 12, 1), 52);
    const end = addDays(start, weeks * 7 - 1);
    const leaves = await this.prisma.leave.findMany({
      where: { status: { in: EFFECTIVE }, start: { lte: end }, end: { gte: start }, ...(q.baseId ? { employee: { homeBaseId: q.baseId } } : {}) },
      include: { employee: { select: { id: true, homeBase: { select: { code: true } }, position: { select: { name: true } }, qualifications: { select: { qualification: { select: { name: true } } } } } } },
    });
    const out: { week: string; base: string; profile: string; people: number }[] = [];
    for (let w = 0; w < weeks; w++) {
      const span = { start: addDays(start, w * 7), end: addDays(start, w * 7 + 6) };
      const groups = new Map<string, Set<string>>();
      for (const l of leaves) {
        if (!overlapDays(l, span)) continue;
        const profiles = l.employee.qualifications.length ? l.employee.qualifications.map(x => x.qualification.name) : [''];
        for (const qn of profiles) {
          const key = `${l.employee.homeBase.code}|${l.employee.position.name}${qn ? ` (${qn})` : ''}`;
          (groups.get(key) ?? groups.set(key, new Set()).get(key)!).add(l.employee.id);
        }
      }
      for (const [key, people] of groups) {
        if (people.size >= threshold) { const [base, profile] = key.split('|'); out.push({ week: iso(span.start), base, profile, people: people.size }); }
      }
    }
    return { threshold, warnings: out };
  }

  /** Medical statistics are aggregates by base and month, never individuals (12.3). */
  @Get('stats/medical') @Require('medical', 'view')
  async medicalStats(@Req() req: AuthedRequest, @Query() q: { from?: string; to?: string }) {
    if (!this.svc.staffMedicalView(req)) throw new ForbiddenException('Medical statistics are restricted');
    const to = startOfDay(q.to ? parseDate(q.to) : new Date());
    const from = startOfDay(q.from ? parseDate(q.from) : new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() - 5, 1)));
    const [leaves, headcount] = await Promise.all([
      this.prisma.leave.findMany({
        where: { type: { category: 'medical' }, status: { in: EFFECTIVE }, start: { lte: to }, end: { gte: from } },
        select: { start: true, end: true, longTerm: true, employeeId: true, employee: { select: { homeBase: { select: { code: true } } } } },
      }),
      this.prisma.employee.groupBy({ by: ['homeBaseId'], where: { active: true }, _count: true }),
    ]);
    const bases = await this.prisma.base.findMany({ select: { id: true, code: true } });
    const heads = new Map(headcount.map(h => [bases.find(b => b.id === h.homeBaseId)?.code ?? '', h._count]));
    const rows = new Map<string, { base: string; month: string; personDays: number; people: Set<string>; longTerm: number }>();
    for (let m = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1)); m <= to; m = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1))) {
      const span = { start: m, end: new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 0)) };
      for (const l of leaves) {
        const d = overlapDays(l, span);
        if (!d) continue;
        const key = `${l.employee.homeBase.code}|${m.toISOString().slice(0, 7)}`;
        const row = rows.get(key) ?? { base: l.employee.homeBase.code, month: m.toISOString().slice(0, 7), personDays: 0, people: new Set<string>(), longTerm: 0 };
        row.personDays += d; row.people.add(l.employeeId); if (l.longTerm) row.longTerm++;
        rows.set(key, row);
      }
    }
    return [...rows.values()].map(r => {
      const [y, mo] = r.month.split('-').map(Number);
      const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
      const hc = heads.get(r.base) ?? 0;
      return { base: r.base, month: r.month, personDays: r.personDays, absenceRate: hc ? Math.round((r.personDays / (hc * days)) * 10000) / 100 : null, longTermCount: r.longTerm };
    }).sort((a, b) => a.month.localeCompare(b.month) || a.base.localeCompare(b.base));
  }

  @Get('balance/:employeeId') @Require('leave', 'view')
  async balance(@Param('employeeId') employeeId: string, @Req() req: AuthedRequest) {
    const roles = rolesOf(req);
    if (employeeOnly(roles) && !this.svc.isSelf(req, employeeId)) throw new ForbiddenException('Employees can only see their own balance');
    return this.svc.balance(employeeId);
  }

  @Get(':id') @Require('leave', 'view')
  async detail(@Param('id') id: string, @Req() req: AuthedRequest) {
    const l = await this.mustLoad(id);
    const roles = rolesOf(req);
    if (employeeOnly(roles) && !this.svc.isSelf(req, l.employeeId)) throw new ForbiddenException('Employees can only see their own leave');
    const out = await this.svc.view(l, req, true);
    // Access log for medical documents (23): who looked at what and when.
    if (l.type.category === 'medical' && 'documentUrl' in out && !this.svc.isSelf(req, l.employeeId)) {
      await audit(this.prisma, req.user?.sub, 'Leave', l.id, 'medical_view');
    }
    return out;
  }

  // ---------- writes

  @Post() @Require('leave', 'edit')
  async create(
    @Body() body: { employeeId?: string; typeId?: string; start?: string; end?: string; documentUrl?: string; notes?: string },
    @Req() req: AuthedRequest,
  ) {
    const employeeId = body?.employeeId ?? req.user?.employeeId;
    if (!employeeId) throw new BadRequestException('employeeId is required');
    const fields = pickFields({ typeId: 'string', start: 'date', end: 'date', documentUrl: 'string', notes: 'string' }, body as Record<string, unknown>, ['typeId', 'start', 'end']);
    const start = startOfDay(fields.start as Date), end = startOfDay(fields.end as Date);
    if (end < start) throw new BadRequestException('end must not be before start');

    const [emp, type] = await Promise.all([
      this.prisma.employee.findUnique({ where: { id: employeeId }, include: { homeBase: true } }),
      this.prisma.leaveType.findUnique({ where: { id: fields.typeId as string } }),
    ]);
    if (!emp || !emp.active) throw new BadRequestException('Employee does not exist or is archived');
    if (!type) throw new BadRequestException('Unknown leave type');

    const self = this.svc.isSelf(req, employeeId);
    const medical = type.category === 'medical';
    if (!self) {
      if (medical ? !this.svc.staffMedicalEdit(req) : !this.svc.canManage(req, emp)) {
        throw new ForbiddenException(medical ? 'Only HR can record medical leave for someone else' : 'You cannot create leave for this employee');
      }
    }
    if (type.category === 'absence' && self && !this.svc.canManage(req, emp)) throw new ForbiddenException('Unjustified absence is recorded by a manager');

    const warnings: string[] = [];
    if (type.needsDocument && !fields.documentUrl) {
      // HR may log a sick call from site before the certificate arrives; everyone else must attach it.
      if (medical && !self && this.svc.staffMedicalEdit(req)) warnings.push('Certificate still missing; attach it when it arrives');
      else throw new BadRequestException(`${type.name} requires a document`);
    }

    const clash = await this.prisma.leave.findFirst({ where: { employeeId, status: { in: PENDING_OR_EFFECTIVE }, start: { lte: end }, end: { gte: start } }, include: { type: true } });
    if (clash) throw new ConflictException(`Overlaps another leave (${iso(clash.start)} to ${iso(clash.end)})`);

    const days = inclusiveDays({ start, end });
    if (type.name === 'Recovery days') {
      const bal = (await this.svc.balance(employeeId)).daysOffBalance;
      if (bal < days) throw new BadRequestException(`Only ${bal} recovery day(s) available, ${days} requested`);
    }
    if (type.name === 'Annual leave') {
      const b = await this.svc.balance(employeeId);
      if (b.annualLeave.remaining < days) warnings.push(`Exceeds annual entitlement: ${b.annualLeave.remaining} day(s) remaining, ${days} requested`);
    }

    // Who decides: the employee's own request waits; a manager entering it for them is the approver.
    // Medical and absence records are facts, not requests: HR/manager entries are effective at once.
    let status: string;
    if (medical) status = self ? 'SUBMITTED' : 'RECORDED';
    else if (type.category === 'absence') status = 'RECORDED';
    else status = self && type.needsApproval ? 'SUBMITTED' : 'APPROVED';

    const leave = await this.prisma.leave.create({
      data: { employeeId, typeId: type.id, start, end, status, documentUrl: fields.documentUrl as string | undefined, notes: fields.notes as string | undefined, enteredBy: req.user?.sub, approvedBy: EFFECTIVE.includes(status) && !self ? req.user?.sub : undefined },
    });
    await audit(this.prisma, req.user?.sub, 'Leave', leave.id, medical ? 'medical_create' : 'create', null, { ...leave, notes: undefined, documentUrl: undefined });

    const effects = EFFECTIVE.includes(status) ? await this.svc.applyEffects(leave.id, req.user?.sub) : null;
    const full = (await this.svc.loadLeave(leave.id))!;
    await this.svc.announceCreated(full, req.user?.sub);
    return { leave: await this.svc.view(full, req), effects, warnings };
  }

  /** Approve a request, or (medical) validate the certificate an employee submitted. */
  @Post(':id/approve') @Require('leave', 'edit')
  async approve(@Param('id') id: string, @Body() body: { note?: string }, @Req() req: AuthedRequest) {
    const l = await this.mustLoad(id);
    if (l.status !== 'SUBMITTED') throw new BadRequestException(`Only submitted requests can be approved (this one is ${l.status.toLowerCase()})`);
    const medical = l.type.category === 'medical';
    if (medical ? !this.svc.staffMedicalEdit(req) : !this.svc.canManage(req, l.employee)) throw new ForbiddenException('You cannot decide this request');
    if (this.svc.isSelf(req, l.employeeId) && !can(rolesOf(req).filter(r => r !== 'EMPLOYEE'), 'leave', 'full')) throw new ForbiddenException('You cannot approve your own request');
    if (l.type.name === 'Recovery days' && (await this.svc.balance(l.employeeId)).daysOffBalance < inclusiveDays(l)) {
      throw new BadRequestException('Not enough days-off balance for these recovery days');
    }
    // Re-check overlap now: something else may have been approved since the request was made.
    const clash = await this.prisma.leave.findFirst({ where: { id: { not: id }, employeeId: l.employeeId, status: { in: EFFECTIVE }, start: { lte: l.end }, end: { gte: l.start } } });
    if (clash) throw new ConflictException('Overlaps a leave that is already in effect');

    const status = medical ? 'RECORDED' : 'APPROVED';
    await this.prisma.leave.update({ where: { id }, data: { status, approvedBy: req.user?.sub, decisionNote: body?.note } });
    await audit(this.prisma, req.user?.sub, 'Leave', id, medical ? 'medical_validate' : 'approve', { status: l.status }, { status });
    const effects = await this.svc.applyEffects(id, req.user?.sub);
    await this.svc.announceDecision(l, 'approved', body?.note, req.user?.sub);
    return { status, effects };
  }

  @Post(':id/reject') @Require('leave', 'edit')
  async reject(@Param('id') id: string, @Body() body: { reason?: string }, @Req() req: AuthedRequest) {
    const l = await this.mustLoad(id);
    if (l.status !== 'SUBMITTED') throw new BadRequestException('Only submitted requests can be rejected');
    const medical = l.type.category === 'medical';
    if (medical ? !this.svc.staffMedicalEdit(req) : !this.svc.canManage(req, l.employee)) throw new ForbiddenException('You cannot decide this request');
    if (!body?.reason?.trim()) throw new BadRequestException('A reason is required to reject');
    await this.prisma.leave.update({ where: { id }, data: { status: 'REJECTED', decisionNote: body.reason.trim(), approvedBy: req.user?.sub } });
    await audit(this.prisma, req.user?.sub, 'Leave', id, 'reject', { status: l.status }, { status: 'REJECTED' }, body.reason);
    await this.svc.announceDecision(l, 'rejected', body.reason.trim(), req.user?.sub);
    return { status: 'REJECTED' };
  }

  /** Cancel before or during the leave. Seats already handed to someone else stay with them. */
  @Post(':id/cancel') @Require('leave', 'edit')
  async cancel(@Param('id') id: string, @Body() body: { reason?: string }, @Req() req: AuthedRequest) {
    const l = await this.mustLoad(id);
    if (!PENDING_OR_EFFECTIVE.includes(l.status)) throw new BadRequestException(`A ${l.status.toLowerCase()} leave cannot be cancelled`);
    const self = this.svc.isSelf(req, l.employeeId);
    const manager = l.type.category === 'medical' ? this.svc.staffMedicalEdit(req) : this.svc.canManage(req, l.employee);
    const allowed = (self && l.status === 'SUBMITTED') || manager;
    if (!allowed) throw new ForbiddenException('You cannot cancel this leave');
    await this.prisma.$transaction(async tx => {
      await tx.leave.update({ where: { id }, data: { status: 'CANCELLED', decisionNote: body?.reason } });
      await this.absence.closeTasks(tx, id);
      await this.svc.syncLedger(tx, { ...l, status: 'CANCELLED' }, await this.svc.settings.all(), req.user?.sub);
    });
    await audit(this.prisma, req.user?.sub, 'Leave', id, 'cancel', { status: l.status }, { status: 'CANCELLED' }, body?.reason);
    return { status: 'CANCELLED', note: EFFECTIVE.includes(l.status) ? 'Open replacement tasks closed; seats already reassigned are not changed' : undefined };
  }

  /** The person returns before the planned end. `lastDay` becomes the final day of leave. */
  @Post(':id/return-early') @Require('leave', 'edit')
  async returnEarly(@Param('id') id: string, @Body() body: { lastDay?: string }, @Req() req: AuthedRequest) {
    const l = await this.mustLoad(id);
    if (!EFFECTIVE.includes(l.status)) throw new BadRequestException('Only leave in effect can be shortened');
    if (l.type.category === 'medical' ? !this.svc.staffMedicalEdit(req) : !this.svc.canManage(req, l.employee)) throw new ForbiddenException('You cannot change this leave');
    if (!body?.lastDay) throw new BadRequestException('lastDay is required');
    const lastDay = startOfDay(parseDate(body.lastDay));
    if (lastDay < startOfDay(l.start) || lastDay >= startOfDay(l.end)) throw new BadRequestException('lastDay must fall within the leave and before its current end');

    await this.prisma.$transaction(async tx => {
      await tx.leave.update({ where: { id }, data: { end: lastDay, longTerm: l.type.category === 'medical' && isLongTerm({ start: l.start, end: lastDay }, (await this.svc.settings.all())['rules.longTermAbsenceDays'] as number) } });
      await this.absence.closeTasks(tx, id, lastDay);
    });
    await this.svc.syncLedger(this.prisma, (await this.svc.loadLeave(id))!, await this.svc.settings.all(), req.user?.sub);
    await audit(this.prisma, req.user?.sub, 'Leave', id, 'shorten', { end: l.end }, { end: lastDay });
    return { end: iso(lastDay) };
  }

  /** Medical leave extended with a new certificate (12.3). Only the added days free more seats. */
  @Post(':id/extend') @Require('medical', 'edit')
  async extend(@Param('id') id: string, @Body() body: { newEnd?: string; documentUrl?: string }, @Req() req: AuthedRequest) {
    const l = await this.mustLoad(id);
    if (l.type.category !== 'medical') throw new BadRequestException('Only medical leave is extended this way');
    if (!this.svc.staffMedicalEdit(req)) throw new ForbiddenException('Only HR can extend medical leave');
    if (!EFFECTIVE.includes(l.status)) throw new BadRequestException('Only recorded medical leave can be extended');
    if (!body?.newEnd || !body.documentUrl) throw new BadRequestException('newEnd and a new certificate (documentUrl) are required');
    const newEnd = startOfDay(parseDate(body.newEnd));
    if (newEnd <= startOfDay(l.end)) throw new BadRequestException('newEnd must be after the current end');
    const clash = await this.prisma.leave.findFirst({ where: { id: { not: id }, employeeId: l.employeeId, status: { in: PENDING_OR_EFFECTIVE }, start: { lte: newEnd }, end: { gt: l.end } } });
    if (clash) throw new ConflictException('The extension overlaps another leave');

    const from = addDays(l.end, 1);
    await this.prisma.leave.update({ where: { id }, data: { end: newEnd, documentUrl: body.documentUrl } });
    const effects = await this.svc.applyEffects(id, req.user?.sub, from);
    await audit(this.prisma, req.user?.sub, 'Leave', id, 'medical_extend', { end: l.end }, { end: newEnd });
    return { end: iso(newEnd), ...effects };
  }

  /** Fit-for-duty clearance, optionally with a restriction (12.3). Unit-seat restrictions free the person's unit seats. */
  @Post(':id/clearance') @Require('medical', 'edit')
  async clear(
    @Param('id') id: string,
    @Body() body: { restriction?: { kind?: string; end?: string; note?: string } },
    @Req() req: AuthedRequest,
  ) {
    const l = await this.mustLoad(id);
    if (l.type.category !== 'medical') throw new BadRequestException('Clearance applies to medical leave');
    if (!this.svc.staffMedicalEdit(req)) throw new ForbiddenException('Only HR can clear someone for duty');
    if (!EFFECTIVE.includes(l.status)) throw new BadRequestException('Leave is not in effect');
    if (l.fitForDuty) throw new BadRequestException('Already cleared');
    const today = startOfDay(new Date());
    if (startOfDay(l.end) >= today) throw new BadRequestException('Clearance can be given once the leave has ended');

    const r = body?.restriction;
    if (r && !['base_only', 'no_field', 'no_night', 'custom'].includes(r.kind ?? '')) throw new BadRequestException('restriction.kind must be base_only, no_field, no_night or custom');
    const rEnd = r?.end ? startOfDay(parseDate(r.end)) : null;
    if (rEnd && rEnd < today) throw new BadRequestException('restriction.end is in the past');

    const result = await this.prisma.$transaction(async tx => {
      const restriction = r ? await tx.restriction.create({ data: { employeeId: l.employeeId, kind: r.kind!, start: today, end: rEnd, source: 'fit_for_duty' } }) : null;
      const ffd = await tx.fitForDuty.create({ data: { leaveId: id, clearedAt: new Date(), clearedBy: req.user?.sub ?? 'unknown', restrictionId: restriction?.id } });
      const released = restriction && ['base_only', 'no_field'].includes(restriction.kind)
        ? await this.absence.releaseSeats(tx, l.employeeId, { start: today, end: FAR_FUTURE }, { trigger: 'restriction', sourceId: restriction.id, unitSeatsOnly: true })
        : [];
      return { ffd, restriction, released };
    });
    await audit(this.prisma, req.user?.sub, 'Leave', id, 'clearance', null, { restriction: result.restriction?.kind ?? null });
    if (result.restriction) {
      await this.svc.notifier.notify({
        type: 'restriction_changed', except: req.user?.sub, to: [{ employeeId: l.employeeId }, { role: 'DISPATCHER' }],
        payload: { action: 'added', kind: result.restriction.kind, until: result.restriction.end ? iso(result.restriction.end) : undefined, employee: `${l.employee.firstName} ${l.employee.lastName}` },
      });
    }
    return result;
  }
}

/** Restrictions can also be set by a manager without any medical leave (e.g. "no night work"). */
@Controller('employees')
class RestrictionsController {
  constructor(
    @Inject(PrismaService) private prisma: PrismaService,
    @Inject(AbsenceService) private absence: AbsenceService,
    @Inject(NotificationsService) private notifier: NotificationsService,
  ) {}

  @Post(':id/restrictions') @Require('employees', 'full')
  async add(@Param('id') id: string, @Body() body: { kind?: string; start?: string; end?: string }, @Req() req: AuthedRequest) {
    if (!['base_only', 'no_field', 'no_night', 'custom'].includes(body?.kind ?? '')) throw new BadRequestException('kind must be base_only, no_field, no_night or custom');
    const emp = await this.prisma.employee.findUnique({ where: { id } });
    if (!emp) throw new NotFoundException('Employee not found');
    const start = startOfDay(body.start ? parseDate(body.start) : new Date());
    const end = body.end ? startOfDay(parseDate(body.end)) : null;
    if (end && end < start) throw new BadRequestException('end must not be before start');
    const out = await this.prisma.$transaction(async tx => {
      const restriction = await tx.restriction.create({ data: { employeeId: id, kind: body.kind!, start, end, source: 'manager' } });
      const released = ['base_only', 'no_field'].includes(restriction.kind)
        ? await this.absence.releaseSeats(tx, id, { start, end: end ?? FAR_FUTURE }, { trigger: 'restriction', sourceId: restriction.id, unitSeatsOnly: true })
        : [];
      return { restriction, released };
    });
    await audit(this.prisma, req.user?.sub, 'Employee', id, 'restriction_add', null, out.restriction);
    await this.notifier.notify({
      type: 'restriction_changed', except: req.user?.sub, to: [{ employeeId: id }, { role: 'DISPATCHER' }],
      payload: { action: 'added', kind: body.kind, until: end ? iso(end) : undefined, employee: `${emp.firstName} ${emp.lastName}` },
    });
    return out;
  }

  /** Ending a restriction stamps today as its last day. */
  @Delete(':id/restrictions/:restrictionId') @Require('employees', 'full')
  async end(@Param('id') id: string, @Param('restrictionId') restrictionId: string, @Req() req: AuthedRequest) {
    const r = await this.prisma.restriction.findFirst({ where: { id: restrictionId, employeeId: id } });
    if (!r) throw new NotFoundException('Restriction not found');
    const today = startOfDay(new Date());
    if (r.end && r.end <= today) throw new BadRequestException('Restriction has already ended');
    const after = await this.prisma.restriction.update({ where: { id: restrictionId }, data: { end: today } });
    await audit(this.prisma, req.user?.sub, 'Employee', id, 'restriction_end', r, after);
    await this.notifier.notify({ type: 'restriction_changed', except: req.user?.sub, to: [{ employeeId: id }, { role: 'DISPATCHER' }], payload: { action: 'ended', kind: r.kind } });
    return after;
  }
}

@Module({
  imports: [SettingsModule, AbsenceModule],
  controllers: [LeaveController, RestrictionsController],
  providers: [LeaveService],
  exports: [LeaveService],
})
export class LeaveModule {}
