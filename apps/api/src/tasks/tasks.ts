import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Inject, Module, NotFoundException, Param, Post, Put, Query, Req } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthedRequest, Require } from '../auth/auth.module';
import { can } from '../auth/permissions';
import { NotificationsService } from '../notifications/notifications';
import { audit, parseDate } from '../common/validate';
import { startOfDay } from '../domain/status';

const iso = (d: Date) => d.toISOString().slice(0, 10);
const OPEN_WO = ['OPEN', 'IN_PROGRESS', 'WAITING_PARTS'];
const include = { employee: { select: { id: true, employeeNo: true, firstName: true, lastName: true } } } as const;

type Row = { id: string; employeeId: string; title: string; notes: string | null; dueDate: Date | null; status: string; doneAt: Date | null; doneNote: string | null; createdAt: Date; employee: { id: string; employeeNo: string; firstName: string; lastName: string } };
function shape(t: Row, today: Date) {
  return {
    id: t.id, title: t.title, notes: t.notes, status: t.status, doneNote: t.doneNote, createdAt: t.createdAt,
    dueDate: t.dueDate ? iso(t.dueDate) : null, doneAt: t.doneAt,
    overdue: t.status === 'OPEN' && !!t.dueDate && t.dueDate < today,
    employee: { id: t.employee.id, employeeNo: t.employee.employeeNo, name: `${t.employee.firstName} ${t.employee.lastName}` },
  };
}

/**
 * Tasks the manager gives to people (the employee side of the platform): the manager creates, edits and deletes
 * them; the person sees their own and marks them done.
 */
@Controller('tasks')
class TasksController {
  constructor(@Inject(PrismaService) private prisma: PrismaService, @Inject(NotificationsService) private notifier: NotificationsService) {}

  private isManager(req: AuthedRequest) { return can((req.user?.roles ?? []).map(r => r.role), 'employees', 'edit'); }

  @Get()
  async list(@Req() req: AuthedRequest, @Query() q: { employeeId?: string; status?: string; q?: string }) {
    const manager = this.isManager(req);
    if (!manager && !req.user?.employeeId) throw new ForbiddenException('No employee record behind this account');
    const where: Record<string, unknown> = {};
    // People only ever see their own tasks, whatever they ask for.
    if (!manager) where.employeeId = req.user!.employeeId;
    else if (q.employeeId) where.employeeId = q.employeeId;
    if (q.status === 'OPEN' || q.status === 'DONE') where.status = q.status;
    if (q.q && manager) where.OR = [{ title: { contains: q.q, mode: 'insensitive' } }, ...['firstName', 'lastName', 'employeeNo'].map(f => ({ employee: { [f]: { contains: q.q, mode: 'insensitive' } } }))];
    const rows = await this.prisma.employeeTask.findMany({ where: where as never, include, orderBy: [{ status: 'desc' }, { dueDate: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }], take: 500 });
    const today = startOfDay(new Date());
    return rows.map(t => shape(t, today));
  }

  /** One task for each person chosen. */
  @Post() @Require('employees', 'edit')
  async create(@Req() req: AuthedRequest, @Body() body: { employeeIds?: unknown; title?: unknown; notes?: unknown; dueDate?: string }) {
    const ids = Array.isArray(body?.employeeIds) ? [...new Set(body.employeeIds.filter((x): x is string => typeof x === 'string'))] : [];
    const title = typeof body?.title === 'string' ? body.title.trim() : '';
    if (!ids.length) throw new BadRequestException('Choose at least one person');
    if (!title || title.length > 200) throw new BadRequestException('A title (up to 200 characters) is required');
    const notes = typeof body.notes === 'string' && body.notes.trim() ? body.notes.trim() : null;
    const dueDate = body.dueDate ? startOfDay(parseDate(body.dueDate)) : null;
    const people = await this.prisma.employee.findMany({ where: { id: { in: ids }, active: true }, select: { id: true } });
    if (people.length !== ids.length) throw new BadRequestException('Unknown or archived person');
    const today = startOfDay(new Date());
    const out = [];
    for (const employeeId of ids) {
      const t = await this.prisma.employeeTask.create({ data: { employeeId, title, notes, dueDate, createdBy: req.user?.sub }, include });
      await audit(this.prisma, req.user?.sub, 'EmployeeTask', t.id, 'create', null, { employeeId, title, dueDate });
      await this.notifier.notify({ type: 'task_assigned', to: [{ employeeId }], except: req.user?.sub, payload: { title, due: dueDate ? iso(dueDate) : null, taskId: t.id } });
      out.push(shape(t, today));
    }
    return out;
  }

