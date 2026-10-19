// Prints a summary of the analytics endpoints so the demo data can be tuned. Usage: tsx scripts/peek-analytics.ts
import '../src/env';
import { call, login } from './lib';

async function main() {
  const ops = await login('ops');
  const t0 = Date.now();
  const f = (await call('GET', '/analytics/forecast?days=90', ops)).json;
  console.log(`forecast ${Date.now() - t0} ms · profiles: ${f.profiles.map((p: any) => p.key).join(', ')}`);
  console.log('min ratio:', JSON.stringify(f.minRatio));
  const all = f.shortages.filter((s: any) => s.scope === 'all');
  console.log(`shortages (all bases): ${all.length}`);
  for (const s of all.slice(0, 12)) console.log(`  ${s.profile.padEnd(16)} ${s.from}..${s.to} (${s.days}d) peak -${s.peakDeficit} worst ${s.worstRatio}`);
  const perBase = f.shortages.filter((s: any) => s.scope !== 'all');
  console.log(`shortages (per base): ${perBase.length}`);
  for (const b of f.scopes) {
    const today = b.series;
    const prof = Object.keys(today).map(k => `${k}:${today[k][0].available}/${today[k][0].required}`).join(' ');
    console.log(`  ${b.code} today available/required -> ${prof}`);
  }
  const k = (await call('GET', '/analytics/kpis', ops)).json;
  for (const x of k.kpis) console.log(`  KPI ${x.label.padEnd(42)} ${x.value} ${x.unit} ${x.detail ?? ''}`);
  const run = await call('POST', '/analytics/recommendations/run', ops);
  console.log('recommendations run:', JSON.stringify(run.json));
  const list = (await call('GET', '/analytics/recommendations', ops)).json;
  for (const r of list.slice(0, 20)) console.log(`  [${r.severity}] ${r.type.padEnd(22)} ${r.title}`);
  const ov = (await call('GET', '/analytics/overview', ops)).json;
  console.log('overview:', JSON.stringify({ headcount: ov.headcount, crews: { deployed: ov.crews.deployed, compliant: ov.crews.compliant }, below: ov.basePostsBelowMin.length, tasks: ov.openTasks }));
  for (const p of ['people', 'leave', 'units', 'base-staffing', 'map']) {
    const r = await call('GET', `/analytics/${p}`, ops);
    console.log(`  /analytics/${p} -> ${r.status} (${r.text.length} bytes)`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
