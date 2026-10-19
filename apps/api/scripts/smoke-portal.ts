// Live smoke test for E19 (work orders) and E21's API: portal today/stats/profile, files, swaps.
import '../src/env';
import { at, call, check, day, DAY, finish, login, mkEmployee, mkUser, prisma, today } from './lib';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF').toString('base64');

async function main() {
  const [ops, hr, disp, admin] = await Promise.all(['ops', 'hr', 'dispatcher', 'admin'].map(login));
  const chiefDemo = await login('chief'); // a demo account with no employee behind it
  const medT = (await prisma.leaveType.findUniqueOrThrow({ where: { name: 'Medical leave' } })).id;
  const annualT = (await prisma.leaveType.findUniqueOrThrow({ where: { name: 'Annual leave' } })).id;

  // ---------------- world: base PRT, unit type with its own qualification
  const rigP = await prisma.qualification.create({ data: { name: 'Rig-P' } });
  const ut = await prisma.unitType.create({ data: { name: 'Rig Portal', colorKey: 'amber' } });
  const pos = async (n: string) => prisma.position.findUniqueOrThrow({ where: { name: n } });
  const [chiefP, opP] = await Promise.all([pos('Chief of Unit'), pos('Field Operator')]);
  await prisma.crewTemplateSeat.createMany({ data: [
    { unitTypeId: ut.id, positionId: chiefP.id, count: 1, requiredQualId: rigP.id },
    { unitTypeId: ut.id, positionId: opP.id, count: 3, requiredQualId: rigP.id },
  ] });
  const base = (await call('POST', '/bases', ops, { code: 'PRT', name: 'Portal Base' })).json;
  const site = (await call('POST', '/sites', ops, { name: 'PRT-W1', baseId: base.id, travelHours: 3 })).json;
  const u1 = (await call('POST', '/units', ops, { code: 'HL-PT1', unitTypeId: ut.id, homeBaseId: base.id })).json;
  const j = (await call('POST', '/jobs', disp, { wellName: 'PW-9', rigName: 'RIG 9', siteId: site.id, serviceType: 'Rig Portal', plannedStart: at(-5), plannedEnd: at(40) })).json;
  await call('POST', `/jobs/${j.id}/deploy`, disp, { unitId: u1.id });
  const seats = await prisma.seat.findMany({ where: { unitId: u1.id }, include: { position: true } });
  const seat = (p: string, i = 1) => seats.find(s => s.position.name === p && s.index === i)!;

  const P = (position: string, level: 'JUNIOR' | 'EXPERIENCED', quals = ['Rig-P'], offset = -2) => mkEmployee({ position, level, quals, base: 'PRT', anchorOffset: offset });
  const emp = { C: await P('Chief of Unit', 'EXPERIENCED'), O1: await P('Field Operator', 'EXPERIENCED'), O2: await P('Field Operator', 'JUNIOR'), O3: await P('Field Operator', 'JUNIOR'), R: await P('Field Operator', 'JUNIOR', ['Rig-P'], 20) };
  const mech = await P('Mechanic', 'JUNIOR', ['Heavy vehicle mechanics']), mech2 = await P('Mechanic', 'JUNIOR', ['Heavy vehicle mechanics']);
  const tok: Record<string, string> = {};
  for (const [k, e] of Object.entries({ ...emp, M: mech, M2: mech2 })) tok[k] = await login((await mkUser(e.id, [{ role: 'EMPLOYEE' }], `p-${k.toLowerCase()}-${Date.now() % 1e5}`)).login);
  const live = (e: { id: string }, s: { id: string }, a: number, b: number, status: 'ACTIVE' | 'CONFIRMED' = 'ACTIVE') =>
    prisma.assignment.create({ data: { employeeId: e.id, seatId: s.id, start: new Date(today.getTime() + a * DAY), plannedEnd: new Date(today.getTime() + b * DAY), status } });
  await live(emp.C, seat('Chief of Unit'), -5, 20);
  const aO1 = await live(emp.O1, seat('Field Operator', 1), -5, 20);
  const aO2 = await live(emp.O2, seat('Field Operator', 2), -5, 20);
  const aO3 = await live(emp.O3, seat('Field Operator', 3), -5, 20);
  await live(emp.R, seat('Field Operator', 2), 21, 35, 'CONFIRMED'); // follows O2
  // The next rotation (everyone is on again from day 54): upcoming stretches that can be swapped.
  const fC = await live(emp.C, seat('Chief of Unit'), 54, 60, 'CONFIRMED');
  const fO2 = await live(emp.O2, seat('Field Operator', 2), 54, 60, 'CONFIRMED');
  const fO3 = await live(emp.O3, seat('Field Operator', 3), 54, 60, 'CONFIRMED');

  // ================= portal: today =================
  check('an account without an employee gets a clear error', (await call('GET', '/portal/today', chiefDemo)).status === 400);
  check('unauthenticated => 401', (await call('GET', '/portal/today')).status === 401);
  const t2 = (await call('GET', '/portal/today', tok.O2)).json;
  check('today: status ON_UNIT with the seat, unit type, job and travel time', t2.status.status === 'ON_UNIT' && t2.seat.label === 'HL-PT1 · Field Operator #2' && t2.seat.unit.type === 'Rig Portal' && t2.seat.job.well === 'PW-9' && t2.seat.job.travelHours === 3, t2);
  check('today: crew mates and the chief as supervisor', t2.team.length === 3 && t2.supervisor?.role === 'Chief of Unit' && t2.supervisor.name.includes(emp.C.firstName), { team: t2.team, sup: t2.supervisor });
  check('today: who replaces me and when', t2.replacement.replacedBy?.name.includes(emp.R.firstName) && t2.replacement.replacedBy.from === day(at(21)), t2.replacement);
  check('today: my next crew change is the day after my stretch ends', t2.nextCrewChange.date === day(at(21)), t2.nextCrewChange);
  check('today: next days off is known', !!t2.nextDaysOff, t2.nextDaysOff);
  const tR = (await call('GET', '/portal/today', tok.R)).json;
  check('an upcoming person sees their coming seat and whom they replace', tR.seat?.upcoming === true && tR.seat.label.includes('Operator #2') && tR.replacement.replacing?.name.includes(emp.O2.firstName), tR);
  check('the portal never exposes anyone else\'s medical details', !JSON.stringify(t2).toLowerCase().includes('medical'));

  // ================= an employee never sees other people's schedules =================
  const mineList = (await call('GET', '/assignments?limit=200', tok.O1)).json;
  check('assignments list is limited to my own for employees (even when asking for others)', mineList.items.length === 1 && mineList.items.every((a: any) => a.employee.id === emp.O1.id), mineList.items.map((a: any) => a.employee.id));
  const asked = (await call('GET', `/assignments?employeeId=${emp.O2.id}&unitId=${u1.id}`, tok.O1)).json;
  check('…and cannot widen it by filtering', asked.items.every((a: any) => a.employee.id === emp.O1.id));
  check('the seat grid is not available to employees', (await call('GET', `/seats?unitId=${u1.id}`, tok.O1)).status === 403);

  // ================= stats & profile =================
  const st = (await call('GET', '/portal/stats', tok.O1)).json;
  check('stats: field days this year counted from the assignment (6 days: -5..today)', st.fieldDaysYear === 6 && st.year === today.getUTCFullYear() && st.extensionDaysYear === 0 && st.annualLeave.entitled === 30 && st.daysOffBalance === 0, st);
  const pr = await call('GET', '/portal/profile', tok.O1);
  check('profile: contact, qualifications and certificates with validity', pr.json.qualifications.some((q: any) => q.name === 'Rig-P') && pr.json.certifications.length > 0 && pr.json.certifications.every((c: any) => c.validity === 'valid'), pr.json);
  const upd = await call('PUT', '/portal/profile', tok.O1, { phone: '0555123456', emergencyContact: 'Sister 0555999888', position: 'Chief of Unit', hireDate: '2000-01-01' });
  check('profile: contact details can be edited', upd.status === 200 && upd.json.phone === '0555123456' && upd.json.emergencyContact.includes('Sister'), upd.json);
  check('profile: other fields are ignored, not applied', upd.json.position === 'Field Operator' && upd.json.hireDate !== '2000-01-01');
  check('profile: nothing editable => 400', (await call('PUT', '/portal/profile', tok.O1, { position: 'Chief of Unit' })).status === 400);
  check('profile: bad email refused', (await call('PUT', '/portal/profile', tok.O1, { email: 'not-an-email' })).status === 400);
  check('profile edits are audited', (await prisma.auditLog.count({ where: { entityId: emp.O1.id, action: 'profile_update' } })) >= 1);

  // ================= files and certificates =================
  const up = await call('POST', '/files', tok.O1, { name: 'certificate.pdf', mime: 'application/pdf', kind: 'medical', dataBase64: PDF });
  check('upload a medical certificate', up.status === 201 && up.json.url.startsWith('files/'), up.json);
  check('unsupported file types are refused', (await call('POST', '/files', tok.O1, { name: 'x.exe', mime: 'application/x-msdownload', dataBase64: PDF })).status === 400);
  check('empty or missing data is refused', (await call('POST', '/files', tok.O1, { name: 'x.pdf', mime: 'application/pdf', dataBase64: '' })).status === 400);
  const big = Buffer.alloc(8.5 * 1024 * 1024, 1).toString('base64');
  check('files over 8 MB are refused', (await call('POST', '/files', tok.O1, { name: 'big.pdf', mime: 'application/pdf', dataBase64: big })).status === 400);
  const raw = async (id: string, t: string) => fetch(`${process.env.API ?? 'http://localhost:3000'}/files/${id}`, { headers: { authorization: `Bearer ${t}` } });
  const own = await raw(up.json.id, tok.O1);
  check('the owner can open their certificate (right type, same bytes)', own.status === 200 && own.headers.get('content-type') === 'application/pdf' && Buffer.from(await own.arrayBuffer()).toString('base64') === PDF);
  check('HR can open it', (await raw(up.json.id, hr)).status === 200);
  check('ops can open it', (await raw(up.json.id, ops)).status === 200);
  check('a dispatcher cannot', (await raw(up.json.id, disp)).status === 403);
  check('another employee cannot', (await raw(up.json.id, tok.O2)).status === 403);
  check('opening someone else\'s medical file is logged', (await prisma.auditLog.count({ where: { entity: 'File', entityId: up.json.id, action: 'medical_view' } })) >= 2);
  check('unauthenticated cannot open it', (await fetch(`${process.env.API ?? 'http://localhost:3000'}/files/${up.json.id}`)).status === 401);
  check('unknown file => 404', (await raw('00000000-0000-0000-0000-000000000000', hr)).status === 404);
  const gen = await call('POST', '/files', tok.O1, { name: 'training.png', mime: 'image/png', dataBase64: Buffer.from('png').toString('base64') });
  check('a general file: staff can open, other employees cannot', (await raw(gen.json.id, disp)).status === 200 && (await raw(gen.json.id, tok.O2)).status === 403);
  // submit a medical leave with that certificate from the portal, then HR validates it
  const sub = await call('POST', '/leaves', tok.O1, { typeId: medT, start: at(30), end: at(32), documentUrl: up.json.url });
  check('medical leave submitted with the uploaded certificate', sub.status === 201 && sub.json.leave.status === 'SUBMITTED', sub.json);
  check('HR validates it', (await call('POST', `/leaves/${sub.json.leave.id}/approve`, hr)).status === 201);
  // HR uploads a certificate on behalf of another employee: that employee can open it because it is attached to their leave
  const hrUp = await call('POST', '/files', hr, { name: 'phone-call.pdf', mime: 'application/pdf', kind: 'medical', dataBase64: PDF });
  const onBehalf = await call('POST', '/leaves', hr, { employeeId: emp.O3.id, typeId: medT, start: at(25), end: at(26), documentUrl: hrUp.json.url });
  check('HR records a sick call with a certificate on someone\'s behalf', onBehalf.status === 201, onBehalf.json);
  check('that employee can open the certificate HR uploaded for them', (await raw(hrUp.json.id, tok.O3)).status === 200);
  check('a different employee still cannot', (await raw(hrUp.json.id, tok.O2)).status === 403);

  // ================= swaps =================
  const cand = await call('GET', `/swaps/candidates?assignmentId=${fO2.id}`, tok.O2);
  check('swap candidates: upcoming, same position, someone else, overlapping', cand.status === 200 && cand.json.some((c: any) => c.assignmentId === fO3.id) && !cand.json.some((c: any) => c.assignmentId === fO2.id) && !cand.json.some((c: any) => c.seat.includes('Chief')), cand.json);
  check('cannot list candidates for someone else\'s assignment', (await call('GET', `/swaps/candidates?assignmentId=${fO2.id}`, tok.O3)).status === 403);
  check('a running assignment cannot be swapped: no candidates, and a request is refused with advice', (await call('GET', `/swaps/candidates?assignmentId=${aO2.id}`, tok.O2)).json.length === 0 && (await call('POST', '/swaps', tok.O2, { requesterAssignmentId: aO2.id, colleagueAssignmentId: aO3.id })).status === 400);
  check('cannot swap with yourself', (await call('POST', '/swaps', tok.O2, { requesterAssignmentId: fO2.id, colleagueAssignmentId: fO2.id })).status === 400);
  check('cannot offer someone else\'s assignment', (await call('POST', '/swaps', tok.O2, { requesterAssignmentId: aO1.id, colleagueAssignmentId: fO3.id })).status === 403);
  const bad = await call('POST', '/swaps', tok.O2, { requesterAssignmentId: fO2.id, colleagueAssignmentId: fC.id });
  check('a swap that would break a rule is refused up front (422 with the reason)', bad.status === 422 && bad.json.violations.length > 0, bad.json);
  const sw = await call('POST', '/swaps', tok.O2, { requesterAssignmentId: fO2.id, colleagueAssignmentId: fO3.id, note: 'Family event' });
  check('swap requested', sw.status === 201 && sw.json.status === 'PENDING', sw.json);
  check('a second request on the same assignment is refused', (await call('POST', '/swaps', tok.O3, { requesterAssignmentId: fO3.id, colleagueAssignmentId: fO2.id })).status === 409);
  const o3Box = (await call('GET', '/notifications', tok.O3)).json;
  check('the colleague is notified', o3Box.items.some((n: any) => n.type === 'swap_requested' && n.payload.stage === 'colleague'), o3Box.items.map((n: any) => n.type));
  check('only the colleague can answer', (await call('POST', `/swaps/${sw.json.id}/respond`, tok.O1, { accept: true })).status === 403 && (await call('POST', `/swaps/${sw.json.id}/respond`, tok.O2, { accept: true })).status === 403);
  check('the manager cannot decide before the colleague accepts', (await call('POST', `/swaps/${sw.json.id}/decide`, disp, { approve: true })).status === 400);
  const mine = (await call('GET', '/swaps', tok.O3)).json;
  check('the colleague sees the request and may respond', mine.length === 1 && mine[0].canRespond && mine[0].requester.name.includes(emp.O2.firstName) && mine[0].a.seat.includes('Operator #2'), mine);
  check('the colleague accepts', (await call('POST', `/swaps/${sw.json.id}/respond`, tok.O3, { accept: true })).json.status === 'ACCEPTED');
  const mgr = (await call('GET', '/swaps', disp)).json;
  check('managers now see it waiting for a decision', mgr.some((s: any) => s.id === sw.json.id && s.canDecide));
  check('managers are notified', (await call('GET', '/notifications', ops)).json.items.some((n: any) => n.type === 'swap_requested' && n.payload.stage === 'manager'));
  check('an employee cannot decide', (await call('POST', `/swaps/${sw.json.id}/decide`, tok.O1, { approve: true })).status === 403);
  check('rejecting needs a reason', (await call('POST', `/swaps/${sw.json.id}/decide`, disp, { approve: false })).status === 400);
  const ap = await call('POST', `/swaps/${sw.json.id}/decide`, disp, { approve: true, note: 'Fine' });
  check('the manager approves and the two people change seats', ap.status === 201 && ap.json.status === 'APPROVED', ap.json);
  const [r2, r3] = await Promise.all([prisma.assignment.findUniqueOrThrow({ where: { id: fO2.id } }), prisma.assignment.findUniqueOrThrow({ where: { id: fO3.id } })]);
  check('assignments were exchanged', r2.employeeId === emp.O3.id && r3.employeeId === emp.O2.id);
  check('both people are told the decision', (await call('GET', '/notifications', tok.O2)).json.items.some((n: any) => n.type === 'swap_decided' && n.title.includes('approved')) && (await call('GET', '/notifications', tok.O3)).json.items.some((n: any) => n.type === 'swap_decided'));
  check('the stretch that is running now is untouched', (await call('GET', '/portal/today', tok.O2)).json.seat.label.includes('Operator #2'));
  check('an approved request cannot be decided again', (await call('POST', `/swaps/${sw.json.id}/decide`, disp, { approve: false, note: 'x' })).status === 400);

  const sw2 = await call('POST', '/swaps', tok.O2, { requesterAssignmentId: fO3.id, colleagueAssignmentId: fO2.id });
  check('a second swap: the colleague declines', (await call('POST', `/swaps/${sw2.json.id}/respond`, tok.O3, { accept: false, note: 'Sorry, no' })).json.status === 'DECLINED');
  check('the requester hears it was declined, with the note', (await call('GET', '/notifications', tok.O2)).json.items.some((n: any) => n.type === 'swap_decided' && n.body.includes('Sorry')));
  const sw3 = await call('POST', '/swaps', tok.O2, { requesterAssignmentId: fO3.id, colleagueAssignmentId: fO2.id });
  check('a request can be cancelled by its author only', (await call('POST', `/swaps/${sw3.json.id}/cancel`, tok.O3)).status === 403 && (await call('POST', `/swaps/${sw3.json.id}/cancel`, tok.O2)).json.status === 'CANCELLED');
  const sw4 = await call('POST', '/swaps', tok.O2, { requesterAssignmentId: fO3.id, colleagueAssignmentId: fO2.id });
  await call('POST', `/swaps/${sw4.json.id}/respond`, tok.O3, { accept: true });
  check('a manager can reject with a reason', (await call('POST', `/swaps/${sw4.json.id}/decide`, ops, { approve: false, note: 'Crew stability' })).json.status === 'REJECTED');
  const sw5 = await call('POST', '/swaps', tok.O2, { requesterAssignmentId: fO3.id, colleagueAssignmentId: fO2.id });
  await call('POST', `/swaps/${sw5.json.id}/respond`, tok.O3, { accept: true });
  await prisma.leave.create({ data: { employeeId: emp.O3.id, typeId: annualT, start: new Date(today.getTime() + 55 * DAY), end: new Date(today.getTime() + 57 * DAY), status: 'APPROVED' } });
  const stale = await call('POST', `/swaps/${sw5.json.id}/decide`, disp, { approve: true });
  check('approval re-checks the rules: leave booked meanwhile blocks it (422)', stale.status === 422 && stale.json.violations.some((v: any) => v.rule === 'availability'), stale.json);

  // ================= work orders =================
  const woBad = await call('POST', '/work-orders', tok.M, { unitId: u1.id, type: 'corrective', expectedReturn: at(5) });
  check('a mechanic cannot create work orders', woBad.status === 403);
  check('type and dates are validated', (await call('POST', '/work-orders', ops, { unitId: u1.id, type: 'magic', expectedReturn: at(5) })).status === 400 && (await call('POST', '/work-orders', ops, { unitId: u1.id, type: 'corrective', plannedStart: at(5), expectedReturn: at(2) })).status === 400);
  const wo = await call('POST', '/work-orders', ops, { unitId: u1.id, type: 'corrective', priority: 'high', description: 'Winch repair', expectedReturn: at(5), assigneeIds: [mech.id] });
  check('ops opens a work order for the unit with a mechanic', wo.status === 201 && wo.json.status === 'OPEN' && wo.json.assignees[0].id === mech.id && wo.json.base.code === 'PRT', wo.json);
  check('the unit is now under maintenance on the board data', (await call('GET', `/units?baseId=${base.id}`, disp)).json.items.find((u: any) => u.code === 'HL-PT1').status === 'UNDER_MAINTENANCE');
  const mine1 = (await call('GET', '/work-orders?mine=true', tok.M)).json;
  check('the mechanic sees the task in the portal list', mine1.total === 1 && mine1.items[0].description === 'Winch repair');
  check('another mechanic sees none', (await call('GET', '/work-orders', tok.M2)).json.total === 0);
  check('a mechanic cannot open someone else\'s task', (await call('GET', `/work-orders/${wo.json.id}`, tok.M2)).status === 403);
  check('the assignee was told about the new task', (await call('GET', '/notifications', tok.M)).json.items.some((n: any) => n.title.includes('HL-PT1')));
  check('an unassigned mechanic cannot change status', (await call('POST', `/work-orders/${wo.json.id}/status`, tok.M2, { status: 'DONE' })).status === 403);
  check('the assigned mechanic cannot edit details', (await call('PUT', `/work-orders/${wo.json.id}`, tok.M, { description: 'x' })).status === 403);
  check('the mechanic starts work', (await call('POST', `/work-orders/${wo.json.id}/status`, tok.M, { status: 'IN_PROGRESS' })).json.status === 'IN_PROGRESS');
  check('waiting for parts, then back in progress', (await call('POST', `/work-orders/${wo.json.id}/status`, tok.M, { status: 'WAITING_PARTS' })).json.status === 'WAITING_PARTS' && (await call('POST', `/work-orders/${wo.json.id}/status`, tok.M, { status: 'IN_PROGRESS' })).json.status === 'IN_PROGRESS');
  check('invalid transitions are refused', (await call('POST', `/work-orders/${wo.json.id}/status`, tok.M, { status: 'OPEN' })).status === 400 && (await call('POST', `/work-orders/${wo.json.id}/status`, tok.M, { status: 'sleeping' })).status === 400);
  const upd2 = await call('PUT', `/work-orders/${wo.json.id}`, ops, { priority: 'urgent', assigneeIds: [mech.id, mech2.id] });
  check('ops can edit details and add a second mechanic', upd2.status === 200 && upd2.json.priority === 'urgent' && upd2.json.assignees.length === 2, upd2.json);
  const done = await call('POST', `/work-orders/${wo.json.id}/status`, tok.M, { status: 'DONE' });
  check('finishing the last open order brings the unit back', done.status === 201 && done.json.unitBack === true, done.json);
  check('the unit is no longer under maintenance', (await call('GET', `/units?baseId=${base.id}`, disp)).json.items.find((u: any) => u.code === 'HL-PT1').status === 'DEPLOYED');
  check('dispatchers are told the unit is back', (await call('GET', '/notifications?limit=200', disp)).json.items.some((n: any) => n.type === 'unit_back' && n.payload.unit === 'HL-PT1'));
  check('a finished work order cannot be edited or reopened', (await call('PUT', `/work-orders/${wo.json.id}`, ops, { priority: 'low' })).status === 400 && (await call('POST', `/work-orders/${wo.json.id}/status`, ops, { status: 'IN_PROGRESS' })).status === 400);
  check('ops sees all work orders for the base', (await call('GET', `/work-orders?baseId=${base.id}`, ops)).json.total === 1);
  void admin;

  await finish();
}
main().catch(e => { console.error(e); process.exit(1); });
