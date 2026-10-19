import { Controller, Get, Inject, Module, Query, Req } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthedRequest, Require } from '../auth/auth.module';
import { can } from '../auth/permissions';
import { page, parseDate } from '../common/validate';

// Leave and file entries can carry medical details (notes, certificates). Without medical access only the fact of
// the change is shown.
const MEDICAL_ENTITIES = ['Leave', 'File'];

/** The audit trail (plan section 23): who changed what, before and after, and why. Read only. */
@Controller('audit')
class AuditController {
  constructor(@Inject(PrismaService) private prisma: PrismaService) {}

  @Get('facets') @Require('audit', 'view')
  async facets() {
    const [entities, actions] = await Promise.all([
      this.prisma.auditLog.groupBy({ by: ['entity'], _count: true, orderBy: { entity: 'asc' } }),
      this.prisma.auditLog.groupBy({ by: ['action'], _count: true, orderBy: { action: 'asc' } }),
    ]);
    return { entities: entities.map(e => ({ name: e.entity, count: e._count })), actions: actions.map(a => ({ name: a.action, count: a._count })) };
  }

  @Get() @Require('audit', 'view')
  async list(@Req() req: AuthedRequest, @Query() q: { entity?: string; entityId?: string; action?: string; userId?: string; login?: string; from?: string; to?: string; limit?: string; offset?: string }) {
    const where: Record<string, unknown> = {};
    if (q.entity) where.entity = q.entity;
    if (q.entityId) where.entityId = q.entityId;
    if (q.action) where.action = q.action;
    if (q.userId) where.userId = q.userId;
    if (q.login) where.user = { login: { contains: q.login, mode: 'insensitive' } };
    if (q.from || q.to) {
      const to = q.to ? parseDate(q.to) : undefined;
      where.at = { gte: q.from ? parseDate(q.from) : undefined, lt: to ? new Date(to.getTime() + 86_400_000) : undefined };
    }
    const { take, skip } = page(q);
    const [total, rows] = await Promise.all([
      this.prisma.auditLog.count({ where: where as never }),
      this.prisma.auditLog.findMany({ where: where as never, orderBy: { at: 'desc' }, take, skip, include: { user: { select: { id: true, login: true } } } }),
    ]);
    const medical = can((req.user?.roles ?? []).map(r => r.role), 'medical', 'view');
    return {
      total,
      items: rows.map(r => {
        const hide = !medical && MEDICAL_ENTITIES.includes(r.entity);
        return { id: r.id, at: r.at, entity: r.entity, entityId: r.entityId, action: r.action, reason: hide ? null : r.reason, user: r.user, before: hide ? null : r.before, after: hide ? null : r.after, redacted: hide };
      }),
    };
  }
}

@Module({ controllers: [AuditController] })
export class AuditModule {}
