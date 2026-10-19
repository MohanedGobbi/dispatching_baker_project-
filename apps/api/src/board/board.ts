import {
  CallHandler, Controller, ExecutionContext, ForbiddenException, Get, Inject, Injectable, MessageEvent, Module, NestInterceptor,
  Query, Req, Sse,
} from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { interval, map, merge, Observable, Subject, tap } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';
import { Require, AuthedRequest } from '../auth/auth.module';
import { SettingsModule, SettingsService } from '../settings/settings';
import { EmployeeInsightsService, InsightsModule } from '../employees/insights';
import { CalendarCoreModule, CalendarService, DayCell, iso, addDays } from '../calendar/calendar.service';
import { viewerFor } from '../calendar/calendar';
import { parseDate } from '../common/validate';
import { computeUnitStatus } from '../domain/derived';
import { seniorityAtLeast } from '../domain/rules';
import { Seniority, startOfDay } from '../domain/status';

const DAY = 86_400_000;
const LIVE = ['CONFIRMED', 'ACTIVE'] as const;
const OPEN_WO = ['OPEN', 'IN_PROGRESS', 'WAITING_PARTS'];
const OPEN_TASK = ['OPEN', 'ESCALATED', 'CANDIDATE_PROPOSED'];
const SHORT_QUAL: Record<string, string> = { 'Open Hole': 'OH', 'Cased Hole': 'CH' };
const COLUMN_OF: Record<string, string> = {
  STANDBY: 'standby', DAYS_OFF: 'daysOff', LEAVE: 'leave', MEDICAL_LEAVE: 'unavailable', UNAVAILABLE: 'unavailable',
  TRAINING: 'training', AWAITING_CLEARANCE: 'awaitingClearance',
};

type Severity = 'ok' | 'info' | 'warn' | 'bad';
const RANK: Record<Severity, number> = { ok: 0, info: 1, warn: 2, bad: 3 };
const worst = (xs: Severity[]): Severity => xs.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'ok' as Severity);

// ---------------------------------------------------------------- live updates

/** Every successful change request tells the open boards to refresh (plan 14.3, 29 "Realtime"). */
@Injectable()
export class BoardEvents {
  readonly changes = new Subject<{ type: 'changed'; path: string; at: string }>();
}

@Injectable()
class ChangeNotifier implements NestInterceptor {
  constructor(@Inject(BoardEvents) private events: BoardEvents) {}
  intercept(ctx: ExecutionContext, next: CallHandler) {
    const req = ctx.switchToHttp().getRequest<{ method: string; url: string }>();
    return next.handle().pipe(tap(() => {
      if (req.method !== 'GET' && !req.url.startsWith('/auth')) this.events.changes.next({ type: 'changed', path: req.url.split('?')[0], at: new Date().toISOString() });
    }));
  }
}

// ---------------------------------------------------------------- board

@Controller('board')
class BoardController {
  constructor(
    @Inject(PrismaService) private prisma: PrismaService,
    @Inject(SettingsService) private settings: SettingsService,
    @Inject(EmployeeInsightsService) private insights: EmployeeInsightsService,
    @Inject(CalendarService) private cal: CalendarService,
    @Inject(BoardEvents) private events: BoardEvents,
  ) {}

  /** Server-sent events: the client reconnects with its token in the Authorization header. */
  @Sse('events') @Require('assignments', 'view')
  stream(): Observable<MessageEvent> {
    return merge(
      this.events.changes.pipe(map(e => ({ data: e }) as MessageEvent)),
      interval(25_000).pipe(map(() => ({ data: { type: 'ping' } }) as MessageEvent)),
    );
  }

