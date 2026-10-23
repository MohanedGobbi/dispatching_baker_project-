import {
  BadRequestException, Body, Controller, Delete, Get, Inject, Injectable, Module, NotFoundException, OnModuleDestroy, OnModuleInit, Param, Post, Put, Query,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { audit, parseDate, pickFields, Spec, MANAGER } from '../common/validate';
import { startOfDay } from '../domain/status';
import { nextDue, serviceState, workOrderToOpen } from '../domain/preventive';

const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const OPEN_WO = ['OPEN', 'IN_PROGRESS', 'WAITING_PARTS'];
const DOC_KINDS = ['registration', 'insurance', 'inspection', 'other'];
const PLAN_SPEC: Spec = { name: 'string', everyDays: 'number', durationDays: 'number', leadDays: 'number', startFrom: 'date', lastDone: 'date', active: 'boolean', notes: 'string' };
const DOC_SPEC: Spec = { kind: 'string', title: 'string', fileId: 'string', expiresAt: 'date', notes: 'string' };

type PlanRow = { id: string; unitId: string; name: string; everyDays: number; durationDays: number; leadDays: number; startFrom: Date; lastDone: Date | null; active: boolean; notes: string | null; workOrders: { id: string; status: string; plannedStart: Date; expectedReturn: Date }[] };

export function shapePlan(p: PlanRow, today: Date) {
  const open = p.workOrders.find(w => OPEN_WO.includes(w.status)) ?? null;
  return {
    id: p.id, unitId: p.unitId, name: p.name, everyDays: p.everyDays, durationDays: p.durationDays, leadDays: p.leadDays,
    startFrom: iso(p.startFrom), lastDone: p.lastDone ? iso(p.lastDone) : null, active: p.active, notes: p.notes,
    nextDue: iso(nextDue(p)), state: p.active ? serviceState(p, today) : 'ok',
    openWorkOrder: open ? { id: open.id, status: open.status, plannedStart: iso(open.plannedStart), expectedReturn: iso(open.expectedReturn) } : null,
  };
}

/** Days of a span that fall inside [from, to], counted once per calendar day. */
function daysIn(set: Set<number>, start: Date, end: Date, from: number, to: number) {
  for (let t = Math.max(startOfDay(start).getTime(), from); t <= Math.min(startOfDay(end).getTime(), to); t += DAY) set.add(t);
}

@Injectable()
export class FleetService {
  constructor(@Inject(PrismaService) private prisma: PrismaService) {}

  /** Open the work orders of services that are due (within their lead time) and have none open. */
  async schedulePreventive(now = new Date()) {
    const today = startOfDay(now);
    const plans = await this.prisma.maintenancePlan.findMany({
      where: { active: true, unit: { status: { not: 'OUT_OF_SERVICE' } } },
      include: {
        unit: { select: { id: true, homeBaseId: true, deployments: { where: { end: { gte: today } }, select: { start: true, end: true } } } },
        workOrders: { where: { status: { in: OPEN_WO } }, select: { id: true } },
      },
    });
    let created = 0;
    for (const p of plans) {
      const wo = workOrderToOpen(p, today, p.workOrders.length > 0, p.unit.deployments);
      if (!wo) continue;
      const row = await this.prisma.workOrder.create({
        data: { unitId: p.unitId, baseId: p.unit.homeBaseId, type: 'preventive', priority: 'normal', description: p.name, maintenancePlanId: p.id, ...wo },
      });
      await audit(this.prisma, 'WorkOrder', row.id, 'preventive_scheduled', null, { plan: p.name, plannedStart: iso(wo.plannedStart) });
      created++;
    }
    return { created };
  }
}

/** Unit page data (history, preventive plans, documents) and the preventive scheduler. */
@Controller()
class FleetController {
  constructor(@Inject(PrismaService) private prisma: PrismaService, @Inject(FleetService) private svc: FleetService) {}

  private async mustUnit(id: string) {
    const u = await this.prisma.unit.findUnique({ where: { id }, select: { id: true, code: true, homeBaseId: true } });
    if (!u) throw new NotFoundException('Unit not found');
    return u;
  }

  /** Month by month: days on a job, days in the workshop, days idle (up to today). */
  @Get('units/:id/history')
  async history(@Param('id') id: string, @Query('months') monthsQ?: string) {
    await this.mustUnit(id);
    const months = Math.min(Math.max(parseInt(monthsQ ?? '12', 10) || 12, 1), 36);
    const today = startOfDay(new Date());
    const first = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - months + 1, 1));
    const [deps, wos] = await Promise.all([
      this.prisma.unitDeployment.findMany({ where: { unitId: id, end: { gte: first } } }),
      this.prisma.workOrder.findMany({ where: { unitId: id, status: { not: 'CANCELLED' }, expectedReturn: { gte: first } } }),
    ]);
    const out = [];
    for (let m = 0; m < months; m++) {
      const start = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + m, 1));
      const endOfMonth = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
      const to = Math.min(endOfMonth.getTime(), today.getTime());
      const days = Math.round((to - start.getTime()) / DAY) + 1;
      const job = new Set<number>(), shop = new Set<number>();
      for (const d of deps) daysIn(job, d.start, d.end, start.getTime(), to);
      // A finished work order counts until it was completed, an open one until its expected return.
      for (const w of wos) daysIn(shop, w.plannedStart, w.completedAt && w.completedAt < w.expectedReturn ? w.completedAt : w.expectedReturn, start.getTime(), to);
      for (const t of shop) job.delete(t); // a day in the workshop is not a working day
      out.push({ month: iso(start).slice(0, 7), days, jobDays: job.size, workshopDays: shop.size, idleDays: Math.max(days - job.size - shop.size, 0) });
    }
    const total = out.reduce((a, r) => ({ days: a.days + r.days, job: a.job + r.jobDays, shop: a.shop + r.workshopDays }), { days: 0, job: 0, shop: 0 });
    return { months: out, utilisation: total.days ? Math.round((total.job / total.days) * 1000) / 10 : 0, workshopShare: total.days ? Math.round((total.shop / total.days) * 1000) / 10 : 0 };
  }

  // ---------- preventive maintenance

  @Get('units/:id/maintenance-plans')
  async plans(@Param('id') id: string) {
    await this.mustUnit(id);
    const rows = await this.prisma.maintenancePlan.findMany({ where: { unitId: id }, orderBy: [{ active: 'desc' }, { name: 'asc' }], include: { workOrders: { orderBy: { plannedStart: 'desc' } } } });
    const today = startOfDay(new Date());
    return rows.map(p => shapePlan(p, today));
  }

  @Post('units/:id/maintenance-plans')
  async createPlan(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    await this.mustUnit(id);
    const data = this.planData(body, true);
    const p = await this.prisma.maintenancePlan.create({ data: { unitId: id, ...data } as never, include: { workOrders: true } });
    await audit(this.prisma, 'MaintenancePlan', p.id, 'create', null, p);
    return shapePlan(p, startOfDay(new Date()));
  }

  @Put('maintenance-plans/:id')
  async updatePlan(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    const before = await this.prisma.maintenancePlan.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Maintenance plan not found');
    const p = await this.prisma.maintenancePlan.update({ where: { id }, data: this.planData(body, false) as never, include: { workOrders: true } });
    await audit(this.prisma, 'MaintenancePlan', id, 'update', before, p);
    return shapePlan(p, startOfDay(new Date()));
  }

  /** Delete a plan. Its past work orders stay (unlinked); an open one is left for the workshop to finish or cancel. */
  @Delete('maintenance-plans/:id')
  async deletePlan(@Param('id') id: string) {
    const p = await this.prisma.maintenancePlan.findUnique({ where: { id } });
    if (!p) throw new NotFoundException('Maintenance plan not found');
    await this.prisma.$transaction([
      this.prisma.workOrder.updateMany({ where: { maintenancePlanId: id }, data: { maintenancePlanId: null } }),
      this.prisma.maintenancePlan.delete({ where: { id } }),
    ]);
    await audit(this.prisma, 'MaintenancePlan', id, 'delete', p, null);
    return { deleted: true };
  }

  /** Record a service done outside a work order (e.g. at a dealer). */
  @Post('maintenance-plans/:id/done')
  async markDone(@Param('id') id: string, @Body() body: { date?: string }) {
    const p = await this.prisma.maintenancePlan.findUnique({ where: { id } });
    if (!p) throw new NotFoundException('Maintenance plan not found');
    const date = startOfDay(parseDate(body?.date));
    if (date > startOfDay(new Date())) throw new BadRequestException('A service cannot be recorded in the future');
    const after = await this.prisma.maintenancePlan.update({ where: { id }, data: { lastDone: date }, include: { workOrders: true } });
    await audit(this.prisma, 'MaintenancePlan', id, 'done', { lastDone: p.lastDone }, { lastDone: date });
    return shapePlan(after, startOfDay(new Date()));
  }

  /** Book the service now, without waiting for its lead time. */
  @Post('maintenance-plans/:id/schedule')
  async scheduleNow(@Param('id') id: string, @Body() body: { start?: string }) {
    const p = await this.prisma.maintenancePlan.findUnique({ where: { id }, include: { unit: true, workOrders: { where: { status: { in: OPEN_WO } } } } });
    if (!p) throw new NotFoundException('Maintenance plan not found');
    if (p.workOrders.length) throw new BadRequestException('A work order for this service is already open');
    const start = startOfDay(parseDate(body?.start, nextDue(p) < new Date() ? new Date() : nextDue(p)));
    const end = new Date(start.getTime() + (Math.max(p.durationDays, 1) - 1) * DAY);
    const job = await this.prisma.unitDeployment.findFirst({ where: { unitId: p.unitId, start: { lte: end }, end: { gte: start } }, include: { job: { select: { wellName: true } } } });
    if (job) throw new BadRequestException(`The unit is on a job (${job.job.wellName}) until ${iso(job.end)}; pick a date after that`);
    const wo = await this.prisma.workOrder.create({
      data: { unitId: p.unitId, baseId: p.unit.homeBaseId, type: 'preventive', description: p.name, maintenancePlanId: p.id, plannedStart: start, expectedReturn: end },
    });
    await audit(this.prisma, 'WorkOrder', wo.id, 'preventive_scheduled', null, { plan: p.name, plannedStart: iso(start) });
    return { workOrderId: wo.id, plannedStart: iso(start) };
  }

  /** Run the scheduler now (it also runs every hour inside the API). */
  @Post('maintenance-plans/run')
  run() { return this.svc.schedulePreventive(); }

  private planData(body: Record<string, unknown>, create: boolean) {
    const data = pickFields(PLAN_SPEC, body, create ? ['name', 'everyDays'] : []);
    if (typeof data.name === 'string') { data.name = data.name.trim(); if (!data.name) throw new BadRequestException('A name is required'); }
    for (const [k, min, max] of [['everyDays', 1, 3650], ['durationDays', 1, 60], ['leadDays', 0, 365]] as const) {
      const v = data[k];
      if (v !== undefined && (!Number.isInteger(v) || (v as number) < min || (v as number) > max)) throw new BadRequestException(`${k} must be a whole number from ${min} to ${max}`);
    }
    if (create && !data.startFrom) data.startFrom = startOfDay(new Date());
    return data;
  }

  // ---------- documents

  @Get('units/:id/documents')
  async documents(@Param('id') id: string) {
    await this.mustUnit(id);
    const today = startOfDay(new Date());
    const rows = await this.prisma.unitDocument.findMany({ where: { unitId: id }, orderBy: [{ kind: 'asc' }, { createdAt: 'desc' }], include: { file: { select: { id: true, name: true, size: true, mime: true } } } });
    return rows.map(d => ({
      id: d.id, kind: d.kind, title: d.title, notes: d.notes, createdAt: d.createdAt, file: d.file,
      expiresAt: d.expiresAt ? iso(d.expiresAt) : null,
      validity: !d.expiresAt ? 'none' : d.expiresAt < today ? 'expired' : d.expiresAt.getTime() <= today.getTime() + 30 * DAY ? 'expiring' : 'valid',
    }));
  }

  @Post('units/:id/documents')
  async addDocument(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    await this.mustUnit(id);
    const data = pickFields(DOC_SPEC, body, ['kind', 'title']);
    if (!DOC_KINDS.includes(data.kind as string)) throw new BadRequestException(`kind must be one of ${DOC_KINDS.join(', ')}`);
    data.title = (data.title as string).trim();
    if (data.fileId && !(await this.prisma.storedFile.findFirst({ where: { id: data.fileId as string, kind: 'general' } }))) throw new BadRequestException('Unknown file');
    const d = await this.prisma.unitDocument.create({ data: { unitId: id, createdBy: MANAGER, ...data } as never });
    await audit(this.prisma, 'UnitDocument', d.id, 'create', null, d);
    return d;
  }

  @Delete('unit-documents/:id')
  async deleteDocument(@Param('id') id: string) {
    const d = await this.prisma.unitDocument.findUnique({ where: { id } });
    if (!d) throw new NotFoundException('Document not found');
    await this.prisma.unitDocument.delete({ where: { id } });
    await audit(this.prisma, 'UnitDocument', id, 'delete', d, null);
    return { deleted: true };
  }
}

@Module({ controllers: [FleetController], providers: [FleetService], exports: [FleetService] })
export class FleetModule implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  constructor(@Inject(FleetService) private svc: FleetService) {}
  onModuleInit() {
    if (process.env.JOBS === 'off') return;
    const tick = () => { this.svc.schedulePreventive().catch(e => console.error('preventive scheduler failed', e)); };
    tick();
    this.timer = setInterval(tick, 60 * 60 * 1000);
    this.timer.unref();
  }
  onModuleDestroy() { clearInterval(this.timer); }
}
