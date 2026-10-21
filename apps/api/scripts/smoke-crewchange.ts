// Live checks for moving a crew change (POST /assignments/crew-change), on one seat and on a whole unit.
import '../src/env';
import { prisma, call, check, login, finish, day } from './lib';

async function main() {
  const admin = await login('admin');
  const list = (await call('GET', '/calendar/crew-changes?days=30', admin)).json;
  const handover = list.changes.find((c: any) => c.outgoing && c.incoming && c.unitId && c.daysAway >= 3);
  check('the list has a handover with someone leaving and someone arriving', !!handover, list.counts);
  if (!handover) return finish();
  check('crew changes carry their unit', typeof handover.unitCode === 'string');
  const plus = (iso: string, n: number) => new Date(Date.parse(iso) + n * 86_400_000).toISOString().slice(0, 10);

  // one seat, two days later
  const to = plus(handover.date, 2);
  const r = await call('POST', '/assignments/crew-change', admin, { seatIds: [handover.seatId], from: handover.date, to, overrideReason: 'smoke' });
  check('moving one seat works', r.status === 201 && r.json.moved === 2, r.json);
  const rows = await prisma.assignment.findMany({ where: { seatId: handover.seatId, status: { in: ['CONFIRMED', 'ACTIVE'] } }, orderBy: { start: 'asc' } });
  check('the outgoing person stays until the day before', rows.some(a => a.employeeId === handover.outgoing.id && day(a.plannedEnd.toISOString()) === plus(to, -1)));
  check('the incoming person starts on the new day', rows.some(a => a.employeeId === handover.incoming.id && day(a.start.toISOString()) === to));
  const after = (await call('GET', '/calendar/crew-changes?days=30', admin)).json;
  check('the list shows the new date', after.changes.some((c: any) => c.seatId === handover.seatId && c.date === to));

  // back again, earlier
  const back = await call('POST', '/assignments/crew-change', admin, { seatIds: [handover.seatId], from: to, to: handover.date, overrideReason: 'smoke' });
  check('moving it back works', back.status === 201, back.json);

  // the whole unit
  const unitRows = after.changes.filter((c: any) => c.unitId === handover.unitId && c.date !== to);
  if (unitRows.length) {
    const d = unitRows[0].date; const seats = unitRows.filter((c: any) => c.date === d).map((c: any) => c.seatId);
    const u = await call('POST', '/assignments/crew-change', admin, { seatIds: seats, from: d, to: plus(d, 1), overrideReason: 'smoke' });
    check(`moving the whole unit (${seats.length} seats) works`, u.status === 201 && u.json.seats === seats.length, u.json);
  }

  // errors
  check('same date => 400', (await call('POST', '/assignments/crew-change', admin, { seatIds: [handover.seatId], from: handover.date, to: handover.date })).status === 400);
  check('no change that day => 400', (await call('POST', '/assignments/crew-change', admin, { seatIds: [handover.seatId], from: plus(handover.date, 1), to: plus(handover.date, 3) })).status === 400);
  check('leaving before arriving => 400', (await call('POST', '/assignments/crew-change', admin, { seatIds: [handover.seatId], from: handover.date, to: plus(handover.date, -200) })).status === 400);
  const emp = await login('employee');
  check('employees cannot move crew changes', (await call('POST', '/assignments/crew-change', emp, { seatIds: [handover.seatId], from: handover.date, to })).status === 403);
  finish();
}
main().catch(e => { console.error(e); process.exit(1); });
