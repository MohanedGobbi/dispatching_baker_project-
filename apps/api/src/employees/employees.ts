import {
  BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Inject, Module, NotFoundException,
  Param, Post, Put, Query, Req,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Require, AuthedRequest } from '../auth/auth.module';
import { can } from '../auth/permissions';
import { EmployeeInsightsService, InsightsModule } from './insights';
import { audit, page, parseDate, pickFields, Spec } from '../common/validate';
import { startOfDay, Seniority } from '../domain/status';
import { SettingsModule, SettingsService } from '../settings/settings';

const FULL_SPEC: Spec = {
  employeeNo: 'string', firstName: 'string', lastName: 'string', photoUrl: 'string', phone: 'string', email: 'string',
  emergencyContact: 'string', homeCity: 'string', positionId: 'string', workMode: 'string', hireDate: 'date',
  contractType: 'string', homeBaseId: 'string', rotationPatternId: 'string', rotationAnchorDate: 'date',
  backToBackId: 'string', priorFieldDays: 'number', tags: 'string[]', managerNotes: 'string',
};
// Dispatchers get "view + limited edit" (plan section 3).
const LIMITED_FIELDS = new Set(['phone', 'email', 'emergencyContact', 'tags', 'backToBackId']);
const WORK_MODES = ['FIELD', 'BASE', 'FLEXIBLE'];
const SENIORITY = ['NEW_RECRUIT', 'JUNIOR', 'EXPERIENCED', 'SENIOR'];

const rolesOf = (req: AuthedRequest) => (req.user?.roles ?? []).map(r => r.role);
const employeeOnly = (roles: string[]) => roles.length > 0 && roles.every(r => r === 'EMPLOYEE');

@Controller('employees')
class EmployeesController {
  constructor(
    @Inject(PrismaService) private prisma: PrismaService,
    @Inject(EmployeeInsightsService) private insights: EmployeeInsightsService,
  ) {}

  @Get() @Require('employees', 'view')
  async list(
    @Req() req: AuthedRequest,
    @Query() q: { baseId?: string; positionId?: string; q?: string; active?: string; seniority?: string; qualificationId?: string;
      status?: string; date?: string; limit?: string; offset?: string },
  ) {
    if (employeeOnly(rolesOf(req))) throw new ForbiddenException('Employees can only view their own profile');
    const asOf = parseDate(q.date);
    const where: Record<string, unknown> = { active: q.active === 'false' ? false : q.active === 'all' ? undefined : true };
    if (q.baseId) where.homeBaseId = q.baseId;
    if (q.positionId) where.positionId = q.positionId;
    if (q.qualificationId) where.qualifications = { some: { qualificationId: q.qualificationId } };
    if (q.q) {
      where.OR = ['firstName', 'lastName', 'employeeNo'].map(f => ({ [f]: { contains: q.q, mode: 'insensitive' } }));
    }
    const all = await this.prisma.employee.findMany({
      where: where as never, orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      include: { position: true, homeBase: { select: { code: true, name: true } }, rotationPattern: true },
    });
    const computed = await this.insights.enrich(all, asOf);
    // seniority / status are computed, so they filter after enrichment, then we page.
    const rows = all
      .map(e => ({ ...e, managerNotes: undefined, ...computed.get(e.id)! }))
      .filter(e => (!q.seniority || e.seniority === q.seniority) && (!q.status || e.status === q.status));
    const { take, skip } = page(q);
    return { total: rows.length, items: rows.slice(skip, skip + take) };
  }

