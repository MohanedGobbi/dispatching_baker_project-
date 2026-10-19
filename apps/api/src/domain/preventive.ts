// Preventive maintenance (plan E19): when a repeated service is next due, and whether to open its work order.
import { startOfDay } from './status';

const DAY = 86_400_000;
export type ServiceState = 'overdue' | 'due_soon' | 'ok';

export interface PlanFacts { everyDays: number; leadDays: number; startFrom: Date; lastDone: Date | null }

/** Next due date: the last recorded service (or the start date) plus the interval. */
export function nextDue(p: PlanFacts): Date {
  return new Date(startOfDay(p.lastDone ?? p.startFrom).getTime() + p.everyDays * DAY);
}

export function serviceState(p: PlanFacts, today: Date): ServiceState {
  const due = nextDue(p).getTime(), t = startOfDay(today).getTime();
  if (due < t) return 'overdue';
  if (due <= t + p.leadDays * DAY) return 'due_soon';
  return 'ok';
}

/**
 * The work order to open for a plan, or null. Opened once the service is within its lead time (or overdue) and no
 * work order for this plan is still open. An overdue service is booked from today, not in the past, and never while
 * the unit is on a job: it starts the day after the job ends.
 */
export function workOrderToOpen(
  p: PlanFacts & { durationDays: number; active: boolean }, today: Date, hasOpenWorkOrder: boolean, jobs: { start: Date; end: Date }[] = [],
): { plannedStart: Date; expectedReturn: Date } | null {
  if (!p.active || hasOpenWorkOrder || serviceState(p, today) === 'ok') return null;
  const t = startOfDay(today);
  const length = (Math.max(p.durationDays, 1) - 1) * DAY;
  let start = nextDue(p) < t ? t : nextDue(p);
  const sorted = [...jobs].sort((a, b) => a.start.getTime() - b.start.getTime());
  for (const j of sorted) {
    if (startOfDay(j.start).getTime() <= start.getTime() + length && startOfDay(j.end) >= start) start = new Date(startOfDay(j.end).getTime() + DAY);
  }
  return { plannedStart: start, expectedReturn: new Date(start.getTime() + length) };
}
