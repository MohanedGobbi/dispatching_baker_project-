import {
  BadRequestException, Body, ConflictException, Controller, Delete, Get, Inject, Injectable, Module,
  NotFoundException, Param, Post, Query,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsModule, SettingsService } from '../settings/settings';
import { AbsenceModule, AbsenceService } from '../absence/absence.service';
import { audit, MANAGER, page, parseDate, pickFields } from '../common/validate';
import { inclusiveDays, isLongTerm, offDaysIn, overlapDays } from '../domain/absence';
import { Pattern, startOfDay } from '../domain/status';

const DAY = 86_400_000;
const FAR_FUTURE = new Date('9999-12-31T00:00:00Z');
const EFFECTIVE = ['APPROVED', 'RECORDED'];            // statuses that actually remove the person
const PENDING_OR_EFFECTIVE = ['SUBMITTED', ...EFFECTIVE];
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(startOfDay(d).getTime() + n * DAY);

type LeaveWithType = Awaited<ReturnType<LeaveService['loadLeave']>>;

@Injectable()
export class LeaveService {
  constructor(
    @Inject(PrismaService) public prisma: PrismaService,
    @Inject(SettingsService) public settings: SettingsService,
    @Inject(AbsenceService) public absence: AbsenceService,
  ) {}

  loadLeave(id: string) {
    return this.prisma.leave.findUnique({ where: { id }, include: { type: true, employee: { include: { homeBase: true, rotationPattern: true } }, fitForDuty: true } });
  }

