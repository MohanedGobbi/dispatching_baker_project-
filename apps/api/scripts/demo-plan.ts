// Realistic-scale run: N of 16 units (default 8) get jobs starting this week, then the engine plans four weeks for every base.
// Usage: tsx scripts/demo-plan.ts [--publish]   (API running, freshly seeded)
import '../src/env';
import { at, call, DAY, login, prisma } from './lib';

async function main() {
  const publish = process.argv.includes('--publish');
  const [disp, ops] = await Promise.all([login('dispatcher'), login('ops')]);
  const units = await prisma.unit.findMany({ where: { status: { not: 'OUT_OF_SERVICE' } }, include: { unitType: true, homeBase: { include: { sites: true } } }, orderBy: { code: 'asc' } });
  let n = 0;
  const count = parseInt(process.argv.find(a => /^--units=/.test(a))?.split('=')[1] ?? '8', 10);
  for (const u of units.slice(0, count)) {
    const site = u.homeBase.sites[n % u.homeBase.sites.length];
    const j = await call('POST', '/jobs', disp, { wellName: `WELL-${n + 1}`, rigName: `RIG ${100 + n}`, siteId: site.id, serviceType: u.unitType.name, plannedStart: at(-(n % 4) * 6), plannedEnd: at(60) });
    await call('POST', `/jobs/${j.json.id}/deploy`, disp, { unitId: u.id });
    n++;
  }
  console.log(`${n} units deployed`);

  const t0 = Date.now();
  const res = await call('POST', '/planning/plans', disp, { start: at(0), end: at(27) });
  const ms = Date.now() - t0;
  if (res.status !== 201) { console.log(res.status, res.text.slice(0, 500)); process.exit(1); }
  const plan = res.json;
  const s = plan.summary;
  const required = s.stats.coveredDays + s.stats.gapDays;
  console.log(`request: ${ms} ms (engine ${s.engineMs} ms)`);
  console.log(`slots ${s.stats.slots}  placements ${s.stats.placements}  gaps ${s.stats.gaps}`);
  console.log(`covered ${s.stats.coveredDays} seat-days of ${required}  (${Math.round((s.stats.coveredDays / required) * 1000) / 10}%)`);
  console.log(`required seat-days uncovered: ${s.stats.requiredGapDays}`);
  const byKind: Record<string, number> = {};
  for (const g of s.gaps) for (const o of g.options) byKind[o.kind] = (byKind[o.kind] ?? 0) + 1;
  console.log('gap fix options offered:', JSON.stringify(byKind));
  for (const g of s.gaps.slice(0, 6)) console.log(`  gap ${g.seat} ${g.from}..${g.to} ${g.required ? '' : '(optional)'}  -> ${g.options.map((o: any) => o.label).slice(0, 2).join(' | ')}`);

  const days = (g: any) => Math.round((Date.parse(g.to) - Date.parse(g.from)) / DAY) + 1;
  const req = s.gaps.filter((g: any) => g.required);
  const unitGaps = req.filter((g: any) => /^HL-/.test(g.seat)), baseGaps = req.filter((g: any) => / base · /.test(g.seat));
  console.log(`required gaps — unit crews: ${unitGaps.reduce((n: number, g: any) => n + days(g), 0)} seat-days in ${unitGaps.length} gaps; base posts: ${baseGaps.reduce((n: number, g: any) => n + days(g), 0)} seat-days in ${baseGaps.length} gaps`);
  const byPos: Record<string, number> = {};
  for (const g of req) { const k = g.seat.split(' · ')[1].replace(/ #\d+/, ''); byPos[k] = (byPos[k] ?? 0) + days(g); }
  console.log('required gap seat-days by position:', JSON.stringify(byPos));

  // Invariants that must hold at any scale
  const live = await prisma.assignment.findMany({ where: { planId: plan.id } });
  const byPerson = new Map<string, { s: number; e: number }[]>();
  for (const a of live) (byPerson.get(a.employeeId) ?? byPerson.set(a.employeeId, []).get(a.employeeId)!).push({ s: a.start.getTime(), e: a.plannedEnd.getTime() });
  let overlaps = 0;
  for (const spans of byPerson.values()) { spans.sort((x, y) => x.s - y.s); for (let i = 1; i < spans.length; i++) if (spans[i].s <= spans[i - 1].e) overlaps++; }
  const bySeat = new Map<string, { s: number; e: number }[]>();
  for (const a of live) (bySeat.get(a.seatId) ?? bySeat.set(a.seatId, []).get(a.seatId)!).push({ s: a.start.getTime(), e: a.plannedEnd.getTime() });
  let seatOverlaps = 0;
  for (const spans of bySeat.values()) { spans.sort((x, y) => x.s - y.s); for (let i = 1; i < spans.length; i++) if (spans[i].s <= spans[i - 1].e) seatOverlaps++; }
  const longest = Math.max(...live.map(a => Math.round((a.plannedEnd.getTime() - a.start.getTime()) / DAY) + 1));
  console.log(`invariants: person double-bookings ${overlaps}, seat overlaps ${seatOverlaps}, longest stretch ${longest} days`);

  if (publish) {
    await call('POST', `/planning/plans/${plan.id}/submit`, disp);
    await call('POST', `/planning/plans/${plan.id}/approve`, ops, {});
    const pub = await call('POST', `/planning/plans/${plan.id}/publish`, ops, { skipInvalid: true });
    console.log('publish:', pub.status, JSON.stringify({ published: pub.json.published, skipped: pub.json.skipped }));
    if (pub.json.problems?.length) console.log('  first problems:', JSON.stringify(pub.json.problems.slice(0, 3).map((p: any) => p.reasons)));
  }
  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
