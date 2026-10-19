import { describe, it, expect } from 'vitest';
import { computeUnitStatus, countFieldDays } from './derived';

const d = (s: string) => new Date(s + 'T00:00:00Z');

describe('computeUnitStatus', () => {
  const base = { manualStatus: 'AVAILABLE' as const, workOrders: [], deployments: [] };
  it('available by default', () => expect(computeUnitStatus(base, d('2026-10-19'))).toBe('AVAILABLE'));
  it('deployed inside a deployment', () => {
    expect(computeUnitStatus({ ...base, deployments: [{ start: d('2026-10-01'), end: d('2026-10-30') }] }, d('2026-10-19'))).toBe('DEPLOYED');
    expect(computeUnitStatus({ ...base, deployments: [{ start: d('2026-10-01'), end: d('2026-10-30') }] }, d('2026-11-02'))).toBe('AVAILABLE');
  });
  it('open work order beats deployment; done work order does not', () => {
    const wo = (status: string) => ({ status, plannedStart: d('2026-10-10'), expectedReturn: d('2026-10-25') });
    const dep = [{ start: d('2026-10-01'), end: d('2026-10-30') }];
    expect(computeUnitStatus({ ...base, deployments: dep, workOrders: [wo('IN_PROGRESS')] }, d('2026-10-19'))).toBe('UNDER_MAINTENANCE');
    expect(computeUnitStatus({ ...base, deployments: dep, workOrders: [wo('DONE')] }, d('2026-10-19'))).toBe('DEPLOYED');
  });
  it('out of service wins over everything', () => {
    expect(computeUnitStatus({ ...base, manualStatus: 'OUT_OF_SERVICE', deployments: [{ start: d('2026-10-01'), end: d('2026-10-30') }] }, d('2026-10-19'))).toBe('OUT_OF_SERVICE');
  });
});

describe('countFieldDays', () => {
  it('counts inclusive days and caps at asOf', () => {
    expect(countFieldDays([{ start: d('2026-10-01'), end: d('2026-10-28') }], d('2026-10-19'))).toBe(19);
  });
  it('counts overlapping assignments once', () => {
    expect(countFieldDays([
      { start: d('2026-01-01'), end: d('2026-01-10') },
      { start: d('2026-01-05'), end: d('2026-01-15') },
    ], d('2026-12-31'))).toBe(15);
  });
  it('ignores future assignments', () => {
    expect(countFieldDays([{ start: d('2027-01-01'), end: d('2027-01-28') }], d('2026-10-19'))).toBe(0);
  });
});
