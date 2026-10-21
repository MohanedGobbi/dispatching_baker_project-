// Live checks: a unit that is not on a job raises no replacement tasks; tasks are trimmed to the job's days.
import '../src/env';
import { prisma, call, check, login, finish, today, DAY } from './lib';

async function main() {
  const admin = await login('admin');
  const idle = await prisma.unit.findFirst({ where: { deployments: { none: {} } }, include: { seats: { where: { requiredFlag: true } } } });
  const busy = await prisma.unitDeployment.findFirst({ where: { end: { gte: today, lte: new Date(today.getTime() + 200 * DAY) }, start: { lte: today } }, include: { unit: { include: { seats: { where: { requiredFlag: true } } } } } });
  check('there is a unit with no job and one on a job', !!idle?.seats.length && !!busy?.unit.seats.length);
  if (!idle || !busy) return finish();
  // tasks as an archive or an unassign would open them
  const a = await prisma.replacementTask.create({ data: { seatId: idle.seats[0].id, fromDate: today, toDate: new Date(today.getTime() + 20 * DAY), trigger: 'employee_archived', urgency: 'CRITICAL', deadline: today } });
  const b = await prisma.replacementTask.create({ data: { seatId: busy.unit.seats[0].id, fromDate: today, toDate: new Date(busy.end.getTime() + 60 * DAY), trigger: 'unassigned', urgency: 'CRITICAL', deadline: today } });

  const list = (await call('GET', '/replacements', admin)).json as any[];
  check('the unit with no job is not in the replacement center', !list.some(t => t.id === a.id));
  check('its task is closed', (await prisma.replacementTask.findUnique({ where: { id: a.id } }))?.status === 'CLOSED');
  const trimmed = list.find(t => t.id === b.id);
  check('a task on a unit on a job stays', !!trimmed);
  check('it ends when the job ends', trimmed?.to === busy.end.toISOString().slice(0, 10), trimmed);
  await prisma.replacementTask.deleteMany({ where: { id: { in: [a.id, b.id] } } });
  finish();
}
main().catch(e => { console.error(e); process.exit(1); });
