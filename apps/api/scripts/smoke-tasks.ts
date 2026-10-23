// Live checks for tasks the manager gives to people: create, list, edit, mark done, delete, audit.
// Isolated: the people it uses are created here.
import '../src/env';
import { at, call, check, day, finish, login, mkEmployee, prisma } from './lib';

async function main() {
  const admin = await login('admin');
  const A = await mkEmployee({ position: 'Field Operator', level: 'JUNIOR', quals: [], base: 'HMD' });
  const B = await mkEmployee({ position: 'Field Operator', level: 'JUNIOR', quals: [], base: 'HMD' });

  check('a task needs a person and a title', (await call('POST', '/tasks', admin, { employeeIds: [], title: 'x' })).status === 400 && (await call('POST', '/tasks', admin, { employeeIds: [A.id], title: ' ' })).status === 400);
  const made = await call('POST', '/tasks', admin, { employeeIds: [A.id, B.id], title: 'Bring your medical certificate', notes: 'To the HMD office', dueDate: at(3) });
  check('one task per person', made.status === 201 && made.json.length === 2 && made.json[0].dueDate === day(at(3)), made.json);
  const late = (await call('POST', '/tasks', admin, { employeeIds: [A.id], title: 'Return the safety harness', dueDate: at(-1) })).json[0];
  check('a task past its date is overdue', late.overdue === true);

  const done = await call('PUT', `/tasks/${late.id}`, admin, { status: 'DONE', doneNote: 'Left it at the store' });
  check('a task is marked done with a note', done.status === 200 && done.json.status === 'DONE' && done.json.doneNote === 'Left it at the store');
  check('open tasks can be listed alone', (await call('GET', `/tasks?employeeId=${A.id}&status=OPEN`, admin)).json.length === 1);

  const all = (await call('GET', `/tasks?employeeId=${A.id}`, admin)).json;
  check('every task of a person, open first', all.length === 2 && all[0].status === 'OPEN');
  check('a task is edited', (await call('PUT', `/tasks/${all[0].id}`, admin, { dueDate: at(10), title: 'Bring your medical certificate (original)' })).json.dueDate === day(at(10)));
  check('a task title cannot be emptied', (await call('PUT', `/tasks/${all[0].id}`, admin, { title: ' ' })).status === 400);
  const theirs = made.json.find((t: any) => t.employee.id === B.id);
  check('a task is deleted', (await call('DELETE', `/tasks/${theirs.id}`, admin)).status === 200 && (await call('GET', `/tasks?employeeId=${B.id}`, admin)).json.length === 0);
  check('search finds a task by title', (await call('GET', '/tasks?q=harness', admin)).json.some((t: any) => t.id === late.id));
  check('every change is audited', (await prisma.auditLog.count({ where: { entity: 'EmployeeTask', entityId: late.id } })) >= 2);

  await finish();
}

main().catch(e => { console.error(e); process.exit(1); });
