import { BadRequestException, Body, Controller, Get, Inject, Module, NotFoundException, Put, Req } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthedRequest } from '../auth/auth.module';
import { EmployeeInsightsService, InsightsModule } from '../employees/insights';
import { CalendarCoreModule, CalendarService, addDays, iso } from '../calendar/calendar.service';
import { LeaveModule, LeaveService } from '../leave/leave';
import { audit, pickFields } from '../common/validate';
import { countFieldDays } from '../domain/derived';
import { startOfDay } from '../domain/status';

const LIVE = ['CONFIRMED', 'ACTIVE'] as const;
const WORKING = new Set(['ON_UNIT', 'EXTENDED', 'ON_BASE_POST', 'STANDBY']);

/** Everything the employee portal needs about the signed-in person (plan 18). Every route is "mine". */
@Controller('portal')
class PortalController {
  constructor(
    @Inject(PrismaService) private prisma: PrismaService,
    @Inject(CalendarService) private cal: CalendarService,
    @Inject(EmployeeInsightsService) private insights: EmployeeInsightsService,
    @Inject(LeaveService) private leave: LeaveService,
  ) {}

  private me(req: AuthedRequest): string {
    if (!req.user?.employeeId) throw new BadRequestException('Your account is not linked to an employee, so there is no schedule to show');
    return req.user.employeeId;
  }

  private personLabel(e: { firstName: string; lastName: string }) { return `${e.firstName} ${e.lastName}`; }

  /** "Today": my status, my seat, my crew, who is my chief, who replaces me, and what needs my attention. */
  @Get('today')
  async today(@Req() req: AuthedRequest) {
    const id = this.me(req);
    const today = startOfDay(new Date());
    const emp = await this.prisma.employee.findUnique({ where: { id }, include: { position: true, homeBase: true } });
    if (!emp) throw new NotFoundException('Employee not found');

    const ahead = (await this.cal.buildDays([id], today, addDays(today, 180), { canSeeMedical: () => true })).get(id) ?? [];
    const first = ahead[0];
    const nextOff = ahead.find(c => c.status === 'DAYS_OFF');
    const nextOn = ahead.find((c, i) => i > 0 && WORKING.has(c.status) && !WORKING.has(ahead[i - 1].status));

    const include = {
      seat: { include: { position: { select: { name: true } }, unit: { include: { unitType: true, deployments: { where: { start: { lte: today }, end: { gte: today } }, include: { job: { include: { site: true } } } } } }, base: true } },
    } as const;
    const current = await this.prisma.assignment.findFirst({ where: { employeeId: id, status: { in: [...LIVE] }, start: { lte: today }, plannedEnd: { gte: today } }, include, orderBy: { start: 'desc' } });
    const upcoming = current ? null : await this.prisma.assignment.findFirst({ where: { employeeId: id, status: { in: [...LIVE] }, start: { gt: today } }, include, orderBy: { start: 'asc' } });
    const shown = current ?? upcoming;

    let seat: Record<string, unknown> | null = null;
    let team: { id: string; name: string; position: string }[] = [];
    let supervisor: { id: string; name: string; role: string } | null = null;
    let replacement: { replacedBy: { name: string; from: string } | null; replacing: { name: string; until: string } | null } = { replacedBy: null, replacing: null };
    let nextCrewChange: { date: string; seat: string } | null = null;

    if (shown) {
      const s = shown.seat;
      const unit = s.unit;
      const job = unit?.deployments[0]?.job;
      const label = `${unit?.code ?? `${s.base?.code} base`} · ${s.position.name} #${s.index}`;
      seat = {
        label, position: s.position.name, kind: unit ? 'unit' : 'base', from: iso(shown.start), to: iso(shown.plannedEnd), upcoming: !current,
        unit: unit ? { code: unit.code, type: unit.unitType.name } : null, base: s.base ? { code: s.base.code, name: s.base.name } : null,
        job: job ? { well: job.wellName, rig: job.rigName, site: job.site.name, travelHours: job.site.travelHours } : null,
      };
      // Crew mates: the others on the same unit today, or the others at the same base (never the medical reasons of anyone).
      const mates = await this.prisma.assignment.findMany({
        where: { status: { in: [...LIVE] }, start: { lte: shown.start > today ? shown.start : today }, plannedEnd: { gte: shown.start > today ? shown.start : today }, employeeId: { not: id }, seat: unit ? { unitId: unit.id } : { baseId: s.baseId, holderType: 'BASE' } },
        include: { employee: { select: { id: true, firstName: true, lastName: true } }, seat: { include: { position: { select: { name: true } } } } },
      });
      team = mates.map(m => ({ id: m.employee.id, name: this.personLabel(m.employee), position: m.seat.position.name }));
      const chief = mates.find(m => m.seat.position.name === 'Chief of Unit');
      if (unit && chief) supervisor = { id: chief.employee.id, name: this.personLabel(chief.employee), role: 'Chief of Unit' };
      if (!unit && s.baseId) {
        const mgr = await this.prisma.employee.findFirst({ where: { homeBaseId: s.baseId, position: { name: 'Base Manager' }, active: true, id: { not: id } }, select: { id: true, firstName: true, lastName: true } });
        if (mgr) supervisor = { id: mgr.id, name: this.personLabel(mgr), role: 'Base manager' };
      }
      // My replacement and who I am replacing (plan 18 "My replacement").
      const after = await this.prisma.assignment.findFirst({
        where: { seatId: shown.seatId, status: { in: [...LIVE] }, id: { not: shown.id }, start: { gt: shown.start } }, orderBy: { start: 'asc' },
        include: { employee: { select: { firstName: true, lastName: true } } },
      });
      const before = shown.replacesId
        ? await this.prisma.assignment.findUnique({ where: { id: shown.replacesId }, include: { employee: { select: { firstName: true, lastName: true } } } })
        : await this.prisma.assignment.findFirst({ where: { seatId: shown.seatId, id: { not: shown.id }, plannedEnd: { gte: addDays(shown.start, -2), lt: shown.start } }, orderBy: { plannedEnd: 'desc' }, include: { employee: { select: { firstName: true, lastName: true } } } });
      replacement = {
        replacedBy: after ? { name: this.personLabel(after.employee), from: iso(after.start) } : null,
        replacing: before ? { name: this.personLabel(before.employee), until: iso(before.plannedEnd) } : null,
      };
      nextCrewChange = { date: iso(addDays(shown.plannedEnd, 1)), seat: label };
    }

    const [unread, pendingAck] = await Promise.all([
      this.prisma.notification.count({ where: { userId: req.user!.sub, readAt: null } }),
      this.prisma.notification.count({ where: { userId: req.user!.sub, requiresAck: true, acknowledgedAt: null } }),
    ]);
    return {
      date: iso(today),
      employee: { id: emp.id, name: this.personLabel(emp), employeeNo: emp.employeeNo, position: emp.position.name, base: emp.homeBase.code },
      status: first ? { status: first.status, label: first.label } : null, restrictions: first?.restrictions ?? [],
      seat, team, supervisor, replacement, nextCrewChange,
      nextDaysOff: nextOff?.date ?? null, nextBackOn: nextOn?.date ?? null,
      unread, pendingAck,
    };
  }

