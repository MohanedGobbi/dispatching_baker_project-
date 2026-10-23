// Live smoke test for E12-E14: leave, medical leave, clearance, restrictions, extensions, days-off balance.
// Usage: tsx scripts/smoke-leave.ts   (API running on a throwaway DATA_DIR, freshly seeded)
// One user: the manager enters every leave, so it is in effect at once (medical and absence RECORDED, the rest APPROVED).
import '../src/env';
import { at, call, check, day, DAY, finish, login, mkEmployee, prisma, today } from './lib';

async function main() {
  const [admin, ops, hr, disp] = await Promise.all(['admin', 'ops', 'hr', 'dispatcher'].map(login));
  const type = async (name: string) => (await prisma.leaveType.findUniqueOrThrow({ where: { name } })).id;
  const [medT, annualT, recoveryT, absenceT] = await Promise.all([type('Medical leave'), type('Annual leave'), type('Recovery days'), type('Unjustified absence')]);

  // ---- a deployed-style unit with people on it
  const ohType = await prisma.unitType.findUniqueOrThrow({ where: { name: 'Open Hole' } });
  const unit = (await call('POST', '/units', ops, { code: 'HL-L1', unitTypeId: ohType.id, homeBaseId: (await prisma.base.findUniqueOrThrow({ where: { code: 'HMD' } })).id })).json;
  const seats = await prisma.seat.findMany({ where: { unitId: unit.id }, include: { position: true } });
  const seat = (pos: string, i: number) => seats.find(s => s.position.name === pos && s.index === i)!;
  const P = await mkEmployee({ position: 'Field Operator', level: 'JUNIOR', quals: ['Open Hole'], base: 'HMD' });
  const Q = await mkEmployee({ position: 'Field Operator', level: 'JUNIOR', quals: ['Open Hole'], base: 'HMD' });
  const R = await mkEmployee({ position: 'Field Operator', level: 'JUNIOR', quals: ['Open Hole'], base: 'HMD' });
  const E = await mkEmployee({ position: 'Field Operator', level: 'EXPERIENCED', quals: ['Open Hole'], base: 'HMD' });
  const X = await mkEmployee({ position: 'Field Operator', level: 'EXPERIENCED', quals: ['Open Hole'], base: 'HMD' });
  const W = await mkEmployee({ position: 'Field Operator', level: 'JUNIOR', quals: ['Open Hole'], base: 'HMD' });
  const asg = (e: { id: string }, seatId: string, s: number, en: number) => call('POST', '/assignments', disp, { employeeId: e.id, seatId, start: at(s), end: at(en), overrideReason: 'smoke setup' });
  const pA = (await asg(P, seat('Field Operator', 2).id, 0, 20)).json.assignment;
  const qA = (await asg(Q, seat('Field Operator', 3).id, 0, 10)).json.assignment;
  const rA = (await asg(R, seat('Field Operator', 3).id, 11, 20)).json.assignment;
  check('setup: crew placed', !!pA && !!qA && !!rA, { pA, qA, rA });

  // ================= medical leave (acceptance 2, 3) =================
  const med = await call('POST', '/leaves', hr, { employeeId: P.id, typeId: medT, start: at(0), end: at(9), documentUrl: 'cert-1.pdf', notes: 'CONFIDENTIAL-NOTE' });
  check('medical leave is recorded at once => RECORDED', med.status === 201 && med.json.leave.status === 'RECORDED', med.json);
  const fx = med.json.effects.released;
  check('acceptance 2: one seat released', fx.length === 1 && fx[0].seatId === seat('Field Operator', 2).id, fx);
  const task = await prisma.replacementTask.findFirstOrThrow({ where: { sourceId: med.json.leave.id } });
  check('acceptance 2: CRITICAL replacement task for today', task.urgency === 'CRITICAL' && task.trigger === 'medical_leave' && day(task.fromDate.toISOString()) === day(at(0)) && day(task.toDate.toISOString()) === day(at(9)), task);
  const pRows = await prisma.assignment.findMany({ where: { employeeId: P.id, status: { not: 'CANCELLED' } }, orderBy: { start: 'asc' } });
  check('their assignment now starts after the leave (returns day 10)', pRows.length === 1 && day(pRows[0].start.toISOString()) === day(at(10)) && day(pRows[0].plannedEnd.toISOString()) === day(at(20)), pRows);
  const seatsNow = await call('GET', `/seats?unitId=${unit.id}`, disp);
  check('acceptance 2: seat shows empty on the board', seatsNow.json.find((s: any) => s.id === seat('Field Operator', 2).id).holder === null);
  check('status computed MEDICAL_LEAVE', (await call('GET', `/employees/${P.id}`, hr)).json.status === 'MEDICAL_LEAVE');
  const dupe = await call('POST', '/leaves', hr, { employeeId: P.id, typeId: medT, start: at(5), end: at(12), documentUrl: 'x.pdf' });
  check('overlapping leave => 409', dupe.status === 409);

  // acceptance 3: the freed seat can now be filled
  const rep = await call('POST', '/assignments', disp, { employeeId: E.id, seatId: seat('Field Operator', 2).id, start: at(0), end: at(9), type: 'REPLACEMENT' });
  check('acceptance 3: replacement can take the freed seat', rep.status === 201, rep.json);

  // ---- the manager sees everything
  const detail = await call('GET', `/leaves/${med.json.leave.id}`, hr);
  check('detail shows the certificate and notes', detail.json.documentUrl === 'cert-1.pdf' && detail.json.notes === 'CONFIDENTIAL-NOTE', detail.json);
  const list = await call('GET', `/leaves?employeeId=${P.id}`, hr);
  check('the list shows the real reason', list.json.items.some((l: any) => l.type.name === 'Medical leave'), list.json.items);
  check('nobody needs a sign-in', (await call('GET', '/leaves')).status === 200);

  // ---- a sick call before the certificate arrives
  const sub = await call('POST', '/leaves', hr, { employeeId: Q.id, typeId: medT, start: at(16), end: at(18) });
  check('medical leave without a certificate is recorded, with a reminder', sub.status === 201 && sub.json.leave.status === 'RECORDED' && sub.json.warnings.some((w: string) => w.includes('Certificate')), sub.json);
  // A request left waiting by the old employee portal can still be decided.
  const waiting = await prisma.leave.create({ data: { employeeId: Q.id, typeId: medT, start: new Date(today.getTime() + 22 * DAY), end: new Date(today.getTime() + 24 * DAY), status: 'SUBMITTED', documentUrl: 'self-cert.pdf' } });
  const val = await call('POST', `/leaves/${waiting.id}/approve`, hr);
  check('a waiting medical request is validated => RECORDED', val.status === 201 && val.json.status === 'RECORDED', val.json);

  // ---- extension of medical leave + long-term flag
  check('extend needs a new certificate', (await call('POST', `/leaves/${med.json.leave.id}/extend`, hr, { newEnd: at(14) })).status === 400);
  const ext = await call('POST', `/leaves/${med.json.leave.id}/extend`, hr, { newEnd: at(14), documentUrl: 'cert-2.pdf' });
  check('medical leave extended; only added days free more seats', ext.status === 201 && ext.json.end === day(at(14)), ext.json);
  const lt = await call('POST', '/leaves', hr, { employeeId: W.id, typeId: medT, start: at(1), end: at(45), documentUrl: 'long.pdf' });
  check('45-day medical leave is flagged long-term', lt.status === 201 && lt.json.leave.longTerm === true, lt.json);

  // ================= clearance & restrictions (acceptance 4) =================
  await prisma.leave.create({ data: { employeeId: X.id, typeId: medT, start: new Date(today.getTime() - 40 * DAY), end: new Date(today.getTime() - 20 * DAY), status: 'RECORDED' } });
  await prisma.assignment.create({ data: { employeeId: X.id, seatId: seat('Field Operator', 1).id, start: today, plannedEnd: new Date(today.getTime() + 10 * DAY), status: 'ACTIVE' } });
  const short = await prisma.leave.create({ data: { employeeId: Q.id, typeId: medT, start: new Date(today.getTime() - 30 * DAY), end: new Date(today.getTime() - 28 * DAY), status: 'RECORDED' } });
  check('after a long medical leave ends: AWAITING_CLEARANCE', (await call('GET', `/employees/${X.id}`, hr)).json.status === 'AWAITING_CLEARANCE');
  const queue = await call('GET', '/leaves/clearance/queue', hr);
  check('clearance queue lists X, not the short leave', queue.status === 200 && queue.json.some((r: any) => r.employee.id === X.id) && !queue.json.some((r: any) => r.leaveId === short.id), queue.json);
  const xLeave = (await prisma.leave.findFirstOrThrow({ where: { employeeId: X.id } })).id;
  check('invalid restriction kind rejected', (await call('POST', `/leaves/${xLeave}/clearance`, hr, { restriction: { kind: 'nope' } })).status === 400);
  const clr = await call('POST', `/leaves/${xLeave}/clearance`, hr, { restriction: { kind: 'base_only', end: at(14) } });
  check('acceptance 4: cleared with base_only restriction', clr.status === 201 && clr.json.restriction.kind === 'base_only', clr.json);
  check('restriction frees X\'s unit seat with a HIGH task', clr.json.released.length === 1 && (await prisma.replacementTask.findFirstOrThrow({ where: { sourceId: clr.json.restriction.id } })).urgency === 'HIGH', clr.json.released);
  check('X is no longer awaiting clearance', (await call('GET', `/employees/${X.id}`, hr)).json.status !== 'AWAITING_CLEARANCE');
  check('cannot clear twice', (await call('POST', `/leaves/${xLeave}/clearance`, hr, {})).status === 400);
  const pv = await call('POST', '/assignments/preview', disp, { employeeId: X.id, seatId: seat('Field Operator', 1).id, start: at(5), end: at(12) });
  check('acceptance 4: engine/validator refuses X for unit seats', pv.json.violations.some((v: any) => v.rule === 'restriction'), pv.json.violations);
  const rs = await call('POST', `/employees/${X.id}/restrictions`, hr, { kind: 'no_night' });
  check('manager adds a restriction', rs.status === 201 && rs.json.released.length === 0, rs.json);
  check('end a restriction', (await call('DELETE', `/employees/${X.id}/restrictions/${rs.json.restriction.id}`, hr)).status === 200);
  check('ending twice is rejected', (await call('DELETE', `/employees/${X.id}/restrictions/${rs.json.restriction.id}`, hr)).status === 400);

  // ================= other leave types =================
  const ann = await call('POST', '/leaves', hr, { employeeId: Q.id, typeId: annualT, start: at(30), end: at(36) });
  check('annual leave entered by the manager => APPROVED', ann.status === 201 && ann.json.leave.status === 'APPROVED', ann.json);
  check('an approved leave cannot be rejected', (await call('POST', `/leaves/${ann.json.leave.id}/reject`, hr, { reason: 'x' })).status === 400);
  const bal0 = await call('GET', `/leaves/balance/${Q.id}`, hr);
  check('annual entitlement tracked (30 - 7 = 23)', bal0.json.annualLeave.taken === 7 && bal0.json.annualLeave.remaining === 23, bal0.json.annualLeave);
  const can1 = await call('POST', `/leaves/${ann.json.leave.id}/cancel`, hr, { reason: 'plans changed' });
  check('cancel approved leave', can1.status === 201 && can1.json.status === 'CANCELLED');
  check('cancelled leave frees the entitlement', (await call('GET', `/leaves/balance/${Q.id}`, hr)).json.annualLeave.taken === 0);
  const V = await mkEmployee({ position: 'Field Operator', level: 'JUNIOR', quals: ['Open Hole'], base: 'HMD' });
  const abs = await call('POST', '/leaves', hr, { employeeId: V.id, typeId: absenceT, start: at(1), end: at(1) });
  check('unjustified absence is recorded at once', abs.status === 201 && abs.json.leave.status === 'RECORDED', abs.json);
  check('no recovery days without balance', (await call('POST', '/leaves', hr, { employeeId: Q.id, typeId: recoveryT, start: at(40), end: at(41) })).status === 400);

  // returning early
  const ann2 = await call('POST', '/leaves', hr, { employeeId: W.id, typeId: annualT, start: at(60), end: at(70) });
  check('leave entered for someone => approved directly', ann2.json.leave.status === 'APPROVED', ann2.json);
  check('return early shortens the leave', (await call('POST', `/leaves/${ann2.json.leave.id}/return-early`, hr, { lastDay: at(63) })).json.end === day(at(63)));
  check('return-early after the end rejected', (await call('POST', `/leaves/${ann2.json.leave.id}/return-early`, hr, { lastDay: at(80) })).status === 400);

  // overlap warnings (12.4)
  for (const n of [0, 1, 2]) {
    const e = await mkEmployee({ position: 'Mechanic', level: 'JUNIOR', quals: ['Heavy vehicle mechanics'], base: 'INA' });
    await call('POST', '/leaves', hr, { employeeId: e.id, typeId: annualT, start: at(100 + n), end: at(103 + n) });
  }
  const ov = await call('GET', `/leaves/overlaps?baseId=${(await prisma.base.findUniqueOrThrow({ where: { code: 'INA' } })).id}&from=${at(98)}&weeks=3`, disp);
  check('overlap warning: 3 mechanics off in the same week', ov.json.warnings.some((w: any) => w.people >= 3 && w.profile.startsWith('Mechanic')), ov.json);

  // aggregate-only medical stats
  const st = await call('GET', '/leaves/stats/medical', hr);
  check('medical stats are aggregated, no individuals', st.status === 200 && st.json.length > 0 && !st.text.includes('Smoke') && !st.text.includes('employee'), st.text.slice(0, 200));

  // ================= extensions & balance (acceptance 8) =================
  const reqE = await call('POST', '/extensions', disp, { assignmentId: qA.id, days: 2, reason: 'no_replacement' });
  check('extension requested', reqE.status === 201 && !reqE.json.needsOverride, reqE.json);
  check('duplicate pending request => 409', (await call('POST', '/extensions', disp, { assignmentId: qA.id, days: 1, reason: 'urgent_job' })).status === 409);
  check('invalid reason rejected', (await call('POST', '/extensions', disp, { assignmentId: qA.id, days: 1, reason: 'bored' })).status === 400);
  const app1 = await call('POST', `/extensions/${reqE.json.extension.id}/approve`, ops, {});
  check('successor on the seat blocks the extension (409)', app1.status === 409, app1.json);
  // an open replacement task for the days we are about to cover
  await prisma.replacementTask.create({ data: { seatId: seat('Field Operator', 3).id, fromDate: new Date(today.getTime() + 11 * DAY), toDate: new Date(today.getTime() + 12 * DAY), trigger: 'leave', urgency: 'NORMAL' } });
  const app2 = await call('POST', `/extensions/${reqE.json.extension.id}/approve`, ops, { shiftSuccessor: true });
  check('acceptance 8: approved with shiftSuccessor; balance +2', app2.status === 201 && app2.json.balanceChange === 2 && app2.json.newEnd === day(at(12)), app2.json);
  const qNow = await prisma.assignment.findUniqueOrThrow({ where: { id: qA.id } });
  const rNow = await prisma.assignment.findUniqueOrThrow({ where: { id: rA.id } });
  check('assignment extended, original end remembered, successor delayed', day(qNow.plannedEnd.toISOString()) === day(at(12)) && day(qNow.originalEnd!.toISOString()) === day(at(10)) && day(rNow.start.toISOString()) === day(at(13)), { qNow, rNow });
  check('the matching replacement task was closed', (await prisma.replacementTask.count({ where: { seatId: seat('Field Operator', 3).id, trigger: 'leave', status: 'CLOSED' } })) === 1);
  check('days beyond the original end show as EXTENDED', (await call('GET', `/employees/${Q.id}?date=${at(11)}`, hr)).json.status === 'EXTENDED');
  check('balance now +2', (await call('GET', `/leaves/balance/${Q.id}`, hr)).json.daysOffBalance === 2);

  // limits: used 2 of 7 per rotation; asking 6 more breaches
  const big = await call('POST', '/extensions', disp, { assignmentId: qA.id, days: 9, reason: 'urgent_job' });
  check('request beyond limit is flagged', big.status === 201 && big.json.needsOverride && big.json.breaches.length >= 1, big.json);
  const noOv = await call('POST', `/extensions/${big.json.extension.id}/approve`, ops, { shiftSuccessor: true });
  check('approving beyond the limit needs an override reason (422)', noOv.status === 422 && noOv.json.breaches.length >= 1, noOv.json);
  // the successor now starts day 13 and ends day 20; 9 more days would swallow it entirely => safe-guard
  const ov2 = await call('POST', `/extensions/${big.json.extension.id}/approve`, ops, { shiftSuccessor: true, overrideReason: 'Rig move delayed' });
  check('extension that would swallow the incoming assignment is refused', ov2.status === 409, ov2.json);
  check('reject needs a reason', (await call('POST', `/extensions/${big.json.extension.id}/reject`, ops, {})).status === 400);
  check('reject', (await call('POST', `/extensions/${big.json.extension.id}/reject`, ops, { reason: 'Replacement arrives' })).json.status === 'REJECTED');

  // balance mechanics
  check('adjustment needs a note', (await call('POST', '/extensions/balance-adjust', ops, { employeeId: Q.id, days: 3 })).status === 400);
  check('adjustment +3', (await call('POST', '/extensions/balance-adjust', ops, { employeeId: Q.id, days: 3, note: 'Manual credit' })).status === 201);
  const rank = await call('GET', '/extensions/balances', ops);
  check('balance ranking puts Q first with 5', rank.json[0]?.id === Q.id && rank.json[0].balance === 5, rank.json?.slice?.(0, 2));
  const rec = await call('POST', '/leaves', hr, { employeeId: Q.id, typeId: recoveryT, start: at(50), end: at(52) });
  check('recovery days now allowed (balance 5, asking 3)', rec.status === 201 && rec.json.leave.status === 'APPROVED', rec.json);
  check('recovery days consume the balance (5 - 3 = 2)', (await call('GET', `/leaves/balance/${Q.id}`, hr)).json.daysOffBalance === 2);
  check('cancelling restores the balance', (await call('POST', `/leaves/${rec.json.leave.id}/cancel`, hr, {})).status === 201 && (await call('GET', `/leaves/balance/${Q.id}`, hr)).json.daysOffBalance === 5);

  const rep2 = await call('GET', '/extensions/report?groupBy=reason', ops);
  check('extension report by reason', rep2.status === 200 && rep2.json.find((r: any) => r.key === 'no_replacement')?.days === 2, rep2.json);

  // rotation-shift policy instead of balance
  await call('PUT', '/settings/rules.shiftNextRotationOnExtension', admin, { value: true });
  const before = (await prisma.employee.findUniqueOrThrow({ where: { id: R.id } })).rotationAnchorDate!;
  const r1 = await call('POST', '/extensions', disp, { assignmentId: rA.id, days: 2, reason: 'replacement_late' });
  const r2 = await call('POST', `/extensions/${r1.json.extension.id}/approve`, ops, {});
  const after = (await prisma.employee.findUniqueOrThrow({ where: { id: R.id } })).rotationAnchorDate!;
  check('with shift policy: rotation moves, no balance owed', r2.status === 201 && r2.json.rotationShifted && r2.json.balanceChange === 0 && after.getTime() - before.getTime() === 2 * DAY, r2.json);
  await call('PUT', '/settings/rules.shiftNextRotationOnExtension', admin, { value: false });

  await finish();
}
main().catch(e => { console.error(e); process.exit(1); });
