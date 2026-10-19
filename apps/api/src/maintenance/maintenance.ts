import {
  BadRequestException, Body, Controller, ForbiddenException, Get, Inject, Module, NotFoundException, Param, Post, Put, Query, Req,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Require, AuthedRequest } from '../auth/auth.module';
import { can } from '../auth/permissions';
import { NotificationsService } from '../notifications/notifications';
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
const iso = (d: Date) => d.toISOString().slice(0, 10);

const INCLUDE = {
  unit: { select: { id: true, code: true } }, base: { select: { id: true, code: true } },
  assignees: { include: { employee: { select: { id: true, firstName: true, lastName: true, employeeNo: true } } } },
} as const;

/** Unit maintenance and base work orders (plan 17). Opening one makes the unit "under maintenance" everywhere. */
@Controller('work-orders')
class MaintenanceController {
  constructor(
    @Inject(PrismaService) private prisma: PrismaService,
    @Inject(NotificationsService) private notifier: NotificationsService,
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

  /** Base managers work on their own base only; everyone else with edit access is unscoped. */
  private assertBase(req: AuthedRequest, baseId: string, baseCode: string) {
    const roles = req.user?.roles ?? [];
    if (roles.some(r => ['SUPER_ADMIN', 'OPS_MANAGER'].includes(r.role))) return;
    const scoped = roles.filter(r => r.role === 'BASE_MANAGER');
    if (scoped.length && scoped.some(r => r.baseScope === baseId || r.baseScope === baseCode)) return;
    if (roles.some(r => r.role === 'CHIEF_OF_UNIT')) return; // chiefs may raise work orders for their unit (plan section 3)
    throw new ForbiddenException('You can only manage work orders of your own base');
  }

  @Get() @Require('maintenance', 'view')
  async list(@Req() req: AuthedRequest, @Query() q: { baseId?: string; unitId?: string; status?: string; mine?: string; open?: string; limit?: string; offset?: string }) {
    const roles = (req.user?.roles ?? []).map(r => r.role);
    const employeeOnly = roles.every(r => r === 'EMPLOYEE');
    const where: Record<string, unknown> = {};
    if (q.baseId) where.baseId = q.baseId;
    if (q.unitId) where.unitId = q.unitId;
    if (q.status) where.status = q.status;
    else if (q.open === 'true') where.status = { in: OPEN };
    // Mechanics and technicians only see their own tasks (plan section 3).
    if (employeeOnly || q.mine === 'true') {
      if (!req.user?.employeeId) return { total: 0, items: [] };
      where.assignees = { some: { employeeId: req.user.employeeId } };
    }
    const { take, skip } = page(q);
    const [total, rows] = await Promise.all([
      this.prisma.workOrder.count({ where: where as never }),
      this.prisma.workOrder.findMany({ where: where as never, orderBy: [{ expectedReturn: 'asc' }], take, skip, include: INCLUDE }),
    ]);
    return { total, items: rows.map(r => this.shape(r)) };
  }

  @Get(':id') @Require('maintenance', 'view')
  async detail(@Param('id') id: string, @Req() req: AuthedRequest) {
    const w = await this.load(id);
    const roles = (req.user?.roles ?? []).map(r => r.role);
    if (roles.every(r => r === 'EMPLOYEE') && !w.assignees.some(a => a.employeeId === req.user?.employeeId)) throw new ForbiddenException('That is not your task');
    return this.shape(w);
  }

  @Post() @Require('maintenance', 'edit')
  async create(@Body() body: Record<string, unknown> & { unitId?: string; assigneeIds?: string[] }, @Req() req: AuthedRequest) {
    const data = pickFields(SPEC, body, ['type', 'expectedReturn']);
    if (!TYPES.includes(data.type as string)) throw new BadRequestException(`type must be one of ${TYPES.join(', ')}`);
    if (data.priority !== undefined && !PRIORITIES.includes(data.priority as string)) throw new BadRequestException(`priority must be one of ${PRIORITIES.join(', ')}`);
    if (!body.unitId) throw new BadRequestException('unitId is required');
    const unit = await this.prisma.unit.findUnique({ where: { id: body.unitId }, include: { homeBase: true } });
    if (!unit) throw new BadRequestException('Unit does not exist');
    this.assertBase(req, unit.homeBaseId, unit.homeBase.code);
    const start = (data.plannedStart as Date | undefined) ?? startOfDay(new Date());
    if ((data.expectedReturn as Date) < start) throw new BadRequestException('expectedReturn must not be before plannedStart');
    const assignees = await this.checkAssignees(body.assigneeIds);

    const w = await this.prisma.workOrder.create({
      data: { ...data, plannedStart: start, unitId: unit.id, baseId: unit.homeBaseId, assignees: { create: assignees.map(employeeId => ({ employeeId })) } } as never,
      include: INCLUDE,
    });
    await audit(this.prisma, req.user?.sub, 'WorkOrder', w.id, 'create', null, { unit: unit.code, type: w.type });
    // Mechanics who were given the job hear about it (acknowledgement is not needed).
    for (const employeeId of assignees) {
      await this.notifier.notify({ type: 'broadcast', to: [{ employeeId }], except: req.user?.sub, payload: { title: `New work order: ${unit.code}`, message: `${w.type}${w.description ? `: ${w.description}` : ''}. Back by ${iso(w.expectedReturn)}.` } });
    }
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

  @Put(':id') @Require('maintenance', 'edit')
  async update(@Param('id') id: string, @Body() body: Record<string, unknown> & { assigneeIds?: string[] }, @Req() req: AuthedRequest) {
    const w = await this.load(id);
    this.assertBase(req, w.baseId, w.base.code);
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
    await audit(this.prisma, req.user?.sub, 'WorkOrder', id, 'update', this.shape(w), this.shape(after));
    return this.shape(after);
  }

  /**
   * Status change. The people who are assigned may move their own task along; managers may move any in their base.
   * Finishing the last open order of a unit brings it back (and tells the dispatchers).
   */
  @Post(':id/status') @Require('maintenance', 'view')
  async setStatus(@Param('id') id: string, @Body() body: { status?: string; note?: string }, @Req() req: AuthedRequest) {
    const w = await this.load(id);
    const roles = req.user?.roles ?? [];
    const assigned = !!req.user?.employeeId && w.assignees.some(a => a.employeeId === req.user!.employeeId);
    const manager = can(roles.map(r => r.role), 'maintenance', 'edit');
    if (!assigned && !manager) throw new ForbiddenException('Only the assigned mechanics or a manager can change this work order');
    if (!assigned) this.assertBase(req, w.baseId, w.base.code);
    const next = body?.status;
    if (!next || !STATUSES.includes(next)) throw new BadRequestException(`status must be one of ${STATUSES.join(', ')}`);
    if (!NEXT[w.status].includes(next)) throw new BadRequestException(`A work order that is ${w.status.toLowerCase().replace('_', ' ')} cannot become ${next.toLowerCase().replace('_', ' ')}`);

    const after = await this.prisma.workOrder.update({ where: { id }, data: { status: next }, include: INCLUDE });
    await audit(this.prisma, req.user?.sub, 'WorkOrder', id, 'status', { status: w.status }, { status: next }, body?.note);
    let unitBack = false;
    if (['DONE', 'CANCELLED'].includes(next)) {
      const stillOpen = await this.prisma.workOrder.count({ where: { unitId: w.unitId, status: { in: OPEN }, id: { not: id } } });
      unitBack = stillOpen === 0;
      if (unitBack) {
        await this.notifier.notify({
          type: 'unit_back', except: req.user?.sub, key: `back:${id}`,
          to: [{ role: 'DISPATCHER' }, { role: 'OPS_MANAGER' }, { role: 'BASE_MANAGER', baseId: w.baseId }],
          payload: { unit: w.unit.code, base: w.base.code },
        });
      }
    }
    return { ...this.shape(after), unitBack };
  }
}

@Module({ controllers: [MaintenanceController] })
export class MaintenanceModule {}
