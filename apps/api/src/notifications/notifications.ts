import {
  BadRequestException, Body, Controller, Get, Global, Inject, Injectable, Module, NotFoundException,
  OnModuleDestroy, OnModuleInit, Param, Post, Put, Query, Req,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { fitTasksToJobs } from '../absence/absence.service';
import { Require, AuthedRequest } from '../auth/auth.module';
import { SettingsModule, SettingsService } from '../settings/settings';
import { CalendarCoreModule, CalendarService } from '../calendar/calendar.service';
import { audit, page } from '../common/validate';
import { startOfDay } from '../domain/status';
import { MailerService } from '../mail/mailer';
import { CATALOG, catalogForPrefs, isType, NotificationType, render } from './templates';

const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(startOfDay(d).getTime() + n * DAY);
const LIVE = ['CONFIRMED', 'ACTIVE'] as const;
const OPEN_TASK = ['OPEN', 'CANDIDATE_PROPOSED'];

export type Recipient = { userId: string } | { employeeId: string } | { role: string; baseId?: string };
export interface NotifyInput {
  type: NotificationType; to: Recipient[]; payload: Record<string, unknown>
  ack?: boolean; except?: string; key?: string // key: do not repeat the same notification for the same user
}

@Injectable()
export class NotificationsService {
  constructor(
    @Inject(PrismaService) private prisma: PrismaService,
    @Inject(SettingsService) private settings: SettingsService,
    @Inject(CalendarService) private cal: CalendarService,
  ) {}

  // ---------- helpers other modules use to describe things in a notification

  async seatLabel(seatId: string): Promise<string> {
    const s = await this.prisma.seat.findUnique({ where: { id: seatId }, include: { unit: { select: { code: true } }, base: { select: { code: true } }, position: { select: { name: true } } } });
    return s ? `${s.unit?.code ?? `${s.base?.code} base`} · ${s.position.name} #${s.index}` : 'a seat';
  }

  async personName(employeeId: string | null | undefined): Promise<string> {
    if (!employeeId) return '';
    const e = await this.prisma.employee.findUnique({ where: { id: employeeId }, select: { firstName: true, lastName: true } });
    return e ? `${e.firstName} ${e.lastName}` : '';
  }

  /**
   * Resolve recipients to distinct user ids. A Base Manager role with a base only matches that base.
   * The manager (super admin) runs everything, so whatever is addressed to a staff role reaches them too.
   */
  private async resolve(to: Recipient[], except?: string): Promise<string[]> {
    const ids = new Set<string>();
    if (to.some(r => 'role' in r && r.role !== 'EMPLOYEE')) {
      for (const m of await this.prisma.userRole.findMany({ where: { role: 'SUPER_ADMIN', user: { active: true } }, select: { userId: true } })) ids.add(m.userId);
    }
    for (const r of to) {
      if ('userId' in r) ids.add(r.userId);
      else if ('employeeId' in r) {
        const u = await this.prisma.user.findUnique({ where: { employeeId: r.employeeId }, select: { id: true } });
        if (u) ids.add(u.id);
      } else {
        const rows = await this.prisma.userRole.findMany({ where: { role: r.role }, select: { userId: true, baseScope: true } });
        let base: { id: string; code: string } | null = null;
        if (r.baseId) base = await this.prisma.base.findUnique({ where: { id: r.baseId }, select: { id: true, code: true } });
        for (const row of rows) {
          // A role scoped to a base only hears about that base; unscoped holders hear about everything.
          if (r.baseId && row.baseScope && base && row.baseScope !== base.id && row.baseScope !== base.code) continue;
          ids.add(row.userId);
        }
      }
    }
    if (except) ids.delete(except);
    return [...ids];
  }

  async prefsOf(userId: string) {
    const p = await this.prisma.userPrefs.findUnique({ where: { userId } });
    return { inApp: (p?.inApp ?? {}) as Record<string, boolean>, email: (p?.email ?? {}) as Record<string, boolean> };
  }

  /** Create in-app notifications (and queue emails) for everyone the input resolves to. Returns how many were created. */
  async notify(input: NotifyInput): Promise<number> {
    const def = CATALOG[input.type];
    const requiresAck = input.ack ?? def.ack;
    const userIds = await this.resolve(input.to, input.except);
    let created = 0;
    for (const userId of userIds) {
      if (input.key) {
        const dup = await this.prisma.notification.findFirst({ where: { userId, type: input.type, payload: { path: ['_key'], equals: input.key } }, select: { id: true } });
        if (dup) continue;
      }
      const prefs = await this.prefsOf(userId);
      // Acknowledgement-required notices cannot be muted: the plan says the employee must see them.
      if (prefs.inApp[input.type] === false && !requiresAck) continue;
      await this.prisma.notification.create({
        data: { userId, type: input.type, payload: { ...input.payload, ...(input.key ? { _key: input.key } : {}) } as never, requiresAck },
      });
      created++;
      const wantsEmail = prefs.email[input.type] ?? def.email;
      if (wantsEmail) {
        const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { employee: { select: { email: true } } } });
        const to = u?.employee?.email;
        if (to) {
          const text = render(input.type, input.payload);
          await this.prisma.emailOutbox.create({ data: { toEmail: to, userId, type: input.type, subject: text.title, body: text.body } });
        }
      }
    }
    return created;
  }

  // ---------- the daily job (crew changes, clearance, shortages, due escalations)

  async runDaily(now = new Date()) {
    const today = startOfDay(now);
    const settings = await this.settings.all();
    const result = { crewChanges: 0, clearance: 0, belowMinimum: 0, escalated: 0 };

    // 1. crew change within 48 hours: the day after an assignment ends
    const ending = await this.prisma.assignment.findMany({
      where: { status: { in: [...LIVE] }, plannedEnd: { gte: addDays(today, -1), lte: addDays(today, 1) } },
      include: { seat: { include: { unit: { select: { id: true, code: true } } } } },
    });
    for (const a of ending) {
      const changeDate = addDays(a.plannedEnd, 1);
      if (changeDate < today) continue;
      const seat = await this.seatLabel(a.seatId);
      const next = await this.prisma.assignment.findFirst({ where: { seatId: a.seatId, status: { in: [...LIVE] }, start: { lte: changeDate }, plannedEnd: { gte: changeDate }, id: { not: a.id } } });
      result.crewChanges += await this.notify({ type: 'crew_change_48h', to: [{ employeeId: a.employeeId }], payload: { seat, date: iso(changeDate), role: 'outgoing' }, key: `cc48:${a.id}:out` });
      if (next) result.crewChanges += await this.notify({ type: 'crew_change_48h', to: [{ employeeId: next.employeeId }], payload: { seat, date: iso(changeDate), role: 'incoming' }, key: `cc48:${a.id}:in` });
    }

    // 2. long medical leave ended, nobody cleared the person yet
    const clearanceAfter = settings['rules.clearanceRequiredAfterDays'] as number;
    const ended = await this.prisma.leave.findMany({ where: { type: { category: 'medical' }, status: 'RECORDED', end: { lt: today }, fitForDuty: null }, include: { employee: { select: { firstName: true, lastName: true } } } });
    for (const l of ended) {
      if (Math.round((l.end.getTime() - l.start.getTime()) / DAY) + 1 <= clearanceAfter) continue;
      result.clearance += await this.notify({ type: 'awaiting_clearance', to: [{ role: 'HR' }], payload: { employee: `${l.employee.firstName} ${l.employee.lastName}`, endedOn: iso(l.end) }, key: `clr:${l.id}` });
    }

    // 3. base posts below their minimum today
    const workingDays = settings['org.workingDays'] as string;
    const rules = await this.prisma.baseStaffingRule.findMany({ include: { base: { select: { id: true, code: true, active: true } }, position: { select: { name: true } } } });
    for (const r of rules) {
      if (!r.base.active || r.minCount === 0) continue;
      if (r.scheduleWindow === 'working_days' && workingDays[today.getUTCDay()] !== '1') continue;
      const held = await this.prisma.assignment.findMany({ where: { status: { in: [...LIVE] }, start: { lte: today }, plannedEnd: { gte: today }, seat: { baseId: r.baseId, positionId: r.positionId, holderType: 'BASE' } }, select: { employeeId: true } });
      const days = await this.cal.buildDays(held.map(h => h.employeeId), today, today, { canSeeMedical: () => false });
      const present = [...days.values()].filter(d => d[0]?.status === 'ON_BASE_POST').length;
      if (present < r.minCount) {
        result.belowMinimum += await this.notify({
          type: 'base_below_min', to: [{ role: 'BASE_MANAGER', baseId: r.baseId }, { role: 'OPS_MANAGER' }],
          payload: { base: r.base.code, position: r.position.name, filled: present, min: r.minCount }, key: `bbm:${r.baseId}:${r.positionId}:${iso(today)}`,
        });
      }
    }

    // 4. replacement tasks whose first uncovered day is close become escalated
    const within = settings['replacements.escalateWithinDays'] as number;
    await fitTasksToJobs(this.prisma);
    const due = await this.prisma.replacementTask.findMany({ where: { status: { in: OPEN_TASK }, deadline: { lte: addDays(today, within) } } });
    for (const t of due) {
      await this.prisma.replacementTask.update({ where: { id: t.id }, data: { status: 'ESCALATED', escalatedAt: new Date() } });
      result.escalated += await this.notify({ type: 'task_escalated', to: [{ role: 'OPS_MANAGER' }, { role: 'DISPATCHER' }], payload: { seat: await this.seatLabel(t.seatId), from: iso(t.fromDate), to: iso(t.toDate) }, key: `esc:${t.id}` });
    }
    return result;
  }
}

