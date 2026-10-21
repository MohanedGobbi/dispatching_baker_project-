import {
  BadRequestException, Body, ConflictException, Controller, Delete, Get, Inject, Module, NotFoundException, Param, Post, Put, Query, Req,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { Require, AuthedRequest } from '../auth/auth.module';
import { SettingsModule, SettingsService } from '../settings/settings';
import { audit, page, parseDate, pickFields, Spec } from '../common/validate';
import { computeUnitStatus, countFieldDays, UnitStatusValue } from '../domain/derived';
import { startOfDay } from '../domain/status';
import { crewEnough } from '../domain/rules';
import { nextDue, serviceState } from '../domain/preventive';

const UNIT_SPEC: Spec = { code: 'string', unitTypeId: 'string', homeBaseId: 'string', plate: 'string', model: 'string', year: 'number', notes: 'string' };
const MANUAL_STATUSES = ['AVAILABLE', 'IN_TRANSIT', 'OUT_OF_SERVICE'];

type CrewType = { crewSeats: { positionId: string; count: number; optional: boolean; minSeniority: string | null; position: { name: string }; requiredQual: { name: string } | null }[] };

/** Create a unit and the crew seats its type defines. Used by POST /units and the Excel import. */
export async function createUnitWithSeats(tx: Prisma.TransactionClient, data: Record<string, unknown>, type: CrewType, minExperienced: number) {
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
}

@Controller('units')
class UnitsController {
  constructor(
    @Inject(PrismaService) private prisma: PrismaService,
    @Inject(SettingsService) private settings: SettingsService,
  ) {}

  @Get() @Require('units', 'view')
  async list(@Query() q: { typeId?: string; baseId?: string; status?: string; q?: string; date?: string; limit?: string; offset?: string }) {
    const date = parseDate(q.date);
    const text = q.q?.trim();
    const minCrew = (await this.settings.all())['rules.minCrewOnUnit'] as number;
    const units = await this.prisma.unit.findMany({
      where: {
        ...(q.typeId ? { unitTypeId: q.typeId } : {}), ...(q.baseId ? { homeBaseId: q.baseId } : {}),
        ...(text ? { OR: ['code', 'plate', 'model', 'notes'].map(f => ({ [f]: { contains: text, mode: 'insensitive' } })) } : {}),
      },
      orderBy: { code: 'asc' },
      include: {
        unitType: true, homeBase: { select: { code: true, name: true } }, workOrders: true, maintenancePlans: { where: { active: true } },
        deployments: { include: { job: { select: { ref: true, wellName: true, rigName: true, openEnded: true } } } },
        seats: { where: { holderType: 'UNIT' }, select: { id: true, requiredFlag: true, assignments: {
          where: { status: { in: ['CONFIRMED', 'ACTIVE'] }, start: { lte: date }, plannedEnd: { gte: date } }, select: { id: true } } } },
      },
    });
    const rows = units.map(u => {
      const status = computeUnitStatus({ manualStatus: u.status, workOrders: u.workOrders, deployments: u.deployments }, date);
      const current = u.deployments.find(d => startOfDay(d.start) <= startOfDay(date) && startOfDay(date) <= d.end);
      const required = u.seats.filter(s => s.requiredFlag);
      const filledRequired = required.filter(s => s.assignments.length > 0).length;
      // The service due first, for the "service due" tile and column.
      const service = u.maintenancePlans.map(p => ({ name: p.name, due: nextDue(p), state: serviceState(p, date) })).sort((a, b) => a.due.getTime() - b.due.getTime())[0];
      const openWo = u.workOrders.find(w => !['DONE', 'CANCELLED'].includes(w.status) && startOfDay(w.plannedStart) <= startOfDay(date));
      return {
        id: u.id, code: u.code, type: u.unitType.name, typeId: u.unitTypeId, colorKey: u.unitType.colorKey, home: u.homeBase, homeBaseId: u.homeBaseId,
        plate: u.plate, model: u.model, year: u.year, notes: u.notes,
        status, job: current?.job ?? null, jobUntil: current?.job.openEnded ? null : current?.end ?? null, backBy: openWo?.expectedReturn ?? null,
        nextService: service ? { name: service.name, due: service.due.toISOString().slice(0, 10), state: service.state } : null,
        crew: { filled: filledRequired, required: required.length },
        // A deployed unit short of crew is a compliance problem (plan 14.1 badges); `minCrew` filled seats is enough.
        problem: status === 'DEPLOYED' && !crewEnough(filledRequired, required.length, minCrew),
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
        holder: s.assignments[0] ? { ...s.assignments[0].employee, assignmentId: s.assignments[0].id, until: s.assignments[0].plannedEnd } : null,
      })),
      crewHistory,
      crewMin: (await this.settings.all())['rules.minCrewOnUnit'] as number,
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
      const unit = await this.prisma.$transaction(tx => createUnitWithSeats(tx, data, type, minExperienced));
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
    delete data.homeBaseId; // use /transfer so the move is recorded
    const before = await this.prisma.unit.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Unit not found');
    const newType = data.unitTypeId && data.unitTypeId !== before.unitTypeId ? data.unitTypeId as string : null;
    delete data.unitTypeId;
    const after = await this.prisma.$transaction(async tx => {
      // A type change keeps the crew seats (and who holds them) when both types have the same seats; only the
      // qualification each seat asks for follows the new type.
      if (newType) {
        const types = await tx.unitType.findMany({ where: { id: { in: [before.unitTypeId, newType] } }, include: { crewSeats: { include: { requiredQual: true } } } });
        const from = types.find(x => x.id === before.unitTypeId), to = types.find(x => x.id === newType);
        if (!to) throw new BadRequestException('Unknown unit type');
        const shape = (x: typeof to) => x.crewSeats.map(s => `${s.positionId}:${s.count}`).sort().join(',');
        if (from && shape(from) !== shape(to)) throw new BadRequestException(`${to.name} has different crew seats, so the type cannot be changed`);
        const qualOf = new Map(to.crewSeats.map(s => [s.positionId, s.requiredQual?.name]));
        for (const seat of await tx.seat.findMany({ where: { unitId: id } })) {
          const req = { ...((seat.requirements ?? {}) as Record<string, unknown>) };
          const q = qualOf.get(seat.positionId);
          if (q) req.qualification = q; else delete req.qualification;
          await tx.seat.update({ where: { id: seat.id }, data: { requirements: req as never } });
        }
        data.unitTypeId = newType;
      }
      return tx.unit.update({ where: { id }, data: data as never });
    });
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

  /**
   * Delete a unit entered by mistake. A unit with any history (crew assignments, jobs, work orders) is refused:
   * take it out of service instead, so reports and the board's time machine keep their past.
   */
  @Delete(':id') @Require('units', 'full')
  async remove(@Param('id') id: string, @Req() req: AuthedRequest) {
    const unit = await this.prisma.unit.findUnique({
      where: { id },
      include: { _count: { select: { deployments: true, workOrders: true } }, seats: { select: { id: true, _count: { select: { assignments: true } } } } },
    });
    if (!unit) throw new NotFoundException('Unit not found');
    const assignments = unit.seats.reduce((n, s) => n + s._count.assignments, 0);
    if (assignments || unit._count.deployments || unit._count.workOrders) {
      const what = [assignments && `${assignments} crew assignment(s)`, unit._count.deployments && `${unit._count.deployments} job(s)`, unit._count.workOrders && `${unit._count.workOrders} work order(s)`].filter(Boolean).join(', ');
      throw new ConflictException(`${unit.code} has history (${what}). Take it out of service instead of deleting it.`);
    }
    const seatIds = unit.seats.map(s => s.id);
    await this.prisma.$transaction([
      this.prisma.replacementTask.deleteMany({ where: { seatId: { in: seatIds } } }),
      this.prisma.maintenancePlan.deleteMany({ where: { unitId: id } }),
      this.prisma.unitDocument.deleteMany({ where: { unitId: id } }),
      this.prisma.seat.deleteMany({ where: { id: { in: seatIds } } }),
      this.prisma.unit.delete({ where: { id } }),
    ]);
    await audit(this.prisma, req.user?.sub, 'Unit', id, 'delete', { code: unit.code, unitTypeId: unit.unitTypeId, homeBaseId: unit.homeBaseId }, null);
    return { deleted: true };
  }

  /**
   * The same change to several units at once (the fleet list lets the manager tick rows): move them to another
   * base, change their type or set them available / out of service. Each one is checked and audited on its own,
   * and a unit that cannot take the change is reported instead of stopping the rest.
   */
  @Post('bulk') @Require('units', 'edit')
  async bulk(@Body() body: { ids?: string[]; action?: string; value?: string }, @Req() req: AuthedRequest) {
    const { ids, action, value } = body ?? {};
    if (!Array.isArray(ids) || !ids.length || !value) throw new BadRequestException('ids[] and value are required');
    if (!['homeBase', 'unitType', 'status'].includes(action ?? '')) throw new BadRequestException('action must be homeBase, unitType or status');
    if (action === 'status' && !MANUAL_STATUSES.includes(value)) throw new BadRequestException(`status must be one of ${MANUAL_STATUSES.join(', ')}`);

    const units = await this.prisma.unit.findMany({ where: { id: { in: ids } } });
    const failed: { code: string; reason: string }[] = [];
    let updated = 0;
    for (const u of units) {
      try {
        if (action === 'homeBase') await this.transfer(u.id, { baseId: value }, req);
        else if (action === 'unitType') await this.update(u.id, { unitTypeId: value }, req);
        else await this.setStatus(u.id, { status: value }, req);
        updated++;
      } catch (e) {
        failed.push({ code: u.code, reason: (e as { response?: { message?: string } }).response?.message ?? (e as Error).message });
      }
    }
    return { updated, failed };
  }

  @Post(':id/transfer') @Require('units', 'full')
  async transfer(@Param('id') id: string, @Body() body: { baseId?: string; reason?: string }, @Req() req: AuthedRequest) {
    if (!body?.baseId) throw new BadRequestException('baseId is required');
    const [unit, base] = await Promise.all([
      this.prisma.unit.findUnique({ where: { id } }), this.prisma.base.findUnique({ where: { id: body.baseId } }),
    ]);
    if (!unit) throw new NotFoundException('Unit not found');
    if (!base || !base.active) throw new BadRequestException('Target base does not exist or is archived');
    if (unit.homeBaseId === base.id) return unit; // already there: nothing to do (bulk moves pass whole selections)
    const after = await this.prisma.unit.update({ where: { id }, data: { homeBaseId: base.id } });
    await audit(this.prisma, req.user?.sub, 'Unit', id, 'transfer', { homeBaseId: unit.homeBaseId }, { homeBaseId: base.id }, body.reason);
    return after;
  }
}

@Module({ imports: [SettingsModule], controllers: [UnitsController] })
export class UnitsModule {}
