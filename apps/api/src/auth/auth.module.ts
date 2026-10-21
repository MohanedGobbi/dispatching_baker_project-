import {
  BadRequestException, CanActivate, Controller, ExecutionContext, Get, Inject, Injectable, Module, Post, Body,
  Req, SetMetadata, UnauthorizedException, ForbiddenException,
} from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsModule, SettingsService } from '../settings/settings';
import { MailerService } from '../mail/mailer';
import { audit } from '../common/validate';
import { hashPassword, randomToken, sha256, signToken, verifyPassword, verifyToken, TokenPayload } from './crypto';
import { can, Level, Module as Mod } from './permissions';
import { Public } from './decorators';

export const jwtSecret = () => process.env.JWT_SECRET ?? 'dev-only-secret-change-me';

export { Public, Require } from './decorators';
/** Reachable while the account still has to replace a temporary password. */
const AllowTempPassword = () => SetMetadata('tempPassword', true);

export interface AuthedRequest { headers: Record<string, string | undefined>; user?: TokenPayload & { mustChangePassword?: boolean } }

interface Account { active: boolean; pv: number; roles: { role: string; baseScope: string | null }[]; employeeId: string | null; mustChangePassword: boolean }

// A valid signature is not enough: the account may have been deleted, disabled or given new roles, or the password
// changed, since the token was issued. The account is cached briefly so this costs one query a minute per user, and
// changes made through this API drop the cache entry at once.
const accounts = new Map<string, { until: number; account: Account }>();
export const forgetUser = (userId: string) => { accounts.delete(userId); };

const passwordVersion = (u: { passwordChangedAt: Date | null }) => u.passwordChangedAt?.getTime() ?? 0;

export function issueToken(u: { id: string; employeeId: string | null; passwordChangedAt: Date | null; roles: { role: string; baseScope: string | null }[] }) {
  return signToken({ sub: u.id, roles: u.roles.map(r => ({ role: r.role, baseScope: r.baseScope })), employeeId: u.employeeId, pv: passwordVersion(u) }, jwtSecret());
}

/** Password policy. Returns the problem, or null when the password is acceptable. */
export async function passwordProblem(settings: SettingsService, password: unknown, login?: string): Promise<string | null> {
  const min = Number((await settings.all())['security.passwordMinLength']) || 8;
  if (typeof password !== 'string' || password.length < min) return `The password needs at least ${min} characters`;
  if (password.length > 200) return 'The password is too long';
  if (login && password.toLowerCase() === login.toLowerCase()) return 'The password cannot be the login';
  return null;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(Reflector) private reflector: Reflector, @Inject(PrismaService) private prisma: PrismaService) {}

  private async account(userId: string): Promise<Account | null> {
    const hit = accounts.get(userId);
    if (hit && hit.until > Date.now()) return hit.account;
    const row = await this.prisma.user.findUnique({ where: { id: userId }, include: { roles: true } });
    if (!row) { accounts.delete(userId); return null; }
    const account: Account = {
      active: row.active, pv: passwordVersion(row), employeeId: row.employeeId, mustChangePassword: row.mustChangePassword,
      roles: row.roles.map(r => ({ role: r.role, baseScope: r.baseScope })),
    };
    accounts.set(userId, { until: Date.now() + 60_000, account });
    return account;
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>('public', targets)) return true;

    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers['authorization'] ?? '';
    const token = header.startsWith('Bearer ') ? verifyToken(header.slice(7), jwtSecret()) : null;
    const account = token ? await this.account(token.sub) : null;
    if (!token || !account || !account.active || (token.pv ?? 0) !== account.pv) throw new UnauthorizedException('Login required');
    // Roles and the employee link come from the account, not the token, so changes apply without signing in again.
    req.user = { ...token, roles: account.roles, employeeId: account.employeeId, mustChangePassword: account.mustChangePassword };

    if (account.mustChangePassword && !this.reflector.getAllAndOverride<boolean>('tempPassword', targets)) {
      throw new ForbiddenException('Choose a new password first');
    }
    const need = this.reflector.getAllAndOverride<{ module: Mod; level: Level }>('require', targets);
    if (need && !can(account.roles.map(r => r.role), need.module, need.level)) {
      throw new ForbiddenException(`Needs ${need.level} access on ${need.module}`);
    }
    return true;
  }
}

const resetText = (link: string, m: number) => ({
  subject: 'Reset your CrewBoard password',
  body: `Someone asked to reset the password of your CrewBoard account.\n\nOpen this link within ${m} minutes to choose a new one:\n${link}\n\nIf it was not you, ignore this message: your password stays as it is.`,
});

@Controller('auth')
class AuthController {
  constructor(
    @Inject(PrismaService) private prisma: PrismaService,
    @Inject(SettingsService) private settings: SettingsService,
    @Inject(MailerService) private mailer: MailerService,
  ) {}

  @Public() @Post('login')
  async login(@Body() body: { login?: string; password?: string }) {
    if (!body?.login || !body?.password) throw new BadRequestException('login and password are required');
    const user = await this.prisma.user.findUnique({ where: { login: body.login }, include: { roles: true } });
    // Same error for unknown user, disabled account and wrong password.
    if (!user || !user.active || !verifyPassword(body.password, user.passwordHash)) throw new UnauthorizedException('Invalid credentials');
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    const roles = user.roles.map(r => ({ role: r.role, baseScope: r.baseScope }));
    return { token: issueToken(user), user: { id: user.id, login: user.login, roles, employeeId: user.employeeId, mustChangePassword: user.mustChangePassword } };
  }

