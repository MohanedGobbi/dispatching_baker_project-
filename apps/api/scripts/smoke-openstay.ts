// Live checks for stays with no crew change date yet (Assignment.openEnded).
import '../src/env';
import { prisma, call, check, login, finish, day } from './lib';

async function main() {
  const admin = await login('admin');
  const board = (await call('GET', '/board', admin)).json;
  const today = board.date;
  // an empty seat nobody is booked on later either
  let seat: any = null, person: any = null;
  for (const s of board.units.flatMap((u: any) => u.seats).filter((s: any) => !s.holder)) {
    const p = (board.columns.standby ?? []).find((x: any) => x.position === s.position) ?? board.columns.standby?.[0];
    if (!p) continue;
    const pv = await call('POST', '/assignments/preview', admin, { employeeId: p.id, seatId: s.seatId, start: today, openEnded: true });
    if (!pv.json.seatTaken) { seat = s; person = p; break; }
  }
  check('there is a free seat and someone free', !!seat && !!person);
  if (!seat || !person) return finish();

  const pv = await call('POST', '/assignments/preview', admin, { employeeId: person.id, seatId: seat.seatId, start: today, openEnded: true });
  check('preview takes openEnded', pv.status === 201 && !pv.json.violations.some((v: any) => ['rotation_off', 'max_consecutive'].includes(v.rule)), pv.json);
  const r = await call('POST', '/assignments', admin, { employeeId: person.id, seatId: seat.seatId, start: today, openEnded: true, overrideReason: 'smoke' });
  check('an open stay is created', r.status === 201 && r.json.assignment.openEnded === true, r.json);
  const id = r.json.assignment.id;

  const b2 = (await call('GET', '/board', admin)).json;
  const held = b2.units.flatMap((u: any) => u.seats).find((s: any) => s.seatId === seat.seatId);
  check('the board shows it with no crew change date', held?.holder?.openEnded === true);
  const cc = (await call('GET', '/calendar/crew-changes?days=30', admin)).json;
  check('no crew change is listed for it', !cc.changes.some((c: any) => c.seatId === seat.seatId && c.outgoing?.id === person.id));
  check('it cannot be extended', (await call('POST', '/extensions', admin, { assignmentId: id, days: 3, reason: 'urgent_job' })).status === 400);

  // set the crew change date, then take it away again
  const end = new Date(Date.parse(today) + 13 * 86_400_000).toISOString().slice(0, 10);
  const m = await call('PUT', `/assignments/${id}/move`, admin, { end, overrideReason: 'smoke' });
  check('setting the date ends the stay the day before the change', m.status === 200 && day(m.json.assignment.plannedEnd) === end && m.json.assignment.openEnded === false, m.json);
  const cc2 = (await call('GET', '/calendar/crew-changes?days=30', admin)).json;
  // the list only shows handovers on seats still needed then (a unit on a job)
  const onJob = board.units.find((u: any) => u.seats.some((s: any) => s.seatId === seat.seatId))?.status === 'DEPLOYED' && seat.required;
  if (onJob) check('the crew change is listed now', cc2.changes.some((c: any) => c.seatId === seat.seatId && c.outgoing?.id === person.id));
  const o = await call('PUT', `/assignments/${id}/move`, admin, { openEnded: true, overrideReason: 'smoke' });
  check('"not decided yet" opens it again', o.status === 200 && o.json.assignment.openEnded === true, o.json);

  // unassigning an open stay opens a gap of one usual stretch, not years
  const u = await call('POST', `/assignments/${id}/unassign`, admin, { from: today });
  const task = u.json.replacementTask;
  check('unassigning closes the stay', u.status === 201);
  if (task) check('the gap is one stretch long', Math.round((Date.parse(task.toDate) - Date.parse(task.fromDate)) / 86_400_000) === 27, task);
  await prisma.replacementTask.deleteMany({ where: { id: task?.id ?? '' } });
  finish();
}
main().catch(e => { console.error(e); process.exit(1); });
