// Live checks for the unit page: preventive maintenance plans and their work orders, unit documents, monthly history.
// Isolated: it works on units it creates (codes HL-FLT…).
import '../src/env';
import { at, call, check, day, DAY, finish, login, prisma, today } from './lib';

async function main() {
  const [admin, disp] = await Promise.all(['admin', 'dispatcher'].map(login));
  const tag = `HL-FLT${Date.now() % 1e5}`;
  const ohType = await prisma.unitType.findUniqueOrThrow({ where: { name: 'Open Hole' } });
  const hmd = await prisma.base.findUniqueOrThrow({ where: { code: 'HMD' } });
  const unit = (await call('POST', '/units', admin, { code: tag, unitTypeId: ohType.id, homeBaseId: hmd.id })).json;
  const ago = (n: number) => new Date(today.getTime() - n * DAY).toISOString();

  // ================= plans =================
  check('a plan needs a name and an interval', (await call('POST', `/units/${unit.id}/maintenance-plans`, admin, { name: 'x' })).status === 400);
  check('interval must be sensible', (await call('POST', `/units/${unit.id}/maintenance-plans`, admin, { name: 'x', everyDays: 0 })).status === 400);
  const due = (await call('POST', `/units/${unit.id}/maintenance-plans`, admin, { name: 'Engine service', everyDays: 90, durationDays: 2, leadDays: 14, startFrom: ago(200), lastDone: ago(80) })).json;
  check('a service done 80 days ago every 90 days is due soon, due in 10 days', due.state === 'due_soon' && due.nextDue === day(at(10)), due);
  const late = (await call('POST', `/units/${unit.id}/maintenance-plans`, admin, { name: 'Winch check', everyDays: 30, startFrom: ago(200), lastDone: ago(40) })).json;
  check('one done 40 days ago every 30 days is overdue', late.state === 'overdue', late);
  const fine = (await call('POST', `/units/${unit.id}/maintenance-plans`, admin, { name: 'Inspection', everyDays: 365, lastDone: ago(10) })).json;
  check('a fresh one is ok', fine.state === 'ok');

  // ================= scheduler =================
  const run = await call('POST', '/maintenance-plans/run', admin);
  const wos = await prisma.workOrder.findMany({ where: { unitId: unit.id }, orderBy: { plannedStart: 'asc' } });
  check('scheduler opens work orders for the due and overdue services only', run.status === 201 && wos.length === 2 && wos.every(w => w.type === 'preventive' && w.maintenancePlanId), wos.map(w => w.description));
  check('the overdue one is booked from today, the due one on its due date', day(wos[0].plannedStart.toISOString()) === day(at(0)) && day(wos[1].plannedStart.toISOString()) === day(at(10)) && day(wos[1].expectedReturn.toISOString()) === day(at(11)));
  await call('POST', '/maintenance-plans/run', admin);
  check('running again opens nothing more', (await prisma.workOrder.count({ where: { unitId: unit.id } })) === 2);
  const lateWo = wos.find(w => w.maintenancePlanId === late.id)!;
  check('finishing the work order records the service', (await call('POST', `/work-orders/${lateWo.id}/status`, admin, { status: 'DONE' })).status === 201
    && (await call('GET', `/units/${unit.id}/maintenance-plans`, admin)).json.find((p: any) => p.id === late.id).lastDone === day(at(0)));
  check('…and the work order keeps its completion time', !!(await prisma.workOrder.findUniqueOrThrow({ where: { id: lateWo.id } })).completedAt);

  const marked = (await call('POST', `/maintenance-plans/${fine.id}/done`, admin, { date: at(-2) })).json;
  check('a service done elsewhere can be recorded', marked.lastDone === day(at(-2)) && marked.nextDue === day(at(363)));
  check('not in the future', (await call('POST', `/maintenance-plans/${fine.id}/done`, admin, { date: at(3) })).status === 400);
  check('booking now is refused while one is open', (await call('POST', `/maintenance-plans/${due.id}/schedule`, admin, {})).status === 400);

  // a unit on a job: the overdue service waits for the job to end, and a manual booking during it is refused
  const busy = (await call('POST', '/units', admin, { code: `${tag}B`, unitTypeId: ohType.id, homeBaseId: hmd.id })).json;
  const site = await prisma.site.findFirstOrThrow({ where: { baseId: hmd.id } });
  const job = (await call('POST', '/jobs', admin, { wellName: 'FLT-1', siteId: site.id, serviceType: 'Open Hole', plannedStart: at(-3), plannedEnd: at(6) })).json;
  check('unit deployed', (await call('POST', `/jobs/${job.id}/deploy`, admin, { unitId: busy.id })).status === 201);
  const busyPlan = (await call('POST', `/units/${busy.id}/maintenance-plans`, admin, { name: 'Engine service', everyDays: 30, startFrom: ago(100), lastDone: ago(45) })).json;
  check('manual booking during the job is refused', (await call('POST', `/maintenance-plans/${busyPlan.id}/schedule`, admin, { start: at(1) })).status === 400);
  await call('POST', '/maintenance-plans/run', admin);
  const busyWo = await prisma.workOrder.findFirst({ where: { unitId: busy.id } });
  check('the scheduler books it the day after the job', !!busyWo && day(busyWo.plannedStart.toISOString()) === day(at(7)), busyWo?.plannedStart);
  check('so the unit stays on its job today', (await call('GET', `/units?q=${tag}B`, admin)).json.items[0].status === 'DEPLOYED');

  // ================= units list =================
  const listed = (await call('GET', `/units?q=${tag}`, admin)).json.items.find((u: any) => u.code === tag);
  check('the unit list shows the service due first', listed.nextService?.name === 'Engine service' && listed.nextService.state === 'due_soon', listed.nextService);

  // ================= documents =================
  check('document kind is checked', (await call('POST', `/units/${unit.id}/documents`, admin, { kind: 'passport', title: 'x' })).status === 400);
  const file = (await call('POST', '/files', admin, { name: 'insurance.pdf', mime: 'application/pdf', dataBase64: Buffer.from('%PDF-1.4 test').toString('base64') })).json;
  const doc = await call('POST', `/units/${unit.id}/documents`, admin, { kind: 'insurance', title: 'Fleet insurance', fileId: file.id, expiresAt: at(20) });
  await call('POST', `/units/${unit.id}/documents`, admin, { kind: 'inspection', title: 'Old inspection', expiresAt: at(-1) });
  await call('POST', `/units/${unit.id}/documents`, admin, { kind: 'registration', title: 'Registration' });
  const docs = (await call('GET', `/units/${unit.id}/documents`, admin)).json;
  const v = (k: string) => docs.find((d: any) => d.kind === k)?.validity;
  check('documents list with validity: expiring, expired, none', doc.status === 201 && v('insurance') === 'expiring' && v('inspection') === 'expired' && v('registration') === 'none', docs);
  check('the file is attached and downloadable', docs.find((d: any) => d.kind === 'insurance').file?.id === file.id && (await fetch(`${process.env.API ?? 'http://localhost:3000'}/files/${file.id}`, { headers: { authorization: `Bearer ${admin}` } })).status === 200);
  check('a document can be removed', (await call('DELETE', `/unit-documents/${doc.json.id}`, admin)).status === 200 && (await call('GET', `/units/${unit.id}/documents`, admin)).json.length === 2);

  // ================= history =================
  const hist = (await call('GET', `/units/${busy.id}/history?months=2`, admin)).json;
  const thisMonth = hist.months[1];
  check('history: one row per month, job days counted up to today', hist.months.length === 2 && thisMonth.jobDays >= 1 && thisMonth.jobDays + thisMonth.workshopDays + thisMonth.idleDays === thisMonth.days, hist);

  // ================= clean up =================
  check('a plan can be deleted; its work orders stay', (await call('DELETE', `/maintenance-plans/${fine.id}`, admin)).status === 200 && (await prisma.workOrder.count({ where: { unitId: unit.id } })) === 2);
  check('a unit with work orders still cannot be deleted', (await call('DELETE', `/units/${unit.id}`, admin)).status === 409);
  const bare = (await call('POST', '/units', admin, { code: `${tag}C`, unitTypeId: ohType.id, homeBaseId: hmd.id })).json;
  await call('POST', `/units/${bare.id}/maintenance-plans`, admin, { name: 'Engine service', everyDays: 90 });
  await call('POST', `/units/${bare.id}/documents`, admin, { kind: 'registration', title: 'Registration' });
  check('a unit with only plans and papers can be deleted', (await call('DELETE', `/units/${bare.id}`, admin)).status === 200);

  await finish();
}

main().catch(e => { console.error(e); process.exit(1); });
