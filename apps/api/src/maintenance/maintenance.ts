import {
  BadRequestException, Body, Controller, Get, Inject, Module, NotFoundException, Param, Post, Put, Query,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { audit, page, parseDate, pickFields, Spec } from '../common/validate';
import { startOfDay } from '../domain/status';

const STATUSES = ['OPEN', 'IN_PROGRESS', 'WAITING_PARTS', 'DONE', 'CANCELLED'];
const OPEN = ['OPEN', 'IN_PROGRESS', 'WAITING_PARTS'];
const TYPES = ['preventive', 'corrective', 'inspection', 'tool_repair', 'other'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
// From -> allowed next statuses. Done and cancelled are final.
const NEXT: Record<string, string[]> = {
  OPEN: ['IN_PROGRESS', 'WAITING_PARTS', 'DONE', 'CANCELLED'],
  IN_PROGRESS: ['WAITING_PARTS', 'DONE', 'CANCELLED'],
  WAITING_PARTS: ['IN_PROGRESS', 'DONE', 'CANCELLED'],
  DONE: [], CANCELLED: [],
};
const SPEC: Spec = { type: 'string', description: 'string', priority: 'string', plannedStart: 'date', expectedReturn: 'date' };

const INCLUDE = {
  unit: { select: { id: true, code: true } }, base: { select: { id: true, code: true } },
  assignees: { include: { employee: { select: { id: true, firstName: true, lastName: true, employeeNo: true } } } },
} as const;

/** Unit maintenance and base work orders (plan 17). Opening one makes the unit "under maintenance" everywhere. */
@Controller('work-orders')
class MaintenanceController {
  constructor(
    @Inject(PrismaService) private prisma: PrismaService,
  ) {}

  private shape(w: Awaited<ReturnType<MaintenanceController['load']>>) {
    return {
      id: w.id, unit: w.unit, base: w.base, type: w.type, priority: w.priority, description: w.description, status: w.status,
      plannedStart: w.plannedStart, expectedReturn: w.expectedReturn,
      assignees: w.assignees.map(a => ({ id: a.employee.id, name: `${a.employee.firstName} ${a.employee.lastName}`, employeeNo: a.employee.employeeNo })),
    };
  }

  private async load(id: string) {
    const w = await this.prisma.workOrder.findUnique({ where: { id }, include: INCLUDE });
    if (!w) throw new NotFoundException('Work order not found');
    return w;
  }

  @Get()
  async list(@Query() q: { baseId?: string; unitId?: string; status?: string; open?: string; limit?: string; offset?: string }) {
    const where: Record<string, unknown> = {};
    if (q.baseId) where.baseId = q.baseId;
    if (q.unitId) where.unitId = q.unitId;
    if (q.status) where.status = q.status;
    else if (q.open === 'true') where.status = { in: OPEN };
    const { take, skip } = page(q);
    const [total, rows] = await Promise.all([
      this.prisma.workOrder.count({ where: where as never }),
      this.prisma.workOrder.findMany({ where: where as never, orderBy: [{ expectedReturn: 'asc' }], take, skip, include: INCLUDE }),
    ]);
    return { total, items: rows.map(r => this.shape(r)) };
  }

  @Get(':id')
  async detail(@Param('id') id: string) {
    const w = await this.load(id);
    return this.shape(w);
  }

  @Post()
  async create(@Body() body: Record<string, unknown> & { unitId?: string; assigneeIds?: string[] }) {
    const data = pickFields(SPEC, body, ['type', 'expectedReturn']);
    if (!TYPES.includes(data.type as string)) throw new BadRequestException(`type must be one of ${TYPES.join(', ')}`);
    if (data.priority !== undefined && !PRIORITIES.includes(data.priority as string)) throw new BadRequestException(`priority must be one of ${PRIORITIES.join(', ')}`);
    if (!body.unitId) throw new BadRequestException('unitId is required');
    const unit = await this.prisma.unit.findUnique({ where: { id: body.unitId }, include: { homeBase: true } });
    if (!unit) throw new BadRequestException('Unit does not exist');
    const start = (data.plannedStart as Date | undefined) ?? startOfDay(new Date());
    if ((data.expectedReturn as Date) < start) throw new BadRequestException('expectedReturn must not be before plannedStart');
    const assignees = await this.checkAssignees(body.assigneeIds);

    const w = await this.prisma.workOrder.create({
      data: { ...data, plannedStart: start, unitId: unit.id, baseId: unit.homeBaseId, assignees: { create: assignees.map(employeeId => ({ employeeId })) } } as never,
      include: INCLUDE,
    });
    await audit(this.prisma, 'WorkOrder', w.id, 'create', null, { unit: unit.code, type: w.type });
    return this.shape(w);
  }

  private async checkAssignees(ids: unknown): Promise<string[]> {
    if (ids === undefined) return [];
    if (!Array.isArray(ids) || !ids.every(x => typeof x === 'string')) throw new BadRequestException('assigneeIds must be a list of employee ids');
    const unique = [...new Set(ids as string[])];
    const found = await this.prisma.employee.count({ where: { id: { in: unique }, active: true } });
    if (found !== unique.length) throw new BadRequestException('Every assignee must be an active employee');
    return unique;
  }

  @Put(':id')
  async update(@Param('id') id: string, @Body() body: Record<string, unknown> & { assigneeIds?: string[] }) {
    const w = await this.load(id);
    if (!OPEN.includes(w.status)) throw new BadRequestException(`A ${w.status.toLowerCase()} work order cannot be edited`);
    const data = pickFields(SPEC, body);
    if (data.type !== undefined && !TYPES.includes(data.type as string)) throw new BadRequestException(`type must be one of ${TYPES.join(', ')}`);
    if (data.priority !== undefined && !PRIORITIES.includes(data.priority as string)) throw new BadRequestException(`priority must be one of ${PRIORITIES.join(', ')}`);
    const start = (data.plannedStart as Date) ?? w.plannedStart, end = (data.expectedReturn as Date) ?? w.expectedReturn;
    if (end < start) throw new BadRequestException('expectedReturn must not be before plannedStart');
    const assignees = body.assigneeIds === undefined ? undefined : await this.checkAssignees(body.assigneeIds);
    const after = await this.prisma.$transaction(async tx => {
      if (assignees) {
        await tx.workOrderAssignee.deleteMany({ where: { workOrderId: id } });
        await tx.workOrderAssignee.createMany({ data: assignees.map(employeeId => ({ workOrderId: id, employeeId })) });
      }
      return tx.workOrder.update({ where: { id }, data: data as never, include: INCLUDE });
    });
    await audit(this.prisma, 'WorkOrder', id, 'update', this.shape(w), this.shape(after));
    return this.shape(after);
  }

  /**
   * Status change. Finishing the last open order of a unit brings it back.
   */
  @Post(':id/status')
  async setStatus(@Param('id') id: string, @Body() body: { status?: string; note?: string }) {
    const w = await this.load(id);
    const next = body?.status;
    if (!next || !STATUSES.includes(next)) throw new BadRequestException(`status must be one of ${STATUSES.join(', ')}`);
    if (!NEXT[w.status].includes(next)) throw new BadRequestException(`A work order that is ${w.status.toLowerCase().replace('_', ' ')} cannot become ${next.toLowerCase().replace('_', ' ')}`);

    const done = next === 'DONE';
    const after = await this.prisma.workOrder.update({ where: { id }, data: { status: next, ...(done ? { completedAt: new Date() } : {}) }, include: INCLUDE });
    // Finishing a preventive work order records the service, which sets when the next one is due.
    if (done && w.maintenancePlanId) await this.prisma.maintenancePlan.update({ where: { id: w.maintenancePlanId }, data: { lastDone: startOfDay(new Date()) } });
    await audit(this.prisma, 'WorkOrder', id, 'status', { status: w.status }, { status: next }, body?.note);
    let unitBack = false;
    if (['DONE', 'CANCELLED'].includes(next)) {
      const stillOpen = await this.prisma.workOrder.count({ where: { unitId: w.unitId, status: { in: OPEN }, id: { not: id } } });
      unitBack = stillOpen === 0;
    }
    return { ...this.shape(after), unitBack };
  }
}

@Module({ controllers: [MaintenanceController] })
export class MaintenanceModule {}
