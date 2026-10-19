import {
  BadRequestException, Body, Controller, Get, Inject, Module, NotFoundException, Param, Post, Put, Query, Req,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Require, AuthedRequest } from '../auth/auth.module';
import { SettingsModule, SettingsService } from '../settings/settings';
import { audit, page, parseDate, pickFields, Spec } from '../common/validate';
import { computeUnitStatus, countFieldDays, UnitStatusValue } from '../domain/derived';
import { startOfDay } from '../domain/status';

const UNIT_SPEC: Spec = { code: 'string', unitTypeId: 'string', homeBaseId: 'string', plate: 'string', model: 'string', year: 'number', notes: 'string' };
const MANUAL_STATUSES = ['AVAILABLE', 'IN_TRANSIT', 'OUT_OF_SERVICE'];

@Controller('units')
class UnitsController {
  constructor(
    @Inject(PrismaService) private prisma: PrismaService,
    @Inject(SettingsService) private settings: SettingsService,
  ) {}

  @Get() @Require('units', 'view')
  async list(@Query() q: { typeId?: string; baseId?: string; status?: string; date?: string; limit?: string; offset?: string }) {
    const date = parseDate(q.date);
    const units = await this.prisma.unit.findMany({
      where: { ...(q.typeId ? { unitTypeId: q.typeId } : {}), ...(q.baseId ? { homeBaseId: q.baseId } : {}) },
      orderBy: { code: 'asc' },
      include: {
        unitType: true, homeBase: { select: { code: true, name: true } }, workOrders: true,
        deployments: { include: { job: { select: { ref: true, wellName: true, rigName: true } } } },
        seats: { where: { holderType: 'UNIT' }, select: { id: true, requiredFlag: true, assignments: {
          where: { status: { in: ['CONFIRMED', 'ACTIVE'] }, start: { lte: date }, plannedEnd: { gte: date } }, select: { id: true } } } },
      },
    });
    const rows = units.map(u => {
      const status = computeUnitStatus({ manualStatus: u.status, workOrders: u.workOrders, deployments: u.deployments }, date);
      const current = u.deployments.find(d => startOfDay(d.start) <= startOfDay(date) && startOfDay(date) <= d.end);
      const required = u.seats.filter(s => s.requiredFlag);
      const filledRequired = required.filter(s => s.assignments.length > 0).length;
      return {
        id: u.id, code: u.code, type: u.unitType.name, typeId: u.unitTypeId, colorKey: u.unitType.colorKey, home: u.homeBase,
        status, job: current?.job ?? null,
        crew: { filled: filledRequired, required: required.length },
        // A deployed unit with missing required seats is a compliance problem (plan 14.1 badges).
        problem: status === 'DEPLOYED' && filledRequired < required.length,
      };
    }).filter(u => !q.status || u.status === q.status);
    const { take, skip } = page(q);
    return { total: rows.length, items: rows.slice(skip, skip + take) };
  }

  @Get(':id') @Require('units', 'view')
  async detail(@Param('id') id: string, @Query('date') dateStr?: string) {
    const date = parseDate(dateStr);
    const u = await this.prisma.unit.findUnique({
      where: { id },
      include: {
        unitType: true, homeBase: true,
        workOrders: { orderBy: { plannedStart: 'desc' }, take: 20 },
        deployments: { orderBy: { start: 'desc' }, take: 30, include: { job: true } },
        seats: {
          where: { holderType: 'UNIT' }, orderBy: [{ positionId: 'asc' }, { index: 'asc' }], include: {
            position: { select: { name: true } },
            assignments: {
              where: { status: { in: ['CONFIRMED', 'ACTIVE'] }, start: { lte: date }, plannedEnd: { gte: date } },
              include: { employee: { select: { id: true, employeeNo: true, firstName: true, lastName: true } } },
            },
          },
        },
      },
    });
    if (!u) throw new NotFoundException('Unit not found');

    // Utilization over the 365 days ending at `date` (plan KPI: days deployed / days in period).
    const windowStart = new Date(startOfDay(date).getTime() - 364 * 86_400_000);
    const deployedDays = countFieldDays(
      u.deployments.map(d => ({ start: d.start < windowStart ? windowStart : d.start, end: d.end })), date);
    const downtimeDays = countFieldDays(
      u.workOrders.map(w => ({ start: w.plannedStart < windowStart ? windowStart : w.plannedStart, end: w.expectedReturn })), date);

    const crewHistory = await this.prisma.assignment.findMany({
      where: { seat: { unitId: id }, status: { in: ['CONFIRMED', 'ACTIVE', 'COMPLETED'] } },
      orderBy: { start: 'desc' }, take: 40,
      include: { employee: { select: { id: true, firstName: true, lastName: true } }, seat: { include: { position: { select: { name: true } } } } },
    });

    return {
      ...u,
      status: computeUnitStatus({ manualStatus: u.status, workOrders: u.workOrders, deployments: u.deployments }, date),
      seats: u.seats.map(s => ({
        id: s.id, position: s.position.name, index: s.index, required: s.requiredFlag, requirements: s.requirements,
        holder: s.assignments[0]?.employee ?? null,
      })),
      crewHistory,
      utilization: { windowDays: 365, deployedDays, downtimeDays, rate: Math.round((deployedDays / 365) * 1000) / 10 },
    };
  }

