import { Controller, Get, Inject, Module, Query } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { page, parseDate } from '../common/validate';

/** The audit trail (plan section 23): who changed what, before and after, and why. Read only. */
@Controller('audit')
class AuditController {
  constructor(@Inject(PrismaService) private prisma: PrismaService) {}

  @Get('facets') async facets() {
    const [entities, actions] = await Promise.all([
      this.prisma.auditLog.groupBy({ by: ['entity'], _count: true, orderBy: { entity: 'asc' } }),
      this.prisma.auditLog.groupBy({ by: ['action'], _count: true, orderBy: { action: 'asc' } }),
    ]);
    return { entities: entities.map(e => ({ name: e.entity, count: e._count })), actions: actions.map(a => ({ name: a.action, count: a._count })) };
  }

  @Get() async list(@Query() q: { entity?: string; entityId?: string; action?: string; from?: string; to?: string; limit?: string; offset?: string }) {
    const where: Record<string, unknown> = {};
    if (q.entity) where.entity = q.entity;
    if (q.entityId) where.entityId = q.entityId;
    if (q.action) where.action = q.action;
    if (q.from || q.to) {
      const to = q.to ? parseDate(q.to) : undefined;
      where.at = { gte: q.from ? parseDate(q.from) : undefined, lt: to ? new Date(to.getTime() + 86_400_000) : undefined };
    }
    const { take, skip } = page(q);
    const [total, rows] = await Promise.all([
      this.prisma.auditLog.count({ where: where as never }),
      this.prisma.auditLog.findMany({ where: where as never, orderBy: { at: 'desc' }, take, skip }),
    ]);
    return {
      total,
      items: rows.map(r => {
        return { id: r.id, at: r.at, entity: r.entity, entityId: r.entityId, action: r.action, reason: r.reason, before: r.before, after: r.after };
      }),
    };
  }
}

@Module({ controllers: [AuditController] })
export class AuditModule {}
