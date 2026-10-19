import {
  BadRequestException, CanActivate, Controller, ExecutionContext, Get, Inject, Injectable, Module, Post, Body,
  Req, SetMetadata, UnauthorizedException, ForbiddenException,
} from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { signToken, verifyPassword, verifyToken, TokenPayload } from './crypto';
import { can, Level, Module as Mod } from './permissions';

export const jwtSecret = () => process.env.JWT_SECRET ?? 'dev-only-secret-change-me';

export const Public = () => SetMetadata('public', true);
/** Require at least `level` on `module`. Routes without it only need a valid login. */
export const Require = (module: Mod, level: Level) => SetMetadata('require', { module, level });

export interface AuthedRequest { headers: Record<string, string | undefined>; user?: TokenPayload }

@Injectable()
export class AuthGuard implements CanActivate {
  // A valid signature is not enough: the account may have been deleted or the demo data reset since the token was
  // issued. Existence is cached briefly so this costs one query a minute per user, not one per request.
  private known = new Map<string, number>();

  constructor(@Inject(Reflector) private reflector: Reflector, @Inject(PrismaService) private prisma: PrismaService) {}

  private async stillExists(userId: string): Promise<boolean> {
    const until = this.known.get(userId);
    if (until && until > Date.now()) return true;
    const row = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (row) this.known.set(userId, Date.now() + 60_000); else this.known.delete(userId);
    return !!row;
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>('public', targets)) return true;

    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers['authorization'] ?? '';
    const user = header.startsWith('Bearer ') ? verifyToken(header.slice(7), jwtSecret()) : null;
    if (!user || !(await this.stillExists(user.sub))) throw new UnauthorizedException('Login required');
    req.user = user;

    const need = this.reflector.getAllAndOverride<{ module: Mod; level: Level }>('require', targets);
    if (need && !can(user.roles.map(r => r.role), need.module, need.level)) {
      throw new ForbiddenException(`Needs ${need.level} access on ${need.module}`);
    }
    return true;
  }
}

@Controller('auth')
class AuthController {
  constructor(@Inject(PrismaService) private prisma: PrismaService) {}

  @Public() @Post('login')
  async login(@Body() body: { login?: string; password?: string }) {
    if (!body?.login || !body?.password) throw new BadRequestException('login and password are required');
    const user = await this.prisma.user.findUnique({ where: { login: body.login }, include: { roles: true } });
    // Same error for unknown user and wrong password.
    if (!user || !verifyPassword(body.password, user.passwordHash)) throw new UnauthorizedException('Invalid credentials');
    const roles = user.roles.map(r => ({ role: r.role, baseScope: r.baseScope }));
    const token = signToken({ sub: user.id, roles, employeeId: user.employeeId }, jwtSecret());
    return { token, user: { id: user.id, login: user.login, roles, employeeId: user.employeeId } };
  }

  @Get('me')
  me(@Req() req: AuthedRequest) { return req.user; }
}

@Module({
  controllers: [AuthController],
  providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
})
export class AuthModule {}
