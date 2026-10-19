import { BadRequestException, Body, Controller, Get, Inject, Module, NotFoundException, Param, Post, Put, Query, Req } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsModule, SettingsService } from '../settings/settings';
import { AuthedRequest, forgetUser, passwordProblem, Require } from '../auth/auth.module';
import { hashPassword, tempPassword } from '../auth/crypto';
import { MATRIX, Role } from '../auth/permissions';
import { audit, mapDbError } from '../common/validate';

const ROLES = Object.keys(MATRIX) as Role[];
const LOGIN = /^[a-z0-9._-]{3,40}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type RoleInput = { role?: unknown; baseScope?: unknown };

const include = { roles: true, employee: { select: { id: true, employeeNo: true, firstName: true, lastName: true, email: true } } } as const;

function shape(u: {
  id: string; login: string; email: string | null; active: boolean; mustChangePassword: boolean; lastLoginAt: Date | null; createdAt: Date
  roles: { role: string; baseScope: string | null }[]
  employee: { id: string; employeeNo: string; firstName: string; lastName: string; email: string | null } | null
}) {
  return {
    id: u.id, login: u.login, email: u.email, active: u.active, mustChangePassword: u.mustChangePassword, lastLoginAt: u.lastLoginAt, createdAt: u.createdAt,
    roles: u.roles.map(r => ({ role: r.role, baseScope: r.baseScope })),
    employee: u.employee ? { id: u.employee.id, employeeNo: u.employee.employeeNo, name: `${u.employee.firstName} ${u.employee.lastName}`, email: u.employee.email } : null,
  };
}

/** User accounts and their roles (plan section 3, E2). Passwords are never returned; temporary ones are shown once. */
@Controller('users')
class UsersController {
  constructor(@Inject(PrismaService) private prisma: PrismaService, @Inject(SettingsService) private settings: SettingsService) {}

  @Get('roles') @Require('users', 'view')
  roles() { return { roles: ROLES, matrix: MATRIX }; }

  @Get() @Require('users', 'view')
  async list(@Query() q: { q?: string; role?: string; active?: string }) {
    const where: Record<string, unknown> = {};
    if (q.active === 'true' || q.active === 'false') where.active = q.active === 'true';
    if (q.role) where.roles = { some: { role: q.role } };
    if (q.q) {
      where.OR = [
        { login: { contains: q.q, mode: 'insensitive' } }, { email: { contains: q.q, mode: 'insensitive' } },
        ...['firstName', 'lastName', 'employeeNo'].map(f => ({ employee: { [f]: { contains: q.q, mode: 'insensitive' } } })),
      ];
    }
    const rows = await this.prisma.user.findMany({ where: where as never, include, orderBy: { login: 'asc' } });
    return rows.map(shape);
  }

  @Post() @Require('users', 'full')
  async create(@Req() req: AuthedRequest, @Body() body: { login?: unknown; email?: unknown; employeeId?: unknown; roles?: RoleInput[]; password?: unknown }) {
    const login = typeof body?.login === 'string' ? body.login.trim() : '';
    if (!LOGIN.test(login)) throw new BadRequestException('The login needs 3 to 40 letters, digits, dots, dashes or underscores');
    const roles = await this.parseRoles(body.roles);
    const email = this.parseEmail(body.email);
    const employeeId = await this.parseEmployee(body.employeeId);
    let password = typeof body.password === 'string' && body.password ? body.password : null;
    if (password) { const p = await passwordProblem(this.settings, password, login); if (p) throw new BadRequestException(p); }
    const temp = password ? null : tempPassword();
    password ??= temp!;
    try {
      const u = await this.prisma.user.create({
        data: { login, email, employeeId, passwordHash: hashPassword(password), mustChangePassword: !!temp, roles: { create: roles } },
        include,
      });
      await audit(this.prisma, req.user!.sub, 'User', u.id, 'create', null, { login, email, employeeId, roles });
      return { user: shape(u), tempPassword: temp };
    } catch (e) { throw mapDbError(e, 'User (login or employee already has an account)'); }
  }