  @Get(':id') @Require('employees', 'view')
  async detail(@Param('id') id: string, @Req() req: AuthedRequest, @Query('date') dateStr?: string) {
    const roles = rolesOf(req);
    if (employeeOnly(roles) && req.user?.employeeId !== id) throw new ForbiddenException('Employees can only view their own profile');
    const asOf = parseDate(dateStr);
    const e = await this.prisma.employee.findUnique({
      where: { id },
      include: {
        position: true, homeBase: true, rotationPattern: true,
        qualifications: { include: { qualification: true } },
        certifications: { include: { type: true }, orderBy: { issuedAt: 'desc' } },
        restrictions: { where: { OR: [{ end: null }, { end: { gte: asOf } }] } },
        extensions: { select: { days: true, status: true } },
        leaves: { include: { type: true }, orderBy: { start: 'desc' }, take: 50 },
        assignments: {
          orderBy: { start: 'desc' }, take: 30,
          include: { seat: { include: { unit: { select: { code: true } }, base: { select: { code: true } }, position: true } } },
        },
      },
    });
    if (!e) throw new NotFoundException('Employee not found');
    const computed = (await this.insights.enrich([e], asOf)).get(id)!;

    // Medical privacy (plan 12.3): only HR, Ops and the employee see the reason, certificate or notes.
    // The EMPLOYEE role's medical access covers their own records only, so it never opens someone else's.
    const staffMedicalAccess = can(roles.filter(r => r !== 'EMPLOYEE'), 'medical', 'view');
    const medicalAccess = staffMedicalAccess || req.user?.employeeId === id;
    const leaves = e.leaves.map(l => l.type.category !== 'medical' || medicalAccess
      ? l
      : { id: l.id, start: l.start, end: l.end, status: l.status, type: { id: l.type.id, name: 'Unavailable', category: 'unavailable' } });

    // Manager-only notes: HR/Ops/Admin (full access) and base managers; not dispatchers or crew.
    const canSeeNotes = can(roles, 'employees', 'full') || roles.includes('BASE_MANAGER');
    return {
      ...e, managerNotes: canSeeNotes ? e.managerNotes : undefined, leaves,
      certifications: e.certifications.map(c => ({ id: c.id, typeId: c.typeId, type: c.type, issuedAt: c.issuedAt, documentUrl: c.documentUrl })),
      extensionDays: e.extensions.filter(x => x.status === 'APPROVED').reduce((n, x) => n + x.days, 0),
      ...computed,
      // others only ever see "Unavailable", never that it is medical
      status: !medicalAccess && computed.status === 'MEDICAL_LEAVE' ? 'UNAVAILABLE' : computed.status,
      daysOffBalance: (await this.prisma.daysOffLedger.aggregate({ where: { employeeId: id }, _sum: { days: true } }))._sum.days ?? 0,
    };
  }

  @Post() @Require('employees', 'full')
  async create(@Body() body: Record<string, unknown>, @Req() req: AuthedRequest) {
    const data = pickFields(FULL_SPEC, body, ['employeeNo', 'firstName', 'lastName', 'positionId', 'homeBaseId', 'hireDate']);
    if (body.workMode !== undefined) data.workMode = this.workMode(body.workMode);
    try {
      const e = await this.prisma.employee.create({ data: data as never });
      await audit(this.prisma, req.user?.sub, 'Employee', e.id, 'create', null, e);
      return e;
    } catch (err) { throw this.mapError(err); }
  }

  @Put(':id') @Require('employees', 'edit')
  async update(@Param('id') id: string, @Body() body: Record<string, unknown>, @Req() req: AuthedRequest) {
    const roles = rolesOf(req);
    const full = can(roles, 'employees', 'full');
    const data = pickFields(FULL_SPEC, body);
    if (body.workMode !== undefined) data.workMode = this.workMode(body.workMode);
    if (!full) {
      const denied = Object.keys(data).filter(k => !LIMITED_FIELDS.has(k));
      if (denied.length) throw new ForbiddenException(`Limited edit: cannot change ${denied.join(', ')}`);
    }
    const before = await this.prisma.employee.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Employee not found');
    try {
      const after = await this.prisma.employee.update({ where: { id }, data: data as never });
      // Changing pattern/anchor/base is what regenerates calendars and flags assignments; keep it traceable.
      await audit(this.prisma, req.user?.sub, 'Employee', id, 'update', before, after);
      return after;
    } catch (err) { throw this.mapError(err); }
  }

  /** Manager override of the computed level, with a mandatory reason (7.2). Send level: null to clear. */
  @Put(':id/seniority') @Require('employees', 'full')
  async overrideSeniority(@Param('id') id: string, @Body() body: { level?: string | null; reason?: string }, @Req() req: AuthedRequest) {
    const level = body?.level ?? null;
    if (level !== null && !SENIORITY.includes(level)) throw new BadRequestException(`level must be one of ${SENIORITY.join(', ')} or null`);
    if (level !== null && !body.reason?.trim()) throw new BadRequestException('A reason is required to override seniority');
    const before = await this.prisma.employee.findUnique({ where: { id }, select: { seniorityOverride: true, seniorityReason: true } });
    if (!before) throw new NotFoundException('Employee not found');
    const after = await this.prisma.employee.update({
      where: { id }, data: { seniorityOverride: level as Seniority | null, seniorityReason: level ? body.reason!.trim() : null },
      select: { seniorityOverride: true, seniorityReason: true },
    });
    await audit(this.prisma, req.user?.sub, 'Employee', id, 'seniority_override', before, after, body?.reason);
    return after;
  }