  /** The manager edits anything; the person can only mark it done (with a note) or open again. */
  @Put(':id')
  async update(@Req() req: AuthedRequest, @Param('id') id: string, @Body() body: { title?: unknown; notes?: unknown; dueDate?: string | null; status?: unknown; doneNote?: unknown }) {
    const t = await this.prisma.employeeTask.findUnique({ where: { id }, include });
    if (!t) throw new NotFoundException('Task not found');
    const manager = this.isManager(req);
    const own = !!req.user?.employeeId && req.user.employeeId === t.employeeId;
    if (!manager && !own) throw new ForbiddenException('Not your task');
    const data: Record<string, unknown> = {};
    if (manager) {
      if (body.title !== undefined) { if (typeof body.title !== 'string' || !body.title.trim()) throw new BadRequestException('A title is required'); data.title = body.title.trim(); }
      if (body.notes !== undefined) data.notes = typeof body.notes === 'string' && body.notes.trim() ? body.notes.trim() : null;
      if (body.dueDate !== undefined) data.dueDate = body.dueDate ? startOfDay(parseDate(body.dueDate)) : null;
    } else if (body.title !== undefined || body.notes !== undefined || body.dueDate !== undefined) {
      throw new ForbiddenException('Only the manager can change a task');
    }
    if (body.status !== undefined) {
      if (body.status !== 'OPEN' && body.status !== 'DONE') throw new BadRequestException('status must be OPEN or DONE');
      data.status = body.status;
      data.doneAt = body.status === 'DONE' ? new Date() : null;
      data.doneNote = body.status === 'DONE' && typeof body.doneNote === 'string' && body.doneNote.trim() ? body.doneNote.trim() : null;
    }
    const after = await this.prisma.employeeTask.update({ where: { id }, data: data as never, include });
    await audit(this.prisma, req.user?.sub, 'EmployeeTask', id, body.status === 'DONE' ? 'done' : 'update', { status: t.status, title: t.title }, data);
    if (body.status === 'DONE' && t.status !== 'DONE' && !manager) {
      await this.notifier.notify({ type: 'task_done', to: [{ role: 'SUPER_ADMIN' }], payload: { employee: `${t.employee.firstName} ${t.employee.lastName}`, title: t.title, note: data.doneNote ?? null, taskId: id } });
    }
    return shape(after, startOfDay(new Date()));
  }

  @Delete(':id') @Require('employees', 'edit')
  async remove(@Req() req: AuthedRequest, @Param('id') id: string) {
    const t = await this.prisma.employeeTask.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('Task not found');
    await this.prisma.employeeTask.delete({ where: { id } });
    await audit(this.prisma, req.user?.sub, 'EmployeeTask', id, 'delete', t, null);
    return { deleted: true };
  }

  /**
   * Everything waiting for the signed-in person, for the portal's To do tab: tasks, notices to confirm, colleagues'
   * swap requests to answer, work orders assigned to them, and their own requests still waiting for the manager.
   */
  @Get('todo')
  async todo(@Req() req: AuthedRequest) {
    const employeeId = req.user?.employeeId;
    if (!employeeId) throw new ForbiddenException('No employee record behind this account');
    const today = startOfDay(new Date());
    const [tasks, acks, swaps, wos, leaves] = await Promise.all([
      this.prisma.employeeTask.findMany({ where: { employeeId, status: 'OPEN' }, include, orderBy: { dueDate: { sort: 'asc', nulls: 'last' } } }),
      this.prisma.notification.count({ where: { userId: req.user!.sub, requiresAck: true, acknowledgedAt: null } }),
      this.prisma.swapRequest.count({ where: { colleagueId: employeeId, status: 'PENDING' } }),
      this.prisma.workOrder.findMany({ where: { status: { in: OPEN_WO }, assignees: { some: { employeeId } } }, include: { unit: { select: { code: true } } }, orderBy: { expectedReturn: 'asc' } }),
      this.prisma.leave.count({ where: { employeeId, status: 'SUBMITTED' } }),
    ]);
    return {
      tasks: tasks.map(t => shape(t, today)),
      noticesToConfirm: acks,
      swapsToAnswer: swaps,
      workOrders: wos.map(w => ({ id: w.id, unit: w.unit.code, description: w.description ?? w.type, status: w.status, backBy: iso(w.expectedReturn) })),
      waitingForManager: { leave: leaves },
    };
  }
}

@Module({ controllers: [TasksController] })
export class TasksModule {}
