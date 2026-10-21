import {
  BadRequestException, Body, ConflictException, Controller, Delete, Get, Inject, Module, NotFoundException,
  Param, Post, Put, Query, Req,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Require, AuthedRequest } from '../auth/auth.module';
import { audit, page, parseDate, pickFields, Spec } from '../common/validate';
import { startOfDay } from '../domain/status';

const JOB_SPEC: Spec = {
  wellName: 'string', rigName: 'string', client: 'string', siteId: 'string', serviceType: 'string',
  plannedStart: 'date', plannedEnd: 'date', openEnded: 'boolean',
};
/** An open job needs a plannedEnd for every date range to keep working, so it is parked this far ahead. */
const OPEN_YEARS = 5;
const OPEN_WO = ['OPEN', 'IN_PROGRESS', 'WAITING_PARTS'];
const DAY = 86_400_000;

@Controller('jobs')
class JobsController {
  constructor(@Inject(PrismaService) private prisma: PrismaService) {}

  /** Service types are the unit type names, so the catalog stays the single source. */
  private async assertServiceType(serviceType: unknown) {
    const types = (await this.prisma.unitType.findMany({ select: { name: true } })).map(t => t.name);
    if (typeof serviceType !== 'string' || !types.includes(serviceType)) {
      throw new BadRequestException(`serviceType must be one of ${types.join(', ')}`);
    }
  }

  @Get() @Require('jobs', 'view')
  async list(@Query() q: { status?: string; siteId?: string; baseId?: string; serviceType?: string; from?: string; to?: string; limit?: string; offset?: string }) {
    const where: Record<string, unknown> = {};
    if (q.status) where.status = q.status;
    if (q.siteId) where.siteId = q.siteId;
    if (q.serviceType) where.serviceType = q.serviceType;
    if (q.baseId) where.site = { baseId: q.baseId };
    // timeline window: jobs overlapping [from, to]
    if (q.from) where.plannedEnd = { gte: parseDate(q.from) };
    if (q.to) where.plannedStart = { lte: parseDate(q.to) };
    const { take, skip } = page(q);
    const [total, items] = await Promise.all([
      this.prisma.job.count({ where: where as never }),
      this.prisma.job.findMany({
        where: where as never, orderBy: { plannedStart: 'asc' }, take, skip,
        include: { site: { select: { name: true, baseId: true } }, deployments: { include: { unit: { select: { code: true } } } } },
      }),
    ]);
    return { total, items };
  }

  @Get(':id') @Require('jobs', 'view')
  async detail(@Param('id') id: string) {
    const job = await this.prisma.job.findUnique({
      where: { id }, include: { site: { include: { base: { select: { code: true, name: true } } } }, deployments: { include: { unit: { include: { unitType: true } } }, orderBy: { start: 'asc' } } },
    });
    if (!job) throw new NotFoundException('Job not found');
    return job;
  }

