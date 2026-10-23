import {
  BadRequestException, Body, Controller, Get, Inject, Injectable, Module, NotFoundException, Param, Post, Query,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsModule, SettingsService } from '../settings/settings';
import { audit, parseDate, MANAGER } from '../common/validate';
import { addDays, iso } from '../calendar/calendar.service';
import { overlapDays } from '../domain/absence';
import { profileLabel } from '../domain/forecast';
import { startOfDay } from '../domain/status';
import { AnalyticsCoreModule, AnalyticsService } from './analytics.service';

const DAY = 86_400_000;
const EFFECTIVE_LEAVE = ['APPROVED', 'RECORDED', 'ACTIVE', 'COMPLETED'];
const OPEN_WO = ['OPEN', 'IN_PROGRESS', 'WAITING_PARTS'];

interface Finding { key: string; type: string; baseId?: string; severity: 'low' | 'medium' | 'high'; title: string; action: string; data: Record<string, unknown> }

// ---------------------------------------------------------------- recommendations (plan 21)

/** Rule-based and explainable: every finding carries the numbers behind it and a suggested action. */
@Injectable()
export class RecommendationsService {
  constructor(
    @Inject(PrismaService) private prisma: PrismaService,
    @Inject(SettingsService) private settings: SettingsService,
    @Inject(AnalyticsService) private analytics: AnalyticsService,
  ) {}

