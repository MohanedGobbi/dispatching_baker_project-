import { describe, it, expect } from 'vitest';
import { mergeSpans, subtractSpans, intersect, spanDays } from './spans';

const d = (s: string) => new Date(s + 'T00:00:00Z');
const sp = (a: string, b: string) => ({ start: d(a), end: d(b) });
const fmt = (s: { start: Date; end: Date }[]) => s.map(x => `${x.start.toISOString().slice(5, 10)}..${x.end.toISOString().slice(5, 10)}`);

describe('spans', () => {
  it('merges overlapping and consecutive spans', () => {
    expect(fmt(mergeSpans([sp('2026-10-10', '2026-10-12'), sp('2026-10-01', '2026-10-05'), sp('2026-10-06', '2026-10-08')]))).toEqual(['10-01..10-08', '10-10..10-12']);
  });
  it('subtract: nothing covered, all covered, hole in the middle, both ends', () => {
    const s = sp('2026-10-01', '2026-10-30');
    expect(fmt(subtractSpans(s, []))).toEqual(['10-01..10-30']);
    expect(subtractSpans(s, [sp('2026-09-01', '2026-11-30')])).toEqual([]);
    expect(fmt(subtractSpans(s, [sp('2026-10-10', '2026-10-14')]))).toEqual(['10-01..10-09', '10-15..10-30']);
    expect(fmt(subtractSpans(s, [sp('2026-09-25', '2026-10-05'), sp('2026-10-25', '2026-11-05')]))).toEqual(['10-06..10-24']);
  });
  it('subtract ignores spans outside and unsorted input', () => {
    expect(fmt(subtractSpans(sp('2026-10-10', '2026-10-20'), [sp('2026-11-01', '2026-11-05'), sp('2026-10-12', '2026-10-13'), sp('2026-09-01', '2026-09-05')]))).toEqual(['10-10..10-11', '10-14..10-20']);
  });
  it('intersect and spanDays', () => {
    expect(intersect(sp('2026-10-01', '2026-10-10'), sp('2026-10-05', '2026-10-20'))).toEqual(sp('2026-10-05', '2026-10-10'));
    expect(intersect(sp('2026-10-01', '2026-10-04'), sp('2026-10-05', '2026-10-20'))).toBeNull();
    expect(spanDays(sp('2026-10-01', '2026-10-28'))).toBe(28);
  });
});
