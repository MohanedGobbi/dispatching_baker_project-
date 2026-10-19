import {
  BadRequestException, Body, Controller, Delete, Get, Inject, Module, NotFoundException, Param, Post, Put, Query, Req,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Require, AuthedRequest } from '../auth/auth.module';
import { audit, mapDbError, parseDate, pickFields, Spec } from '../common/validate';
import { computeUnitStatus } from '../domain/derived';

const BASE_SPEC: Spec = {
  code: 'string', name: 'string', regionId: 'string', address: 'string', city: 'string', lat: 'number', lng: 'number',
  phone: 'string', managerId: 'string', unitCapacity: 'number', bedCapacity: 'number', facilities: 'string[]', active: 'boolean',
};
const SITE_SPEC: Spec = {
  name: 'string', type: 'string', lat: 'number', lng: 'number', baseId: 'string', client: 'string', travelHours: 'number', accessNotes: 'string',
};

@Controller()
class BasesController {
  constructor(@Inject(PrismaService) private prisma: PrismaService) {}

  @Get('bases') @Require('bases', 'view')
  list(@Query('includeArchived') includeArchived?: string) {
    return this.prisma.base.findMany({
      where: includeArchived === 'true' ? {} : { active: true },
      orderBy: { name: 'asc' },
      include: { region: true, _count: { select: { units: true, employees: true, sites: true } } },
    });
  }

  /** Base page (5.4): units here, staff, posts filled vs required, jobs served. */
  @Get('bases/:id') @Require('bases', 'view')
  async detail(@Param('id') id: string, @Query('date') dateStr?: string) {
    const date = parseDate(dateStr);
    const base = await this.prisma.base.findUnique({ where: { id }, include: { region: true, sites: true, staffing: { include: { position: true } } } });
    if (!base) throw new NotFoundException('Base not found');

    const units = await this.prisma.unit.findMany({
      where: { homeBaseId: id }, include: { unitType: true, workOrders: true, deployments: { include: { job: true } } },
    });
    const unitCards = units.map(u => ({
      id: u.id, code: u.code, type: u.unitType.name,
      status: computeUnitStatus({ manualStatus: u.status, workOrders: u.workOrders, deployments: u.deployments }, date),
    }));

    // filled = distinct people on a base post of that position on `date`
    const basePosts = await this.prisma.assignment.findMany({
      where: { seat: { baseId: id }, status: { in: ['CONFIRMED', 'ACTIVE'] }, start: { lte: date }, plannedEnd: { gte: date } },
      select: { employeeId: true, seat: { select: { positionId: true } } },
    });
    const staffing = base.staffing.map(r => {
      const filled = new Set(basePosts.filter(a => a.seat.positionId === r.positionId).map(a => a.employeeId)).size;
      const state = filled < r.minCount ? 'below_min' : filled < r.targetCount ? 'below_target' : 'ok';
      return { position: r.position.name, positionId: r.positionId, min: r.minCount, target: r.targetCount, filled, state };
    });

    const jobsServed = await this.prisma.job.findMany({
      where: { site: { baseId: id }, status: { in: ['PLANNED', 'ACTIVE'] } }, orderBy: { plannedStart: 'asc' }, take: 50,
    });
    const staffCount = await this.prisma.employee.count({ where: { homeBaseId: id, active: true } });
    return { ...base, units: unitCards, staffCount, staffing, jobsServed };
  }

  @Post('bases') @Require('bases', 'edit')
  async create(@Body() body: Record<string, unknown>, @Req() req: AuthedRequest) {
    const data = pickFields(BASE_SPEC, body, ['code', 'name']);
    const base = await this.prisma.base.create({ data: data as never }).catch(e => { throw mapDbError(e, 'Base code'); });
    await audit(this.prisma, req.user?.sub, 'Base', base.id, 'create', null, base);
    return base;
  }

  @Put('bases/:id') @Require('bases', 'edit')
  async update(@Param('id') id: string, @Body() body: Record<string, unknown>, @Req() req: AuthedRequest) {
    const before = await this.prisma.base.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Base not found');
    const after = await this.prisma.base.update({ where: { id }, data: pickFields(BASE_SPEC, body) as never }).catch(e => { throw mapDbError(e, 'Base'); });
    await audit(this.prisma, req.user?.sub, 'Base', id, 'update', before, after);
    return after;
  }

  /** Archive rather than delete: a base has history. Refused while it still has active units or staff. */
  @Delete('bases/:id') @Require('bases', 'edit')
  async archive(@Param('id') id: string, @Req() req: AuthedRequest) {
    const [units, staff] = await Promise.all([
      this.prisma.unit.count({ where: { homeBaseId: id } }),
      this.prisma.employee.count({ where: { homeBaseId: id, active: true } }),
    ]);
    if (units || staff) throw new BadRequestException(`Base still has ${units} unit(s) and ${staff} active employee(s); transfer them first`);
    const after = await this.prisma.base.update({ where: { id }, data: { active: false } });
    await audit(this.prisma, req.user?.sub, 'Base', id, 'archive');
    return after;
  }

