// Pure logic for absences and extensions (plan sections 12, 13, 16).
import { isRotationOn, Pattern, startOfDay } from './status';

const DAY = 86_400_000;
export interface Span { start: Date; end: Date }

export const inclusiveDays = (s: Span) => Math.round((startOfDay(s.end).getTime() - startOfDay(s.start).getTime()) / DAY) + 1;
const addDays = (d: Date, n: number) => new Date(startOfDay(d).getTime() + n * DAY);

/**
 * Remove an absence window from an assignment. `kept` are the pieces the person still holds (before and/or after
 * the absence), `removed` is the overlap that the seat now needs someone else for. No overlap => nothing removed.
 */
export function carveAssignment(a: Span, absence: Span): { kept: Span[]; removed: Span | null } {
  const aS = startOfDay(a.start), aE = startOfDay(a.end), xS = startOfDay(absence.start), xE = startOfDay(absence.end);
  if (xE < aS || xS > aE) return { kept: [{ start: aS, end: aE }], removed: null };
  const kept: Span[] = [];
  if (xS > aS) kept.push({ start: aS, end: addDays(xS, -1) });
  if (xE < aE) kept.push({ start: addDays(xE, 1), end: aE });
  return { kept, removed: { start: xS > aS ? xS : aS, end: xE < aE ? xE : aE } };
}

export type Urgency = 'CRITICAL' | 'HIGH' | 'NORMAL';
export type Trigger = 'medical_leave' | 'leave' | 'restriction' | 'unassigned' | 'employee_archived' | 'split';

/** Section 16 urgency table. `from` is the first uncovered day. */
export function urgencyFor(trigger: Trigger, from: Date, today: Date): Urgency {
  const away = Math.round((startOfDay(from).getTime() - startOfDay(today).getTime()) / DAY);
  if (trigger === 'medical_leave') return away <= 0 ? 'CRITICAL' : away <= 7 ? 'HIGH' : 'NORMAL';
  if (trigger === 'restriction') return 'HIGH';
  return away <= 0 ? 'CRITICAL' : away <= 7 ? 'HIGH' : 'NORMAL';
}

/** Days of `range` that a cycle rotation marks as "off" (weekly/custom patterns have no lost rest days). */
export function offDaysIn(pattern: Pattern | null, anchor: Date | null, range: Span): number {
  if (!pattern || pattern.type !== 'cycle' || !anchor) return 0;
  let n = 0;
  for (let t = startOfDay(range.start).getTime(); t <= startOfDay(range.end).getTime(); t += DAY) {
    if (!isRotationOn(pattern, anchor, new Date(t))) n++;
  }
  return n;
}

export const isLongTerm = (s: Span, thresholdDays: number) => inclusiveDays(s) > thresholdDays;

export interface ExtensionLimits { perRotation: number; perQuarter: number }
export interface ExtensionUsage { rotationDays: number; quarterDays: number }

/** Section 13: beyond the limits an extension still works, but only with a manager override reason. */
export function extensionLimitBreaches(request: number, used: ExtensionUsage, limits: ExtensionLimits): string[] {
  const out: string[] = [];
  if (used.rotationDays + request > limits.perRotation) out.push(`${used.rotationDays + request} extension days this rotation exceeds the limit of ${limits.perRotation}`);
  if (used.quarterDays + request > limits.perQuarter) out.push(`${used.quarterDays + request} extension days this quarter exceeds the limit of ${limits.perQuarter}`);
  return out;
}

export function quarterOf(d: Date): Span {
  const y = d.getUTCFullYear(), q = Math.floor(d.getUTCMonth() / 3);
  return { start: new Date(Date.UTC(y, q * 3, 1)), end: new Date(Date.UTC(y, q * 3 + 3, 0)) };
}

/** Overlap of two spans in days (0 when they do not touch). */
export function overlapDays(a: Span, b: Span): number {
  const s = Math.max(startOfDay(a.start).getTime(), startOfDay(b.start).getTime());
  const e = Math.min(startOfDay(a.end).getTime(), startOfDay(b.end).getTime());
  return e >= s ? Math.round((e - s) / DAY) + 1 : 0;
}
