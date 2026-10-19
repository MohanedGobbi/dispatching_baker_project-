// Plants the 14 scenarios of plan section 28.2 on top of `demo-plan --publish`, so every screen has a story to tell.
// Usage (API running, freshly seeded, after demo-plan): tsx scripts/demo-scenarios.ts
import '../src/env';
import { at, call, DAY, login, prisma, today } from './lib';

const log = (n: number | string, text: string) => console.log(`  ${String(n).padStart(2)}. ${text}`);
const d = (n: number) => new Date(today.getTime() + n * DAY);

async function main() {
  const [hr, ops, disp] = await Promise.all([login('hr'), login('ops'), login('dispatcher')]);
  const leaveType = async (name: string) => (await prisma.leaveType.findUniqueOrThrow({ where: { name } })).id;
  const [medT, annualT] = await Promise.all([leaveType('Medical leave'), leaveType('Annual leave')]);
  const unit = (code: string) => prisma.unit.findUniqueOrThrow({ where: { code }, include: { homeBase: { include: { sites: true } }, unitType: true } });
  const holders = (code: string) => prisma.assignment.findMany({
    where: { status: { in: ['ACTIVE', 'CONFIRMED'] }, start: { lte: today }, plannedEnd: { gte: today }, seat: { unit: { code } } },
    include: { employee: { include: { user: true, qualifications: { include: { qualification: true } } } }, seat: { include: { position: true } } },
  });
  const qual = async (name: string) => (await prisma.qualification.findUniqueOrThrow({ where: { name } })).id;
  const [qCH, qOH] = await Promise.all([qual('Cased Hole'), qual('Open Hole')]);
  const startJob = async (code: string, from: number, to: number, well: string) => {
    const u = await unit(code);
    const j = await call('POST', '/jobs', disp, { wellName: well, rigName: `RIG ${well}`, siteId: u.homeBase.sites[0].id, serviceType: u.unitType.name, plannedStart: at(from), plannedEnd: at(to) });
    await call('POST', `/jobs/${j.json.id}/deploy`, disp, { unitId: u.id });
    return u;
  };
  console.log('Planting scenarios:');

  // ---- 5. an operator on a unit goes on medical leave today -> critical replacement task
  const sick = (await holders('HL-6700')).find(a => a.seat.position.name === 'Field Operator');
  if (sick) {
    await call('POST', '/leaves', hr, { employeeId: sick.employeeId, typeId: medT, start: at(0), end: at(9), documentUrl: 'certificate-demo.pdf' });
    log(5, `${sick.employee.firstName} ${sick.employee.lastName} (HL-6700) on medical leave today: critical replacement task`);
  }
  // a chief on annual leave in 5 days: a task for that day, and "no chief" if nobody is found
  const chief0 = (await holders('HL-6700')).find(a => a.seat.position.name === 'Chief of Unit');
  if (chief0) await call('POST', '/leaves', hr, { employeeId: chief0.employeeId, typeId: annualT, start: at(5), end: at(8) });

  // ---- 9 (prepared first). Few Experienced Cased Hole operators: the rest keep only Open Hole (retrained to OH only)
  const expCH = (await call('GET', `/employees?qualificationId=${qCH}&seniority=EXPERIENCED&limit=500`, ops)).json.items
    .filter((e: any) => e.position.name === 'Field Operator');
  const sorted = [...expCH].sort((a: any, b: any) => a.employeeNo.localeCompare(b.employeeNo));
  const keep = new Set(sorted.slice(0, 3).map((e: any) => e.id));
  const pruned = sorted.filter((e: any) => !keep.has(e.id));
  const hasOH = new Set((await prisma.employeeQualification.findMany({ where: { qualificationId: qOH, employeeId: { in: pruned.map((e: any) => e.id) } } })).map(q => q.employeeId));
  const drop = pruned.filter((e: any) => hasOH.has(e.id));
  await prisma.employeeQualification.deleteMany({ where: { qualificationId: qCH, employeeId: { in: drop.map((e: any) => e.id) } } });
  await prisma.employee.updateMany({ where: { id: { in: pruned.filter((e: any) => !hasOH.has(e.id)).map((e: any) => e.id) } }, data: { seniorityOverride: 'JUNIOR', seniorityReason: 'Demo scenario: Cased Hole experience is scarce' } });
  log(9, `only ${keep.size} Experienced Cased Hole operators remain (${drop.length} are Open Hole only, ${pruned.length - drop.length} are Junior)`);

  // ---- 3. a Cased Hole unit starts today; its crew is planned; then one operator turns out to be Open Hole only
  const u3 = await startJob('HL-6784', -3, 60, 'WELL-CH1');
  const hmd = u3.homeBaseId;
  const plan = await call('POST', '/planning/plans', disp, { start: at(0), end: at(27), baseIds: [hmd] });
  if (plan.status === 201) {
    await call('POST', `/planning/plans/${plan.json.id}/submit`, disp);
    await call('POST', `/planning/plans/${plan.json.id}/approve`, ops, {});
    const pub = await call('POST', `/planning/plans/${plan.json.id}/publish`, ops, { skipInvalid: true });
    const crew = (await holders('HL-6784')).filter(a => a.seat.position.name === 'Field Operator');
    const victim = crew.find(a => a.employee.qualifications.some(q => q.qualificationId === qOH)) ?? crew[0];
    if (victim) {
      await prisma.employeeQualification.deleteMany({ where: { employeeId: victim.employeeId, qualificationId: qCH } });
      log(3, `${victim.employee.firstName} ${victim.employee.lastName} is on Cased Hole unit HL-6784 with Open Hole only (published ${pub.json.published})`);
    } else log(3, 'HL-6784 crew could not be planned');
  }

  // ---- 4. a unit at base with no crew and a job starting in 5 days
  await startJob('HL-6798', 5, 60, 'WELL-CH2');
  const scan = await call('POST', '/replacements/scan', disp, { start: at(0), end: at(27) });
  log(4, `HL-6798 (TMN) has a job in 5 days and no crew: ${scan.json.created} replacement task(s) opened by the scan`);

  // ---- 9. Cased Hole jobs piling up about six weeks out
  for (const [code, well] of [['HL-6763', 'WELL-CH3'], ['HL-6777', 'WELL-CH4'], ['HL-6791', 'WELL-CH5'], ['HL-6770', 'WELL-CH6']] as const) await startJob(code, 35, 75, well);
  log(9, 'four more Cased Hole jobs start in about 5 weeks: the forecast will show Experienced CH operators running short');

  // ---- 1. a deployed unit with only 2 of 3 operators
  const u1 = (await holders('HL-6707')).filter(a => a.seat.position.name === 'Field Operator').sort((a, b) => b.seat.index - a.seat.index)[0];
  if (u1) { await call('POST', `/assignments/${u1.id}/unassign`, disp, { from: at(0), reason: 'Demo: operator pulled off' }); log(1, 'HL-6707 (INA) has only 2 of 3 operators'); }

  // ---- 2. a deployed unit with no Experienced operator
  const u2 = await holders('HL-6714');
  let demoted = 0;
  for (const a of u2.filter(x => ['Chief of Unit', 'Field Operator'].includes(x.seat.position.name))) {
    await prisma.employee.update({ where: { id: a.employeeId }, data: { seniorityOverride: 'JUNIOR', seniorityReason: 'Demo scenario: no experienced person on this crew' } });
    demoted++;
  }
  log(2, `HL-6714 (TMN) has no Experienced operator (${demoted} crew members are Junior)`);

  // ---- 6. a 45-day medical leave on a scarce Cased Hole profile (aggregate only: never named in analytics)
  const scarce = sorted.find((e: any) => keep.has(e.id));
  if (scarce) {
    const r = await call('POST', '/leaves', hr, { employeeId: scarce.id, typeId: medT, start: at(0), end: at(44), documentUrl: 'long-term-certificate.pdf' });
    log(6, `45-day medical leave on an Experienced Cased Hole operator: ${r.status === 201 ? 'recorded' : r.status}`);
  }

  // ---- 7. one person awaiting clearance, another restricted to base posts
  const people = await prisma.employee.findMany({ where: { active: true, position: { name: 'Field Operator' } }, orderBy: { employeeNo: 'desc' }, take: 40 });
  const waiting = people[0];
  await prisma.leave.create({ data: { employeeId: waiting.id, typeId: medT, start: d(-35), end: d(-12), status: 'RECORDED', documentUrl: 'old-certificate.pdf' } });
  const restricted = (await holders('HL-6728')).find(a => a.seat.position.name === 'Field Operator');
  if (restricted) await call('POST', `/employees/${restricted.employeeId}/restrictions`, hr, { kind: 'base_only', end: at(21) });
  log(7, `${waiting.firstName} ${waiting.lastName} awaits clearance; ${restricted?.employee.firstName ?? '?'} ${restricted?.employee.lastName ?? ''} is restricted to base posts`);

  // ---- 8. HMD below its minimum mechanics next week because of overlapping leave
  const mechs = await prisma.employee.findMany({ where: { homeBaseId: hmd, position: { name: 'Mechanic' }, active: true }, orderBy: { employeeNo: 'asc' } });
  let booked = 0;
  for (const m of mechs.slice(0, 3)) { const r = await call('POST', '/leaves', hr, { employeeId: m.id, typeId: annualT, start: at(6), end: at(13) }); if (r.status === 201) booked++; }
  log(8, `${booked} of ${mechs.length} HMD mechanics are on leave next week (minimum is 2)`);

  // ---- 11. three people owed a lot of rest after repeated extensions
  const onUnit = (await holders('HL-6735')).concat(await holders('HL-6742'), await holders('HL-6749')).filter(a => a.seat.position.name === 'Field Operator').slice(0, 3);
  let n = 0;
  for (const [i, a] of onUnit.entries()) {
    const days = [11, 9, 8][i];
    await prisma.extension.createMany({ data: [
      { assignmentId: a.id, employeeId: a.employeeId, days: Math.ceil(days / 2), reason: 'no_replacement', status: 'APPROVED', acknowledgedAt: new Date(), createdAt: d(-40) },
      { assignmentId: a.id, employeeId: a.employeeId, days: Math.floor(days / 2), reason: 'replacement_late', status: 'APPROVED', acknowledgedAt: new Date(), createdAt: d(-12) },
    ] });
    await prisma.daysOffLedger.create({ data: { employeeId: a.employeeId, days, reason: 'extension', note: 'Repeated extensions (demo)' } });
    n++;
  }
  log(11, `${n} operators are owed 8-11 rest days after repeated extensions`);

  // ---- 12. certificates that expire during a planned assignment
  const longRunning = (await prisma.assignment.findMany({ where: { status: 'ACTIVE', plannedEnd: { gte: d(20) }, start: { lte: today }, seat: { holderType: 'UNIT', position: { name: 'Field Operator' } } }, take: 12, include: { employee: true } })).slice(5, 8);
  for (const a of longRunning) await prisma.certification.updateMany({ where: { employeeId: a.employeeId }, data: { expiresAt: d(10 + Math.floor(Math.random() * 6)) } });
  log(12, `${longRunning.length} operators' certificates expire in about 2 weeks, in the middle of their rotation`);

  // ---- 13. a unit back from maintenance in 3 days
  const wu = await unit('HL-6791');
  const mech = await prisma.employee.findFirst({ where: { homeBaseId: wu.homeBaseId, position: { name: 'Mechanic' }, active: true } });
  const wo = await call('POST', '/work-orders', ops, { unitId: wu.id, type: 'corrective', priority: 'high', description: 'Winch and hydraulics overhaul', expectedReturn: at(3), assigneeIds: mech ? [mech.id] : [] });
  log(13, `HL-6791 is in the workshop, back in 3 days (${wo.status === 201 ? 'work order opened' : wo.status})`);

  // ---- 14. a swap request waiting for approval between two operators
  const upcoming = await prisma.assignment.findMany({
    where: { status: 'CONFIRMED', start: { gt: today, lte: d(25) }, seat: { holderType: 'UNIT', position: { name: 'Field Operator' } } },
    include: { employee: { include: { user: true } }, seat: true }, orderBy: { start: 'asc' }, take: 60,
  });
  let swapped = false;
  for (let i = 0; i < upcoming.length && !swapped; i++) {
    for (let j = i + 1; j < upcoming.length && !swapped; j++) {
      const a = upcoming[i], b = upcoming[j];
      if (a.employeeId === b.employeeId || !a.employee.user || !b.employee.user) continue;
      const ta = await login(a.employee.user.login);
      const r = await call('POST', '/swaps', ta, { requesterAssignmentId: a.id, colleagueAssignmentId: b.id, note: 'Family event that week' });
      if (r.status !== 201) continue;
      const tb = await login(b.employee.user.login);
      await call('POST', `/swaps/${r.json.id}/respond`, tb, { accept: true });
      log(14, `${a.employee.firstName} ${a.employee.lastName} and ${b.employee.firstName} ${b.employee.lastName} asked to swap; waiting for a manager`);
      swapped = true;
    }
  }
  if (!swapped) log(14, 'no valid pair found for a swap request');

  // ---- history: four earlier rotations on every unit with a job, so the board's time machine has something to show
  const crewedUnits = await prisma.unit.findMany({ where: { deployments: { some: {} } }, include: { seats: { where: { holderType: 'UNIT', requiredFlag: true }, include: { position: true } } } });
  const pools = new Map<string, string[]>();
  const poolFor = async (baseId: string, positionId: string) => {
    const k = baseId + positionId;
    if (!pools.has(k)) pools.set(k, (await prisma.employee.findMany({ where: { homeBaseId: baseId, positionId, active: true }, orderBy: { employeeNo: 'asc' }, select: { id: true } })).map(e => e.id));
    return pools.get(k)!;
  };
  const cursor = new Map<string, number>();
  const past: { employeeId: string; seatId: string; start: Date; plannedEnd: Date; actualEnd: Date; status: 'COMPLETED'; type: 'NORMAL' }[] = [];
  for (let block = 0; block < 4; block++) {
    const from = -112 + block * 28;
    for (const u of crewedUnits) for (const s of u.seats) {
      const pool = await poolFor(u.homeBaseId, s.positionId);
      if (!pool.length) continue;
      const k = u.homeBaseId + s.positionId;
      const i = (cursor.get(k) ?? 0);
      cursor.set(k, i + 1);
      past.push({ employeeId: pool[i % pool.length], seatId: s.id, start: d(from), plannedEnd: d(from + 27), actualEnd: d(from + 27), status: 'COMPLETED', type: 'NORMAL' });
    }
  }
  await prisma.assignment.createMany({ data: past });
  log('H', `${past.length} past assignments recorded: the board's time machine works for the last 3 months`);

  // ---- let the rules look at the world and send the daily reminders
  const rec = await call('POST', '/analytics/recommendations/run', ops);
  const daily = await call('POST', '/notifications/run-daily', disp);
  console.log(`\nRecommendations: ${JSON.stringify(rec.json)}\nDaily job: ${JSON.stringify(daily.json)}`);
  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