  /** Create a unit and generate its crew seats from the unit type's template (8.2). */
  @Post() @Require('units', 'full')
  async create(@Body() body: Record<string, unknown>, @Req() req: AuthedRequest) {
    const data = pickFields(UNIT_SPEC, body, ['code', 'unitTypeId', 'homeBaseId']);
    const type = await this.prisma.unitType.findUnique({
      where: { id: data.unitTypeId as string },
      include: { crewSeats: { include: { position: true, requiredQual: true } } },
    });
    if (!type) throw new BadRequestException('Unknown unit type');
    const minExperienced = (await this.settings.all())['rules.minExperiencedPerCrew'] as number;

    try {
      const unit = await this.prisma.$transaction(async tx => {
        const created = await tx.unit.create({ data: data as never });
        const seats: { holderType: 'UNIT'; unitId: string; positionId: string; index: number; requiredFlag: boolean; requirements: object }[] = [];
        for (const t of type.crewSeats) {
          for (let i = 1; i <= t.count; i++) {
            const isOperator = t.position.name === 'Field Operator';
            const minSeniority = t.minSeniority ?? (isOperator && i <= minExperienced ? 'EXPERIENCED' : undefined);
            seats.push({
              holderType: 'UNIT', unitId: created.id, positionId: t.positionId, index: i, requiredFlag: !t.optional,
              requirements: { ...(t.requiredQual ? { qualification: t.requiredQual.name } : {}), ...(minSeniority ? { minSeniority } : {}) },
            });
          }
        }
        await tx.seat.createMany({ data: seats });
        return created;
      });
      await audit(this.prisma, req.user?.sub, 'Unit', unit.id, 'create', null, unit);
      return unit;
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') throw new BadRequestException('Unit code already exists');
      if ((err as { code?: string }).code === 'P2003') throw new BadRequestException('Home base does not exist');
      throw err;
    }
  }

  @Put(':id') @Require('units', 'edit')
  async update(@Param('id') id: string, @Body() body: Record<string, unknown>, @Req() req: AuthedRequest) {
    const data = pickFields(UNIT_SPEC, body);
    delete data.unitTypeId; // changing type would invalidate the generated crew seats
    delete data.homeBaseId; // use /transfer so the move is recorded
    const before = await this.prisma.unit.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Unit not found');
    const after = await this.prisma.unit.update({ where: { id }, data: data as never });
    await audit(this.prisma, req.user?.sub, 'Unit', id, 'update', before, after);
    return after;
  }

  /**
   * Status change (8.3). Deployed is derived from jobs. Under maintenance is derived from an open work order,
   * so asking for it here opens one.
   */
  @Put(':id/status') @Require('units', 'edit')
  async setStatus(
    @Param('id') id: string,
    @Body() body: { status?: string; expectedReturn?: string; description?: string },
    @Req() req: AuthedRequest,
  ) {
    const unit = await this.prisma.unit.findUnique({ where: { id } });
    if (!unit) throw new NotFoundException('Unit not found');
    const status = body?.status;
    if (status === 'UNDER_MAINTENANCE') {
      if (!body.expectedReturn) throw new BadRequestException('expectedReturn is required to open a maintenance work order');
      const expectedReturn = parseDate(body.expectedReturn);
      const wo = await this.prisma.workOrder.create({
        data: { unitId: id, baseId: unit.homeBaseId, type: 'corrective', description: body.description, plannedStart: startOfDay(new Date()), expectedReturn },
      });
      await audit(this.prisma, req.user?.sub, 'Unit', id, 'maintenance_opened', null, wo);
      return { workOrder: wo, status: 'UNDER_MAINTENANCE' };
    }
    if (!status || !MANUAL_STATUSES.includes(status)) {
      throw new BadRequestException(`status must be one of ${MANUAL_STATUSES.join(', ')} or UNDER_MAINTENANCE; Deployed comes from jobs`);
    }
    const after = await this.prisma.unit.update({ where: { id }, data: { status: status as UnitStatusValue } });
    await audit(this.prisma, req.user?.sub, 'Unit', id, 'status', { status: unit.status }, { status: after.status });
    return { status: after.status };
  }

  @Post(':id/transfer') @Require('units', 'full')
  async transfer(@Param('id') id: string, @Body() body: { baseId?: string; reason?: string }, @Req() req: AuthedRequest) {
    if (!body?.baseId) throw new BadRequestException('baseId is required');
    const [unit, base] = await Promise.all([
      this.prisma.unit.findUnique({ where: { id } }), this.prisma.base.findUnique({ where: { id: body.baseId } }),
    ]);
    if (!unit) throw new NotFoundException('Unit not found');
    if (!base || !base.active) throw new BadRequestException('Target base does not exist or is archived');
    if (unit.homeBaseId === base.id) throw new BadRequestException('Unit is already based there');
    const after = await this.prisma.unit.update({ where: { id }, data: { homeBaseId: base.id } });
    await audit(this.prisma, req.user?.sub, 'Unit', id, 'transfer', { homeBaseId: unit.homeBaseId }, { homeBaseId: base.id }, body.reason);
    return after;
  }
}

@Module({ imports: [SettingsModule], controllers: [UnitsController] })
export class UnitsModule {}