  async detect(): Promise<Finding[]> {
    const settings = await this.settings.all();
    const today = startOfDay(new Date());
    const minDays = settings['recommendations.shortageMinDays'] as number;
    const hireLead = settings['recommendations.hireLeadDays'] as number;
    const balanceLimit = settings['recommendations.balanceThreshold'] as number;
    const woLimit = settings['recommendations.workOrderBacklog'] as number;
    const overlapLimit = settings['leave.overlapWarningThreshold'] as number;

    const fc = await this.analytics.forecast({ days: 90 });
    const people = await this.analytics.people();
    const bases = await this.prisma.base.findMany({ where: { active: true }, select: { id: true, code: true } });
    const baseId = (code: string) => bases.find(b => b.code === code)?.id;
    const out: Finding[] = [];

    // 1. recruit: the whole company is short of a profile for several days. One finding per profile, built from
    //    all of its shortage periods (the worst one drives the number), so a rotating shortage is not reported ten times.
    const groupBy = <T,>(xs: T[], key: (x: T) => string) => xs.reduce((m, x) => { (m.get(key(x)) ?? m.set(key(x), []).get(key(x))!).push(x); return m; }, new Map<string, T[]>());
    const allShort = fc.shortages.filter(x => x.scope === 'all');
    for (const [profile, list] of groupBy(allShort, s => s.profile)) {
      const days = list.reduce((n, s) => n + s.days, 0);
      if (days < minDays) continue;
      const first = list.reduce((a, b) => (b.from < a.from ? b : a));
      const peak = Math.max(...list.map(s => s.peakDeficit));
      const worst = Math.min(...list.map(s => s.worstRatio));
      const to = list.reduce((a, b) => (b.to > a.to ? b : a)).to;
      const by = iso(new Date(Math.max(today.getTime(), Date.parse(first.from) - hireLead * DAY)));
      out.push({
        key: `recruit:all:${profile}`, type: 'recruit', severity: peak >= 3 || worst < 0.7 ? 'high' : 'medium',
        title: `Recruit ${peak} ${profileLabel(profile)}`,
        action: `Short on ${days} of the next 90 days (first on ${first.from}). Start recruiting now so ${peak} are in place by ${by}.`,
        data: { profile, label: profileLabel(profile), from: first.from, to, shortageDays: days, periods: list.length, peakDeficit: peak, worstRatio: worst, recruitBy: by },
      });
    }

    // 2. transfer: a base is short while another has people to spare over the same days (one finding per profile and base)
    const baseScopes = fc.scopes;
    for (const [, list] of groupBy(fc.shortages.filter(x => x.scope !== 'all' && x.days >= 3), s => `${s.profile}|${s.scope}`)) {
      let best: { s: (typeof list)[number]; code: string; n: number } | null = null;
      for (const s of list) {
        for (const a of baseScopes.filter(x => x.id !== s.scope)) {
          const ser = a.series[s.profile];
          if (!ser) continue;
          const win = ser.filter(p => p.date >= s.from && p.date <= s.to);
          const n = Math.min(s.peakDeficit, Math.min(...win.map(p => p.available - p.required)));
          if (n >= 1 && (!best || n > best.n)) best = { s, code: a.code, n };
        }
      }
      if (best) {
        const s = best.s;
        out.push({
          key: `transfer:${s.profile}:${s.scope}`, type: 'transfer', baseId: s.scope, severity: 'medium',
          title: `Transfer ${best.n} ${profileLabel(s.profile)} from ${best.code} to ${s.scopeCode}`,
          action: `${best.code} has ${best.n} to spare while ${s.scopeCode} is short between ${s.from} and ${s.to}. Move them for that period (travel and accommodation needed).`,
          data: { profile: s.profile, label: profileLabel(s.profile), from: s.from, to: s.to, n: best.n, fromBase: best.code, toBase: s.scopeCode, peakDeficit: s.peakDeficit },
        });
      }
    }

    // 3. relief first for people owed a lot of rest
    const ledger = await this.prisma.daysOffLedger.groupBy({ by: ['employeeId'], _sum: { days: true } });
    for (const l of ledger) {
      const days = l._sum.days ?? 0;
      const p = people.find(x => x.id === l.employeeId);
      if (!p || days < balanceLimit) continue;
      out.push({
        key: `relief:${p.id}`, type: 'relief', baseId: p.baseId, severity: days >= balanceLimit * 2 ? 'high' : 'medium',
        title: `Prioritise relief for ${p.name} (owed ${days} rest days)`,
        action: `Plan ${p.name}'s relief at the next crew change, or grant recovery days, before more extensions are asked of them.`,
        data: { employeeId: p.id, name: p.name, base: p.baseCode, balance: days },
      });
    }

    // 4. spread leave: too many of one profile away in the same week
    const leaves = await this.prisma.leave.findMany({
      where: { status: { in: EFFECTIVE_LEAVE }, start: { lte: addDays(today, 84) }, end: { gte: today }, employeeId: { in: people.map(p => p.id) } },
      select: { employeeId: true, start: true, end: true },
    });
    for (let w = 0; w < 12; w++) {
      const span = { start: addDays(today, w * 7), end: addDays(today, w * 7 + 6) };
      const groups = new Map<string, Set<string>>();
      for (const l of leaves) {
        if (!overlapDays(l, span)) continue;
        const p = people.find(x => x.id === l.employeeId);
        if (!p) continue;
        const k = `${p.baseCode}|${p.position}`;
        (groups.get(k) ?? groups.set(k, new Set()).get(k)!).add(p.id);
      }
      for (const [k, set] of groups) {
        if (set.size < overlapLimit) continue;
        const [base, position] = k.split('|');
        out.push({
          key: `spread:${base}:${position}:${iso(span.start)}`, type: 'spread_leave', baseId: baseId(base), severity: set.size >= overlapLimit + 2 ? 'high' : 'medium',
          title: `Spread leave: ${set.size} ${position}s at ${base} are away in the week of ${iso(span.start)}`,
          action: 'Ask some of them to move their dates, and steer new requests to quieter weeks.',
          data: { base, position, week: iso(span.start), away: set.size },
        });
      }
    }

    // 5. train Open Hole operators for Cased Hole when CH is short and OH has people to spare
    const chShort = fc.shortages.filter(x => x.scope === 'all' && ['op_ch', 'exp_ch'].includes(x.profile) && x.days >= minDays);
    if (chShort.length && fc.total['op_oh']) {
      const worst = chShort.reduce((a, b) => (b.peakDeficit > a.peakDeficit ? b : a));
      const win = fc.total['op_oh'].filter(p => p.date >= worst.from && p.date <= worst.to);
      const spare = Math.min(...win.map(p => p.available - p.required));
      const n = Math.min(worst.peakDeficit, spare);
      if (n >= 1) {
        out.push({
          key: 'train:ch', type: 'train', severity: 'medium', title: `Train ${n} Open Hole operators for Cased Hole`,
          action: `Cased Hole is short from ${worst.from} while Open Hole operators are spare. Start Cased Hole training now.`,
          data: { n, from: worst.from, to: worst.to, shortProfile: worst.profile, spareOpenHole: spare },
        });
      }
    }

    // 6. promotion pipeline: people close to the Experienced thresholds
    const expYears = settings['seniority.experiencedYears'] as number, expDays = settings['seniority.experiencedFieldDays'] as number;
    const near = people.filter(p => p.category === 'FIELD_CREW' && p.seniority === 'JUNIOR' && p.yearsOfService >= expYears - 0.5 && p.fieldDays >= expDays * 0.85);
    for (const code of [...new Set(near.map(p => p.baseCode))]) {
      const mine = near.filter(p => p.baseCode === code);
      out.push({
        key: `promote:${code}`, type: 'promotion', baseId: baseId(code), severity: 'low',
        title: `Prepare promotions to Experienced: ${mine.length} at ${code}`,
        action: 'They reach the Experienced thresholds soon. Prepare the sign-off so they can fill Experienced seats.',
        data: { base: code, people: mine.map(p => ({ name: p.name, years: p.yearsOfService, fieldDays: p.fieldDays })) },
      });
    }

    // 8. mechanics: work-order backlog at a base
    const orders = await this.prisma.workOrder.findMany({ where: { status: { in: OPEN_WO } }, include: { base: { select: { id: true, code: true } } } });
    for (const b of bases) {
      const open = orders.filter(o => o.baseId === b.id);
      if (open.length < woLimit) continue;
      out.push({
        key: `mechanics:${b.code}`, type: 'mechanics', baseId: b.id, severity: 'medium', title: `Reinforce mechanics at ${b.code}: ${open.length} open work orders`,
        action: 'Add mechanics temporarily, or move planned maintenance to a quieter base.', data: { base: b.code, openWorkOrders: open.length },
      });
    }

    // 9. a long absence on a scarce profile (aggregate only: never names, never reasons)
    const long = await this.prisma.leave.findMany({ where: { longTerm: true, status: { in: EFFECTIVE_LEAVE }, end: { gte: today } }, select: { employeeId: true, start: true, end: true } });
    const byProfile = new Map<string, { count: number; from: string; to: string }>();
    for (const l of long) {
      const p = people.find(x => x.id === l.employeeId);
      if (!p) continue;
      for (const prof of p.profiles) {
        const scarce = fc.shortages.some(s => s.scope === 'all' && s.profile === prof);
        if (!scarce) continue;
        const cur = byProfile.get(prof) ?? { count: 0, from: iso(l.start), to: iso(l.end) };
        cur.count++; if (iso(l.start) < cur.from) cur.from = iso(l.start); if (iso(l.end) > cur.to) cur.to = iso(l.end);
        byProfile.set(prof, cur);
      }
    }
    for (const [prof, v] of byProfile) {
      out.push({
        key: `temporary:${prof}`, type: 'temporary_reinforcement', severity: 'high', title: `Temporary reinforcement: long absence on ${profileLabel(prof)}`,
        action: 'A long-term absence overlaps a shortage on this profile. Arrange temporary cover.', data: { profile: prof, label: profileLabel(prof), absences: v.count, from: v.from, to: v.to },
      });
    }
    return out;
  }