  @Get() @Require('assignments', 'view')
  async board(
    @Req() req: AuthedRequest,
    @Query() q: { date?: string; baseId?: string; typeId?: string; view?: string; problemsOnly?: string; planId?: string; q?: string },
  ) {
    const roles = (req.user?.roles ?? []).map(r => r.role);
    if (roles.every(r => r === 'EMPLOYEE')) throw new ForbiddenException('The board is not available to employees');
    const D = startOfDay(q.date ? parseDate(q.date) : new Date());
    const today = startOfDay(new Date());
    const past = D < today;                      // the "time machine": the same view for any earlier date
    const view = q.view ?? 'all';
    const problemsOnly = q.problemsOnly === 'true';
    const needle = q.q?.trim().toLowerCase();
    const settings = await this.settings.all();
    const minExperienced = settings['rules.minExperiencedPerCrew'] as number;
    const chiefRequired = settings['rules.chiefRequired'] as boolean;

    const bases = await this.prisma.base.findMany({ where: { active: true, ...(q.baseId ? { id: q.baseId } : {}) }, orderBy: { name: 'asc' } });
    const baseIds = bases.map(b => b.id);
    const statuses = past ? ['CONFIRMED', 'ACTIVE', 'COMPLETED'] : [...LIVE];
    const covering = { start: { lte: D }, plannedEnd: { gte: D } };

    // ---- units
    const units = view === 'base' ? [] : await this.prisma.unit.findMany({
      where: { homeBaseId: { in: baseIds }, ...(q.typeId ? { unitTypeId: q.typeId } : {}) },
      orderBy: { code: 'asc' },
      include: {
        unitType: true,
        deployments: { where: { start: { lte: D }, end: { gte: D } }, include: { job: { include: { site: { select: { name: true } } } } } },
        workOrders: { where: { status: { in: OPEN_WO }, plannedStart: { lte: D }, expectedReturn: { gte: D } } },
        seats: {
          where: { holderType: 'UNIT' }, orderBy: [{ positionId: 'asc' }, { index: 'asc' }],
          include: { position: { include: { requiredCertTypes: true } }, assignments: { where: { status: { in: statuses as never }, ...covering } } },
        },
      },
    });
    const drafts = q.planId ? await this.prisma.assignment.findMany({ where: { planId: q.planId, status: 'DRAFT', ...covering } }) : [];
    const upcoming = await this.prisma.assignment.findMany({
      where: { status: { in: [...LIVE] }, seat: { unit: { homeBaseId: { in: baseIds } } }, plannedEnd: { gte: D, lte: addDays(D, 14) } },
      select: { seatId: true, plannedEnd: true },
    });

    // ---- base staffing
    const baseSeats = view === 'field' ? [] : await this.prisma.seat.findMany({
      where: { holderType: 'BASE', baseId: { in: baseIds } }, include: { position: { include: { defaultRotation: true } }, assignments: { where: { status: { in: statuses as never }, ...covering } } },
    });
    const rules = view === 'field' ? [] : await this.prisma.baseStaffingRule.findMany({ where: { baseId: { in: baseIds } }, include: { position: { include: { defaultRotation: true } } } });
    const workOrders = view === 'field' ? [] : await this.prisma.workOrder.findMany({
      where: { baseId: { in: baseIds }, status: { in: OPEN_WO }, plannedStart: { lte: D } },
      include: { unit: { select: { code: true } }, assignees: true },
    });

    // ---- people: everyone in a field or base position (the side columns), plus every holder
    const people = await this.prisma.employee.findMany({
      where: { active: true, position: { category: { in: ['FIELD_CREW', 'BASE_STAFF'] } } },
      include: {
        position: { include: { requiredCertTypes: true } }, homeBase: { select: { code: true, id: true } }, rotationPattern: true,
        qualifications: { include: { qualification: true } }, certifications: true,
      },
    });
    const byId = new Map(people.map(p => [p.id, p]));
    const [days, sen] = await Promise.all([
      this.cal.buildDays(people.map(p => p.id), D, D, viewerFor(req)),
      this.insights.enrich(people.map(p => ({ ...p })), today),
    ]);
    const cell = (id: string): DayCell | undefined => days.get(id)?.[0];
    const person = (id: string) => {
      const p = byId.get(id);
      if (!p) return null;
      return {
        id: p.id, name: `${p.firstName} ${p.lastName}`, employeeNo: p.employeeNo, position: p.position.name, base: p.homeBase.code,
        seniority: sen.get(p.id)?.seniority ?? 'JUNIOR', tags: p.qualifications.map(x => SHORT_QUAL[x.qualification.name] ?? x.qualification.name),
        restrictions: cell(id)?.restrictions ?? [],
      };
    };

    // ---- unit cards
    const unitCards = units.map(u => {
      const status = computeUnitStatus({ manualStatus: u.status, workOrders: u.workOrders, deployments: u.deployments }, D);
      const dep = u.deployments[0];
      const deployed = status === 'DEPLOYED';
      const ORDER: Record<string, number> = { 'Chief of Unit': 0, 'Field Engineer': 1, 'Field Operator': 2, 'Field Driver': 3 };
      const orderedSeats = [...u.seats].sort((a, b) => (ORDER[a.position.name] ?? 9) - (ORDER[b.position.name] ?? 9) || a.index - b.index);
      const seatCards = orderedSeats.map(s => {
        const a = s.assignments[0];
        const draft = !a ? drafts.find(d => d.seatId === s.id) : undefined;
        const holderRow = a ?? draft;
        const p = holderRow ? byId.get(holderRow.employeeId) : undefined;
        const req_ = (s.requirements ?? {}) as { qualification?: string; minSeniority?: Seniority };
        const issues: { code: string; severity: Severity; text: string }[] = [];
        let holder = null as null | (ReturnType<typeof person> & { assignmentId: string; until: string; draft: boolean });
        if (holderRow) {
          const info = person(holderRow.employeeId);
          holder = info ? { ...info, assignmentId: holderRow.id, until: iso(holderRow.plannedEnd), draft: !!draft } : null;
          if (p) {
            if (req_.qualification && !p.qualifications.some(x => x.qualification.name === req_.qualification)) {
              issues.push({ code: 'qualification', severity: 'bad', text: `Missing ${SHORT_QUAL[req_.qualification] ?? req_.qualification} qualification` });
            }
            if (req_.minSeniority && !seniorityAtLeast(sen.get(p.id)?.seniority ?? 'JUNIOR', req_.minSeniority)) {
              issues.push({ code: 'seniority', severity: 'bad', text: `Needs ${req_.minSeniority.toLowerCase().replace('_', ' ')} or above` });
            }
            for (const ct of s.position.requiredCertTypes) {
              const best = p.certifications.filter(c => c.typeId === ct.id).sort((x, y) => y.expiresAt.getTime() - x.expiresAt.getTime())[0];
              if (!best) issues.push({ code: 'cert', severity: 'bad', text: 'Mandatory certificate missing' });
              else if (best.expiresAt < D) issues.push({ code: 'cert', severity: 'bad', text: 'Certificate expired' });
              else if (best.expiresAt.getTime() - D.getTime() <= 30 * DAY) issues.push({ code: 'cert_soon', severity: 'warn', text: `Certificate expires in ${Math.round((best.expiresAt.getTime() - D.getTime()) / DAY)} days` });
            }
          }
        } else if (deployed && s.requiredFlag) issues.push({ code: 'empty', severity: 'warn', text: 'Needs someone' });
        // Two expired certificates give the same message twice; show it once.
        const uniqueIssues = [...new Map(issues.map(i => [`${i.code}|${i.text}`, i])).values()];
        return { seatId: s.id, position: s.position.name, index: s.index, required: s.requiredFlag, requirements: req_, holder, issues: uniqueIssues };
      });

      const requiredSeats = seatCards.filter(s => s.required);
      const filled = requiredSeats.filter(s => s.holder).length;
      const ops = requiredSeats.filter(s => s.position === 'Field Operator');
      const opsFilled = ops.filter(s => s.holder);
      const experienced = seatCards.filter(s => s.holder && seniorityAtLeast(s.holder.seniority as Seniority, 'EXPERIENCED')).length;
      const hasChief = seatCards.some(s => s.position === 'Chief of Unit' && s.holder);

      const badges: { code: string; severity: Severity; text: string }[] = [];
      badges.push({ code: 'crew', severity: !deployed || filled >= requiredSeats.length ? 'ok' : 'warn', text: `${filled}/${requiredSeats.length}` });
      if (deployed && opsFilled.length > 0 && experienced < minExperienced) {
        badges.push({ code: 'no_experienced', severity: opsFilled.length === ops.length ? 'bad' : 'warn', text: 'No experienced' });
      }
      if (deployed && chiefRequired && opsFilled.length > 0 && !hasChief) badges.push({ code: 'no_chief', severity: 'warn', text: 'No chief of unit' });
      for (const code of ['qualification', 'seniority', 'cert']) {
        const hit = seatCards.flatMap(s => s.issues).find(i => i.code === code);
        if (hit) badges.push({ code, severity: 'bad', text: hit.text });
      }
      const soonCert = seatCards.flatMap(s => s.issues).find(i => i.code === 'cert_soon');
      if (soonCert) badges.push({ code: 'cert_soon', severity: 'warn', text: soonCert.text });
      // Crew change: the earliest day a current holder leaves (assignment end + 1).
      const seatIds = new Set(u.seats.map(s => s.id));
      const nextEnd = upcoming.filter(a => seatIds.has(a.seatId)).sort((x, y) => x.plannedEnd.getTime() - y.plannedEnd.getTime())[0];
      let crewChange: { inDays: number; date: string } | null = null;
      if (nextEnd && deployed) {
        const date = addDays(nextEnd.plannedEnd, 1);
        crewChange = { inDays: Math.round((date.getTime() - D.getTime()) / DAY), date: iso(date) };
        badges.push({ code: 'crew_change', severity: 'info', text: `Crew change in ${crewChange.inDays} day${crewChange.inDays === 1 ? '' : 's'}` });
      }
      if (status === 'UNDER_MAINTENANCE') badges.push({ code: 'maintenance', severity: 'info', text: 'Under maintenance' });
      if (status === 'OUT_OF_SERVICE') badges.push({ code: 'out_of_service', severity: 'warn', text: 'Out of service' });

      const hit = needle ? u.code.toLowerCase().includes(needle) || dep?.job.wellName.toLowerCase().includes(needle) || dep?.job.rigName?.toLowerCase().includes(needle) : false;
      return {
        id: u.id, code: u.code, baseId: u.homeBaseId, type: u.unitType.name, colorKey: u.unitType.colorKey, status,
        job: dep ? { ref: dep.job.ref, well: dep.job.wellName, rig: dep.job.rigName, site: dep.job.site.name } : null,
        seats: seatCards, badges, state: worst(badges.map(b => b.severity)), crew: { filled, required: requiredSeats.length }, crewChange, match: hit,
      };
    });

    // ---- base staffing meters
    const presentOn = (seatPos: string, baseId: string) => {
      const ids = new Set<string>();
      for (const s of baseSeats.filter(x => x.baseId === baseId && x.positionId === seatPos)) {
        for (const a of s.assignments) if (cell(a.employeeId)?.status === 'ON_BASE_POST') ids.add(a.employeeId);
      }
      return [...ids];
    };
    const staffing = rules.map(r => {
      const ids = presentOn(r.positionId, r.baseId);
      // A post with the working_days window is only needed on the organisation's working days (plan 6.3).
      const workingDays = settings['org.workingDays'] as string;
      const offDay = r.scheduleWindow === 'working_days' && workingDays[D.getUTCDay()] !== '1';
      const state = offDay && ids.length === 0 ? 'off_day' : ids.length < r.minCount ? 'below_min' : ids.length < r.targetCount ? 'below_target' : 'ok';
      return {
        baseId: r.baseId, positionId: r.positionId, position: r.position.name, min: r.minCount, target: r.targetCount, filled: ids.length, state,
        severity: (state === 'below_min' ? 'bad' : state === 'below_target' ? 'warn' : 'ok') as Severity,
        people: ids.map(id => {
          const wo = workOrders.find(w => w.assignees.some(a => a.employeeId === id));
          return { ...person(id), workOrder: wo ? { unit: wo.unit.code, type: wo.type, status: wo.status } : null };
        }),
      };
    });

    // ---- side columns
    const columns: Record<string, unknown[]> = { standby: [], daysOff: [], leave: [], unavailable: [], training: [], awaitingClearance: [] };
    const counts: Record<string, number> = {};
    for (const p of people) {
      const st = cell(p.id)?.status ?? 'STANDBY';
      counts[st] = (counts[st] ?? 0) + 1;
      if (q.baseId && p.homeBaseId !== q.baseId) continue;
      const col = COLUMN_OF[st];
      if (col) columns[col].push({ ...person(p.id), label: cell(p.id)?.label });
    }

    // ---- summary for the manager's overview
    const taskCounts = await this.prisma.replacementTask.groupBy({ by: ['urgency'], where: { status: { in: OPEN_TASK } }, _count: true });
    const matchedPeople = needle ? people.filter(p => `${p.firstName} ${p.lastName} ${p.employeeNo}`.toLowerCase().includes(needle)).map(p => p.id) : [];

    let outUnits = unitCards;
    let outStaffing = staffing;
    if (problemsOnly) {
      outUnits = unitCards.filter(u => u.state === 'bad' || u.state === 'warn');
      outStaffing = staffing.filter(s => s.severity !== 'ok');
    }
    return {
      date: iso(D), past, layer: q.planId ? 'draft' : 'live', planId: q.planId ?? null,
      bases: bases.map(b => ({ id: b.id, code: b.code, name: b.name })),
      units: outUnits, staffing: outStaffing, columns: problemsOnly ? {} : columns,
      summary: {
        headcount: counts,
        unitsByStatus: unitCards.reduce<Record<string, number>>((m, u) => ((m[u.status] = (m[u.status] ?? 0) + 1), m), {}),
        nonCompliantUnits: unitCards.filter(u => u.state === 'bad').length,
        unitsNeedingAttention: unitCards.filter(u => u.state === 'warn' || u.state === 'bad').length,
        basePostsBelowMin: staffing.filter(s => s.state === 'below_min').length,
        openReplacementTasks: Object.fromEntries(taskCounts.map(t => [t.urgency, t._count])),
        crewChangesNext7Days: upcoming.filter(a => addDays(a.plannedEnd, 1).getTime() - D.getTime() <= 7 * DAY).length,
      },
      matches: { units: unitCards.filter(u => u.match).map(u => u.id), employees: matchedPeople },
    };
  }
}

@Module({
  imports: [SettingsModule, InsightsModule, CalendarCoreModule],
  controllers: [BoardController],
  providers: [BoardEvents, { provide: APP_INTERCEPTOR, useClass: ChangeNotifier }],
})
export class BoardModule {}
