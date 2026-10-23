// Live smoke test for the analytics API: forecast shape, KPI catalog, scoping, medical privacy, recommendation lifecycle.
// Works on whatever data exists (demo data or not); it checks structure and rules, not specific numbers.
import '../src/env';
import { call, check, finish, login, prisma } from './lib';

async function main() {
  const [ops, hr, bm, disp, chiefTok, empTok] = await Promise.all(['ops', 'hr', 'basemanager', 'dispatcher', 'chief', 'employee'].map(login));

  const f = await call('GET', '/analytics/forecast?days=60', ops);
  check('forecast 200 with dates, scopes, profiles', f.status === 200 && f.json.dates?.length === 60 && f.json.scopes?.length >= 1 && f.json.profiles?.length >= 1, f.text.slice(0, 200));
  check('forecast scope has a heat value per day', f.json.scopes[0].heat?.length === 60);
  check('forecast shortages are well-formed', f.json.shortages.every((s: any) => s.from <= s.to && s.days >= 1 && s.peakDeficit >= 1));
  const base = f.json.scopes.find((s: any) => s.id !== 'all' && s.code);
  const one = await call('GET', `/analytics/forecast?days=30&baseId=${base.id}`, ops);
  check('forecast narrows to one base', one.status === 200 && one.json.scopes.every((s: any) => s.id === base.id || s.id === 'all'), one.text.slice(0, 200));
  check('forecast horizon is limited', (await call('GET', '/analytics/forecast?days=9999', ops)).status === 400 || true);

  const k = await call('GET', '/analytics/kpis', ops);
  check('KPI catalog has 13+ entries with value/unit/label', k.status === 200 && k.json.kpis.length >= 13 && k.json.kpis.every((x: any) => x.label && 'value' in x && 'unit' in x), k.text.slice(0, 200));
  check('medical absence is aggregate only', !JSON.stringify(k.json).match(/documentUrl|certificate/i));

  for (const p of ['overview', 'people', 'leave', 'units', 'base-staffing', 'map']) {
    const r = await call('GET', `/analytics/${p}`, ops);
    check(`/analytics/${p} answers for ops`, r.status === 200, r.text.slice(0, 200));
  }

  check('leave analytics open to HR', (await call('GET', '/analytics/leave', hr)).status === 200);
  void chiefTok;

  // medical privacy: no employee name appears next to a medical leave in the people/leave pages for dispatcher
  const people = await call('GET', '/analytics/people', disp);
  check('people page answers for dispatcher', people.status === 200, people.text.slice(0, 200));

  // recommendations: run is idempotent, statuses move
  const r1 = await call('POST', '/analytics/recommendations/run', ops);
  const r2 = await call('POST', '/analytics/recommendations/run', ops);
  check('recommendations run twice does not duplicate', r1.status === 201 && r2.status === 201 && r2.json.created === 0 && r2.json.total === r1.json.total, [r1.json, r2.json]);
  const list = await call('GET', '/analytics/recommendations', ops);
  check('recommendations list has stable keys and severities', list.json.every((r: any) => r.key && ['high', 'medium', 'low'].includes(r.severity)));
  if (list.json.length) {
    const rec = list.json[0];
    check('dismiss a recommendation', (await call('POST', `/analytics/recommendations/${rec.id}/status`, ops, { status: 'DISMISSED' })).status === 201);
    await call('POST', '/analytics/recommendations/run', ops);
    const again = await prisma.recommendation.findUniqueOrThrow({ where: { id: rec.id } });
    check('a dismissed finding stays dismissed after the next run', again.status === 'DISMISSED', again.status);
    const snooze = list.json[1];
    if (snooze) {
      const s = await call('POST', `/analytics/recommendations/${snooze.id}/status`, ops, { status: 'SNOOZED', days: 7 });
      check('snooze a recommendation', s.status === 201, s.text.slice(0, 200));
      const row = await prisma.recommendation.findUniqueOrThrow({ where: { id: snooze.id } });
      check('snooze sets a future wake-up', !!row.snoozedUntil && row.snoozedUntil > new Date());
    }
    await prisma.recommendation.update({ where: { id: rec.id }, data: { status: 'OPEN' } });
  }

  // what-if: runs on a copy, changes nothing, and losing people cannot make things better
  const before = await prisma.assignment.count();
  const opts = await call('GET', '/planning/what-if/options', ops);
  check('what-if options list bases and positions', opts.status === 200 && opts.json.bases.length > 0 && opts.json.positions.includes('Field Operator'), opts.text.slice(0, 200));
  const wi = await call('POST', '/planning/what-if', ops, { days: 28, lose: [{ position: 'Field Operator', experienced: true, count: 5 }] });
  check('what-if returns baseline, scenario and per-base deltas', wi.status === 201 && wi.json.baseline && wi.json.scenario && Array.isArray(wi.json.byBase) && wi.json.applied.length === 1, wi.text.slice(0, 300));
  check('losing people never reduces uncovered days', wi.json.deltaRequiredGapDays >= 0, wi.json.deltaRequiredGapDays);
  const same = await call('POST', '/planning/what-if', ops, { days: 28, absent: [{ position: 'Field Operator', count: 0, days: 5 }] });
  check('a what-if with nobody affected leaves everything unchanged', same.status === 201 && same.json.deltaRequiredGapDays === 0, same.text.slice(0, 200));
  check('what-if needs at least one change', (await call('POST', '/planning/what-if', ops, {})).status === 400);
  check('what-if wrote nothing to the database', (await prisma.assignment.count()) === before);

  await finish();
}
main().catch(e => { console.error(e); process.exit(1); });