  /** Re-run the rules. Existing findings keep the decision somebody made (accepted, dismissed, snoozed). */
  async run(userId?: string) {
    const found = await this.detect();
    const now = new Date();
    let created = 0, updated = 0;
    for (const f of found) {
      const existing = await this.prisma.recommendation.findUnique({ where: { key: f.key } });
      const data = { type: f.type, baseId: f.baseId ?? null, data: f.data as never, suggestedAction: f.action, title: f.title, severity: f.severity };
      if (!existing) { await this.prisma.recommendation.create({ data: { ...data, key: f.key } }); created++; continue; }
      // A snooze that has run out brings the finding back; a resolved one that reappears is open again.
      const reopen = (existing.status === 'SNOOZED' && existing.snoozedUntil && existing.snoozedUntil <= now) || existing.status === 'RESOLVED';
      await this.prisma.recommendation.update({ where: { id: existing.id }, data: { ...data, ...(reopen ? { status: 'OPEN', snoozedUntil: null } : {}) } });
      updated++;
    }
    // Findings that no longer hold are marked resolved (kept, for the history).
    const keys = new Set(found.map(f => f.key));
    const stale = await this.prisma.recommendation.findMany({ where: { status: { in: ['OPEN', 'SNOOZED'] }, key: { not: null } } });
    let resolved = 0;
    for (const s of stale) if (s.key && !keys.has(s.key)) { await this.prisma.recommendation.update({ where: { id: s.id }, data: { status: 'RESOLVED' } }); resolved++; }
    await audit(this.prisma, 'Recommendation', 'run', 'run', null, { created, updated, resolved });
    return { created, updated, resolved, total: found.length };
  }
}

