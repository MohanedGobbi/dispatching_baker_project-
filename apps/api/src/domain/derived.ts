// Derived values for units and employees (plan sections 7.1, 8.1, 25).
import { startOfDay } from './status';

const DAY = 86_400_000;
export type UnitStatusValue = 'AVAILABLE' | 'DEPLOYED' | 'IN_TRANSIT' | 'UNDER_MAINTENANCE' | 'OUT_OF_SERVICE';

export interface UnitStatusInput {
  manualStatus: UnitStatusValue; // only OUT_OF_SERVICE / IN_TRANSIT are honoured as manual
  workOrders: { status: string; plannedStart: Date; expectedReturn: Date }[];
  deployments: { start: Date; end: Date }[];
}

const OPEN_WO = new Set(['OPEN', 'IN_PROGRESS', 'WAITING_PARTS']);

/** Section 25: manual out-of-service wins, then active work order, then deployment, else available. */
export function computeUnitStatus(i: UnitStatusInput, date: Date): UnitStatusValue {
  if (i.manualStatus === 'OUT_OF_SERVICE') return 'OUT_OF_SERVICE';
  const d = startOfDay(date);
  if (i.workOrders.some(w => OPEN_WO.has(w.status) && startOfDay(w.plannedStart) <= d && d <= w.expectedReturn)) return 'UNDER_MAINTENANCE';
  if (i.deployments.some(p => startOfDay(p.start) <= d && d <= p.end)) return 'DEPLOYED';
  return i.manualStatus === 'IN_TRANSIT' ? 'IN_TRANSIT' : 'AVAILABLE';
}

/** Field days = days spent on unit seats up to `asOf`, from non-cancelled assignments. Overlaps counted once. */
export function countFieldDays(assignments: { start: Date; end: Date }[], asOf: Date): number {
  const cutoff = startOfDay(asOf).getTime();
  const spans = assignments
    .map(a => [startOfDay(a.start).getTime(), Math.min(startOfDay(a.end).getTime(), cutoff)] as const)
    .filter(([s, e]) => e >= s)
    .sort((a, b) => a[0] - b[0]);
  let total = 0, curS = -1, curE = -1;
  for (const [s, e] of spans) {
    if (curS < 0) { curS = s; curE = e; continue; }
    if (s <= curE + DAY) curE = Math.max(curE, e);
    else { total += (curE - curS) / DAY + 1; curS = s; curE = e; }
  }
  if (curS >= 0) total += (curE - curS) / DAY + 1;
  return total;
}

/** Certifications expiring within `days` of `asOf` (already-expired ones included). */
export function certExpiry(expiresAt: Date, asOf: Date, days = 60): 'expired' | 'expiring' | 'valid' {
  if (expiresAt < asOf) return 'expired';
  return expiresAt.getTime() - asOf.getTime() <= days * DAY ? 'expiring' : 'valid';
}
