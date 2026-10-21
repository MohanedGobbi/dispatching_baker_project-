// Live smoke test for E5-E8 against a running API + seeded DB. Mutates data: run `npm run seed` afterwards.
// Usage: API=http://localhost:3000 tsx scripts/smoke-master-data.ts
import '../src/env';
import { PrismaClient } from '@prisma/client';

const API = process.env.API ?? 'http://localhost:3000';
const prisma = new PrismaClient();
let failed = 0;

async function call(method: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json };
}
function check(name: string, ok: boolean, extra?: unknown) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + JSON.stringify(extra)}`);
}
const login = async (l: string) => (await call('POST', '/auth/login', undefined, { login: l, password: 'demo1234' })).json.token as string;
const iso = (d: Date) => d.toISOString();
const day = 86_400_000;

async function main() {
  const [admin, ops, hr, disp, emp] = await Promise.all(['admin', 'ops', 'hr', 'dispatcher', 'employee'].map(login));
  const now = new Date(); now.setUTCHours(0, 0, 0, 0);

  // ---- E5 bases & sites
  const bases = await call('GET', '/bases', disp);
  check('bases list', bases.status === 200 && bases.json.length === 4, bases);
  const hmd = bases.json.find((b: any) => b.code === 'HMD');
  const detail = await call('GET', `/bases/${hmd.id}`, disp);
  check('base detail loads and carries no base-staff staffing (base staff was removed)', detail.status === 200 && (detail.json.staffing ?? []).length === 0, detail.json.staffing);
  check('dispatcher cannot create base', (await call('POST', '/bases', disp, { code: 'X', name: 'X' })).status === 403);
  const nb = await call('POST', '/bases', ops, { code: 'TST', name: 'Test Base', lat: 30, lng: 5 });
  check('ops creates base', nb.status === 201, nb);
  check('duplicate base code rejected cleanly', [400, 409].includes((await call('POST', '/bases', ops, { code: 'TST', name: 'Dup' })).status));
  const site = await call('POST', '/sites', ops, { name: 'TST-W1', baseId: nb.json.id });
  check('site created', site.status === 201, site);
  const mechPos = (await prisma.position.findUnique({ where: { name: 'Mechanic' } }))!;
  const st = await call('PUT', `/bases/${nb.json.id}/staffing/${mechPos.id}`, ops, { minCount: 1, targetCount: 3 });
  const seats = await prisma.seat.findMany({ where: { baseId: nb.json.id, positionId: mechPos.id }, orderBy: { index: 'asc' } });
  check('staffing template generates 3 seats, first required', st.status === 200 && seats.length === 3 && seats[0].requiredFlag && !seats[1].requiredFlag, seats);
  check('invalid staffing (min>target) rejected', (await call('PUT', `/bases/${nb.json.id}/staffing/${mechPos.id}`, ops, { minCount: 5, targetCount: 2 })).status === 400);
  await call('PUT', `/bases/${nb.json.id}/staffing/${mechPos.id}`, ops, { minCount: 1, targetCount: 1 });
  check('lowering target removes empty surplus seats', (await prisma.seat.count({ where: { baseId: nb.json.id, positionId: mechPos.id } })) === 1);
  check('archive refused while site-less base is empty? (empty base archives)', (await call('DELETE', `/bases/${nb.json.id}`, ops)).status === 200);
  check('archive refused when base has units', (await call('DELETE', `/bases/${hmd.id}`, ops)).status === 400);

  // ---- E6 employees
  const list = await call('GET', '/employees?limit=500', hr);
  const activeCount = await prisma.employee.count({ where: { active: true } });
  check(`employee list (${activeCount} active)`, list.status === 200 && list.json.total === activeCount, list.json?.total);
  const seniors = await call('GET', '/employees?seniority=SENIOR&limit=500', hr);
  check('seniority filter works and is computed', seniors.json.items.every((e: any) => e.seniority === 'SENIOR'), seniors.json.total);
  check('search by name', (await call('GET', '/employees?q=benali', hr)).json.items.every((e: any) => /benali/i.test(e.lastName)));
  check('employee role cannot list', (await call('GET', '/employees', emp)).status === 403);

  const op = await prisma.employee.findFirstOrThrow({ where: { position: { name: 'Field Operator' }, active: true }, include: { qualifications: true } });
  const prof = await call('GET', `/employees/${op.id}`, hr);
  check('profile has computed fields', prof.status === 200 && prof.json.seniority && 'fieldDays' in prof.json && prof.json.status, prof.json?.status);

  // medical privacy: record a medical leave, dispatcher must only see "Unavailable"
  const medType = await prisma.leaveType.findUniqueOrThrow({ where: { name: 'Medical leave' } });
  await prisma.leave.create({ data: { employeeId: op.id, typeId: medType.id, start: new Date(now.getTime() - day), end: new Date(now.getTime() + 10 * day), status: 'ACTIVE', notes: 'CONFIDENTIAL', documentUrl: 'cert.pdf' } });
  const asHr = (await call('GET', `/employees/${op.id}`, hr)).json;
  const asDisp = (await call('GET', `/employees/${op.id}`, disp)).json;
  check('status computed MEDICAL_LEAVE', asHr.status === 'MEDICAL_LEAVE', asHr.status);
  check('HR sees medical details', asHr.leaves[0].notes === 'CONFIDENTIAL');
  check('dispatcher sees only Unavailable (no notes/doc)', asDisp.leaves[0].type.name === 'Unavailable' && !asDisp.leaves[0].notes && !asDisp.leaves[0].documentUrl, asDisp.leaves[0]);
  check('dispatcher does not see manager notes', !('managerNotes' in asDisp) || asDisp.managerNotes === undefined);

  check('dispatcher limited edit: phone ok', (await call('PUT', `/employees/${op.id}`, disp, { phone: '0555000111' })).status === 200);
  check('dispatcher limited edit: position blocked', (await call('PUT', `/employees/${op.id}`, disp, { homeBaseId: hmd.id })).status === 403);

  check('seniority override needs reason', (await call('PUT', `/employees/${op.id}/seniority`, hr, { level: 'SENIOR' })).status === 400);
  check('seniority override applies', (await call('PUT', `/employees/${op.id}/seniority`, hr, { level: 'SENIOR', reason: 'Sign-off' })).status === 200
    && (await call('GET', `/employees/${op.id}`, hr)).json.seniority === 'SENIOR');
  await call('PUT', `/employees/${op.id}/seniority`, hr, { level: null });

  const newEmp = await call('POST', '/employees', hr, {
    employeeNo: 'E-SMOKE', firstName: 'Test', lastName: 'Person', positionId: op.positionId, homeBaseId: hmd.id, hireDate: iso(new Date(now.getTime() - 30 * day)),
  });
  check('create employee', newEmp.status === 201, newEmp);
  check('duplicate employee number rejected', (await call('POST', '/employees', hr, { employeeNo: 'E-SMOKE', firstName: 'A', lastName: 'B', positionId: op.positionId, homeBaseId: hmd.id, hireDate: iso(now) })).status === 400);
  check('new hire is a New Recruit', (await call('GET', `/employees/${newEmp.json.id}`, hr)).json.seniority === 'NEW_RECRUIT');

  // ---- E7 units
  const ohType = await prisma.unitType.findUniqueOrThrow({ where: { name: 'Open Hole' } });
  const unit = await call('POST', '/units', ops, { code: 'HL-SMOKE', unitTypeId: ohType.id, homeBaseId: hmd.id });
  check('create unit', unit.status === 201, unit);
  const uSeats = await prisma.seat.findMany({ where: { unitId: unit.json.id }, include: { position: true }, orderBy: [{ positionId: 'asc' }, { index: 'asc' }] });
  const ops3 = uSeats.filter(s => s.position.name === 'Field Operator');
  check('unit gets 4 seats (1 chief, 3 operators)', uSeats.length === 4 && uSeats.filter(s => !s.requiredFlag).length === 0, uSeats.length);
  check('first operator seat requires Experienced', (ops3.find(s => s.index === 1)!.requirements as any).minSeniority === 'EXPERIENCED');
  check('duplicate unit code rejected', (await call('POST', '/units', ops, { code: 'HL-SMOKE', unitTypeId: ohType.id, homeBaseId: hmd.id })).status === 400);
  check('status: cannot set DEPLOYED manually', (await call('PUT', `/units/${unit.json.id}/status`, ops, { status: 'DEPLOYED' })).status === 400);
  check('unit list shows computed status', (await call('GET', `/units?baseId=${hmd.id}`, disp)).json.items.some((u: any) => u.code === 'HL-SMOKE' && u.status === 'AVAILABLE'));
  const ina = bases.json.find((b: any) => b.code === 'INA');
  check('transfer unit', (await call('POST', `/units/${unit.json.id}/transfer`, ops, { baseId: ina.id, reason: 'rebalancing' })).status === 201);
  check('transfer to same base rejected', (await call('POST', `/units/${unit.json.id}/transfer`, ops, { baseId: ina.id })).status === 400);

  // ---- E8 jobs
  const siteHmd = await prisma.site.findFirstOrThrow({ where: { baseId: hmd.id } });
  const mk = (n: number, len: number) => ({ wellName: 'HGAS-9', rigName: 'SPEC 1', siteId: siteHmd.id, serviceType: 'Open Hole', plannedStart: iso(new Date(now.getTime() + n * day)), plannedEnd: iso(new Date(now.getTime() + (n + len) * day)) });
  const job = await call('POST', '/jobs', disp, mk(-2, 20));
  check('create job with auto ref', job.status === 201 && /^JOB-\d{4}-\d{4}$/.test(job.json.ref), job);
  check('job rejects bad service type', (await call('POST', '/jobs', disp, { ...mk(0, 5), serviceType: 'Nope' })).status === 400);
  check('job rejects end before start', (await call('POST', '/jobs', disp, { ...mk(5, -3) })).status === 400);
  const dep = await call('POST', `/jobs/${job.json.id}/deploy`, disp, { unitId: unit.json.id });
  check('deploy unit to job', dep.status === 201 && dep.json.warnings.length === 0, dep);
  const after = (await call('GET', `/units?baseId=${ina.id}`, disp)).json.items.find((u: any) => u.code === 'HL-SMOKE');
  check('unit now DEPLOYED with job + crew problem flagged', after.status === 'DEPLOYED' && after.job && after.problem === true, after);
  const job2 = await call('POST', '/jobs', disp, mk(5, 5));
  check('double-booking blocked (409)', (await call('POST', `/jobs/${job2.json.id}/deploy`, disp, { unitId: unit.json.id })).status === 409);
  const chType = await prisma.unitType.findUniqueOrThrow({ where: { name: 'Cased Hole' } });
  const chUnit = await call('POST', '/units', ops, { code: 'HL-SMOKE2', unitTypeId: chType.id, homeBaseId: hmd.id });
  const mismatch = await call('POST', `/jobs/${job2.json.id}/deploy`, disp, { unitId: chUnit.json.id });
  check('OH job on CH unit = warning, not error', mismatch.status === 201 && mismatch.json.warnings.length === 1, mismatch);
  const maint = await call('PUT', `/units/${chUnit.json.id}/status`, ops, { status: 'UNDER_MAINTENANCE', expectedReturn: iso(new Date(now.getTime() + 30 * day)) });
  check('status UNDER_MAINTENANCE opens a work order', maint.status === 200 && maint.json.workOrder, maint);
  const job3 = await call('POST', '/jobs', disp, mk(8, 3));
  check('maintenance blocks deployment (409)', (await call('POST', `/jobs/${job3.json.id}/deploy`, disp, { unitId: chUnit.json.id })).status === 409);
  check('start job', (await call('POST', `/jobs/${job.json.id}/start`, disp)).json.status === 'ACTIVE');
  check('end job returns unit to AVAILABLE', (await call('POST', `/jobs/${job.json.id}/end`, disp, { date: iso(new Date(now.getTime() - day)) })).json.status === 'COMPLETED'
    && (await call('GET', `/units?baseId=${ina.id}`, disp)).json.items.find((u: any) => u.code === 'HL-SMOKE').status === 'AVAILABLE');
  check('completed job cannot be edited', (await call('PUT', `/jobs/${job.json.id}`, disp, { wellName: 'x' })).status === 400);
  check('unit detail shows utilization + history', (await call('GET', `/units/${unit.json.id}`, disp)).json.utilization.deployedDays >= 1);

  // ---- units page: search and delete
  const found = await call('GET', '/units?q=smoke', ops);
  check('unit search by code', found.json.items.length >= 2 && found.json.items.every((u: any) => u.code.includes('SMOKE')) && 'plate' in found.json.items[0], found.json.items.map((u: any) => u.code));
  check('a unit with history cannot be deleted (409)', (await call('DELETE', `/units/${unit.json.id}`, ops)).status === 409);
  const spare = await call('POST', '/units', ops, { code: 'HL-SMOKE3', unitTypeId: ohType.id, homeBaseId: hmd.id, plate: 'TMP-1' });
  check('dispatcher cannot delete units', (await call('DELETE', `/units/${spare.json.id}`, disp)).status === 403);
  check('a unit entered by mistake is deleted with its seats', (await call('DELETE', `/units/${spare.json.id}`, ops)).status === 200
    && !(await prisma.unit.findUnique({ where: { id: spare.json.id } })) && (await prisma.seat.count({ where: { unitId: spare.json.id } })) === 0);

  // ---- archive flow (needs an assignment on a unit seat)
  const chief = ops3.find(s => s.index === 2)!;
  await prisma.assignment.create({ data: { employeeId: newEmp.json.id, seatId: chief.id, start: new Date(now.getTime() - 5 * day), plannedEnd: new Date(now.getTime() + 20 * day), status: 'ACTIVE' } });
  await prisma.assignment.create({ data: { employeeId: newEmp.json.id, seatId: chief.id, start: new Date(now.getTime() + 30 * day), plannedEnd: new Date(now.getTime() + 50 * day), status: 'CONFIRMED' } });
  const arch = await call('POST', `/employees/${newEmp.json.id}/archive`, hr, { reason: 'resigned' });
  const tasks = await prisma.replacementTask.findMany({ where: { seatId: chief.id }, orderBy: { fromDate: 'asc' } });
  check('archive releases 2 assignments and creates 2 tasks', arch.status === 201 && arch.json.releasedAssignments === 2 && tasks.length === 2, arch);
  check('running assignment => CRITICAL task from tomorrow; future => NORMAL', tasks[0]?.urgency === 'CRITICAL' && tasks[1]?.urgency === 'NORMAL', tasks.map(t => t.urgency));
  check('archived employee is INACTIVE', (await call('GET', `/employees/${newEmp.json.id}`, hr)).json.status === 'INACTIVE');
  check('cannot archive twice', (await call('POST', `/employees/${newEmp.json.id}/archive`, hr, {})).status === 400);

  // ---- permission sanity
  check('no token => 401', (await call('GET', '/units')).status === 401);
  // The demo "employee" account is linked to one person, who may read their own profile but nobody else's.
  const linkedTo = (await prisma.user.findUniqueOrThrow({ where: { login: 'employee' } })).employeeId;
  const someoneElse = await prisma.employee.findFirstOrThrow({ where: { id: { not: linkedTo ?? undefined } } });
  check('employee cannot read another profile', (await call('GET', `/employees/${someoneElse.id}`, emp)).status === 403);
  check('employee can read their own profile', linkedTo !== null && (await call('GET', `/employees/${linkedTo}`, emp)).status === 200);
  check('audit trail written', (await prisma.auditLog.count()) > 10);

  console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