// ---------------------------------------------------------------- API

@Controller('analytics')
class AnalyticsController {
  constructor(
    @Inject(PrismaService) private prisma: PrismaService,
    @Inject(AnalyticsService) private svc: AnalyticsService,
    @Inject(RecommendationsService) private recs: RecommendationsService,
  ) {}

  @Get('overview') async overview(@Query('baseId') baseId?: string) { return this.svc.overview((baseId || undefined)); }

  @Get('forecast') async forecast(@Query() q: { baseId?: string; days?: string }) {
    return this.svc.forecast({ baseId: (q.baseId || undefined), days: q.days ? parseInt(q.days, 10) : 90 });
  }

  @Get('kpis') async kpis(@Query() q: { baseId?: string; from?: string; to?: string }) {
    return this.svc.kpis({ baseId: (q.baseId || undefined), from: q.from ? parseDate(q.from) : undefined, to: q.to ? parseDate(q.to) : undefined, includeMedical: true });
  }

  @Get('people') async people(@Query() q: { baseId?: string; from?: string; to?: string }) {
    return this.svc.peoplePage({ baseId: (q.baseId || undefined), from: q.from ? parseDate(q.from) : undefined, to: q.to ? parseDate(q.to) : undefined });
  }

  /** HR statistics: the dispatcher's analytics are operational only (plan section 3). */
  @Get('leave') async leave(@Query() q: { baseId?: string; months?: string }) {
    return this.svc.leavePage({ baseId: (q.baseId || undefined), months: q.months ? parseInt(q.months, 10) : 6, includeMedical: true });
  }

  @Get('units') async units(@Query() q: { baseId?: string; days?: string }) {
    return this.svc.unitsPage({ baseId: (q.baseId || undefined), days: q.days ? parseInt(q.days, 10) : 90 });
  }

  @Get('base-staffing') async baseStaffing(@Query('baseId') baseId?: string) { return this.svc.baseStaffingPage({ baseId: (baseId || undefined) }); }


  @Get('map') async map() { return this.svc.map(); }

  // ----- recommendations
  @Get('recommendations') async list(@Query() q: { status?: string; baseId?: string }) {
    const baseId = (q.baseId || undefined);
    const status = q.status ?? 'OPEN';
    const rows = await this.prisma.recommendation.findMany({
      where: { ...(status === 'all' ? {} : { status }), ...(baseId ? { OR: [{ baseId }, { baseId: null }] } : {}) },
      orderBy: [{ updatedAt: 'desc' }], take: 200, include: { base: { select: { code: true } } },
    });
    const rank = { high: 0, medium: 1, low: 2 } as Record<string, number>;
    return rows.sort((a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3)).map(r => ({
      id: r.id, key: r.key, type: r.type, severity: r.severity, title: r.title, action: r.suggestedAction, status: r.status, base: r.base?.code ?? null,
      data: r.data, snoozedUntil: r.snoozedUntil, updatedAt: r.updatedAt,
    }));
  }

  @Post('recommendations/run') run() { return this.recs.run(MANAGER); }

  /** Accept, dismiss or snooze a finding; every decision is logged (plan 21). */
  @Post('recommendations/:id/status') async setStatus(@Param('id') id: string, @Body() body: { status?: string; days?: number; note?: string }) {
    const r = await this.prisma.recommendation.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('Recommendation not found');
    const status = body?.status;
    if (!status || !['OPEN', 'ACCEPTED', 'DISMISSED', 'SNOOZED'].includes(status)) throw new BadRequestException('status must be OPEN, ACCEPTED, DISMISSED or SNOOZED');
    let snoozedUntil: Date | null = null;
    if (status === 'SNOOZED') {
      const days = body.days ?? 7;
      if (!Number.isInteger(days) || days < 1 || days > 90) throw new BadRequestException('days must be a whole number from 1 to 90');
      snoozedUntil = new Date(Date.now() + days * DAY);
    }
    const after = await this.prisma.recommendation.update({ where: { id }, data: { status, snoozedUntil } });
    await audit(this.prisma, 'Recommendation', id, `recommendation_${status.toLowerCase()}`, { status: r.status }, { status, snoozedUntil }, body?.note);
    return { id, status: after.status, snoozedUntil: after.snoozedUntil };
  }
}

@Module({ imports: [SettingsModule, AnalyticsCoreModule], controllers: [AnalyticsController], providers: [RecommendationsService], exports: [RecommendationsService] })
export class AnalyticsModule {}
