import { Inject, Injectable, Module } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { carveAssignment, Span, Trigger, urgencyFor } from '../domain/absence';
import { subtractSpans } from '../domain/spans';
import { startOfDay } from '../domain/status';

export interface ReleasedSeat { assignmentId: string; seatId: string; removed: Span; taskId: string | null; cancelled: boolean }

const OPEN_TASK = ['OPEN', 'ESCALATED', 'CANDIDATE_PROPOSED', 'CANDIDATE_CONFIRMED'];

@Injectable()
export class AbsenceService {
  constructor(@Inject(PrismaService) private prisma: PrismaService) {}

  /**
   * An absence (leave, medical leave, restriction) frees the seats the person holds during `window`:
   * each overlapping assignment is trimmed or split, and every freed span of a required seat gets a replacement
   * task. Draft plan assignments are left alone: publishing re-checks them against the new absence. Calling it again for the same source is safe: spans that already have an open task are not duplicated.
   */
  async releaseSeats(
    tx: Prisma.TransactionClient, employeeId: string, window: Span,
    opts: { trigger: Trigger; sourceId: string; unitSeatsOnly?: boolean },
  ): Promise<ReleasedSeat[]> {
    const today = startOfDay(new Date());
    const assignments = await tx.assignment.findMany({
      where: {
        employeeId, status: { in: ['CONFIRMED', 'ACTIVE'] },
        start: { lte: window.end }, plannedEnd: { gte: window.start },
        ...(opts.unitSeatsOnly ? { seat: { holderType: 'UNIT' as const } } : {}),
      },
      include: { seat: true },
    });

    const released: ReleasedSeat[] = [];
    for (const a of assignments) {
      const { kept, removed } = carveAssignment({ start: a.start, end: a.plannedEnd }, window);
      if (!removed) continue;

      if (kept.length === 0) {
        await tx.assignment.update({ where: { id: a.id }, data: { status: 'CANCELLED' } });
      } else {
        await tx.assignment.update({ where: { id: a.id }, data: { start: kept[0].start, plannedEnd: kept[0].end } });
        // The person comes back after the absence: the later piece stays theirs.
        for (const extra of kept.slice(1)) {
          await tx.assignment.create({
            data: {
              employeeId: a.employeeId, seatId: a.seatId, start: extra.start, plannedEnd: extra.end,
              type: a.type, planId: a.planId, status: extra.start <= today ? 'ACTIVE' : 'CONFIRMED',
            },
          });
        }
      }

      let taskId: string | null = null;
      if (a.seat.requiredFlag) {
        const dup = await tx.replacementTask.findFirst({
          where: { seatId: a.seatId, sourceId: opts.sourceId, status: { in: OPEN_TASK }, fromDate: { lte: removed.end }, toDate: { gte: removed.start } },
        });
        if (!dup) {
          const t = await tx.replacementTask.create({
            data: {
              seatId: a.seatId, fromDate: removed.start, toDate: removed.end, trigger: opts.trigger, sourceId: opts.sourceId,
              urgency: urgencyFor(opts.trigger, removed.start, today), deadline: removed.start,
            },
          });
          taskId = t.id;
        } else taskId = dup.id;
      }
      released.push({ assignmentId: a.id, seatId: a.seatId, removed, taskId, cancelled: kept.length === 0 });
    }
    return released;
  }

  /**
   * Someone now holds the seat for `span`: replacement tasks for those days are done. A task that is only partly
   * covered shrinks to what is still open (and splits in two if the cover is in the middle).
   */
  async coverTasks(tx: Prisma.TransactionClient, seatId: string, span: Span, employeeId: string, assignmentId: string) {
    const tasks = await tx.replacementTask.findMany({ where: { seatId, status: { in: OPEN_TASK }, fromDate: { lte: span.end }, toDate: { gte: span.start } } });
    for (const t of tasks) {
      const rest = subtractSpans({ start: t.fromDate, end: t.toDate }, [span]);
      if (rest.length === 0) {
        await tx.replacementTask.update({ where: { id: t.id }, data: { status: 'CLOSED', candidateId: employeeId, assignmentId } });
      } else {
        await tx.replacementTask.update({ where: { id: t.id }, data: { fromDate: rest[0].start, toDate: rest[0].end, deadline: rest[0].start } });
        for (const extra of rest.slice(1)) {
          await tx.replacementTask.create({ data: { seatId, fromDate: extra.start, toDate: extra.end, trigger: t.trigger, urgency: t.urgency, sourceId: t.sourceId, deadline: extra.start } });
        }
      }
    }
    return tasks.length;
  }

  /** The cause went away (leave cancelled or shortened): tasks nobody confirmed yet no longer make sense. */
  async closeTasks(tx: Prisma.TransactionClient, sourceId: string, afterDate?: Date) {
    const tasks = await tx.replacementTask.findMany({ where: { sourceId, status: { in: ['OPEN', 'CANDIDATE_PROPOSED'] } } });
    for (const t of tasks) {
      if (!afterDate || t.fromDate > afterDate) await tx.replacementTask.update({ where: { id: t.id }, data: { status: 'CLOSED' } });
      else if (t.toDate > afterDate) await tx.replacementTask.update({ where: { id: t.id }, data: { toDate: afterDate } });
    }
    return tasks.length;
  }
}

@Module({ providers: [AbsenceService], exports: [AbsenceService] })
export class AbsenceModule {}