// ---------------------------------------------------------------- API

@Controller('notifications')
class NotificationsController {
  constructor(
    @Inject(PrismaService) private prisma: PrismaService,
    @Inject(NotificationsService) private svc: NotificationsService,
    @Inject(MailerService) private mailer: MailerService,
  ) {}

  @Get()
  async list(@Req() req: AuthedRequest, @Query() q: { unread?: string; limit?: string; offset?: string }) {
    const userId = req.user!.sub;
    const prefs = await this.svc.prefsOf(userId);
    const where = { userId, ...(q.unread === 'true' ? { readAt: null } : {}) };
    const { take, skip } = page(q);
    const [total, unread, rows] = await Promise.all([
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({ where: { userId, readAt: null } }),
      this.prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, take, skip }),
    ]);
    return {
      total, unread, pendingAck: await this.prisma.notification.count({ where: { userId, requiresAck: true, acknowledgedAt: null } }),
      items: rows.map(n => {
        const payload = (n.payload ?? {}) as Record<string, unknown>;
        const { _key, ...visible } = payload; void _key;
        return { id: n.id, type: n.type, ...render(n.type, payload), payload: visible, requiresAck: n.requiresAck, acknowledgedAt: n.acknowledgedAt, readAt: n.readAt, createdAt: n.createdAt };
      }),
    };
  }

  @Get('unread-count')
  async unreadCount(@Req() req: AuthedRequest) {
    const userId = req.user!.sub;
    const [unread, pendingAck] = await Promise.all([
      this.prisma.notification.count({ where: { userId, readAt: null } }),
      this.prisma.notification.count({ where: { userId, requiresAck: true, acknowledgedAt: null } }),
    ]);
    return { unread, pendingAck };
  }

  @Post('read-all')
  async readAll(@Req() req: AuthedRequest) {
    const r = await this.prisma.notification.updateMany({ where: { userId: req.user!.sub, readAt: null }, data: { readAt: new Date() } });
    return { updated: r.count };
  }

  @Get('preferences')
  async getPrefs(@Req() req: AuthedRequest) {
    const p = await this.svc.prefsOf(req.user!.sub);
    return {
      types: catalogForPrefs().map(t => ({ ...t, inApp: t.ack ? true : p.inApp[t.type] !== false, email: p.email[t.type] ?? t.emailDefault, locked: t.ack })),
    };
  }

  @Put('preferences')
  async setPrefs(@Req() req: AuthedRequest, @Body() body: { inApp?: Record<string, boolean>; email?: Record<string, boolean> }) {
    for (const m of [body?.inApp, body?.email]) for (const [k, v] of Object.entries(m ?? {})) {
      if (!isType(k)) throw new BadRequestException(`Unknown notification type "${k}"`);
      if (typeof v !== 'boolean') throw new BadRequestException(`"${k}" must be true or false`);
    }
    const cur = await this.svc.prefsOf(req.user!.sub);
    const data = { inApp: { ...cur.inApp, ...(body?.inApp ?? {}) }, email: { ...cur.email, ...(body?.email ?? {}) } };
    await this.prisma.userPrefs.upsert({ where: { userId: req.user!.sub }, create: { userId: req.user!.sub, ...data }, update: data });
    return this.getPrefs(req);
  }

  @Post(':id/read')
  async read(@Param('id') id: string, @Req() req: AuthedRequest) {
    const { count } = await this.prisma.notification.updateMany({ where: { id, userId: req.user!.sub, readAt: null }, data: { readAt: new Date() } });
    return { updated: count };
  }

  /** Acknowledge a notice that asks for it. For an extension this also records it on the extension itself (13). */
  @Post(':id/acknowledge')
  async acknowledge(@Param('id') id: string, @Req() req: AuthedRequest) {
    const n = await this.prisma.notification.findFirst({ where: { id, userId: req.user!.sub } });
    if (!n) throw new NotFoundException('Notification not found');
    if (!n.requiresAck) throw new BadRequestException('This notification does not need acknowledging');
    const now = new Date();
    await this.prisma.notification.update({ where: { id }, data: { acknowledgedAt: n.acknowledgedAt ?? now, readAt: n.readAt ?? now } });
    const extId = (n.payload as { extensionId?: string } | null)?.extensionId;
    if (extId && req.user?.employeeId) {
      await this.prisma.extension.updateMany({ where: { id: extId, employeeId: req.user.employeeId, acknowledgedAt: null }, data: { acknowledgedAt: now } });
    }
    await audit(this.prisma, req.user!.sub, 'Notification', id, 'acknowledge');
    return { acknowledgedAt: (n.acknowledgedAt ?? now) };
  }

  /** Manager broadcast (19): to everyone, one base, or chosen roles. */
  @Post('broadcast') @Require('planning', 'full')
  async broadcast(@Body() body: { title?: string; message?: string; baseId?: string; roles?: string[]; all?: boolean; ack?: boolean }, @Req() req: AuthedRequest) {
    if (!body?.title?.trim() || !body.message?.trim()) throw new BadRequestException('title and message are required');
    let to: Recipient[];
    if (body.roles?.length) to = body.roles.map(role => ({ role }));
    else if (body.baseId) {
      const people = await this.prisma.user.findMany({ where: { employee: { homeBaseId: body.baseId, active: true } }, select: { id: true } });
      to = people.map(p => ({ userId: p.id }));
    } else if (body.all) {
      to = (await this.prisma.user.findMany({ select: { id: true } })).map(p => ({ userId: p.id }));
    } else throw new BadRequestException('Choose who it is for: all, baseId or roles');
    const sent = await this.svc.notify({ type: 'broadcast', to, payload: { title: body.title.trim(), message: body.message.trim(), from: req.user!.sub }, ack: body.ack === true, except: req.user!.sub });
    await audit(this.prisma, req.user!.sub, 'Notification', 'broadcast', 'broadcast', null, { sent, title: body.title });
    return { sent };
  }

  @Post('run-daily') @Require('planning', 'edit')
  runDaily() { return this.svc.runDaily(); }

  /** Queued emails. The SMTP sender (mail/mailer.ts) sends them when SMTP_HOST is set. */
  @Get('outbox') @Require('settings', 'edit')
  async outbox(@Query('limit') limit?: string) {
    return this.prisma.emailOutbox.findMany({ orderBy: { createdAt: 'desc' }, take: Math.min(parseInt(limit ?? '50', 10) || 50, 200) });
  }

  /** Send the queue now instead of waiting for the next minute. */
  @Post('outbox/send') @Require('settings', 'edit')
  async sendOutbox() {
    if (!this.mailer.enabled) return { enabled: false, sent: 0, failed: 0 };
    return { enabled: true, ...(await this.mailer.flush()) };
  }
}

/** The daily job runs hourly inside the API process; a proper scheduler (BullMQ) replaces it when Redis is wired in. */
@Global()
@Module({ imports: [SettingsModule, CalendarCoreModule], controllers: [NotificationsController], providers: [NotificationsService], exports: [NotificationsService] })
export class NotificationsModule implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  constructor(@Inject(NotificationsService) private svc: NotificationsService) {}
  onModuleInit() {
    if (process.env.JOBS === 'off') return;
    this.timer = setInterval(() => { this.svc.runDaily().catch(e => console.error('daily job failed', e)); }, 60 * 60 * 1000);
    this.timer.unref();
  }
  onModuleDestroy() { clearInterval(this.timer); }
}
