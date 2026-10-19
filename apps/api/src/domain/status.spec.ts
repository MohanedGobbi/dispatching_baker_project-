import { describe, it, expect } from 'vitest';
import { computeSeniority, isRotationOn, computeStatus, StatusInput } from './status';

const d = (s: string) => new Date(s + 'T00:00:00Z');

describe('computeSeniority', () => {
  it('new recruit under 6 months', () => {
    expect(computeSeniority(d('2026-08-01'), 100, d('2026-10-19'))).toBe('NEW_RECRUIT');
  });
  it('experienced at 2y + 300 field days', () => {
    expect(computeSeniority(d('2024-01-01'), 400, d('2026-10-19'))).toBe('EXPERIENCED');
  });
  it('senior at 5y + 800 field days', () => {
    expect(computeSeniority(d('2020-01-01'), 900, d('2026-10-19'))).toBe('SENIOR');
  });
  it('override wins', () => {
    expect(computeSeniority(d('2026-08-01'), 0, d('2026-10-19'), 'EXPERIENCED')).toBe('EXPERIENCED');
  });
});

describe('isRotationOn', () => {
  const p = { type: 'cycle' as const, daysOn: 28, daysOff: 28 };
  it('28/28 cycle', () => {
    expect(isRotationOn(p, d('2026-01-01'), d('2026-01-28'))).toBe(true);
    expect(isRotationOn(p, d('2026-01-01'), d('2026-01-29'))).toBe(false);
    expect(isRotationOn(p, d('2026-01-01'), d('2026-02-26'))).toBe(true);
  });
  it('works before the anchor date', () => {
    expect(isRotationOn(p, d('2026-01-01'), d('2025-12-31'))).toBe(false);
  });
  it('weekly 5/2 (Sun-Thu)', () => {
    const w = { type: 'weekly' as const, weeklyMask: '1111100' };
    expect(isRotationOn(w, d('2026-01-01'), d('2026-10-18'))).toBe(true); // Sunday
    expect(isRotationOn(w, d('2026-01-01'), d('2026-10-23'))).toBe(false); // Friday
  });
});

describe('computeStatus priority', () => {
  const base: StatusInput = {
    active: true, medicalLeaves: [], otherLeaves: [], clearancePending: false,
    unitAssignments: [], basePostAssignments: [], rotationOn: true,
  };
  const day = d('2026-10-19');
  it('medical leave beats unit assignment', () => {
    const s = computeStatus({
      ...base,
      medicalLeaves: [{ start: d('2026-10-19'), end: d('2026-10-30') }],
      unitAssignments: [{ start: d('2026-10-01'), end: d('2026-10-28'), plannedEnd: d('2026-10-28') }],
    }, day);
    expect(s).toBe('MEDICAL_LEAVE');
  });
  it('marks EXTENDED past planned end', () => {
    const s = computeStatus({
      ...base,
      unitAssignments: [{ start: d('2026-09-20'), end: d('2026-10-25'), plannedEnd: d('2026-10-17') }],
    }, day);
    expect(s).toBe('EXTENDED');
  });
  it('standby vs days off follows rotation', () => {
    expect(computeStatus(base, day)).toBe('STANDBY');
    expect(computeStatus({ ...base, rotationOn: false }, day)).toBe('DAYS_OFF');
  });
  it('inactive first, awaiting clearance before assignments', () => {
    expect(computeStatus({ ...base, active: false }, day)).toBe('INACTIVE');
    expect(computeStatus({ ...base, clearancePending: true }, day)).toBe('AWAITING_CLEARANCE');
  });
});