  @Post(':id/qualifications') @Require('employees', 'full')
  async addQualification(@Param('id') id: string, @Body() body: { qualificationId?: string; obtainedAt?: string; validatedBy?: string }, @Req() req: AuthedRequest) {
    if (!body?.qualificationId) throw new BadRequestException('qualificationId is required');
    const data = { employeeId: id, qualificationId: body.qualificationId, obtainedAt: parseDate(body.obtainedAt), validatedBy: body.validatedBy };
    try {
      const row = await this.prisma.employeeQualification.upsert({
        where: { employeeId_qualificationId: { employeeId: id, qualificationId: body.qualificationId } }, create: data, update: data,
      });
      await audit(this.prisma, req.user?.sub, 'Employee', id, 'qualification_add', null, row);
      return row;
    } catch (err) { throw this.mapError(err); }
  }

  @Delete(':id/qualifications/:qualificationId') @Require('employees', 'full')
  async removeQualification(@Param('id') id: string, @Param('qualificationId') qualificationId: string, @Req() req: AuthedRequest) {
    try { await this.prisma.employeeQualification.delete({ where: { employeeId_qualificationId: { employeeId: id, qualificationId } } }); }
    catch (err) { throw this.mapError(err); }
    await audit(this.prisma, req.user?.sub, 'Employee', id, 'qualification_remove', { qualificationId });
    return { removed: qualificationId };
  }

  @Post(':id/certifications') @Require('employees', 'full')
  async addCertification(@Param('id') id: string, @Body() body: Record<string, unknown>, @Req() req: AuthedRequest) {
    const data = pickFields({ typeId: 'string', issuedAt: 'date', documentUrl: 'string' }, body, ['typeId', 'issuedAt']);
    try {
      const cert = await this.prisma.certification.create({ data: { ...data, employeeId: id } as never });
      await audit(this.prisma, req.user?.sub, 'Employee', id, 'certification_add', null, cert);
      return cert;
    } catch (err) { throw this.mapError(err); }
  }

  @Delete(':id/certifications/:certId') @Require('employees', 'full')
  async removeCertification(@Param('id') id: string, @Param('certId') certId: string, @Req() req: AuthedRequest) {
    const { count } = await this.prisma.certification.deleteMany({ where: { id: certId, employeeId: id } });
    if (!count) throw new NotFoundException('Certification not found');
    await audit(this.prisma, req.user?.sub, 'Employee', id, 'certification_remove', { certId });
    return { removed: certId };
  }

  /**
   * Archive (7.3): the person leaves. Current assignments end today, future ones are cancelled, and every released
   * seat gets a replacement task (critical if they were on it today).
   */
  @Post(':id/archive') @Require('employees', 'full')
  async archive(@Param('id') id: string, @Body() body: { reason?: string }, @Req() req: AuthedRequest) {
    const today = startOfDay(new Date());
    const emp = await this.prisma.employee.findUnique({ where: { id } });
    if (!emp) throw new NotFoundException('Employee not found');
    if (!emp.active) throw new BadRequestException('Already archived');

    const result = await this.prisma.$transaction(async tx => {
      const open = await tx.assignment.findMany({
        where: { employeeId: id, status: { in: ['DRAFT', 'CONFIRMED', 'ACTIVE'] }, plannedEnd: { gte: today } },
      });
      let tasks = 0;
      for (const a of open) {
        const running = a.start <= today;
        if (running) await tx.assignment.update({ where: { id: a.id }, data: { actualEnd: today, status: 'COMPLETED' } });
        else await tx.assignment.update({ where: { id: a.id }, data: { status: 'CANCELLED' } });
        const from = running ? new Date(today.getTime() + 86_400_000) : a.start;
        if (from > a.plannedEnd) continue; // nothing left to cover
        const daysLeft = (from.getTime() - today.getTime()) / 86_400_000;
        await tx.replacementTask.create({
          data: {
            seatId: a.seatId, fromDate: from, toDate: a.plannedEnd, trigger: 'employee_archived',
            urgency: running ? 'CRITICAL' : daysLeft <= 7 ? 'HIGH' : 'NORMAL', deadline: from,
          },
        });
        tasks++;
      }
      // Nobody should keep an archived person as back-to-back partner.
      await tx.employee.updateMany({ where: { backToBackId: id }, data: { backToBackId: null } });
      await tx.employee.update({ where: { id }, data: { active: false } });
      return { releasedAssignments: open.length, replacementTasks: tasks };
    });
    await audit(this.prisma, req.user?.sub, 'Employee', id, 'archive', { active: true }, { active: false, ...result }, body?.reason);
    return result;
  }

