import { BadRequestException, Body, Controller, Delete, Get, Inject, Module, NotFoundException, Param, Post, Put, Query } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { audit, MANAGER, parseDate } from '../common/validate';
import { startOfDay } from '../domain/status';

const iso = (d: Date) => d.toISOString().slice(0, 10);

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
 * Things the manager asks a person to do: created, edited, marked done and deleted by the manager.
 */
@Controller('tasks')
class TasksController {
  constructor(@Inject(PrismaService) private prisma: PrismaService) {}


  @Get()
  async list(@Query() q: { employeeId?: string; status?: string; q?: string }) {
    const where: Record<string, unknown> = {};
    if (q.employeeId) where.employeeId = q.employeeId;
    if (q.status === 'OPEN' || q.status === 'DONE') where.status = q.status;
    if (q.q) where.OR = [{ title: { contains: q.q } }, ...['firstName', 'lastName', 'employeeNo'].map(f => ({ employee: { [f]: { contains: q.q } } }))];
    const rows = await this.prisma.employeeTask.findMany({ where: where as never, include, orderBy: [{ status: 'desc' }, { dueDate: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }], take: 500 });
    const today = startOfDay(new Date());
    return rows.map(t => shape(t, today));
  }

  /** One task for each person chosen. */
  @Post() async create(@Body() body: { employeeIds?: unknown; title?: unknown; notes?: unknown; dueDate?: string }) {
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
      const t = await this.prisma.employeeTask.create({ data: { employeeId, title, notes, dueDate, createdBy: MANAGER }, include });
      await audit(this.prisma, 'EmployeeTask', t.id, 'create', null, { employeeId, title, dueDate });
      out.push(shape(t, today));
    }
    return out;
  }

  /** Edit a task, or mark it done (with a note) or open again. */
  @Put(':id')
  async update(@Param('id') id: string, @Body() body: { title?: unknown; notes?: unknown; dueDate?: string | null; status?: unknown; doneNote?: unknown }) {
    const t = await this.prisma.employeeTask.findUnique({ where: { id }, include });
    if (!t) throw new NotFoundException('Task not found');
    const data: Record<string, unknown> = {};
    if (body.title !== undefined) { if (typeof body.title !== 'string' || !body.title.trim()) throw new BadRequestException('A title is required'); data.title = body.title.trim(); }
    if (body.notes !== undefined) data.notes = typeof body.notes === 'string' && body.notes.trim() ? body.notes.trim() : null;
    if (body.dueDate !== undefined) data.dueDate = body.dueDate ? startOfDay(parseDate(body.dueDate)) : null;
    if (body.status !== undefined) {
      if (body.status !== 'OPEN' && body.status !== 'DONE') throw new BadRequestException('status must be OPEN or DONE');
      data.status = body.status;
      data.doneAt = body.status === 'DONE' ? new Date() : null;
      data.doneNote = body.status === 'DONE' && typeof body.doneNote === 'string' && body.doneNote.trim() ? body.doneNote.trim() : null;
    }
    const after = await this.prisma.employeeTask.update({ where: { id }, data: data as never, include });
    await audit(this.prisma, 'EmployeeTask', id, body.status === 'DONE' ? 'done' : 'update', { status: t.status, title: t.title }, data);
    return shape(after, startOfDay(new Date()));
  }

  @Delete(':id') async remove(@Param('id') id: string) {
    const t = await this.prisma.employeeTask.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('Task not found');
    await this.prisma.employeeTask.delete({ where: { id } });
    await audit(this.prisma, 'EmployeeTask', id, 'delete', t, null);
    return { deleted: true };
  }

}

@Module({ controllers: [TasksController] })
export class TasksModule {}
