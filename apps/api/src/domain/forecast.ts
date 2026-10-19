// Coverage forecast (plan 20.1 page 2, 20.2 "Coverage ratio"): for every day, how many people each profile needs
// against how many are available. Pure: the service gathers the counts, this derives ratios and shortage periods.

export type Counts = Record<string, Record<string, number[]>>; // scope (base id) -> profile -> value per day

export interface ForecastInput {
  dates: string[];
  scopes: { id: string; code: string }[];
  required: Counts;
  available: Counts;
}

export interface SeriesPoint { date: string; required: number; available: number }
export interface Shortage { scope: string; scopeCode: string; profile: string; from: string; to: string; days: number; peakDeficit: number; worstRatio: number }
export interface Forecast {
  dates: string[];
  total: Record<string, SeriesPoint[]>;
  scopes: { id: string; code: string; series: Record<string, SeriesPoint[]>; heat: { date: string; ratio: number | null; worst: string | null }[] }[];
  shortages: Shortage[];
  minRatio: { value: number | null; date: string | null; profile: string | null };
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export function buildForecast(input: ForecastInput): Forecast {
  const { dates, scopes } = input;
  const profiles = new Set<string>();
  for (const s of scopes) for (const p of [...Object.keys(input.required[s.id] ?? {}), ...Object.keys(input.available[s.id] ?? {})]) profiles.add(p);

  const at = (m: Counts, scope: string, profile: string, i: number) => m[scope]?.[profile]?.[i] ?? 0;
  const series = (scope: string, profile: string): SeriesPoint[] =>
    dates.map((date, i) => ({ date, required: at(input.required, scope, profile, i), available: at(input.available, scope, profile, i) }));

  const total: Record<string, SeriesPoint[]> = {};
  for (const p of profiles) {
    total[p] = dates.map((date, i) => ({
      date, required: sum(scopes.map(s => at(input.required, s.id, p, i))), available: sum(scopes.map(s => at(input.available, s.id, p, i))),
    }));
  }

  const shortages: Shortage[] = [];
  const findShortages = (scopeId: string, scopeCode: string, profile: string, pts: SeriesPoint[]) => {
    let start = -1, peak = 0, worst = Infinity;
    const close = (end: number) => {
      shortages.push({ scope: scopeId, scopeCode, profile, from: pts[start].date, to: pts[end].date, days: end - start + 1, peakDeficit: peak, worstRatio: Math.round(worst * 100) / 100 });
      start = -1; peak = 0; worst = Infinity;
    };
    pts.forEach((p, i) => {
      const short = p.required > 0 && p.available < p.required;
      if (short) {
        if (start < 0) start = i;
        peak = Math.max(peak, p.required - p.available);
        worst = Math.min(worst, p.available / p.required);
      } else if (start >= 0) close(i - 1);
    });
    if (start >= 0) close(pts.length - 1);
  };

  const outScopes = scopes.map(s => {
    const per: Record<string, SeriesPoint[]> = {};
    for (const p of profiles) per[p] = series(s.id, p);
    for (const p of profiles) findShortages(s.id, s.code, p, per[p]);
    const heat = dates.map((date, i) => {
      let ratio: number | null = null, worst: string | null = null;
      for (const p of profiles) {
        const pt = per[p][i];
        if (pt.required <= 0) continue;
        const r = pt.available / pt.required;
        if (ratio === null || r < ratio) { ratio = r; worst = p; }
      }
      return { date, ratio: ratio === null ? null : Math.round(ratio * 100) / 100, worst };
    });
    return { id: s.id, code: s.code, series: per, heat };
  });
  for (const p of profiles) findShortages('all', 'All bases', p, total[p]);

  let minRatio: Forecast['minRatio'] = { value: null, date: null, profile: null };
  for (const p of profiles) {
    for (const pt of total[p]) {
      if (pt.required <= 0) continue;
      const r = pt.available / pt.required;
      if (minRatio.value === null || r < minRatio.value) minRatio = { value: Math.round(r * 100) / 100, date: pt.date, profile: p };
    }
  }
  return { dates, total, scopes: outScopes, shortages, minRatio };
}

/** Profiles a person counts toward (an operator with both qualifications counts in both). */
export function profilesOf(
  e: { position: string; category: string; qualifications: string[]; experienced: boolean },
): string[] {
  const out: string[] = [];
  if (e.position === 'Chief of Unit') out.push('chief');
  if (e.position === 'Field Operator') {
    if (e.qualifications.includes('Open Hole')) { out.push('op_oh'); if (e.experienced) out.push('exp_oh'); }
    if (e.qualifications.includes('Cased Hole')) { out.push('op_ch'); if (e.experienced) out.push('exp_ch'); }
  }
  if (e.category === 'BASE_STAFF') out.push(`post:${e.position}`);
  return out;
}

export const PROFILE_LABEL: Record<string, string> = {
  chief: 'Chiefs of Unit', op_oh: 'Open Hole operators', op_ch: 'Cased Hole operators',
  exp_oh: 'Experienced Open Hole operators', exp_ch: 'Experienced Cased Hole operators',
};
export const profileLabel = (key: string) => (key.startsWith('post:') ? `${key.slice(5)} (base posts)` : PROFILE_LABEL[key] ?? key);
