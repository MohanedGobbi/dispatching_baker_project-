import { describe, it, expect } from 'vitest';
import { buildForecast, profileLabel, profilesOf } from './forecast';

const dates = ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23'];
const scopes = [{ id: 'A', code: 'HMD' }, { id: 'B', code: 'INA' }];

describe('buildForecast', () => {
  it('sums scopes into totals and reports a shortage run with its peak', () => {
    const f = buildForecast({
      dates, scopes,
      required: { A: { exp_ch: [2, 2, 3, 3, 1] }, B: { exp_ch: [1, 1, 1, 1, 1] } },
      available: { A: { exp_ch: [2, 1, 1, 3, 3] }, B: { exp_ch: [2, 2, 2, 1, 0] } },
    });
    expect(f.total.exp_ch.map(p => p.required)).toEqual([3, 3, 4, 4, 2]);
    expect(f.total.exp_ch.map(p => p.available)).toEqual([4, 3, 3, 4, 3]);
    const all = f.shortages.filter(s => s.scope === 'all');
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ profile: 'exp_ch', from: '2026-10-21', to: '2026-10-21', days: 1, peakDeficit: 1 });
    const a = f.shortages.find(s => s.scope === 'A')!;
    expect(a).toMatchObject({ from: '2026-10-20', to: '2026-10-21', days: 2, peakDeficit: 2, worstRatio: 0.33 });
    expect(f.shortages.find(s => s.scope === 'B')).toMatchObject({ from: '2026-10-23', to: '2026-10-23', worstRatio: 0 });
  });

  it('a shortage that runs to the end of the period is closed', () => {
    const f = buildForecast({ dates, scopes: [scopes[0]], required: { A: { chief: [1, 1, 1, 1, 1] } }, available: { A: { chief: [1, 1, 0, 0, 0] } } });
    expect(f.shortages[0]).toMatchObject({ from: '2026-10-21', to: '2026-10-23', days: 3 });
  });

  it('days with nothing required are not shortages and have no ratio', () => {
    const f = buildForecast({ dates, scopes: [scopes[0]], required: { A: { chief: [0, 0, 1, 0, 0] } }, available: { A: { chief: [0, 0, 1, 0, 0] } } });
    expect(f.shortages).toEqual([]);
    expect(f.scopes[0].heat.map(h => h.ratio)).toEqual([null, null, 1, null, null]);
  });

  it('heatmap takes the worst profile of each day and names it', () => {
    const f = buildForecast({
      dates: dates.slice(0, 2), scopes: [scopes[0]],
      required: { A: { chief: [2, 2], op_oh: [6, 6] } }, available: { A: { chief: [2, 1], op_oh: [3, 9] } },
    });
    expect(f.scopes[0].heat).toEqual([{ date: '2026-10-19', ratio: 0.5, worst: 'op_oh' }, { date: '2026-10-20', ratio: 0.5, worst: 'chief' }]);
  });

  it('reports the single worst point across the horizon', () => {
    const f = buildForecast({ dates, scopes: [scopes[0]], required: { A: { exp_ch: [4, 4, 4, 4, 4] } }, available: { A: { exp_ch: [4, 3, 1, 3, 4] } } });
    expect(f.minRatio).toEqual({ value: 0.25, date: '2026-10-21', profile: 'exp_ch' });
  });
});

describe('profilesOf', () => {
  it('an experienced operator with both qualifications counts in four profiles', () => {
    expect(profilesOf({ position: 'Field Operator', category: 'FIELD_CREW', qualifications: ['Open Hole', 'Cased Hole'], experienced: true }).sort())
      .toEqual(['exp_ch', 'exp_oh', 'op_ch', 'op_oh']);
  });
  it('a junior CH operator and a mechanic', () => {
    expect(profilesOf({ position: 'Field Operator', category: 'FIELD_CREW', qualifications: ['Cased Hole'], experienced: false })).toEqual(['op_ch']);
    expect(profilesOf({ position: 'Mechanic', category: 'BASE_STAFF', qualifications: [], experienced: false })).toEqual(['post:Mechanic']);
    expect(profilesOf({ position: 'Chief of Unit', category: 'FIELD_CREW', qualifications: [], experienced: true })).toEqual(['chief']);
  });
  it('labels', () => {
    expect(profileLabel('exp_ch')).toBe('Experienced Cased Hole operators');
    expect(profileLabel('post:Mechanic')).toBe('Mechanic (base posts)');
  });
});