  @Post('bulk') @Require('employees', 'full')
  async bulk(@Body() body: { ids?: string[]; action?: string; value?: string }, @Req() req: AuthedRequest) {
    const { ids, action, value } = body ?? {};
    if (!Array.isArray(ids) || !ids.length || !value) throw new BadRequestException('ids[] and value are required');
    if (action === 'homeBase') {
      await this.prisma.employee.updateMany({ where: { id: { in: ids } }, data: { homeBaseId: value } });
    } else if (action === 'rotation') {
      await this.prisma.employee.updateMany({ where: { id: { in: ids } }, data: { rotationPatternId: value } });
    } else if (action === 'addTag') {
      const rows = await this.prisma.employee.findMany({ where: { id: { in: ids } }, select: { id: true, tags: true } });
      await this.prisma.$transaction(rows.filter(r => !r.tags.includes(value)).map(r =>
        this.prisma.employee.update({ where: { id: r.id }, data: { tags: [...r.tags, value] } })));
    } else throw new BadRequestException('action must be homeBase, rotation or addTag');
    await audit(this.prisma, req.user?.sub, 'Employee', ids.join(','), `bulk_${action}`, null, { value, count: ids.length });
    return { updated: ids.length };
  }

  private workMode(v: unknown) {
    if (typeof v !== 'string' || !WORK_MODES.includes(v)) throw new BadRequestException(`workMode must be one of ${WORK_MODES.join(', ')}`);
    return v;
  }

  private mapError(e: unknown) {
    const code = (e as { code?: string }).code;
    if (code === 'P2002') return new BadRequestException('Duplicate value (employee number must be unique)');
    if (code === 'P2003') return new BadRequestException('Referenced record does not exist');
    if (code === 'P2025') return new NotFoundException('Not found');
    return e;
  }
}

/**
 * The ranks list (setting people.ranks). Saving it renames the rank on everyone who has it (`was` is the old label),
 * sets their position and level from the rank, and takes a removed rank off the people who had it.
 */
@Controller('ranks')
class RanksController {
  constructor(@Inject(PrismaService) private prisma: PrismaService, @Inject(SettingsService) private settings: SettingsService) {}

  @Put() @Require('employees', 'full')
  async save(@Body() body: { ranks?: { label?: string; position?: string; seniority?: string; was?: string }[] }, @Req() req: AuthedRequest) {
    const list = body?.ranks;
    if (!Array.isArray(list) || list.length === 0) throw new BadRequestException('ranks must be a non-empty list');
    const positions = await this.prisma.position.findMany({ where: { name: { in: ['Chief of Unit', 'Field Operator'] } } });
    const ranks = list.map(r => {
      const label = r.label?.trim();
      if (!label) throw new BadRequestException('Every rank needs a name');
      if (!positions.some(p => p.name === r.position)) throw new BadRequestException(`${label}: position must be Chief of Unit or Field Operator`);
      if (!SENIORITY.includes(r.seniority ?? '')) throw new BadRequestException(`${label}: unknown level`);
      return { label, position: r.position!, seniority: r.seniority as Seniority, was: r.was?.trim() || undefined };
    });
    if (new Set(ranks.map(r => r.label.toLowerCase())).size !== ranks.length) throw new BadRequestException('Two ranks have the same name');

    const before = (await this.settings.all())['people.ranks'] as { label: string }[];
    const kept = new Set(ranks.map(r => r.was ?? r.label));
    await this.prisma.$transaction(async tx => {
      for (const old of before.filter(b => !kept.has(b.label))) {
        await tx.$executeRaw`UPDATE "Employee" SET "tags" = array_remove("tags", ${old.label}), "seniorityOverride" = NULL, "seniorityReason" = NULL WHERE ${old.label} = ANY("tags")`;
      }
      // two passes so swapping two names does not merge the people
      for (const [i, r] of ranks.entries()) if (r.was && r.was !== r.label) await tx.$executeRaw`UPDATE "Employee" SET "tags" = array_replace("tags", ${r.was}, ${`~rank~${i}`}) WHERE ${r.was} = ANY("tags")`;
      for (const [i, r] of ranks.entries()) if (r.was && r.was !== r.label) await tx.$executeRaw`UPDATE "Employee" SET "tags" = array_replace("tags", ${`~rank~${i}`}, ${r.label}) WHERE ${`~rank~${i}`} = ANY("tags")`;
      for (const r of ranks) {
        await tx.employee.updateMany({
          where: { tags: { has: r.label } },
          data: { positionId: positions.find(p => p.name === r.position)!.id, seniorityOverride: r.seniority, seniorityReason: `Rank: ${r.label}` },
        });
      }
    });
    const saved = ranks.map(({ was: _was, ...r }) => r);
    await this.settings.set('people.ranks', saved);
    await audit(this.prisma, req.user?.sub, 'Setting', 'people.ranks', 'update', before, saved);
    return saved;
  }
}

@Module({ imports: [InsightsModule, SettingsModule], controllers: [EmployeesController, RanksController] })
export class EmployeesModule {}