  /** Staffing template (6.3): set min/target for a position at a base and regenerate base post seats. */
  @Put('bases/:id/staffing/:positionId') @Require('bases', 'edit')
  async setStaffing(
    @Param('id') baseId: string, @Param('positionId') positionId: string,
    @Body() body: { minCount?: number; targetCount?: number; scheduleWindow?: string }, @Req() req: AuthedRequest,
  ) {
    const { minCount, targetCount } = body ?? {};
    if (body?.scheduleWindow != null && body.scheduleWindow !== 'working_days') throw new BadRequestException('scheduleWindow must be working_days or empty');
    if (!Number.isInteger(minCount) || !Number.isInteger(targetCount) || minCount! < 0 || targetCount! < minCount!) {
      throw new BadRequestException('minCount and targetCount must be integers with 0 <= min <= target');
    }
    const rule = await this.prisma.baseStaffingRule.upsert({
      where: { baseId_positionId: { baseId, positionId } },
      create: { baseId, positionId, minCount: minCount!, targetCount: targetCount!, scheduleWindow: body.scheduleWindow },
      update: { minCount: minCount!, targetCount: targetCount!, scheduleWindow: body.scheduleWindow },
    });
    await this.syncBaseSeats(baseId, positionId, minCount!, targetCount!);
    await audit(this.prisma, req.user?.sub, 'BaseStaffingRule', rule.id, 'upsert', null, rule);
    return rule;
  }

  /** Seats #1..target exist; the first `min` are required. Seats that hold assignments are never deleted. */
  private async syncBaseSeats(baseId: string, positionId: string, min: number, target: number) {
    const seats = await this.prisma.seat.findMany({
      where: { baseId, positionId, holderType: 'BASE' }, include: { _count: { select: { assignments: true } } }, orderBy: { index: 'asc' },
    });
    for (let i = 1; i <= target; i++) {
      const existing = seats.find(s => s.index === i);
      if (existing) await this.prisma.seat.update({ where: { id: existing.id }, data: { requiredFlag: i <= min } });
      else await this.prisma.seat.create({ data: { holderType: 'BASE', baseId, positionId, index: i, requiredFlag: i <= min } });
    }
    const surplus = seats.filter(s => s.index > target);
    const removable = surplus.filter(s => s._count.assignments === 0).map(s => s.id);
    if (removable.length) await this.prisma.seat.deleteMany({ where: { id: { in: removable } } });
    // Surplus seats that still hold history stay but become optional.
    const kept = surplus.filter(s => s._count.assignments > 0).map(s => s.id);
    if (kept.length) await this.prisma.seat.updateMany({ where: { id: { in: kept } }, data: { requiredFlag: false } });
  }

  // ----- Sites (5.3)
  @Get('sites') @Require('bases', 'view')
  sites(@Query('baseId') baseId?: string) {
    return this.prisma.site.findMany({ where: baseId ? { baseId } : {}, orderBy: { name: 'asc' }, include: { base: { select: { code: true, name: true } } } });
  }

  @Post('sites') @Require('bases', 'edit')
  async createSite(@Body() body: Record<string, unknown>, @Req() req: AuthedRequest) {
    const site = await this.prisma.site.create({ data: pickFields(SITE_SPEC, body, ['name', 'baseId']) as never }).catch(e => { throw mapDbError(e, 'Site'); });
    await audit(this.prisma, req.user?.sub, 'Site', site.id, 'create', null, site);
    return site;
  }

  @Put('sites/:id') @Require('bases', 'edit')
  async updateSite(@Param('id') id: string, @Body() body: Record<string, unknown>, @Req() req: AuthedRequest) {
    const before = await this.prisma.site.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Site not found');
    const after = await this.prisma.site.update({ where: { id }, data: pickFields(SITE_SPEC, body) as never }).catch(e => { throw mapDbError(e, 'Site'); });
    await audit(this.prisma, req.user?.sub, 'Site', id, 'update', before, after);
    return after;
  }

  @Delete('sites/:id') @Require('bases', 'edit')
  async deleteSite(@Param('id') id: string, @Req() req: AuthedRequest) {
    if (await this.prisma.job.count({ where: { siteId: id } })) throw new BadRequestException('Site has jobs and cannot be deleted');
    await this.prisma.site.delete({ where: { id } });
    await audit(this.prisma, req.user?.sub, 'Site', id, 'delete');
    return { deleted: id };
  }
}

@Module({ controllers: [BasesController] })
export class BasesModule {}