  @Post() @Require('jobs', 'edit')
  async create(@Body() body: Record<string, unknown>, @Req() req: AuthedRequest) {
    const data = pickFields(JOB_SPEC, body, ['siteId', 'serviceType', 'plannedStart']);
    await this.assertServiceType(data.serviceType);
    // The job is named after its site unless a well name is given (older jobs carry their own).
    if (!data.wellName) {
      const site = await this.prisma.site.findUnique({ where: { id: data.siteId as string }, select: { name: true } });
      if (!site) throw new BadRequestException('Site does not exist');
      data.wellName = site.name;
    }
    if (data.openEnded) data.plannedEnd = new Date(new Date(data.plannedStart as Date).setUTCFullYear((data.plannedStart as Date).getUTCFullYear() + OPEN_YEARS));
    if (!data.plannedEnd) throw new BadRequestException('Missing: plannedEnd (or openEnded)');
    if ((data.plannedEnd as Date) < (data.plannedStart as Date)) throw new BadRequestException('plannedEnd must not be before plannedStart');
    const year = new Date().getUTCFullYear();
    // Auto number JOB-YYYY-NNNN. The unique index decides races, so retry on a collision.
    for (let attempt = 0; attempt < 5; attempt++) {
      const count = await this.prisma.job.count({ where: { ref: { startsWith: `JOB-${year}-` } } });
      const ref = `JOB-${year}-${String(count + 1 + attempt).padStart(4, '0')}`;
      try {
        const job = await this.prisma.job.create({ data: { ...data, ref } as never });
        await audit(this.prisma, req.user?.sub, 'Job', job.id, 'create', null, job);
        return job;
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === 'P2003') throw new BadRequestException('Site does not exist');
        if (code !== 'P2002') throw err;
      }
    }
    throw new ConflictException('Could not allocate a job reference, try again');
  }

  @Put(':id') @Require('jobs', 'edit')
  async update(@Param('id') id: string, @Body() body: Record<string, unknown>, @Req() req: AuthedRequest) {
    const before = await this.prisma.job.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Job not found');
    if (['COMPLETED', 'CANCELLED'].includes(before.status)) throw new BadRequestException(`A ${before.status.toLowerCase()} job cannot be edited`);
    const data = pickFields(JOB_SPEC, body);
    if (data.serviceType !== undefined) await this.assertServiceType(data.serviceType);
    if (data.openEnded === true) data.plannedEnd = new Date(new Date(before.plannedStart).setUTCFullYear(before.plannedStart.getUTCFullYear() + OPEN_YEARS));
    const start = (data.plannedStart as Date) ?? before.plannedStart, end = (data.plannedEnd as Date) ?? before.plannedEnd;
    if (end < start) throw new BadRequestException('plannedEnd must not be before plannedStart');
    const after = await this.prisma.job.update({ where: { id }, data: data as never });
    await audit(this.prisma, req.user?.sub, 'Job', id, 'update', before, after);
    return after;
  }

  /**
   * Deploy a unit to a job (9). The unit's crew seats become required for these dates (status is derived from
   * deployments). Blocks double-booking and maintenance clashes; a service-type mismatch is a warning only.
   */
  @Post(':id/deploy') @Require('jobs', 'edit')
  async deploy(@Param('id') id: string, @Body() body: { unitId?: string; start?: string; end?: string }, @Req() req: AuthedRequest) {
    if (!body?.unitId) throw new BadRequestException('unitId is required');
    const job = await this.prisma.job.findUnique({ where: { id } });
    if (!job) throw new NotFoundException('Job not found');
    if (['COMPLETED', 'CANCELLED'].includes(job.status)) throw new BadRequestException(`Cannot deploy to a ${job.status.toLowerCase()} job`);
    const unit = await this.prisma.unit.findUnique({ where: { id: body.unitId }, include: { unitType: true } });
    if (!unit) throw new BadRequestException('Unit does not exist');
    if (unit.status === 'OUT_OF_SERVICE') throw new BadRequestException(`${unit.code} is out of service`);

    const start = body.start ? parseDate(body.start) : job.plannedStart;
    const end = body.end ? parseDate(body.end) : job.plannedEnd;
    if (end < start) throw new BadRequestException('end must not be before start');

    const clash = await this.prisma.unitDeployment.findFirst({
      where: { unitId: unit.id, start: { lte: end }, end: { gte: start } }, include: { job: { select: { ref: true } } },
    });
    if (clash) throw new ConflictException(`${unit.code} is already deployed on ${clash.job.ref} during these dates`);
    const maintenance = await this.prisma.workOrder.findFirst({
      where: { unitId: unit.id, status: { in: OPEN_WO }, plannedStart: { lte: end }, expectedReturn: { gte: start } },
    });
    if (maintenance) throw new ConflictException(`${unit.code} is under maintenance until ${maintenance.expectedReturn.toISOString().slice(0, 10)}`);

    const warnings: string[] = [];
    if (unit.unitType.name !== job.serviceType) {
      warnings.push(`${job.serviceType} job on a ${unit.unitType.name} unit (${unit.code})`);
    }
    const deployment = await this.prisma.unitDeployment.create({ data: { unitId: unit.id, jobId: id, start, end } });
    await audit(this.prisma, req.user?.sub, 'Job', id, 'deploy', null, deployment);
    return { deployment, warnings };
  }

  @Delete(':id/deployments/:deploymentId') @Require('jobs', 'edit')
  async undeploy(@Param('id') id: string, @Param('deploymentId') deploymentId: string, @Req() req: AuthedRequest) {
    const { count } = await this.prisma.unitDeployment.deleteMany({ where: { id: deploymentId, jobId: id } });
    if (!count) throw new NotFoundException('Deployment not found');
    await audit(this.prisma, req.user?.sub, 'Job', id, 'undeploy', { deploymentId });
    return { removed: deploymentId };
  }

  @Post(':id/start') @Require('jobs', 'edit')
  async start(@Param('id') id: string, @Req() req: AuthedRequest) {
    const job = await this.prisma.job.findUnique({ where: { id } });
    if (!job) throw new NotFoundException('Job not found');
    if (job.status !== 'PLANNED') throw new BadRequestException(`Only planned jobs can start (this one is ${job.status.toLowerCase()})`);
    const after = await this.prisma.job.update({ where: { id }, data: { status: 'ACTIVE', actualStart: startOfDay(new Date()) } });
    await audit(this.prisma, req.user?.sub, 'Job', id, 'start', { status: job.status }, { status: after.status });
    return after;
  }

  /** Ending a job sends its units back to Available: deployments are cut at the end date and status follows. */
  @Post(':id/end') @Require('jobs', 'edit')
  async end(@Param('id') id: string, @Body() body: { date?: string; cancel?: boolean }, @Req() req: AuthedRequest) {
    const job = await this.prisma.job.findUnique({ where: { id } });
    if (!job) throw new NotFoundException('Job not found');
    if (['COMPLETED', 'CANCELLED'].includes(job.status)) throw new BadRequestException(`Job is already ${job.status.toLowerCase()}`);
    const endDate = startOfDay(body?.date ? parseDate(body.date) : new Date());
    const cancelling = body?.cancel === true;

    const after = await this.prisma.$transaction(async tx => {
      // Deployments starting after the end are dropped; running ones are cut to end the day before a cancel,
      // or on the end day for a normal completion.
      const cut = cancelling ? new Date(endDate.getTime() - DAY) : endDate;
      await tx.unitDeployment.deleteMany({ where: { jobId: id, start: { gt: cut } } });
      await tx.unitDeployment.updateMany({ where: { jobId: id, end: { gt: cut } }, data: { end: cut } });
      return tx.job.update({
        where: { id },
        data: cancelling ? { status: 'CANCELLED' } : { status: 'COMPLETED', actualEnd: endDate, actualStart: job.actualStart ?? job.plannedStart },
      });
    });
    await audit(this.prisma, req.user?.sub, 'Job', id, cancelling ? 'cancel' : 'complete', { status: job.status }, { status: after.status });
    return after;
  }
}

@Module({ controllers: [JobsController] })
export class JobsModule {}
