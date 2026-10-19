import { describe, it, expect } from 'vitest';
import { nextDue, serviceState, workOrderToOpen } from './preventive';

const d = (s: string) => new Date(`${s}T00:00:00Z`);
const plan = { everyDays: 90, leadDays: 14, startFrom: d('2026-01-01'), lastDone: null as Date | null, durationDays: 2, active: true };

describe('preventive maintenance', () => {
  it('is due every N days from the last service, or from the start date before any', () => {
    expect(nextDue(plan).toISOString().slice(0, 10)).toBe('2026-04-01');
    expect(nextDue({ ...plan, lastDone: d('2026-09-10') }).toISOString().slice(0, 10)).toBe('2026-12-09');
  });
  it('is ok, due soon within the lead time, then overdue', () => {
    expect(serviceState(plan, d('2026-03-01'))).toBe('ok');
    expect(serviceState(plan, d('2026-03-18'))).toBe('due_soon');
    expect(serviceState(plan, d('2026-04-01'))).toBe('due_soon');
    expect(serviceState(plan, d('2026-04-02'))).toBe('overdue');
  });
  it('opens one work order on the due date, lasting durationDays', () => {
    expect(workOrderToOpen(plan, d('2026-03-01'), false)).toBeNull();
    const wo = workOrderToOpen(plan, d('2026-03-20'), false)!;
    expect([wo.plannedStart, wo.expectedReturn].map(x => x.toISOString().slice(0, 10))).toEqual(['2026-04-01', '2026-04-02']);
    expect(workOrderToOpen(plan, d('2026-03-20'), true)).toBeNull();
    expect(workOrderToOpen({ ...plan, active: false }, d('2026-03-20'), false)).toBeNull();
  });
  it('waits for the end of a job the unit is on, or one that would overlap the service', () => {
    const jobs = [{ start: d('2026-05-01'), end: d('2026-05-20') }, { start: d('2026-05-22'), end: d('2026-06-05') }];
    const wo = workOrderToOpen(plan, d('2026-05-10'), false, jobs)!;
    expect(wo.plannedStart.toISOString().slice(0, 10)).toBe('2026-06-06');
  });
  it('books an overdue service from today', () => {
    expect(workOrderToOpen(plan, d('2026-05-10'), false)!.plannedStart.toISOString().slice(0, 10)).toBe('2026-05-10');
  });
});