  /** My numbers: days worked this year, extension days, days-off balance, leave balance (plan 18 "My stats"). */
  @Get('stats')
  async stats(@Req() req: AuthedRequest) {
    const id = this.me(req);
    const today = startOfDay(new Date());
    const year = today.getUTCFullYear();
    const emp = await this.prisma.employee.findUnique({ where: { id }, include: { rotationPattern: true } });
    if (!emp) throw new NotFoundException('Employee not found');
    const [computed, balance, ext, basePosts] = await Promise.all([
      this.insights.enrich([emp], today),
      this.leave.balance(id),
      this.prisma.extension.findMany({ where: { employeeId: id, status: 'APPROVED', createdAt: { gte: new Date(Date.UTC(year, 0, 1)) } }, select: { days: true } }),
      this.prisma.assignment.findMany({ where: { employeeId: id, status: { in: [...LIVE, 'COMPLETED'] }, seat: { holderType: 'BASE' }, plannedEnd: { gte: new Date(Date.UTC(year, 0, 1)) } }, select: { start: true, plannedEnd: true, actualEnd: true } }),
    ]);
    const c = computed.get(id)!;
    const yearStart = new Date(Date.UTC(year, 0, 1));
    return {
      year, seniority: c.seniority, yearsOfService: c.yearsOfService,
      fieldDaysYear: c.fieldDaysYear, fieldDaysTotal: c.fieldDays,
      baseDaysYear: countFieldDays(basePosts.map(a => ({ start: a.start < yearStart ? yearStart : a.start, end: a.actualEnd ?? a.plannedEnd })), today),
      extensionDaysYear: ext.reduce((n, x) => n + x.days, 0),
      daysOffBalance: balance.daysOffBalance, annualLeave: balance.annualLeave,
    };
  }

  @Get('profile')
  async profile(@Req() req: AuthedRequest) {
    const id = this.me(req);
    const today = startOfDay(new Date());
    const e = await this.prisma.employee.findUnique({
      where: { id },
      include: { position: true, homeBase: true, rotationPattern: true, qualifications: { include: { qualification: true } }, certifications: { include: { type: true }, orderBy: { issuedAt: 'desc' } }, restrictions: { where: { OR: [{ end: null }, { end: { gte: today } }] } } },
    });
    if (!e) throw new NotFoundException('Employee not found');
    return {
      id: e.id, employeeNo: e.employeeNo, name: this.personLabel(e), position: e.position.name, base: e.homeBase.code, hireDate: iso(e.hireDate),
      phone: e.phone, email: e.email, emergencyContact: e.emergencyContact, homeCity: e.homeCity,
      rotation: e.rotationPattern?.name ?? null, restrictions: e.restrictions.map(r => ({ kind: r.kind, until: r.end ? iso(r.end) : null })),
      qualifications: e.qualifications.map(q => ({ name: q.qualification.name, obtained: iso(q.obtainedAt) })),
      certifications: e.certifications.map(c => ({ id: c.id, name: c.type.name, issued: iso(c.issuedAt) })),
    };
  }

  /** The only fields a person edits about themselves: contact details. */
  @Put('profile')
  async update(@Body() body: Record<string, unknown>, @Req() req: AuthedRequest) {
    const id = this.me(req);
    const data = pickFields({ phone: 'string', email: 'string', emergencyContact: 'string', homeCity: 'string' }, body);
    if (Object.keys(data).length === 0) throw new BadRequestException('Nothing to change');
    if (typeof data.email === 'string' && data.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(data.email)) throw new BadRequestException('That email address does not look right');
    const before = await this.prisma.employee.findUnique({ where: { id }, select: { phone: true, email: true, emergencyContact: true, homeCity: true } });
    await this.prisma.employee.update({ where: { id }, data: data as never });
    await audit(this.prisma, req.user!.sub, 'Employee', id, 'profile_update', before, data);
    return this.profile(req);
  }
}

@Module({ imports: [InsightsModule, CalendarCoreModule, LeaveModule], controllers: [PortalController] })
export class PortalModule {}
