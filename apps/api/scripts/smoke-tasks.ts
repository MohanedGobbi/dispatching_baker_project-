// Live checks for the employee side: tasks from the manager, the portal's To do list, who may see and change what.
// Isolated: the people it uses are created here.
import '../src/env';
import { at, call, check, day, finish, login, mkEmployee, mkUser, prisma } from './lib';

async function main() {
  const admin = await login('admin');
  const disp = await login('dispatcher');
  const A = await mkEmployee({ position: 'Field Operator', level: 'JUNIOR', quals: [], base: 'HMD' });
  const B = await mkEmployee({ position: 'Field Operator', level: 'JUNIOR', quals: [], base: 'HMD' });
  const ua = await mkUser(A.id), ub = await mkUser(B.id);
  const [ta, tb] = [await login(ua.login), await login(ub.login)];

  check('a task needs a person and a title', (await call('POST', '/tasks', admin, { employeeIds: [], title: 'x' })).status === 400 && (await call('POST', '/tasks', admin, { employeeIds: [A.id], title: ' ' })).status === 400);
  check('an employee cannot give tasks', (await call('POST', '/tasks', ta, { employeeIds: [B.id], title: 'x' })).status === 403);
  const made = await call('POST', '/tasks', admin, { employeeIds: [A.id, B.id], title: 'Bring your medical certificate', notes: 'To the HMD office', dueDate: at(3) });
  check('one task per person', made.status === 201 && made.json.length === 2 && made.json[0].dueDate === day(at(3)), made.json);
  const late = (await call('POST', '/tasks', admin, { employeeIds: [A.id], title: 'Return the safety harness', dueDate: at(-1) })).json[0];
  check('a task past its date is overdue', late.overdue === true);
  const inbox = (await call('GET', '/notifications?limit=50', ta)).json.items;
  check('the person is told', inbox.some((n: any) => n.type === 'task_assigned' && n.body.includes('Bring your medical certificate')));

  const mine = (await call('GET', '/tasks', ta)).json;
  check('a person sees only their own tasks', mine.length === 2 && mine.every((t: any) => t.employee.id === A.id));
  check('…even when asking for someone else\'s', (await call('GET', `/tasks?employeeId=${B.id}`, ta)).json.every((t: any) => t.employee.id === A.id));
  const theirs = made.json.find((t: any) => t.employee.id === B.id);
  check('a person cannot touch someone else\'s task', (await call('PUT', `/tasks/${theirs.id}`, ta, { status: 'DONE' })).status === 403);
  check('a person cannot rename their task', (await call('PUT', `/tasks/${late.id}`, ta, { title: 'nothing' })).status === 403);

  const todo = (await call('GET', '/tasks/todo', ta)).json;
  check('To do lists the open tasks, latest-due first', todo.tasks.length === 2 && todo.tasks[0].title === 'Return the safety harness', todo);
  const done = await call('PUT', `/tasks/${late.id}`, ta, { status: 'DONE', doneNote: 'Left it at the store' });
  check('the person marks a task done with a note', done.status === 200 && done.json.status === 'DONE' && done.json.doneNote === 'Left it at the store');
  check('the manager hears about it', (await call('GET', '/notifications?limit=50', admin)).json.items.some((n: any) => n.type === 'task_done' && n.body.includes('Return the safety harness')));
  check('To do no longer lists it', (await call('GET', '/tasks/todo', ta)).json.tasks.length === 1);

  const all = (await call('GET', `/tasks?employeeId=${A.id}`, admin)).json;
  check('the manager sees every task of a person, open first', all.length === 2 && all[0].status === 'OPEN');
  check('the manager edits a task', (await call('PUT', `/tasks/${all[0].id}`, admin, { dueDate: at(10), title: 'Bring your medical certificate (original)' })).json.dueDate === day(at(10)));
  check('the manager deletes a task', (await call('DELETE', `/tasks/${theirs.id}`, admin)).status === 200 && (await call('GET', '/tasks', tb)).json.length === 0);
  check('a dispatcher (staff role kept for tests) can also assign', (await call('POST', '/tasks', disp, { employeeIds: [B.id], title: 'Check the tool box' })).status === 201);
  check('a staff account with no employee has no To do', (await call('GET', '/tasks/todo', admin)).status === 403);
  check('every change is audited', (await prisma.auditLog.count({ where: { entity: 'EmployeeTask', entityId: late.id } })) >= 2);

  await finish();
}

main().catch(e => { console.error(e); process.exit(1); });
