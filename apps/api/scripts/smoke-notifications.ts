// Live smoke test for E20: notifications, acknowledgements, preferences, email outbox, broadcast, daily job.
import '../src/env';
import { at, call, check, day, DAY, finish, login, mkEmployee, mkUser, prisma, today } from './lib';

async function main() {
  const [admin, ops, hr, disp] = await Promise.all(['admin', 'ops', 'hr', 'dispatcher'].map(login));
  const bmHmd = await login('basemanager'); // scoped to HMD: must NOT hear about BRD2
  const medT = (await prisma.leaveType.findUniqueOrThrow({ where: { name: 'Medical leave' } })).id;
  const inbox = async (tok: string, q = '') => (await call('GET', `/notifications?limit=200${q}`, tok)).json;
  // People made by mkEmployee are named T<n> Smoke in every suite, so only count notifications created by this run.
  const started = new Date();
  const ofType = (box: any, type: string, f: (n: any) => boolean = () => true) => box.items.filter((n: any) => n.type === type && new Date(n.createdAt) >= started && f(n));

  // ---------------- world: base BRD2, unit type with its own qualification
  const rigN = await prisma.qualification.create({ data: { name: 'Rig-N' } });
  const ut = await prisma.unitType.create({ data: { name: 'Rig Notif', colorKey: 'green' } });
  const pos = async (n: string) => prisma.position.findUniqueOrThrow({ where: { name: n } });
  const [chiefP, opP, driverP, mechP] = await Promise.all([pos('Chief of Unit'), pos('Field Operator'), pos('Field Driver'), pos('Mechanic')]);
  await prisma.crewTemplateSeat.createMany({ data: [
    { unitTypeId: ut.id, positionId: chiefP.id, count: 1, requiredQualId: rigN.id },
    { unitTypeId: ut.id, positionId: opP.id, count: 3, requiredQualId: rigN.id },
    { unitTypeId: ut.id, positionId: driverP.id, count: 1, optional: true },
  ] });
  const base = (await call('POST', '/bases', ops, { code: 'BRD2', name: 'Notif Base' })).json;
  const site = (await call('POST', '/sites', ops, { name: 'BRD2-W1', baseId: base.id })).json;
  const u1 = (await call('POST', '/units', ops, { code: 'HL-N1', unitTypeId: ut.id, homeBaseId: base.id })).json;
  const seats = await prisma.seat.findMany({ where: { unitId: u1.id }, include: { position: true } });
  const seat = (p: string, i = 1) => seats.find(s => s.position.name === p && s.index === i)!;

  const P = (position: string, level: 'JUNIOR' | 'EXPERIENCED', offset = -2) => mkEmployee({ position, level, quals: ['Rig-N'], base: 'BRD2', anchorOffset: offset });
  const people = { C: await P('Chief of Unit', 'EXPERIENCED'), O1: await P('Field Operator', 'EXPERIENCED'), O2: await P('Field Operator', 'JUNIOR'), O3: await P('Field Operator', 'JUNIOR'), S: await P('Field Operator', 'JUNIOR') };
  for (const e of Object.values(people)) await prisma.employee.update({ where: { id: e.id }, data: { email: `${e.employeeNo.toLowerCase()}@crewboard.test` } });
  const login_: Record<string, string> = {};
  for (const [k, e] of Object.entries(people)) login_[k] = (await mkUser(e.id, [{ role: 'EMPLOYEE' }], `n-${k.toLowerCase()}-${Date.now() % 1e5}`)).login;
  const tok: Record<string, string> = {};
  for (const [k, l] of Object.entries(login_)) tok[k] = await login(l);
  const mgrEmp = await P('Mechanic', 'JUNIOR');
  const bm2 = await mkUser(mgrEmp.id, [{ role: 'BASE_MANAGER', baseScope: 'BRD2' }, { role: 'EMPLOYEE' }], `n-bm2-${Date.now() % 1e5}`);
  const bm2Tok = await login(bm2.login);

  const live = (e: { id: string }, s: { id: string }, a: number, b: number, status: 'ACTIVE' | 'CONFIRMED' = 'ACTIVE') =>
    prisma.assignment.create({ data: { employeeId: e.id, seatId: s.id, start: new Date(today.getTime() + a * DAY), plannedEnd: new Date(today.getTime() + b * DAY), status } });
  await live(people.C, seat('Chief of Unit'), -3, 20);
  const aO1 = await live(people.O1, seat('Field Operator', 1), -3, 20);
  const aO2 = await live(people.O2, seat('Field Operator', 2), -3, 20);
  const aO3 = await live(people.O3, seat('Field Operator', 3), -3, 20);

  check('unauthenticated => 401', (await call('GET', '/notifications')).status === 401);
  check('a fresh employee has an empty inbox', (await inbox(tok.O2)).total === 0);

  // ================= medical leave: who hears, and what they are not told =================
  const med = await call('POST', '/leaves', hr, { employeeId: people.O2.id, typeId: medT, start: at(0), end: at(9), documentUrl: 'x.pdf', notes: 'SECRET-DIAGNOSIS' });
  check('medical leave recorded', med.status === 201, med.json);
  const dBox = await inbox(disp);
  const unav = ofType(dBox, 'employee_unavailable', n => n.payload.employee?.includes(people.O2.firstName));
  check('dispatcher is told the person is unavailable', unav.length === 1 && unav[0].body.includes('unavailable'), unav);
  check('…without any hint of the reason (type, title, body, payload)', !JSON.stringify(unav).toLowerCase().includes('medical') && !JSON.stringify(unav).includes('SECRET'), unav);
  const bm2Box = await inbox(bm2Tok);
  check('the base manager of that base is told', ofType(bm2Box, 'employee_unavailable').length === 1);
  check('a base manager of another base is NOT told', ofType(await inbox(bmHmd), 'employee_unavailable', n => n.payload.employee?.includes(people.O2.firstName)).length === 0);
  check('the person themself is not spammed about their own leave', (await inbox(tok.O2)).total === 0);
  check('HR (the actor) does not notify themself', ofType(await inbox(hr), 'employee_unavailable', n => n.payload.employee?.includes(people.O2.firstName)).length === 0);
  check('the manager hears what is addressed to staff roles', ofType(await inbox(admin), 'employee_unavailable', n => n.payload.employee?.includes(people.O2.firstName)).length === 1);
  const crit = ofType(await inbox(disp), 'task_critical', n => n.payload.seat.includes('Operator #2') && n.payload.seat.includes('HL-N1'));
  check('critical replacement task: dispatcher told', crit.length === 1, crit);
  check('critical replacement task: ops told', ofType(await inbox(ops), 'task_critical', n => n.payload.seat.includes('HL-N1')).length === 1);

  // ================= replacement confirmed: incoming must acknowledge =================
  const task = (await call('GET', '/replacements', disp)).json.find((t: any) => t.seat.includes('HL-N1') && t.seat.includes('Operator #2'));
  const conf = await call('POST', `/replacements/${task.id}/confirm`, disp, { employeeId: people.S.id, overrideReason: 'smoke' });
  check('replacement confirmed', conf.status === 201, conf.json);
  const sBox = await inbox(tok.S);
  const rc = ofType(sBox, 'replacement_confirmed');
  check('the incoming person is told and must acknowledge', rc.length === 1 && rc[0].requiresAck === true && !rc[0].acknowledgedAt, rc);
  check('pendingAck counts it', sBox.pendingAck === 1 && sBox.unread === 1);
  check('the base manager hears about the replacement', ofType(await inbox(bm2Tok), 'replacement_confirmed').length === 1);
  check('the dispatcher who confirmed it is not notified of their own action', ofType(await inbox(disp), 'replacement_confirmed').length === 0);
  check('another base manager does not hear about it', ofType(await inbox(bmHmd), 'replacement_confirmed').length === 0);
  const ack = await call('POST', `/notifications/${rc[0].id}/acknowledge`, tok.S);
  check('acknowledge works and marks it read', ack.status === 201 && (await inbox(tok.S)).pendingAck === 0 && (await inbox(tok.S)).unread === 0);
  check('only the owner can acknowledge (404 for others)', (await call('POST', `/notifications/${rc[0].id}/acknowledge`, tok.O1)).status === 404);
  check('a notice without acknowledgement cannot be acknowledged', (await call('POST', `/notifications/${ofType(await inbox(bm2Tok), 'replacement_confirmed')[0].id}/acknowledge`, bm2Tok)).status === 400);

  // ================= extension: approval is acknowledged by the person =================
  const ext = await call('POST', '/extensions', disp, { assignmentId: aO1.id, days: 2, reason: 'no_replacement' });
  check('extension requested', ext.status === 201, ext.json);
  check('ops hears about the request', ofType(await inbox(ops), 'extension_requested', n => n.payload.extensionId === ext.json.extension.id).length === 1);
  const apr = await call('POST', `/extensions/${ext.json.extension.id}/approve`, ops, {});
  check('extension approved', apr.status === 201, apr.json);
  const o1Ext = ofType(await inbox(tok.O1), 'extension_approved');
  check('the person is told, with the new end date, and must acknowledge', o1Ext.length === 1 && o1Ext[0].requiresAck && o1Ext[0].body.includes(day(at(22))), o1Ext);
  await call('POST', `/notifications/${o1Ext[0].id}/acknowledge`, tok.O1);
  check('acknowledging the notice acknowledges the extension itself', !!(await prisma.extension.findUniqueOrThrow({ where: { id: ext.json.extension.id } })).acknowledgedAt);

  // ================= release: actor not told, acknowledgement cannot be muted =================
  await call('PUT', '/notifications/preferences', tok.O3, { inApp: { assignment_changed: false, crew_change_48h: false } });
  const prefs = (await call('GET', '/notifications/preferences', tok.O3)).json;
  const ac = prefs.types.find((t: any) => t.type === 'assignment_changed'), cc = prefs.types.find((t: any) => t.type === 'crew_change_48h');
  check('preferences: acknowledgement types are locked on; others can be muted', ac.locked && ac.inApp === true && !cc.locked && cc.inApp === false, [ac, cc]);
  check('unknown type in preferences is refused', (await call('PUT', '/notifications/preferences', tok.O3, { inApp: { nope: false } })).status === 400);
  const un = await call('POST', `/assignments/${aO3.id}/unassign`, disp, { from: at(10) });
  check('unassign works', un.status === 201, un.json);
  check('the released person still gets the acknowledgement notice even though they muted that type', ofType(await inbox(tok.O3), 'assignment_changed', n => n.payload.action === 'released' && n.requiresAck).length === 1);
  check('the dispatcher who did it gets no notice', ofType(await inbox(disp), 'assignment_changed').length === 0);

  // ================= texts (English only) =================
  const notice = ofType(await inbox(tok.S), 'replacement_confirmed')[0];
  check('texts are rendered in English', notice.title === 'Replacement confirmed' && notice.body.includes('covers'), notice);

  // ================= daily job =================
  // a crew change tomorrow on the driver seat, a clearance wait, a short base, a task due tomorrow
  const out = await P('Field Driver', 'JUNIOR'), inc = await P('Field Driver', 'JUNIOR');
  const uOut = await mkUser(out.id, [{ role: 'EMPLOYEE' }], `n-out-${Date.now() % 1e5}`), uInc = await mkUser(inc.id, [{ role: 'EMPLOYEE' }], `n-inc-${Date.now() % 1e5}`);
  await live(out, seat('Field Driver'), -10, 0);
  await live(inc, seat('Field Driver'), 1, 10, 'CONFIRMED');
  await call('PUT', '/notifications/preferences', await login(uOut.login), { inApp: { crew_change_48h: true } });
  const other = await P('Field Operator', 'JUNIOR');
  await prisma.leave.create({ data: { employeeId: other.id, typeId: medT, start: new Date(today.getTime() - 30 * DAY), end: new Date(today.getTime() - 10 * DAY), status: 'RECORDED' } });
  await call('PUT', `/bases/${base.id}/staffing/${mechP.id}`, ops, { minCount: 1, targetCount: 1 });
  await prisma.replacementTask.create({ data: { seatId: seat('Field Operator', 3).id, fromDate: new Date(today.getTime() + 1 * DAY), toDate: new Date(today.getTime() + 3 * DAY), trigger: 'leave', urgency: 'HIGH', deadline: new Date(today.getTime() + 1 * DAY) } });

  check('run-daily is for planners only', (await call('POST', '/notifications/run-daily', tok.S)).status === 403);
  const run1 = await call('POST', '/notifications/run-daily', disp);
  check('daily job ran', run1.status === 201 && run1.json.crewChanges >= 2 && run1.json.clearance >= 1 && run1.json.belowMinimum >= 1 && run1.json.escalated >= 1, run1.json);
  check('crew change: outgoing told', ofType(await inbox(await login(uOut.login)), 'crew_change_48h', n => n.payload.role === 'outgoing').length === 1);
  check('crew change: incoming told', ofType(await inbox(await login(uInc.login)), 'crew_change_48h', n => n.payload.role === 'incoming').length === 1);
  check('HR is told about the clearance wait', ofType(await inbox(hr), 'awaiting_clearance', n => n.payload.employee?.includes(other.firstName)).length === 1);
  check('base below minimum: that base manager and ops are told', ofType(await inbox(bm2Tok), 'base_below_min', n => n.payload.base === 'BRD2').length === 1 && ofType(await inbox(ops), 'base_below_min', n => n.payload.base === 'BRD2').length === 1);
  check('the HMD base manager is not told about BRD2', ofType(await inbox(bmHmd), 'base_below_min', n => n.payload.base === 'BRD2').length === 0);
  check('due task escalated and ops told', ofType(await inbox(ops), 'task_escalated', n => n.payload.seat.includes('HL-N1')).length === 1);
  const run2 = await call('POST', '/notifications/run-daily', disp);
  check('running the job again creates nothing new (de-duplicated)', run2.json.crewChanges === 0 && run2.json.clearance === 0 && run2.json.belowMinimum === 0 && run2.json.escalated === 0, run2.json);

  // ================= email outbox =================
  // S (French) asks for leave and HR decides: the decision is a type that emails by default
  const annualT = (await prisma.leaveType.findUniqueOrThrow({ where: { name: 'Annual leave' } })).id;
  const req = await call('POST', '/leaves', tok.S, { typeId: annualT, start: at(80), end: at(84) });
  await call('POST', `/leaves/${req.json.leave?.id ?? req.json.id}/approve`, hr, {});
  const outbox = await call('GET', '/notifications/outbox?limit=200', admin);
  const mail = outbox.json.filter((m: any) => m.toEmail === people.S.employeeNo.toLowerCase() + '@crewboard.test');
  check('emails are queued for types that email by default', mail.some((m: any) => m.type === 'leave_decided' && m.subject === 'Leave approved'), mail.map((m: any) => m.subject));
  check('types that do not email by default queue nothing (replacement confirmed)', !mail.some((m: any) => m.type === 'replacement_confirmed'));
  check('the extension notice was queued by email too', outbox.json.some((m: any) => m.type === 'extension_approved' && m.toEmail === people.O1.employeeNo.toLowerCase() + '@crewboard.test'));
  check('only an admin can read the outbox', (await call('GET', '/notifications/outbox', disp)).status === 403);
  await call('PUT', '/notifications/preferences', tok.O1, { email: { extension_approved: false } });

  // ================= read / unread =================
  const before = await inbox(tok.O1);
  const unreadFirst = before.items.find((n: any) => !n.readAt);
  check('unread count endpoint', (await call('GET', '/notifications/unread-count', tok.O1)).json.unread === before.unread);
  if (unreadFirst) {
    check('mark one read', (await call('POST', `/notifications/${unreadFirst.id}/read`, tok.O1)).json.updated === 1);
    check('someone else cannot mark it', (await call('POST', `/notifications/${unreadFirst.id}/read`, tok.O2)).json.updated === 0);
  }
  await call('POST', '/notifications/read-all', tok.O1);
  check('read-all clears the unread count', (await call('GET', '/notifications/unread-count', tok.O1)).json.unread === 0);
  check('the unread filter works', (await inbox(tok.O1, '&unread=true')).items.length === 0);

  // ================= broadcast =================
  check('employees cannot broadcast', (await call('POST', '/notifications/broadcast', tok.S, { title: 'x', message: 'y', all: true })).status === 403);
  check('dispatchers cannot broadcast', (await call('POST', '/notifications/broadcast', disp, { title: 'x', message: 'y', all: true })).status === 403);
  check('a broadcast needs title, message and an audience', (await call('POST', '/notifications/broadcast', ops, { title: 'x', message: 'y' })).status === 400);
  const bc = await call('POST', '/notifications/broadcast', ops, { title: 'Safety stand-down', message: 'All crews: briefing at 06:00.', baseId: base.id, ack: true });
  check('broadcast to one base reaches its employees only', bc.status === 201 && bc.json.sent >= 5, bc.json);
  const bcMsg = ofType(await inbox(tok.C), 'broadcast');
  check('recipients see title and message, and must acknowledge when asked', bcMsg.length === 1 && bcMsg[0].title === 'Safety stand-down' && bcMsg[0].body.includes('06:00') && bcMsg[0].requiresAck, bcMsg);
  check('people of other bases do not get it', ofType(await inbox(bmHmd), 'broadcast').length === 0);
  check('the sender does not get their own broadcast', ofType(await inbox(ops), 'broadcast').length === 0);

  // ================= plan published =================
  const mk2 = async (position: string, level: 'JUNIOR' | 'EXPERIENCED') => { const e = await P(position, level); const u = await mkUser(e.id, [{ role: 'EMPLOYEE' }], `n-d${Date.now() % 1e5}-${Math.random().toString(36).slice(2, 5)}`); return { e, u }; };
  const D = { chief: await mk2('Chief of Unit', 'EXPERIENCED'), o1: await mk2('Field Operator', 'EXPERIENCED'), o2: await mk2('Field Operator', 'JUNIOR'), o3: await mk2('Field Operator', 'JUNIOR') };
  const u2 = (await call('POST', '/units', ops, { code: 'HL-N2', unitTypeId: ut.id, homeBaseId: base.id })).json;
  const j = (await call('POST', '/jobs', disp, { wellName: 'NW', siteId: site.id, serviceType: 'Rig Notif', plannedStart: at(0), plannedEnd: at(20) })).json;
  await call('POST', `/jobs/${j.id}/deploy`, disp, { unitId: u2.id });
  const plan = (await call('POST', '/planning/plans', disp, { start: at(0), end: at(20), baseIds: ['BRD2'] })).json;
  const planned = new Set(plan.assignments.filter((a: any) => a.seat.startsWith('HL-N2')).map((a: any) => a.employee.id));
  check('a plan was drafted for the new unit with the free people', planned.size === 4, plan.summary?.stats);
  await call('POST', `/planning/plans/${plan.id}/submit`, disp);
  await call('POST', `/planning/plans/${plan.id}/approve`, ops, {});
  check('draft assignments notify nobody', ofType(await inbox(await login(D.chief.u.login)), 'plan_published').length === 0);
  const pub = await call('POST', `/planning/plans/${plan.id}/publish`, ops, {});
  check('plan published', pub.status === 201 && pub.json.published >= 4, pub.json);
  const dChief = ofType(await inbox(await login(D.chief.u.login)), 'plan_published');
  check('each planned person gets one acknowledgement notice naming their first assignment', dChief.length === 1 && dChief[0].requiresAck && dChief[0].payload.seat.includes('HL-N2') && dChief[0].payload.count >= 1, dChief);
  check('the publisher is not notified', ofType(await inbox(ops), 'plan_published').length === 0);

  await finish();
}
main().catch(e => { console.error(e); process.exit(1); });
