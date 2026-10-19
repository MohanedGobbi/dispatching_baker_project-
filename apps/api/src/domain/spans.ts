// Date-span arithmetic used when working out which days of a seat still need someone.
import { startOfDay } from './status';

const DAY = 86_400_000;
export interface Span { start: Date; end: Date }

const addDays = (d: Date, n: number) => new Date(startOfDay(d).getTime() + n * DAY);

/** Merge overlapping or touching spans (touching = consecutive days). */
export function mergeSpans(spans: Span[]): Span[] {
  const s = spans.map(x => ({ start: startOfDay(x.start), end: startOfDay(x.end) })).sort((a, b) => a.start.getTime() - b.start.getTime());
  const out: Span[] = [];
  for (const x of s) {
    const last = out[out.length - 1];
    if (last && x.start.getTime() <= last.end.getTime() + DAY) { if (x.end > last.end) last.end = x.end; }
    else out.push({ ...x });
  }
  return out;
}

/** The parts of `span` not covered by any of `covered`. */
export function subtractSpans(span: Span, covered: Span[]): Span[] {
  let cur = startOfDay(span.start);
  const end = startOfDay(span.end);
  const out: Span[] = [];
  for (const c of mergeSpans(covered)) {
    if (c.end < cur) continue;
    if (c.start > end) break;
    if (c.start > cur) out.push({ start: cur, end: addDays(c.start, -1) });
    cur = addDays(c.end, 1);
    if (cur > end) break;
  }
  if (cur <= end) out.push({ start: cur, end });
  return out;
}

export function intersect(a: Span, b: Span): Span | null {
  const start = startOfDay(a.start) > startOfDay(b.start) ? startOfDay(a.start) : startOfDay(b.start);
  const end = startOfDay(a.end) < startOfDay(b.end) ? startOfDay(a.end) : startOfDay(b.end);
  return start <= end ? { start, end } : null;
}

export const spanDays = (s: Span) => Math.round((startOfDay(s.end).getTime() - startOfDay(s.start).getTime()) / DAY) + 1;