  /** A leave as the screens show it; the detail adds notes, the document and the clearance. */
  view(l: NonNullable<LeaveWithType>, detail = false) {
    const full = {
      id: l.id, employeeId: l.employeeId, start: l.start, end: l.end, status: l.status, longTerm: l.longTerm,
      type: { id: l.type.id, name: l.type.name, category: l.type.category }, decisionNote: l.decisionNote, approvedBy: l.approvedBy, enteredBy: l.enteredBy,
    };
    if (!detail) return full;
    return { ...full, notes: l.notes, documentUrl: l.documentUrl, fitForDuty: l.fitForDuty ?? undefined };
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

  @Get() async list(
    @Query() q: { employeeId?: string; baseId?: string; status?: string; category?: string; from?: string; to?: string; limit?: string; offset?: string },
  ) {
    const where: Record<string, unknown> = {};
    if (q.employeeId) where.employeeId = q.employeeId;
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
    const items = rows.map(r => ({ ...this.svc.view(r), employee: { id: r.employee.id, firstName: r.employee.firstName, lastName: r.employee.lastName, homeBase: r.employee.homeBase.code } }));
    return { total, items };
  }

  /** Medical leaves that ended and are waiting for HR to clear the person (12.3). */
  @Get('clearance/queue') async clearanceQueue() {
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
  @Get('overlaps') async overlaps(@Query() q: { baseId?: string; from?: string; weeks?: string; threshold?: string }) {
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
  @Get('stats/medical') async medicalStats(@Query() q: { from?: string; to?: string }) {
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

  @Get('balance/:employeeId') async balance(@Param('employeeId') employeeId: string) {
    return this.svc.balance(employeeId);
  }

  @Get(':id') async detail(@Param('id') id: string) {
    const l = await this.mustLoad(id);
    return this.svc.view(l, true);
  }

  // ---------- writes

  @Post() async create(
    @Body() body: { employeeId?: string; typeId?: string; start?: string; end?: string; documentUrl?: string; notes?: string },
  ) {
    const employeeId = body?.employeeId;
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

    const medical = type.category === 'medical';

    const warnings: string[] = [];
    if (type.needsDocument && !fields.documentUrl) {
      // A sick call from site can be logged before the certificate arrives.
      if (medical) warnings.push('Certificate still missing; attach it when it arrives');
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

    // The manager enters it, so it is in effect at once: medical and absence records are facts, the rest approved.
    const status = medical || type.category === 'absence' ? 'RECORDED' : 'APPROVED';

    const leave = await this.prisma.leave.create({
      data: { employeeId, typeId: type.id, start, end, status, documentUrl: fields.documentUrl as string | undefined, notes: fields.notes as string | undefined, enteredBy: MANAGER, approvedBy: MANAGER },
    });
    await audit(this.prisma, 'Leave', leave.id, medical ? 'medical_create' : 'create', null, { ...leave, notes: undefined, documentUrl: undefined });

    const effects = await this.svc.applyEffects(leave.id, MANAGER);
    const full = (await this.svc.loadLeave(leave.id))!;
    return { leave: this.svc.view(full), effects, warnings };
  }

  /** Approve a request, or (medical) validate the certificate an employee submitted. */
  @Post(':id/approve') async approve(@Param('id') id: string, @Body() body: { note?: string }) {
    const l = await this.mustLoad(id);
    if (l.status !== 'SUBMITTED') throw new BadRequestException(`Only submitted requests can be approved (this one is ${l.status.toLowerCase()})`);
    const medical = l.type.category === 'medical';
    if (l.type.name === 'Recovery days' && (await this.svc.balance(l.employeeId)).daysOffBalance < inclusiveDays(l)) {
      throw new BadRequestException('Not enough days-off balance for these recovery days');
    }
    // Re-check overlap now: something else may have been approved since the request was made.
    const clash = await this.prisma.leave.findFirst({ where: { id: { not: id }, employeeId: l.employeeId, status: { in: EFFECTIVE }, start: { lte: l.end }, end: { gte: l.start } } });
    if (clash) throw new ConflictException('Overlaps a leave that is already in effect');

    const status = medical ? 'RECORDED' : 'APPROVED';
    await this.prisma.leave.update({ where: { id }, data: { status, approvedBy: MANAGER, decisionNote: body?.note } });
    await audit(this.prisma, 'Leave', id, medical ? 'medical_validate' : 'approve', { status: l.status }, { status });
    const effects = await this.svc.applyEffects(id, MANAGER);
    return { status, effects };
  }

  @Post(':id/reject') async reject(@Param('id') id: string, @Body() body: { reason?: string }) {
    const l = await this.mustLoad(id);
    if (l.status !== 'SUBMITTED') throw new BadRequestException('Only submitted requests can be rejected');
    const medical = l.type.category === 'medical';
    if (!body?.reason?.trim()) throw new BadRequestException('A reason is required to reject');
    await this.prisma.leave.update({ where: { id }, data: { status: 'REJECTED', decisionNote: body.reason.trim(), approvedBy: MANAGER } });
    await audit(this.prisma, 'Leave', id, 'reject', { status: l.status }, { status: 'REJECTED' }, body.reason);
    return { status: 'REJECTED' };
  }

  /** Cancel before or during the leave. Seats already handed to someone else stay with them. */
  @Post(':id/cancel') async cancel(@Param('id') id: string, @Body() body: { reason?: string }) {
    const l = await this.mustLoad(id);
    if (!PENDING_OR_EFFECTIVE.includes(l.status)) throw new BadRequestException(`A ${l.status.toLowerCase()} leave cannot be cancelled`);
    await this.prisma.$transaction(async tx => {
      await tx.leave.update({ where: { id }, data: { status: 'CANCELLED', decisionNote: body?.reason } });
      await this.absence.closeTasks(tx, id);
      await this.svc.syncLedger(tx, { ...l, status: 'CANCELLED' }, await this.svc.settings.all(), MANAGER);
    });
    await audit(this.prisma, 'Leave', id, 'cancel', { status: l.status }, { status: 'CANCELLED' }, body?.reason);
    return { status: 'CANCELLED', note: EFFECTIVE.includes(l.status) ? 'Open replacement tasks closed; seats already reassigned are not changed' : undefined };
  }

  /** The person returns before the planned end. `lastDay` becomes the final day of leave. */
  @Post(':id/return-early') async returnEarly(@Param('id') id: string, @Body() body: { lastDay?: string }) {
    const l = await this.mustLoad(id);
    if (!EFFECTIVE.includes(l.status)) throw new BadRequestException('Only leave in effect can be shortened');
    if (!body?.lastDay) throw new BadRequestException('lastDay is required');
    const lastDay = startOfDay(parseDate(body.lastDay));
    if (lastDay < startOfDay(l.start) || lastDay >= startOfDay(l.end)) throw new BadRequestException('lastDay must fall within the leave and before its current end');

    await this.prisma.$transaction(async tx => {
      await tx.leave.update({ where: { id }, data: { end: lastDay, longTerm: l.type.category === 'medical' && isLongTerm({ start: l.start, end: lastDay }, (await this.svc.settings.all())['rules.longTermAbsenceDays'] as number) } });
      await this.absence.closeTasks(tx, id, lastDay);
    });
    await this.svc.syncLedger(this.prisma, (await this.svc.loadLeave(id))!, await this.svc.settings.all(), MANAGER);
    await audit(this.prisma, 'Leave', id, 'shorten', { end: l.end }, { end: lastDay });
    return { end: iso(lastDay) };
  }

  /** Medical leave extended with a new certificate (12.3). Only the added days free more seats. */
  @Post(':id/extend') async extend(@Param('id') id: string, @Body() body: { newEnd?: string; documentUrl?: string }) {
    const l = await this.mustLoad(id);
    if (l.type.category !== 'medical') throw new BadRequestException('Only medical leave is extended this way');
    if (!EFFECTIVE.includes(l.status)) throw new BadRequestException('Only recorded medical leave can be extended');
    if (!body?.newEnd || !body.documentUrl) throw new BadRequestException('newEnd and a new certificate (documentUrl) are required');
    const newEnd = startOfDay(parseDate(body.newEnd));
    if (newEnd <= startOfDay(l.end)) throw new BadRequestException('newEnd must be after the current end');
    const clash = await this.prisma.leave.findFirst({ where: { id: { not: id }, employeeId: l.employeeId, status: { in: PENDING_OR_EFFECTIVE }, start: { lte: newEnd }, end: { gt: l.end } } });
    if (clash) throw new ConflictException('The extension overlaps another leave');

    const from = addDays(l.end, 1);
    await this.prisma.leave.update({ where: { id }, data: { end: newEnd, documentUrl: body.documentUrl } });
    const effects = await this.svc.applyEffects(id, MANAGER, from);
    await audit(this.prisma, 'Leave', id, 'medical_extend', { end: l.end }, { end: newEnd });
    return { end: iso(newEnd), ...effects };
  }

  /** Fit-for-duty clearance, optionally with a restriction (12.3). Unit-seat restrictions free the person's unit seats. */
  @Post(':id/clearance') async clear(
    @Param('id') id: string,
    @Body() body: { restriction?: { kind?: string; end?: string; note?: string } },
  ) {
    const l = await this.mustLoad(id);
    if (l.type.category !== 'medical') throw new BadRequestException('Clearance applies to medical leave');
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
      const ffd = await tx.fitForDuty.create({ data: { leaveId: id, clearedAt: new Date(), clearedBy: MANAGER, restrictionId: restriction?.id } });
      const released = restriction && ['base_only', 'no_field'].includes(restriction.kind)
        ? await this.absence.releaseSeats(tx, l.employeeId, { start: today, end: FAR_FUTURE }, { trigger: 'restriction', sourceId: restriction.id, unitSeatsOnly: true })
        : [];
      return { ffd, restriction, released };
    });
    await audit(this.prisma, 'Leave', id, 'clearance', null, { restriction: result.restriction?.kind ?? null });
    return result;
  }
}

/** Restrictions can also be set by a manager without any medical leave (e.g. "no night work"). */
@Controller('employees')
class RestrictionsController {
  constructor(
    @Inject(PrismaService) private prisma: PrismaService,
    @Inject(AbsenceService) private absence: AbsenceService,
  ) {}

  @Post(':id/restrictions') async add(@Param('id') id: string, @Body() body: { kind?: string; start?: string; end?: string }) {
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
    await audit(this.prisma, 'Employee', id, 'restriction_add', null, out.restriction);
    return out;
  }

  /** Ending a restriction stamps today as its last day. */
  @Delete(':id/restrictions/:restrictionId') async end(@Param('id') id: string, @Param('restrictionId') restrictionId: string) {
    const r = await this.prisma.restriction.findFirst({ where: { id: restrictionId, employeeId: id } });
    if (!r) throw new NotFoundException('Restriction not found');
    const today = startOfDay(new Date());
    if (r.end && r.end <= today) throw new BadRequestException('Restriction has already ended');
    const after = await this.prisma.restriction.update({ where: { id: restrictionId }, data: { end: today } });
    await audit(this.prisma, 'Employee', id, 'restriction_end', r, after);
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