  /**
   * No sign-in page (2026-10-21): the manager is the only user, so a browser on this machine is signed in as the
   * manager straight away. Only requests from this computer get a token; set AUTO_LOGIN=off to require the password.
   */
  @Public() @Post('auto')
  async auto(@Req() req: AuthedRequest) {
    const ip = (req as unknown as { ip?: string; socket?: { remoteAddress?: string } }).ip ?? (req as unknown as { socket?: { remoteAddress?: string } }).socket?.remoteAddress ?? '';
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip);
    if (process.env.AUTO_LOGIN === 'off' || !local) throw new UnauthorizedException('Sign in with the manager account');
    const user = await this.prisma.user.findFirst({ where: { active: true, employeeId: null, roles: { some: { role: 'SUPER_ADMIN' } } }, include: { roles: true }, orderBy: { createdAt: 'asc' } });
    if (!user) throw new UnauthorizedException('No manager account');
    // No password is typed here, so a temporary one would only lock the manager out.
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date(), mustChangePassword: false } });
    forgetUser(user.id);
    const roles = user.roles.map(r => ({ role: r.role, baseScope: r.baseScope }));
    return { token: issueToken(user), user: { id: user.id, login: user.login, roles, employeeId: user.employeeId, mustChangePassword: false } };
  }

  @Get('me') @AllowTempPassword()
  me(@Req() req: AuthedRequest) { return req.user; }

  /** Change one's own password. Every other session of this account is signed out; the new token is returned. */
  @Post('change-password') @AllowTempPassword()
  async changePassword(@Req() req: AuthedRequest, @Body() body: { current?: string; next?: string }) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: req.user!.sub }, include: { roles: true } });
    if (!body?.current || !verifyPassword(body.current, user.passwordHash)) throw new BadRequestException('The current password is wrong');
    const problem = await passwordProblem(this.settings, body.next, user.login);
    if (problem) throw new BadRequestException(problem);
    if (body.next === body.current) throw new BadRequestException('Choose a password different from the current one');
    const updated = await this.prisma.user.update({
      where: { id: user.id }, include: { roles: true },
      data: { passwordHash: hashPassword(body.next!), passwordChangedAt: new Date(), mustChangePassword: false },
    });
    await this.prisma.passwordResetToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: new Date() } });
    await audit(this.prisma, user.id, 'User', user.id, 'password_change');
    forgetUser(user.id);
    return { token: issueToken(updated) };
  }

  /**
   * Ask for a reset link by email. The answer is the same whether or not the login exists or has an email address,
   * so this cannot be used to find out who has an account.
   */
  @Public() @Post('forgot')
  async forgot(@Body() body: { login?: string }) {
    const login = typeof body?.login === 'string' ? body.login.trim() : '';
    if (!login) throw new BadRequestException('login is required');
    const user = await this.prisma.user.findUnique({ where: { login }, include: { employee: { select: { email: true } } } });
    const to = user?.email ?? user?.employee?.email;
    if (!user || !user.active || !to) return { ok: true };
    const recent = await this.prisma.passwordResetToken.count({ where: { userId: user.id, createdAt: { gte: new Date(Date.now() - 15 * 60_000) } } });
    if (recent >= 3) return { ok: true };

    const minutes = Number((await this.settings.all())['security.resetLinkMinutes']) || 60;
    const token = randomToken();
    await this.prisma.passwordResetToken.create({ data: { userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + minutes * 60_000) } });
    const link = `${(process.env.APP_URL ?? 'http://localhost:5173').replace(/\/$/, '')}/#/reset?token=${token}`;
    const text = resetText(link, minutes);
    await this.prisma.emailOutbox.create({ data: { toEmail: to, userId: user.id, type: 'password_reset', subject: text.subject, body: text.body } });
    await audit(this.prisma, undefined, 'User', user.id, 'password_reset_requested');
    this.mailer.flush().catch(e => console.error('mail sender failed', e));
    return { ok: true };
  }

  /** Set a new password with a link from /auth/forgot. Links work once and expire. */
  @Public() @Post('reset')
  async reset(@Body() body: { token?: string; password?: string }) {
    const row = typeof body?.token === 'string'
      ? await this.prisma.passwordResetToken.findUnique({ where: { tokenHash: sha256(body.token) }, include: { user: true } })
      : null;
    if (!row || row.usedAt || row.expiresAt < new Date() || !row.user.active) throw new BadRequestException('This link is invalid or has expired. Ask for a new one.');
    const problem = await passwordProblem(this.settings, body.password, row.user.login);
    if (problem) throw new BadRequestException(problem);
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: row.userId }, data: { passwordHash: hashPassword(body.password!), passwordChangedAt: now, mustChangePassword: false } }),
      this.prisma.passwordResetToken.updateMany({ where: { userId: row.userId, usedAt: null }, data: { usedAt: now } }),
    ]);
    await audit(this.prisma, row.userId, 'User', row.userId, 'password_reset');
    forgetUser(row.userId);
    return { ok: true };
  }
}

@Module({
  imports: [SettingsModule],
  controllers: [AuthController],
  providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
})
export class AuthModule {}
