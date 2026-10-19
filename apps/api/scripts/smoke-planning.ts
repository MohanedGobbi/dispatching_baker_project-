// Live smoke test for E15-E17: planning engine, plan lifecycle, replacement center.
// Isolated: its own base (PLN), unit type and qualification, so only the people created here can crew it.
import { at, call, check, day, DAY, finish, login, mkEmployee, prisma, today } from './lib';

async function main() {
  const [admin, ops, hr, disp, bm, emp] = await Promise.all(['admin', 'ops', 'hr', 'dispatcher', 'basemanager', 'employee'].map(login));
  const leaveType = async (name: string) => (await prisma.leaveType.findUniqueOrThrow({ where: { name } })).id;
  const [medT, annualT] = await Promise.all([leaveType('Medical leave'), leaveType('Annual leave')]);

  // ---------------- world
  const rigX = await prisma.qualification.create({ data: { name: 'Rig-X' } });
  const ut = await prisma.unitType.create({ data: { name: 'Rig Test', colorKey: 'green' } });
  const pos = async (n: string) => prisma.position.findUniqueOrThrow({ where: { name: n } });
  const [chiefP, opP, driverP] = await Promise.all([pos('Chief of Unit'), pos('Field Operator'), pos('Field Driver')]);
  await prisma.crewTemplateSeat.createMany({ data: [
    { unitTypeId: ut.id, positionId: chiefP.id, count: 1, requiredQualId: rigX.id },
    { unitTypeId: ut.id, positionId: opP.id, count: 3, requiredQualId: rigX.id },
    { unitTypeId: ut.id, positionId: driverP.id, count: 1, optional: true },
  ] });
  const base = (await call('POST', '/bases', ops, { code: 'PLN', name: 'Plan Test Base' })).json;
  const site = (await call('POST', '/sites', ops, { name: 'PLN-W1', baseId: base.id })).json;
  const mkUnit = async (code: string) => (await call('POST', '/units', ops, { code, unitTypeId: ut.id, homeBaseId: base.id })).json;
  const u1 = await mkUnit('HL-P1'), u2 = await mkUnit('HL-P2');
  const job = async (unit: { id: string }, s: number, e: number) => {
    const j = (await call('POST', '/jobs', disp, { wellName: 'PW', siteId: site.id, serviceType: 'Rig Test', plannedStart: at(s), plannedEnd: at(e) })).json;
    return { job: j, dep: await call('POST', `/jobs/${j.id}/deploy`, disp, { unitId: unit.id }) };
  };
  check('world: unit 1 deployed for 28 days', (await job(u1, 0, 27)).dep.status === 201);

  const P = (position: string, level: 'JUNIOR' | 'EXPERIENCED', offset: number) => mkEmployee({ position, level, quals: ['Rig-X'], base: 'PLN', anchorOffset: offset });
  // Set A is on now (days 0-25), set B takes over from day 26. Set C and D are free and on now.
  const A = { chief: await P('Chief of Unit', 'EXPERIENCED', -2), o1: await P('Field Operator', 'EXPERIENCED', -2), o2: await P('Field Operator', 'JUNIOR', -2), o3: await P('Field Operator', 'JUNIOR', -2) };
  const B = { chief: await P('Chief of Unit', 'EXPERIENCED', 26), o1: await P('Field Operator', 'EXPERIENCED', 26), o2: await P('Field Operator', 'JUNIOR', 26), o3: await P('Field Operator', 'JUNIOR', 26) };
  const C = { o1: await P('Field Operator', 'EXPERIENCED', -2), o2: await P('Field Operator', 'JUNIOR', -2), o3: await P('Field Operator', 'JUNIOR', -2) };
  const D = { chief: await P('Chief of Unit', 'EXPERIENCED', -2), o1: await P('Field Operator', 'EXPERIENCED', -2), o2: await P('Field Operator', 'JUNIOR', -2), o3: await P('Field Operator', 'JUNIOR', -2) };
  const ids = (o: Record<string, { id: string }>) => Object.values(o).map(x => x.id);
  const seatsU1 = await prisma.seat.findMany({ where: { unitId: u1.id }, include: { position: true } });

  // ================= plan a period (acceptance 6) =================
  check('employee role cannot plan', (await call('GET', '/planning/plans', emp)).status === 403);
  check('base manager cannot plan another base', (await call('POST', '/planning/plans', bm, { start: at(0), end: at(27), baseIds: ['PLN'] })).status === 403);
  check('period over the limit is refused', (await call('POST', '/planning/plans', disp, { start: at(0), end: at(400), baseIds: ['PLN'] })).status === 400);

  const open = await call('GET', `/planning/open-slots?start=${at(0)}&end=${at(27)}&baseIds=PLN`, disp);
  check('open slots: 4 required seats uncovered for 28 days', open.status === 200 && open.json.length === 4 && open.json.every((s: any) => s.from === day(at(0)) && s.to === day(at(27))), open.json);

  const t0 = Date.now();
  const p1 = await call('POST', '/planning/plans', disp, { start: at(0), end: at(27), baseIds: ['PLN'] });
  const plan1 = p1.json;
  check('plan created as DRAFT', p1.status === 201 && plan1.status === 'DRAFT' && plan1.version >= 1, p1.json);
  check('acceptance 6: every seat covered, no gaps', plan1.summary.gaps.length === 0 && plan1.summary.stats.coveredDays === 4 * 28 && plan1.assignments.length === 8, plan1.summary);
  check('every assignment is explained', plan1.assignments.every((a: any) => a.explanation && a.explanation.includes('covers')), plan1.assignments.map((a: any) => a.explanation));
  const people = new Set(plan1.assignments.map((a: any) => a.employee.id));
  check('only set A and set B were used', [...people].every(id => [...ids(A), ...ids(B)].includes(id as string)) && people.size === 8, [...people]);
  const opSeat1 = seatsU1.find(s => s.position.name === 'Field Operator' && s.index === 1)!;
  const op1Rows = plan1.assignments.filter((a: any) => a.seatId === opSeat1.id);
  check('seat 1 (needs Experienced) got the two experienced operators in order', op1Rows.length === 2 && op1Rows[0].employee.id === A.o1.id && op1Rows[1].employee.id === B.o1.id, op1Rows.map((r: any) => r.employee.id));
  check('handover is seamless (A until day 25, B from day 26)', day(op1Rows[0].end) === day(at(25)) && day(op1Rows[1].start) === day(at(26)) && day(op1Rows[1].end) === day(at(27)), op1Rows);
  check('draft assignments do not affect the live board yet', (await call('GET', `/seats?unitId=${u1.id}`, disp)).json.every((s: any) => s.holder === null));
  console.log(`      (engine ran in ${plan1.summary.engineMs} ms; request ${Date.now() - t0} ms)`);

  // manual edits on the draft
  const draftOp2 = plan1.assignments.find((a: any) => a.employee.id === A.o2.id);
  const outsider = await prisma.employee.findFirstOrThrow({ where: { position: { name: 'Field Operator' }, active: true, qualifications: { none: { qualificationId: rigX.id } } } });
  const bad = await call('PUT', `/planning/plans/${plan1.id}/assignments/${draftOp2.id}`, disp, { employeeId: outsider.id });
  check('manual edit to someone unqualified => 422', bad.status === 422 && bad.json.violations.some((v: any) => v.rule === 'qualification'), bad.json);
  const ovr = await call('PUT', `/planning/plans/${plan1.id}/assignments/${draftOp2.id}`, disp, { employeeId: outsider.id, overrideReason: 'Test override' });
  check('manual edit with an override reason is accepted', ovr.status === 200 && ovr.json.assignment.overrideReason === 'Test override', ovr.json);
  const back = await call('PUT', `/planning/plans/${plan1.id}/assignments/${draftOp2.id}`, disp, { employeeId: A.o2.id });
  check('edit back to the original person (override cleared)', back.status === 200 && back.json.assignment.overrideReason === null, back.json);
  const clash = await call('POST', `/planning/plans/${plan1.id}/assignments`, disp, { employeeId: C.o1.id, seatId: draftOp2.seatId, start: draftOp2.start, end: draftOp2.end });
  check('adding a second draft on the same seat/days => 409', clash.status === 409, clash.json);

  // lifecycle
  check('cannot approve a draft', (await call('POST', `/planning/plans/${plan1.id}/approve`, ops, {})).status === 400);
  check('cannot publish a draft', (await call('POST', `/planning/plans/${plan1.id}/publish`, ops, {})).status === 400);
  check('dispatcher submits', (await call('POST', `/planning/plans/${plan1.id}/submit`, disp)).json.status === 'REVIEW');
  check('editing is locked while under review', (await call('DELETE', `/planning/plans/${plan1.id}/assignments/${draftOp2.id}`, disp)).status === 400);
  check('dispatcher cannot approve', (await call('POST', `/planning/plans/${plan1.id}/approve`, disp, {})).status === 403);
  check('send back needs a reason', (await call('POST', `/planning/plans/${plan1.id}/reject`, ops, {})).status === 400);
  const rj = await call('POST', `/planning/plans/${plan1.id}/reject`, ops, { reason: 'Please re-check set B' });
  check('reviewer sends it back to draft', rj.json.status === 'DRAFT');
  await call('POST', `/planning/plans/${plan1.id}/submit`, disp);
  check('ops approves', (await call('POST', `/planning/plans/${plan1.id}/approve`, ops, { note: 'ok' })).json.status === 'APPROVED');
  const pub1 = await call('POST', `/planning/plans/${plan1.id}/publish`, ops, {});
  check('acceptance 7: published => assignments live', pub1.status === 201 && pub1.json.published === 8 && pub1.json.skipped === 0, pub1.json);
  const board = await call('GET', `/seats?unitId=${u1.id}`, disp);
  check('board now shows the crew', board.json.filter((s: any) => s.holder).length === 4, board.json);
  const live = await prisma.assignment.findMany({ where: { planId: plan1.id } });
  check('first stretch ACTIVE, handover stretch CONFIRMED', live.filter(a => a.status === 'ACTIVE').length === 4 && live.filter(a => a.status === 'CONFIRMED').length === 4);
  check('a published plan cannot be republished', (await call('POST', `/planning/plans/${plan1.id}/publish`, ops, {})).status === 400);
  check('the published unit is fully covered: open slots empty', (await call('GET', `/planning/open-slots?start=${at(0)}&end=${at(27)}&baseIds=PLN`, disp)).json.length === 0);

  // ================= scan -> plan -> re-validation at publish =================
  await job(u2, 5, 14);
  const scan = await call('POST', '/replacements/scan', disp, { start: at(0), end: at(27), baseIds: ['PLN'] });
  check('scan opens a task per uncovered required seat (4)', scan.status === 201 && scan.json.created === 4, scan.json);
  check('scan is idempotent', (await call('POST', '/replacements/scan', disp, { start: at(0), end: at(27), baseIds: ['PLN'] })).json.created === 0);
  const list0 = await call('GET', '/replacements', disp);
  check('replacement center lists them (trigger unit_deployed, HIGH, 5 days out)', list0.json.length === 4 && list0.json.every((t: any) => t.trigger === 'unit_deployed' && t.urgency === 'HIGH' && t.daysUntilStart === 5), list0.json[0]);

  const p2 = (await call('POST', '/planning/plans', disp, { start: at(0), end: at(27), baseIds: ['PLN'] })).json;
  check('plan 2 covers the new unit for its job days (4 seats x 10 days)', p2.summary.gaps.length === 0 && p2.summary.stats.coveredDays === 40, p2.summary);
  await call('POST', `/planning/plans/${p2.id}/submit`, disp);
  await call('POST', `/planning/plans/${p2.id}/approve`, ops, {});
  // between approval and publication, one of the planned people books leave
  const victim = p2.assignments.find((a: any) => a.seat === 'HL-P2 · Field Operator #3');
  await call('POST', '/leaves', hr, { employeeId: victim.employee.id, typeId: annualT, start: at(6), end: at(8) });
  const pubBad = await call('POST', `/planning/plans/${p2.id}/publish`, ops, {});
  check('publish re-validates: a draft that broke is reported (422)', pubBad.status === 422 && pubBad.json.problems.length === 1 && pubBad.json.problems[0].employeeId === victim.employee.id, pubBad.json);
  const pubOk = await call('POST', `/planning/plans/${p2.id}/publish`, ops, { skipInvalid: true });
  check('skipInvalid publishes the rest (3) and cancels the broken one', pubOk.status === 201 && pubOk.json.published === 3 && pubOk.json.skipped === 1, pubOk.json);
  const afterScan = await call('GET', '/replacements', disp);
  check('tasks closed for 3 seats; the seat that lost its person is still open', afterScan.json.length === 1, afterScan.json);

  // ================= leave -> replacement center (acceptance 5, 3) =================
  const medA2 = await call('POST', '/leaves', hr, { employeeId: A.o2.id, typeId: medT, start: at(0), end: at(9), documentUrl: 'c.pdf' });
  check('medical leave opens a CRITICAL task', medA2.status === 201, medA2.json);
  const c1 = await call('GET', '/replacements', disp);
  check('center sorts CRITICAL first', c1.json[0].urgency === 'CRITICAL' && c1.json[0].trigger === 'medical_leave', c1.json.map((t: any) => t.urgency));
  const taskA2 = c1.json[0];
  const cand = await call('GET', `/replacements/${taskA2.id}/candidates`, disp);
  check('one click: top candidates with explanations', cand.status === 200 && cand.json.candidates.length >= 1 && cand.json.candidates[0].explanation.includes('covers'), cand.json);
  check('set B is ruled out (on days off)', cand.json.ruledOut.some((r: any) => ids(B).includes(r.employeeId) && r.because.includes('rotation_off')), cand.json.ruledOut.slice(0, 3));
  const top = cand.json.candidates[0].employeeId;
  check('propose a candidate', (await call('POST', `/replacements/${taskA2.id}/propose`, disp, { employeeId: top })).json.status === 'CANDIDATE_PROPOSED');
  const conf = await call('POST', `/replacements/${taskA2.id}/confirm`, disp, {});
  check('acceptance 3: confirm places the replacement and closes the task', conf.status === 201 && conf.json.closed && conf.json.assignment.type === 'REPLACEMENT', conf.json);
  const seatA2 = seatsU1.find(s => s.id === taskA2.seatId)!;
  check('board shows the replacement on that seat', (await call('GET', `/seats?unitId=${u1.id}`, disp)).json.find((s: any) => s.id === seatA2.id).holder?.id === top);
  check('cannot confirm a closed task', (await call('POST', `/replacements/${taskA2.id}/confirm`, disp, {})).status === 400);

  // partial confirm leaves the rest open
  const medA3 = await call('POST', '/leaves', hr, { employeeId: A.o3.id, typeId: medT, start: at(10), end: at(20), documentUrl: 'c2.pdf' });
  const t3 = (await call('GET', '/replacements', disp)).json.find((t: any) => t.from === day(at(10)) && t.to === day(at(20)));
  check('second leave opens an 11-day task', !!t3 && t3.days === 11, medA3.json);
  const spare = (await call('GET', `/replacements/${t3.id}/candidates`, disp)).json.candidates[0].employeeId;
  const part = await call('POST', `/replacements/${t3.id}/confirm`, disp, { employeeId: spare, start: at(10), end: at(14) });
  check('partial confirm closes 5 days and keeps 6 open', part.status === 201 && !part.json.closed && part.json.remaining[0].from === day(at(15)) && part.json.remaining[0].to === day(at(20)), part.json);
  check('days outside the task are refused', (await call('POST', `/replacements/${t3.id}/confirm`, disp, { employeeId: spare, start: at(0), end: at(2) })).status === 400);

  // ================= gap with fix options + repair mode =================
  await call('POST', '/leaves', hr, { employeeId: A.chief.id, typeId: medT, start: at(5), end: at(12), documentUrl: 'c3.pdf' });
  const rp = await call('POST', '/planning/plans', disp, { start: at(0), end: at(27), baseIds: ['PLN'], mode: 'repair' });
  check('repair plan: re-plans only what open tasks need', rp.status === 201 && rp.json.summary.mode === 'repair', rp.json.summary);
  const chiefGap = rp.json.summary.gaps.find((g: any) => g.seat.includes('Chief of Unit'));
  check('no chief available => a gap, not a bad assignment', !!chiefGap && chiefGap.from === day(at(5)) && chiefGap.to === day(at(12)), rp.json.summary.gaps);
  const kinds = chiefGap?.options.map((o: any) => o.kind) ?? [];
  check('gap lists ranked fix options (call back from days off, hire)', kinds.includes('recall_from_days_off') && kinds[kinds.length - 1] === 'hire', chiefGap?.options);
  check('call-back option names the person and needs an override', chiefGap.options.find((o: any) => o.kind === 'recall_from_days_off').employee && chiefGap.options.find((o: any) => o.kind === 'recall_from_days_off').needsOverride === true);
  check('repair placed the 6-day remainder of the earlier task', rp.json.assignments.some((a: any) => day(a.start) === day(at(15)) && day(a.end) === day(at(20)) && a.type === 'REPLACEMENT'), rp.json.assignments.map((a: any) => a.seat + ' ' + day(a.start) + '..' + day(a.end)));
  await call('POST', `/planning/plans/${rp.json.id}/submit`, disp);
  await call('POST', `/planning/plans/${rp.json.id}/approve`, ops, {});
  const pubRp = await call('POST', `/planning/plans/${rp.json.id}/publish`, ops, {});
  check('repair plan publishes', pubRp.status === 201 && pubRp.json.published === rp.json.assignments.length, pubRp.json);
  const openAfter = (await call('GET', '/replacements', disp)).json;
  check('the tasks the repair covered are closed; the chief gap stays open', openAfter.some((t: any) => t.seat.includes('Chief')) && !openAfter.some((t: any) => t.from === day(at(15))), openAfter.map((t: any) => t.seat + ' ' + t.from));

  // version diff
  const diff = await call('GET', `/planning/plans/${rp.json.id}/diff?against=${plan1.id}`, disp);
  check('plan diff: added / removed / changed', diff.status === 200 && diff.json.added.length >= 1 && diff.json.added.some((r: any) => r.from === day(at(15))), diff.json);
  check('diff without a baseline is a clear error', (await call('GET', `/planning/plans/${plan1.id}/diff`, disp)).status === 400);

  // ================= escalation =================
  await call('POST', '/leaves', hr, { employeeId: A.o1.id, typeId: medT, start: at(1), end: at(3), documentUrl: 'c4.pdf' });
  const esc = await call('POST', '/replacements/escalate-due', disp);
  check('escalate-due escalates tasks starting within 2 days', esc.status === 201 && esc.json.escalated >= 1, esc.json);
  const urgentTask = (await call('GET', '/replacements', disp)).json.find((t: any) => t.seat.includes('Field Operator #1') && t.from === day(at(1)));
  check('that task is ESCALATED', urgentTask?.status === 'ESCALATED', urgentTask);
  check('escalating twice is refused', (await call('POST', `/replacements/${urgentTask.id}/escalate`, disp)).status === 400);
  check('closing needs a reason', (await call('POST', `/replacements/${urgentTask.id}/close`, disp, {})).status === 400);
  check('an escalated task can still be proposed a person', (await call('POST', `/replacements/${urgentTask.id}/propose`, disp, { employeeId: B.o1.id })).status === 201);
  const forced = await call('POST', `/replacements/${urgentTask.id}/confirm`, disp, {});
  check('confirming someone on days off breaks a hard rule => needs override (422)', forced.status === 422 && forced.json.violations.some((v: any) => v.rule === 'rotation_off'), forced.json);
  const forced2 = await call('POST', `/replacements/${urgentTask.id}/confirm`, disp, { overrideReason: 'Recalled from days off by Ops' });
  check('with an override reason the recall goes through and the task closes', forced2.status === 201 && forced2.json.closed, forced2.json);
  check('the override reason is stored on the assignment', (await prisma.assignment.findUniqueOrThrow({ where: { id: forced2.json.assignment.id } })).overrideReason === 'Recalled from days off by Ops');
  // discard a draft
  const p9 = await call('POST', '/planning/plans', disp, { start: at(0), end: at(27), baseIds: ['PLN'] });
  check('a draft can be discarded', (await call('DELETE', `/planning/plans/${p9.json.id}`, disp)).status === 200 && (await call('GET', `/planning/plans/${p9.json.id}`, disp)).status === 404);
  check('a published plan cannot be discarded', (await call('DELETE', `/planning/plans/${plan1.id}`, disp)).status === 400);
  check('audit trail covers planning', (await prisma.auditLog.count({ where: { entity: 'Plan' } })) >= 8);

  void admin; void C; void D;
  await finish();
}
main().catch(e => { console.error(e); process.exit(1); });
