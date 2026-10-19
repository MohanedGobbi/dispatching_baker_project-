import { describe, it, expect } from 'vitest';
import { carveAssignment, urgencyFor, offDaysIn, isLongTerm, extensionLimitBreaches, quarterOf, inclusiveDays, overlapDays } from './absence';

const d = (s: string) => new Date(s + 'T00:00:00Z');
const span = (a: string, b: string) => ({ start: d(a), end: d(b) });
const iso = (s: { start: Date; end: Date }) => `${s.start.toISOString().slice(0, 10)}..${s.end.toISOString().slice(0, 10)}`;

describe('carveAssignment', () => {
  const a = span('2026-10-01', '2026-10-28');
  it('no overlap leaves it untouched', () => {
    const r = carveAssignment(a, span('2026-11-01', '2026-11-05'));
    expect(r.removed).toBeNull();
    expect(r.kept.map(iso)).toEqual(['2026-10-01..2026-10-28']);
  });
  it('absence over the whole assignment removes it all', () => {
    const r = carveAssignment(a, span('2026-09-20', '2026-11-10'));
    expect(r.kept).toEqual([]);
    expect(iso(r.removed!)).toBe('2026-10-01..2026-10-28');
  });
  it('absence from the middle splits it in two', () => {
    const r = carveAssignment(a, span('2026-10-10', '2026-10-14'));
    expect(r.kept.map(iso)).toEqual(['2026-10-01..2026-10-09', '2026-10-15..2026-10-28']);
    expect(iso(r.removed!)).toBe('2026-10-10..2026-10-14');
  });
  it('absence at the end / start trims one side', () => {
    expect(carveAssignment(a, span('2026-10-20', '2026-11-30')).kept.map(iso)).toEqual(['2026-10-01..2026-10-19']);
    expect(carveAssignment(a, span('2026-09-25', '2026-10-05')).kept.map(iso)).toEqual(['2026-10-06..2026-10-28']);
  });
  it('removed window is clipped to the assignment', () => {
    expect(iso(carveAssignment(a, span('2026-10-20', '2026-11-30')).removed!)).toBe('2026-10-20..2026-10-28');
  });
});

describe('urgencyFor (plan section 16)', () => {
  const today = d('2026-10-19');
  it('medical leave: today critical, within 7 days high, later normal', () => {
    expect(urgencyFor('medical_leave', d('2026-10-19'), today)).toBe('CRITICAL');
    expect(urgencyFor('medical_leave', d('2026-10-24'), today)).toBe('HIGH');
    expect(urgencyFor('medical_leave', d('2026-11-30'), today)).toBe('NORMAL');
  });
  it('approved annual leave far ahead is normal', () => expect(urgencyFor('leave', d('2026-12-01'), today)).toBe('NORMAL'));
  it('restriction is always high', () => expect(urgencyFor('restriction', d('2026-12-01'), today)).toBe('HIGH'));
});

describe('rest-day helpers', () => {
  it('offDaysIn counts only cycle off days', () => {
    const p = { type: 'cycle' as const, daysOn: 28, daysOff: 28 };
    expect(offDaysIn(p, d('2026-01-01'), span('2026-01-25', '2026-02-02'))).toBe(5); // Jan 29..Feb 2
    expect(offDaysIn({ type: 'weekly', weeklyMask: '1111100' }, d('2026-01-01'), span('2026-01-25', '2026-02-02'))).toBe(0);
    expect(offDaysIn(null, null, span('2026-01-25', '2026-02-02'))).toBe(0);
  });
  it('long-term threshold', () => {
    expect(isLongTerm(span('2026-10-01', '2026-10-30'), 30)).toBe(false);
    expect(isLongTerm(span('2026-10-01', '2026-10-31'), 30)).toBe(true);
  });
  it('inclusive days and overlap', () => {
    expect(inclusiveDays(span('2026-10-01', '2026-10-01'))).toBe(1);
    expect(overlapDays(span('2026-10-01', '2026-10-10'), span('2026-10-08', '2026-10-20'))).toBe(3);
    expect(overlapDays(span('2026-10-01', '2026-10-10'), span('2026-10-11', '2026-10-20'))).toBe(0);
  });
});

describe('extension limits', () => {
  const limits = { perRotation: 7, perQuarter: 14 };
  it('within limits', () => expect(extensionLimitBreaches(3, { rotationDays: 2, quarterDays: 5 }, limits)).toEqual([]));
  it('breaches are reported separately', () => {
    expect(extensionLimitBreaches(3, { rotationDays: 6, quarterDays: 5 }, limits)).toHaveLength(1);
    expect(extensionLimitBreaches(6, { rotationDays: 6, quarterDays: 12 }, limits)).toHaveLength(2);
  });
  it('quarterOf', () => expect(iso(quarterOf(d('2026-11-15')))).toBe('2026-10-01..2026-12-31'));
});
