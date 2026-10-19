// Live smoke test for E10 (calendars) and E11 (dispatch board API, live updates, time machine).
import { at, call, check, day, DAY, finish, login, mkEmployee, prisma, today, API } from './lib';

async function main() {
  const [ops, hr, disp, emp] = await Promise.all(['ops', 'hr', 'dispatcher', 'employee'].map(login));
  const medT = (await prisma.leaveType.findUniqueOrThrow({ where: { name: 'Medical leave' } })).id;

  // ---------------- world: base BRD, unit type with its own qualification
  const rigY = await prisma.qualification.create({ data: { name: 'Rig-Y' } });
  const ut = await prisma.unitType.create({ data: { name: 'Rig Board', colorKey: 'amber' } });
  const pos = async (n: string) => prisma.position.findUniqueOrThrow({ where: { name: n } });
  const [chiefP, opP, mechP] = await Promise.all([pos('Chief of Unit'), pos('Field Operator'), pos('Mechanic')]);
  await prisma.crewTemplateSeat.createMany({ data: [
    { unitTypeId: ut.id, positionId: chiefP.id, count: 1, requiredQualId: rigY.id },
    { unitTypeId: ut.id, positionId: opP.id, count: 3, requiredQualId: rigY.id },
  ] });
  const base = (await call('POST', '/bases', ops, { code: 'BRD', name: 'Board Test Base' })).json;
  const site = (await call('POST', '/sites', ops, { name: 'BRD-W1', baseId: base.id, travelHours: 4 })).json;
  const mkUnit = async (code: string) => (await call('POST', '/units', ops, { code, unitTypeId: ut.id, homeBaseId: base.id })).json;
  const u1 = await mkUnit('HL-B1'), u2 = await mkUnit('HL-B2');
  for (const u of [u1, u2]) {
    const j = (await call('POST', '/jobs', disp, { wellName: u === u1 ? 'BW-1' : 'BW-2', rigName: 'RIG B', siteId: site.id, serviceType: 'Rig Board', plannedStart: at(-3), plannedEnd: at(20) })).json;
    await call('POST', `/jobs/${j.id}/deploy`, disp, { unitId: u.id });
  }
  const P = (position: string, level: 'JUNIOR' | 'EXPERIENCED') => mkEmployee({ position, level, quals: ['Rig-Y'], base: 'BRD', anchorOffset: -2 });
  const chief = await P('Chief of Unit', 'EXPERIENCED'), o1 = await P('Field Operator', 'EXPERIENCED'), o2 = await P('Field Operator', 'JUNIOR'), o3 = await P('Field Operator', 'JUNIOR');
  const seats = await prisma.seat.findMany({ where: { unitId: u1.id }, include: { position: true } });
  const seat = (p: string, i: number) => seats.find(s => s.position.name === p && s.index === i)!;
  const mkA = (e: { id: string }, s: { id: string }, a: number, b: number, status: 'ACTIVE' | 'CONFIRMED' | 'COMPLETED' | 'DRAFT' = 'ACTIVE') =>
    prisma.assignment.create({ data: { employeeId: e.id, seatId: s.id, start: new Date(today.getTime() + a * DAY), plannedEnd: new Date(today.getTime() + b * DAY), status } });
  await mkA(chief, seat('Chief of Unit', 1), -3, 9);
  await mkA(o1, seat('Field Operator', 1), -3, 20);
  await mkA(o2, seat('Field Operator', 2), -3, 9);
  await mkA(o3, seat('Field Operator', 3), -3, 9);
  // chief: nobody follows (missing); o2: a draft follows (suggested); o3: a confirmed successor follows (confirmed)
  const o2next = await P('Field Operator', 'JUNIOR'), o3next = await P('Field Operator', 'JUNIOR');
  await mkA(o2next, seat('Field Operator', 2), 10, 20, 'DRAFT');
  await mkA(o3next, seat('Field Operator', 3), 10, 20, 'CONFIRMED');

  // ================= board =================
  const b1 = await call('GET', `/board?baseId=${base.id}`, disp);
  const card = b1.json.units?.find((u: any) => u.code === 'HL-B1');
  check('board loads for dispatcher', b1.status === 200 && !!card, b1.text.slice(0, 300));
  check('unit card: DEPLOYED with its job, type colour and 4/4 crew', card.status === 'DEPLOYED' && card.job?.well === 'BW-1' && card.colorKey === 'amber' && card.crew.filled === 4 && card.crew.required === 4, card);
  check('badge 4/4 is OK', card.badges.find((b: any) => b.code === 'crew')?.text === '4/4' && card.badges.find((b: any) => b.code === 'crew').severity === 'ok');
  check('crew change badge: 10 days (first holder leaves day 9)', card.badges.some((b: any) => b.code === 'crew_change' && b.text === 'Crew change in 10 days'), card.badges);
  check('seats show holders with seniority and qualification tags', card.seats.find((s: any) => s.position === 'Chief of Unit').holder.seniority === 'EXPERIENCED' && card.seats[0].holder.tags.includes('Rig-Y'));
  const u2card = b1.json.units.find((u: any) => u.code === 'HL-B2');
  check('empty deployed unit: 0/4 warning and "Needs someone" on seats', u2card.badges[0].text === '0/4' && u2card.badges[0].severity === 'warn' && u2card.seats.every((s: any) => s.issues.some((i: any) => i.code === 'empty')), u2card.badges);

  // rule badges
  await prisma.employee.update({ where: { id: chief.id }, data: { seniorityOverride: 'JUNIOR' } });
  await prisma.employee.update({ where: { id: o1.id }, data: { seniorityOverride: 'JUNIOR' } });
  const noExp = (await call('GET', `/board?baseId=${base.id}`, disp)).json.units.find((u: any) => u.code === 'HL-B1');
  check('"No experienced" badge (red, crew complete)', noExp.badges.some((b: any) => b.code === 'no_experienced' && b.severity === 'bad') && noExp.state === 'bad', noExp.badges);
  check('the seat that needs an Experienced person flags it', noExp.seats.find((s: any) => s.position === 'Field Operator' && s.index === 1).issues.some((i: any) => i.code === 'seniority'));
  await prisma.employee.update({ where: { id: o1.id }, data: { seniorityOverride: 'EXPERIENCED' } });

  await prisma.certification.updateMany({ where: { employeeId: o2.id }, data: { expiresAt: new Date(today.getTime() - 5 * DAY) } });
  await prisma.employeeQualification.deleteMany({ where: { employeeId: o3.id, qualificationId: rigY.id } });
  const bad = (await call('GET', `/board?baseId=${base.id}`, disp)).json.units.find((u: any) => u.code === 'HL-B1');
  check('"Certificate expired" badge', bad.badges.some((b: any) => b.code === 'cert' && b.text === 'Certificate expired'), bad.badges);
  check('"Missing qualification" badge names the qualification', bad.badges.some((b: any) => b.code === 'qualification' && b.text.includes('Rig-Y')), bad.badges);

  const only = await call('GET', `/board?baseId=${base.id}&problemsOnly=true`, disp);
  check('problems-only keeps units needing attention', only.json.units.some((u: any) => u.code === 'HL-B1') && only.json.units.some((u: any) => u.code === 'HL-B2'));
  await prisma.certification.updateMany({ where: { employeeId: o2.id }, data: { expiresAt: new Date(today.getTime() + 300 * DAY) } });
  await prisma.employeeQualification.create({ data: { employeeId: o3.id, qualificationId: rigY.id, obtainedAt: today } });
  await prisma.employee.update({ where: { id: chief.id }, data: { seniorityOverride: 'EXPERIENCED' } });
  const healthy = await call('GET', `/board?baseId=${base.id}&problemsOnly=true`, disp);
  check('problems-only hides a compliant unit', !healthy.json.units.some((u: any) => u.code === 'HL-B1' && u.state === 'ok') && !healthy.json.units.some((u: any) => u.code === 'HL-B1'), healthy.json.units.map((u: any) => u.code + ':' + u.state));

  // search & filters
  const srch = await call('GET', `/board?baseId=${base.id}&q=HL-B2`, disp);
  check('search highlights the unit', srch.json.matches.units.length === 1);
  const srch2 = await call('GET', `/board?baseId=${base.id}&q=${chief.employeeNo}`, disp);
  check('search highlights a person by number', srch2.json.matches.employees.includes(chief.id));
  check('type filter works', (await call('GET', `/board?baseId=${base.id}&typeId=${ut.id}`, disp)).json.units.length === 2 && (await call('GET', `/board?baseId=${base.id}&typeId=nonexistent`, disp)).json.units.length === 0);
  check('employees cannot open the board', (await call('GET', '/board', emp)).status === 403);
  check('unauthenticated => 401', (await call('GET', '/board')).status === 401);

  // ---- side columns & privacy
  const sick = await mkEmployee({ position: 'Field Operator', level: 'JUNIOR', quals: ['Rig-Y'], base: 'BRD' });
  await call('POST', '/leaves', hr, { employeeId: sick.id, typeId: medT, start: at(-1), end: at(5), documentUrl: 'x.pdf' });
  const dBoard = await call('GET', `/board?baseId=${base.id}`, disp);
  check('person on medical leave sits in "unavailable" for the dispatcher', dBoard.json.columns.unavailable.some((p: any) => p.id === sick.id));
  check('…and nothing medical leaks to the dispatcher', !dBoard.text.toLowerCase().includes('medical'), 'found "medical" in dispatcher board');
  const hBoard = await call('GET', `/board?baseId=${base.id}`, hr);
  check('HR sees the reason on the same board', hBoard.json.columns.unavailable.find((p: any) => p.id === sick.id)?.label === 'Medical leave');
  check('standby / days-off columns are populated', dBoard.json.columns.standby.length + dBoard.json.columns.daysOff.length > 0 && dBoard.json.summary.headcount.ON_UNIT >= 4);

  // ---- base staffing meter + work order + weekend
  const staffRule = await call('PUT', `/bases/${base.id}/staffing/${mechP.id}`, ops, { minCount: 1, targetCount: 2, scheduleWindow: 'working_days' });
  check('staffing rule saved', staffRule.status === 200);
  check('an invalid schedule window is refused', (await call('PUT', `/bases/${base.id}/staffing/${mechP.id}`, ops, { minCount: 1, targetCount: 2, scheduleWindow: 'nights' })).status === 400);
  const mech = await mkEmployee({ position: 'Mechanic', level: 'JUNIOR', quals: ['Heavy vehicle mechanics'], base: 'BRD' });
  await prisma.employee.update({ where: { id: mech.id }, data: { workMode: 'BASE', rotationPatternId: (await prisma.rotationPattern.findUniqueOrThrow({ where: { name: '5/2 weekly' } })).id, rotationAnchorDate: today } });
  const mechSeat = (await prisma.seat.findMany({ where: { baseId: base.id, positionId: mechP.id }, orderBy: { index: 'asc' } }))[0];
  await mkA(mech, mechSeat, -3, 20);
  await prisma.workOrder.create({ data: { unitId: u1.id, baseId: base.id, type: 'preventive', plannedStart: new Date(today.getTime() - DAY), expectedReturn: new Date(today.getTime() + 5 * DAY), status: 'IN_PROGRESS', assignees: { create: { employeeId: mech.id } } } });
  // find a working day (Sun-Thu) and a weekend day (Fri/Sat) in the next 7 days
  const dateAt = (n: number) => new Date(today.getTime() + n * DAY);
  const work = [0, 1, 2, 3, 4, 5, 6].find(n => ![5, 6].includes(dateAt(n).getUTCDay()))!;
  const weekend = [0, 1, 2, 3, 4, 5, 6].find(n => dateAt(n).getUTCDay() === 5)!;
  const wBoard = await call('GET', `/board?baseId=${base.id}&date=${day(at(work))}&view=base`, disp);
  const meter = wBoard.json.staffing.find((s: any) => s.position === 'Mechanic');
  check('staffing meter on a working day: 1 / min 1 / target 2 => below target', meter.filled === 1 && meter.min === 1 && meter.target === 2 && meter.state === 'below_target', meter);
  check('mechanic shows the work order they are on', meter.people[0].workOrder?.unit === 'HL-B1' && meter.people[0].workOrder.status === 'IN_PROGRESS', meter.people);
  check('view=base leaves out the units', wBoard.json.units.length === 0);
  const eBoard = await call('GET', `/board?baseId=${base.id}&date=${day(at(weekend))}&view=base`, disp);
  const meterWE = eBoard.json.staffing.find((s: any) => s.position === 'Mechanic');
  check('on the weekend the weekly mechanic is off, and that is not reported as a shortage', meterWE.filled === 0 && meterWE.state === 'off_day', meterWE);
  const noRule = await call('GET', `/board?baseId=${base.id}&view=field`, disp);
  check('view=field leaves out base staffing', noRule.json.staffing.length === 0 && noRule.json.units.length === 2);

  // ---- time machine
  await mkA(o2next, seat('Chief of Unit', 1), -20, -10, 'COMPLETED');
  const tm = await call('GET', `/board?baseId=${base.id}&date=${day(at(-15))}`, disp);
  const tmCard = tm.json.units.find((u: any) => u.code === 'HL-B1');
  check('time machine: a past date shows who was there then', tm.json.past === true && tmCard.seats.find((s: any) => s.position === 'Chief of Unit').holder?.id === o2next.id, tmCard.seats.map((s: any) => s.holder?.name));
  check('time machine: the unit was not deployed yet', tmCard.status !== 'DEPLOYED');

  // ---- draft layer
  const plan = (await call('POST', '/planning/plans', disp, { start: at(0), end: at(27), baseIds: ['BRD'] })).json;
  const live = (await call('GET', `/board?baseId=${base.id}`, disp)).json.units.find((u: any) => u.code === 'HL-B2');
  const draft = (await call('GET', `/board?baseId=${base.id}&planId=${plan.id}`, disp)).json;
  const dCard = draft.units.find((u: any) => u.code === 'HL-B2');
  check('live layer: HL-B2 has nobody', live.seats.every((s: any) => !s.holder));
  check('draft layer overlays the plan on the same board', draft.layer === 'draft' && dCard.seats.some((s: any) => s.holder?.draft === true), dCard.seats.map((s: any) => s.holder));

  // ================= calendars =================
  const pc = await call('GET', `/calendar/employees/${chief.id}?from=${day(at(0))}&to=${day(at(14))}`, disp);
  check('personal calendar: today ON_UNIT then days off after the rotation', pc.status === 200 && pc.json.days[0].status === 'ON_UNIT' && pc.json.days[0].label.startsWith('HL-B1'), pc.json.days?.[0]);
  check('personal calendar summary has next days off', !!pc.json.summary.nextDaysOff && pc.json.summary.today.status === 'ON_UNIT', pc.json.summary);
  check('blocks merge consecutive days', pc.json.blocks[0].from === day(at(0)) && pc.json.blocks[0].to === day(at(9)), pc.json.blocks.slice(0, 2));
  check('month view', (await call('GET', `/calendar/employees/${chief.id}?month=${at(0).slice(0, 7)}`, disp)).json.days.length >= 28);
  const wk = await call('GET', `/calendar/employees/${mech.id}?from=${day(at(0))}&to=${day(at(7))}`, disp);
  check('weekly staff: weekend shows DAYS_OFF despite the assignment', wk.json.days.filter((d: any) => [5, 6].includes(new Date(d.date).getUTCDay())).every((d: any) => d.status === 'DAYS_OFF') && wk.json.days.some((d: any) => d.status === 'ON_BASE_POST'), wk.json.days.map((d: any) => d.date.slice(8) + d.status[0]).join(' '));
  const sickCal = await call('GET', `/calendar/employees/${sick.id}?from=${day(at(0))}&to=${day(at(3))}`, disp);
  check('calendar masks medical leave for the dispatcher', sickCal.json.days.every((d: any) => d.status === 'UNAVAILABLE') && !sickCal.text.toLowerCase().includes('medical'), sickCal.json.days[0]);
  check('…but HR sees it', (await call('GET', `/calendar/employees/${sick.id}?from=${day(at(0))}&to=${day(at(3))}`, hr)).json.days[0].status === 'MEDICAL_LEAVE');
  check('an employee cannot read someone else\'s calendar', (await call('GET', `/calendar/employees/${sick.id}`, emp)).status === 403);

  const tl = await call('GET', `/calendar/timeline?baseId=${base.id}&from=${day(at(0))}&to=${day(at(20))}&groupBy=position`, disp);
  check('timeline: rows with blocks grouped by position', tl.status === 200 && tl.json.rows.length >= 6 && tl.json.rows.every((r: any) => r.blocks.length && r.group), tl.json.rows?.length);
  check('timeline masks the sick person', tl.json.rows.find((r: any) => r.employeeId === sick.id).blocks[0].status === 'UNAVAILABLE');
  check('timeline refuses huge ranges', (await call('GET', `/calendar/timeline?from=${day(at(0))}&to=${day(at(400))}`, disp)).status === 400);
  check('timeline by unit', (await call('GET', `/calendar/timeline?unitId=${u1.id}&from=${day(at(0))}&to=${day(at(10))}&groupBy=unit`, disp)).json.rows.some((r: any) => r.group === 'HL-B1'));

  const cc = await call('GET', '/calendar/crew-changes?days=14&baseId=' + base.id, disp);
  const byseat = (label: string) => cc.json.changes.find((c: any) => c.seat === label);
  check('crew changes: chief leaves with nobody following => missing', byseat('HL-B1 · Chief of Unit #1')?.status === 'missing' && byseat('HL-B1 · Chief of Unit #1').date === day(at(10)), cc.json.changes);
  check('crew changes: a draft successor => suggested', byseat('HL-B1 · Field Operator #2')?.status === 'suggested' && byseat('HL-B1 · Field Operator #2').incoming.id === o2next.id);
  check('crew changes: a live successor => confirmed', byseat('HL-B1 · Field Operator #3')?.status === 'confirmed' && byseat('HL-B1 · Field Operator #3').incoming.id === o3next.id);
  check('crew changes carry travel notes and counts', byseat('HL-B1 · Chief of Unit #1').travel?.hours === 4 && cc.json.counts.missing >= 1 && cc.json.counts.suggested >= 1 && cc.json.counts.confirmed >= 1, cc.json.counts);
  check('crew changes for 7 days wouldn\'t include day 10', (await call('GET', '/calendar/crew-changes?days=7&baseId=' + base.id, disp)).json.changes.length === 0);

  const roster = await call('GET', `/calendar/base-roster?baseId=${base.id}&from=${day(at(0))}&to=${day(at(13))}`, disp);
  const m0 = roster.json.coverage.find((c: any) => c.date === day(at(work)))?.positions.find((p: any) => p.position === 'Mechanic');
  const mWE = roster.json.coverage.find((c: any) => c.date === day(at(weekend)))?.positions.find((p: any) => p.position === 'Mechanic');
  check('base roster: posts with blocks, and daily presence vs minimum', roster.status === 200 && roster.json.posts.length === 2 && m0.present === 1 && m0.min === 1 && mWE.present === 0, { m0, mWE });

  // ================= live updates (SSE) =================
  const ctl = new AbortController();
  const res = await fetch(`${API}/board/events`, { headers: { authorization: `Bearer ${disp}` }, signal: ctl.signal });
  check('event stream opens as text/event-stream', res.status === 200 && (res.headers.get('content-type') ?? '').includes('text/event-stream'));
  const reader = res.body!.getReader();
  let received = '';
  const pump = (async () => { const dec = new TextDecoder(); try { for (;;) { const { value, done } = await reader.read(); if (done) break; received += dec.decode(value); } } catch { /* aborted */ } })();
  await new Promise(r => setTimeout(r, 300));
  await call('POST', '/assignments/preview', disp, { employeeId: o1.id, seatId: seat('Field Operator', 1).id, start: at(0), end: at(2) }); // read-only: must not notify
  await call('POST', '/sites', ops, { name: 'BRD-W2', baseId: base.id });                                                                       // a change: must notify
  await new Promise(r => setTimeout(r, 700));
  ctl.abort(); await pump;
  check('a change request is pushed to open boards', received.includes('"type":"changed"') && received.includes('/sites'), received);
  check('login requests are not broadcast', !received.includes('/auth'));

  void DAY;
  await finish();
}
main().catch(e => { console.error(e); process.exit(1); });