  @Put(':id') @Require('users', 'full')
  async update(@Req() req: AuthedRequest, @Param('id') id: string, @Body() body: { email?: unknown; employeeId?: unknown; roles?: RoleInput[]; active?: unknown }) {
    const before = await this.prisma.user.findUnique({ where: { id }, include });
    if (!before) throw new NotFoundException('User not found');
    const data: Record<string, unknown> = {};
    if (body.email !== undefined) data.email = this.parseEmail(body.email);
    if (body.employeeId !== undefined) data.employeeId = await this.parseEmployee(body.employeeId);
    if (body.active !== undefined) {
      if (typeof body.active !== 'boolean') throw new BadRequestException('"active" must be boolean');
      if (!body.active && id === req.user!.sub) throw new BadRequestException('You cannot disable your own account');
      data.active = body.active;
    }
    const roles = body.roles !== undefined ? await this.parseRoles(body.roles) : null;
    if (roles && id === req.user!.sub && before.roles.some(r => r.role === 'SUPER_ADMIN') && !roles.some(r => r.role === 'SUPER_ADMIN')) {
      throw new BadRequestException('You cannot remove your own administrator role');
    }
    // Keep at least one active administrator, whoever makes the change.
    const losesAdmin = before.roles.some(r => r.role === 'SUPER_ADMIN') && before.active && ((roles && !roles.some(r => r.role === 'SUPER_ADMIN')) || data.active === false);
    if (losesAdmin && (await this.prisma.user.count({ where: { active: true, id: { not: id }, roles: { some: { role: 'SUPER_ADMIN' } } } })) === 0) {
      throw new BadRequestException('This is the last active administrator');
    }
    try {
      const u = await this.prisma.$transaction(async tx => {
        if (roles) { await tx.userRole.deleteMany({ where: { userId: id } }); await tx.userRole.createMany({ data: roles.map(r => ({ ...r, userId: id })) }); }
        return tx.user.update({ where: { id }, data: data as never, include });
      });
      await audit(this.prisma, req.user!.sub, 'User', id, 'update', shape(before), shape(u));
      forgetUser(id);
      return shape(u);
    } catch (e) { throw mapDbError(e, 'User (that employee already has an account)'); }
  }

  /** Give the account a temporary password; it must be changed at the next sign-in and other sessions end. */
  @Post(':id/reset-password') @Require('users', 'full')
  async resetPassword(@Req() req: AuthedRequest, @Param('id') id: string) {
    const temp = tempPassword();
    try {
      await this.prisma.user.update({ where: { id }, data: { passwordHash: hashPassword(temp), mustChangePassword: true, passwordChangedAt: new Date() } });
    } catch (e) { throw mapDbError(e, 'User'); }
    await this.prisma.passwordResetToken.updateMany({ where: { userId: id, usedAt: null }, data: { usedAt: new Date() } });
    await audit(this.prisma, req.user!.sub, 'User', id, 'password_reset_by_admin');
    forgetUser(id);
    return { tempPassword: temp };
  }

  private parseEmail(v: unknown): string | null {
    if (v === null || v === '' || v === undefined) return null;
    if (typeof v !== 'string' || !EMAIL.test(v.trim())) throw new BadRequestException('Invalid email address');
    return v.trim();
  }

  private async parseEmployee(v: unknown): Promise<string | null> {
    if (v === null || v === '' || v === undefined) return null;
    if (typeof v !== 'string') throw new BadRequestException('"employeeId" must be a string');
    const e = await this.prisma.employee.findUnique({ where: { id: v }, select: { id: true } });
    if (!e) throw new BadRequestException('Unknown employee');
    return e.id;
  }

  private async parseRoles(v: RoleInput[] | undefined): Promise<{ role: Role; baseScope: string | null }[]> {
    if (!Array.isArray(v) || v.length === 0) throw new BadRequestException('Give at least one role');
    const bases = await this.prisma.base.findMany({ select: { id: true, code: true } });
    const out = new Map<Role, string | null>();
    for (const r of v) {
      if (!ROLES.includes(r?.role as Role)) throw new BadRequestException(`Unknown role "${String(r?.role)}"`);
      let scope: string | null = null;
      if (r.baseScope !== undefined && r.baseScope !== null && r.baseScope !== '') {
        const b = bases.find(x => x.id === r.baseScope || x.code === r.baseScope);
        if (!b) throw new BadRequestException('Unknown base in scope');
        scope = b.code;
      }
      if (r.role === 'BASE_MANAGER' && !scope) throw new BadRequestException('A base manager needs a base');
      out.set(r.role as Role, scope);
    }
    return [...out].map(([role, baseScope]) => ({ role, baseScope }));
  }
}

@Module({ imports: [SettingsModule], controllers: [UsersController] })
export class UsersModule {}
