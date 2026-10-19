// Performance check (plan E28): times the heavy screens' requests. Run against a seeded database with the API up:
//   SEED_SCALE=5 npm run seed && npx tsx scripts/perf.ts --deploy=40
// --deploy=N first puts N units on jobs so the board, planner and forecast have real work. Prints a markdown table.
import '../src/env';
import { API, at, call, login, prisma } from './lib';

const RUNS = 5;

async function time(path: string, token: string, method = 'GET', body?: unknown) {
  const ms: number[] = [];
  let status = 0, bytes = 0;
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    const res = await fetch(API + path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
    const buf = await res.arrayBuffer();
    ms.push(performance.now() - t0); status = res.status; bytes = buf.byteLength;
  }
  ms.sort((a, b) => a - b);
  return { median: Math.round(ms[Math.floor(RUNS / 2)]), worst: Math.round(ms[RUNS - 1]), status, kb: Math.round(bytes / 1024) };
}

async function main() {
  const admin = await login('admin');
  const deploy = parseInt(process.argv.find(a => a.startsWith('--deploy='))?.split('=')[1] ?? '0', 10);
  if (deploy) {
    const units = await prisma.unit.findMany({ where: { status: { not: 'OUT_OF_SERVICE' }, deployments: { none: {} } }, include: { unitType: true, homeBase: { include: { sites: true } } }, orderBy: { code: 'asc' }, take: deploy });
    for (const [n, u] of units.entries()) {
      const j = await call('POST', '/jobs', admin, { wellName: `PERF-${n + 1}`, siteId: u.homeBase.sites[n % u.homeBase.sites.length].id, serviceType: u.unitType.name, plannedStart: at(-(n % 4) * 6), plannedEnd: at(60) });
      await call('POST', `/jobs/${j.json.id}/deploy`, admin, { unitId: u.id });
    }
  }
  if (deploy) {
    // Crew the units: a published four-week plan, as the demo does.
    const plan = await call('POST', '/planning/plans', admin, { start: at(0), end: at(27) });
    await call('POST', `/planning/plans/${plan.json.id}/publish`, admin, { skipInvalid: true });
  }
  const counts = { employees: await prisma.employee.count(), units: await prisma.unit.count(), deployed: await prisma.unitDeployment.count({ where: { end: { gte: new Date() } } }), assignments: await prisma.assignment.count() };
  const unit = await prisma.unit.findFirstOrThrow({ where: { deployments: { some: {} } } });
  const person = await prisma.employee.findFirstOrThrow({ where: { position: { name: 'Field Operator' } } });

  const rows: [string, Awaited<ReturnType<typeof time>>][] = [];
  const run = async (label: string, path: string, method = 'GET', body?: unknown) => { rows.push([label, await time(path, admin, method, body)]); };
  await run('Board (today)', '/board');
  await run('Units list', '/units?limit=500');
  await run('Unit page: detail', `/units/${unit.id}`);
  await run('Unit page: 12-month history', `/units/${unit.id}/history?months=12`);
  await run('Employees list', '/employees?limit=500');
  await run('Person calendar (90 days)', `/calendar/employees/${person.id}?start=${at(0)}&end=${at(89)}`);
  await run('Timeline (5 weeks, everyone)', `/calendar/timeline?start=${at(0)}&end=${at(34)}`);
  await run('Replacement center', '/replacements');
  await run('Analytics overview', '/analytics/overview');
  await run('Coverage forecast (90 days)', '/analytics/forecast');
  await run('Work orders', '/work-orders?limit=200');
  await run('Tasks', '/tasks');
  await run('Audit log (page)', '/audit?limit=50');
  await run('Excel export: employees', '/transfer/employees/export');
  // The planner runs once per request; fewer repeats would hide nothing, so it uses the same five.
  await run('Planner: 4 weeks, all bases', '/planning/plans', 'POST', { start: at(0), end: at(27) });

  console.log(`\nData: ${counts.employees} people, ${counts.units} units (${counts.deployed} on jobs), ${counts.assignments} assignments. ${RUNS} runs each.\n`);
  console.log('| Request | Median ms | Worst ms | Size kB | Status |');
  console.log('|---|---:|---:|---:|---:|');
  for (const [l, r] of rows) console.log(`| ${l} | ${r.median} | ${r.worst} | ${r.kb} | ${r.status} |`);
  // Drafts made by the timing runs are discarded so the data stays as it was.
  await prisma.assignment.deleteMany({ where: { plan: { status: 'DRAFT' } } });
  await prisma.plan.deleteMany({ where: { status: 'DRAFT' } });
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
