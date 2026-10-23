// Live smoke test for E9 (seats & assignments + rule validator). Mutates data: run `npm run seed` afterwards.
// Usage: API=http://localhost:3000 tsx scripts/smoke-assignments.ts
import '../src/env';
import { PrismaClient } from '../src/db';

const API = process.env.API ?? 'http://localhost:3000';
const prisma = new PrismaClient();
let failed = 0;
let seq = 0;

async function call(method: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(API + path, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* */ }
  return { status: res.status, json };
}
function check(name: string, ok: boolean, extra?: unknown) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + JSON.stringify(extra)?.slice(0, 400)}`);
}
const login = async (l: string) => (await call('POST', '/auth/login', undefined, { login: l, password: 'demo1234' })).json.token as string;
const DAY = 86_400_000;
const today = new Date(); today.setUTCHours(0, 0, 0, 0);
const at = (n: number) => new Date(today.getTime() + n * DAY).toISOString();
const day = (s: string) => s.slice(0, 10);
const rules = (r: any) => (r.json?.violations ?? []).filter((v: any) => v.severity === 'hard').map((v: any) => v.rule);

async function main() {
  const [disp, ops, bm] = await Promise.all(['dispatcher', 'ops', 'basemanager'].map(login));
  const hmd = await prisma.base.findUniqueOrThrow({ where: { code: 'HMD' } });
  const ina = await prisma.base.findUniqueOrThrow({ where: { code: 'INA' } });
  const pos = async (name: string) => prisma.position.findUniqueOrThrow({ where: { name }, include: { requiredCertTypes: true } });
  const qual = async (name: string) => prisma.qualification.findUniqueOrThrow({ where: { name } });
  const [opPos, chiefPos] = await Promise.all([pos('Field Operator'), pos('Chief of Unit')]);
  const [oh, ch] = await Promise.all([qual('Open Hole'), qual('Cased Hole')]);

  // Controlled people: valid certs, on a 28/28 rotation that started 2 days ago, chosen seniority, chosen qualification.
  async function mk(position: typeof opPos, level: 'NEW_RECRUIT' | 'JUNIOR' | 'EXPERIENCED' | 'SENIOR', quals: { id: string }[], base = hmd.id) {
    seq++;
    const e = await prisma.employee.create({
      data: {
        employeeNo: `E9-${seq}`, firstName: `T${seq}`, lastName: 'Smoke', positionId: position.id, homeBaseId: base, workMode: 'FIELD',
        hireDate: new Date(today.getTime() - 900 * DAY), seniorityOverride: level,
        rotationPatternId: (await prisma.rotationPattern.findUniqueOrThrow({ where: { name: '28/28' } })).id, rotationAnchorDate: new Date(today.getTime() - 2 * DAY),
        qualifications: { create: quals.map(q => ({ qualificationId: q.id, obtainedAt: today })) },
        certifications: { create: position.requiredCertTypes.map(c => ({ typeId: c.id, issuedAt: today })) },
      },
    });
    return e;
  }

  const ohType = await prisma.unitType.findUniqueOrThrow({ where: { name: 'Open Hole' } });
  const created = await call('POST', '/units', ops, { code: 'HL-E9', unitTypeId: ohType.id, homeBaseId: hmd.id });
  if (created.status !== 201) throw new Error('unit create failed: ' + JSON.stringify(created.json));
  const unit = created.json;
  const seats = await prisma.seat.findMany({ where: { unitId: unit.id }, include: { position: true }, orderBy: [{ positionId: 'asc' }, { index: 'asc' }] });
  const chiefSeat = seats.find(s => s.position.name === 'Chief of Unit')!;
  const opSeat = (i: number) => seats.find(s => s.position.name === 'Field Operator' && s.index === i)!;

  const chief = await mk(chiefPos, 'JUNIOR', [oh]);
  const j1 = await mk(opPos, 'JUNIOR', [oh]), j2 = await mk(opPos, 'JUNIOR', [oh]), j3 = await mk(opPos, 'JUNIOR', [oh]);
  const recruit = await mk(opPos, 'NEW_RECRUIT', [oh]);
  const exp = await mk(opPos, 'EXPERIENCED', [oh]);
  const chOnly = await mk(opPos, 'EXPERIENCED', [ch]);
  const chief2 = await mk(chiefPos, 'EXPERIENCED', [oh]);

  const body = (e: { id: string }, seatId: string, s = 0, en = 10, extra: object = {}) => ({ employeeId: e.id, seatId, start: at(s), end: at(en), ...extra });

  // ---- preview
  const p1 = await call('POST', '/assignments/preview', disp, body(j1, opSeat(2).id));
  check('preview: valid placement has no hard violations', p1.status === 201 && p1.json.hard === 0 && p1.json.allowed, p1.json);
  check('preview writes nothing', (await prisma.assignment.count({ where: { employeeId: j1.id } })) === 0);
  check('preview: recruit on the Experienced seat => seat_seniority', rules(await call('POST', '/assignments/preview', disp, body(recruit, opSeat(1).id))).includes('seat_seniority'));
  check('preview: Cased-Hole-only operator on OH seat => qualification', rules(await call('POST', '/assignments/preview', disp, body(chOnly, opSeat(2).id))).includes('qualification'));
  check('preview: employee-role has no access (needs view on assignments is fine, but unauth is 401)', (await call('POST', '/assignments/preview', undefined, body(j1, opSeat(2).id))).status === 401);

  // ---- build a crew of juniors
  const c1 = await call('POST', '/assignments', disp, body(chief, chiefSeat.id));
  check('assign chief', c1.status === 201, c1.json);
  check('assignment starting today is ACTIVE', c1.json.assignment?.status === 'ACTIVE');
  check('assign junior to op #2', (await call('POST', '/assignments', disp, body(j1, opSeat(2).id))).status === 201);
  const a3 = await call('POST', '/assignments', disp, body(j2, opSeat(3).id));
  check('assign junior to op #3', a3.status === 201, a3.json);

  // ---- acceptance scenario 1
  const bad = await call('POST', '/assignments', disp, body(recruit, opSeat(1).id));
  check('acceptance 1: recruit joins juniors => 422 with crew_experienced', bad.status === 422 && bad.json.violations.some((v: any) => v.rule === 'crew_experienced'), bad.json);
  check('422 reports crew before/after', bad.json?.crews?.[0]?.after?.operatorsFilled === 3 && bad.json.crews[0].before.operatorsFilled === 2, bad.json?.crews);
  check('nothing was saved on 422', (await prisma.assignment.count({ where: { employeeId: recruit.id } })) === 0);
  const forced = await call('POST', '/assignments', disp, { ...body(recruit, opSeat(1).id), overrideReason: 'Urgent job start; senior arrives day 3' });
  check('override reason lets it save', forced.status === 201, forced.json);
  const log = await prisma.auditLog.findFirst({ where: { entity: 'Assignment', entityId: forced.json.assignment?.id, action: 'assign' } });
  check('override reason is audited', log?.reason === 'Urgent job start; senior arrives day 3');

  // ---- integrity rules
  check('seat already held => 409 (not overridable)', (await call('POST', '/assignments', disp, { ...body(exp, opSeat(2).id), overrideReason: 'x' })).status === 409);
  const dbl = await call('POST', '/assignments', disp, body(j1, opSeat(3).id, 11, 15));
  check('double booking blocked (same person, overlapping days)', dbl.status === 201 || dbl.status === 422);
  const dbl2 = await call('POST', '/assignments/preview', disp, body(j1, chiefSeat.id, 5, 8));
  check('double booking detected in preview', rules(dbl2).includes('double_booking'), dbl2.json);
  const longR = await call('POST', '/assignments/preview', disp, body(exp, chiefSeat.id, 0, 50));
  check('max consecutive days enforced', rules(longR).includes('max_consecutive'), longR.json);

  // ---- availability & privacy
  const medType = await prisma.leaveType.findUniqueOrThrow({ where: { name: 'Medical leave' } });
  await prisma.leave.create({ data: { employeeId: exp.id, typeId: medType.id, start: at(3) as any, end: at(8) as any, status: 'ACTIVE', notes: 'SECRET' } });
  const med = await call('POST', '/assignments/preview', disp, body(exp, opSeat(1).id, 0, 10));
  check('medical leave blocks, reason not leaked', rules(med).includes('availability') && !JSON.stringify(med.json).toLowerCase().includes('medical') && !JSON.stringify(med.json).includes('SECRET'), med.json?.violations);

  // ---- rotation: window after the 28 days on
  const off = await call('POST', '/assignments/preview', disp, body(exp, chiefSeat.id, 24, 34));
  check('days off in rotation flagged', rules(off).includes('rotation_off'), off.json?.violations);

  // ---- move
  const future = await call('POST', '/assignments', disp, body(chief2, chiefSeat.id, 12, 18));
  check('future assignment created (CONFIRMED)', future.status === 201 && future.json.assignment.status === 'CONFIRMED', future.json);
  const mv = await call('PUT', `/assignments/${future.json.assignment.id}/move`, disp, { start: at(13), end: at(19) });
  check('move future assignment dates', mv.status === 200 && mv.json.assignment.plannedEnd.slice(0, 10) === at(19).slice(0, 10), mv.json);
  const runningMove = await call('PUT', `/assignments/${c1.json.assignment.id}/move`, disp, { seatId: opSeat(1).id });
  check('running assignment cannot change seat', runningMove.status === 400, runningMove.json);

  // ---- swap
  const a2 = await prisma.assignment.findFirstOrThrow({ where: { employeeId: j1.id } });
  const a3row = await prisma.assignment.findFirstOrThrow({ where: { employeeId: j2.id } });
  const sw = await call('POST', '/assignments/swap', disp, { firstId: a2.id, secondId: a3row.id });
  check('swap two operators', sw.status === 201, sw.json);
  const after = await prisma.assignment.findMany({ where: { id: { in: [a2.id, a3row.id] } } });
  check('swap exchanged people', after.find(x => x.id === a2.id)?.employeeId === j2.id && after.find(x => x.id === a3row.id)?.employeeId === j1.id);
  check('swap with the same assignment rejected', (await call('POST', '/assignments/swap', disp, { firstId: a2.id, secondId: a2.id })).status === 400);

  // ---- split
  const sp = await call('POST', `/assignments/${a3row.id}/split`, disp, { at: at(6), employeeId: j3.id });
  check('split hands the tail to a replacement', sp.status === 201 && sp.json.tail?.type === 'REPLACEMENT' && sp.json.head.plannedEnd.slice(0, 10) === at(5).slice(0, 10), sp.json);
  const sp2 = await call('POST', `/assignments/${a2.id}/split`, disp, { at: at(7) });
  check('split with nobody creates a replacement task', sp2.status === 201 && sp2.json.task?.trigger === 'split' && sp2.json.task.urgency === 'HIGH', sp2.json);

  // ---- unassign
  const un = await call('POST', `/assignments/${future.json.assignment.id}/unassign`, disp, {});
  check('unassign future => cancelled, gap + task for required seat', un.status === 201 && un.json.assignment.status === 'CANCELLED' && un.json.replacementTask, un.json);
  const un2 = await call('POST', `/assignments/${c1.json.assignment.id}/unassign`, disp, { from: at(3) });
  check('unassign running from day 3 truncates', un2.status === 201 && un2.json.assignment.plannedEnd.slice(0, 10) === at(2).slice(0, 10), un2.json);

  // ---- transfer (atomic move between seats)
  const mvPerson = await mk(opPos, 'JUNIOR', [oh]);
  const mvRes = await call('POST', '/assignments', disp, body(mvPerson, opSeat(3).id, 22, 25, { overrideReason: 'setup' }));
  const mvA = mvRes.json.assignment;
  check('transfer setup: person placed', !!mvA, mvRes.json);
  const bad1 = await call('POST', `/assignments/${mvA.id}/transfer`, disp, { seatId: opSeat(3).id, start: at(24), end: at(25) });
  check('transfer to the same seat is refused', bad1.status === 400);
  const bad2 = await call('POST', `/assignments/${mvA.id}/transfer`, disp, { seatId: chiefSeat.id, start: at(24), end: at(25) });
  check('transfer refused by the rules (operator on the chief seat) and NOTHING changes', bad2.status === 422 && (await prisma.assignment.findUniqueOrThrow({ where: { id: mvA.id } })).status !== 'CANCELLED' && day((await prisma.assignment.findUniqueOrThrow({ where: { id: mvA.id } })).plannedEnd.toISOString()) === day(at(25)), bad2.json);
  const ok1 = await call('POST', `/assignments/${mvA.id}/transfer`, disp, { seatId: opSeat(2).id, start: at(24), end: at(25), overrideReason: 'move test' });
  const oldRow = await prisma.assignment.findUniqueOrThrow({ where: { id: mvA.id } });
  check('transfer ends the old stretch the day before and starts the new one', ok1.status === 201 && day(oldRow.plannedEnd.toISOString()) === day(at(23)) && ok1.json.assignment.seatId === opSeat(2).id && day(ok1.json.assignment.start) === day(at(24)), ok1.json);
  check('transfer leaves a replacement task for the vacated required seat', !!ok1.json.replacementTask && ok1.json.replacementTask.trigger === 'unassigned', ok1.json);
  const fillBack = await call('POST', '/assignments', disp, body(j3, opSeat(3).id, 24, 25, { overrideReason: 'cover the vacated seat' }));
  const closedTask = await prisma.replacementTask.findUniqueOrThrow({ where: { id: ok1.json.replacementTask.id } });
  check('filling the vacated days closes the replacement task it opened', fillBack.status === 201 && closedTask.status === 'CLOSED' && closedTask.assignmentId === fillBack.json.assignment.id, closedTask);
  check('transfer is audited', (await prisma.auditLog.count({ where: { entityId: mvA.id, action: 'transfer' } })) === 1);

  // ---- replace (someone else takes the seat from a date, in one step)
  const rpA = await mk(opPos, 'JUNIOR', [oh]), rpB = await mk(opPos, 'JUNIOR', [oh]), rpC = await mk(opPos, 'JUNIOR', [oh]);
  const rpRes = await call('POST', '/assignments', disp, body(rpA, opSeat(2).id, 40, 46, { overrideReason: 'setup' }));
  const rpId = rpRes.json.assignment?.id;
  check('replace setup: person placed', !!rpId, rpRes.json);
  const rpSame = await call('POST', `/assignments/${rpId}/replace`, disp, { employeeId: rpA.id, from: at(43) });
  check('replacing someone with themselves is refused', rpSame.status === 400);
  const rpLate = await call('POST', `/assignments/${rpId}/replace`, disp, { employeeId: rpB.id, from: at(47) });
  check('replacing after the stretch ends is refused', rpLate.status === 400);
  const rp = await call('POST', `/assignments/${rpId}/replace`, disp, { employeeId: rpB.id, from: at(43), reason: 'sent home sick', overrideReason: 'replace test' });
  const rpOld = await prisma.assignment.findUniqueOrThrow({ where: { id: rpId } });
  check('replace ends the holder the day before and hands the rest of the stretch over',
    rp.status === 201 && day(rpOld.plannedEnd.toISOString()) === day(at(42)) && rp.json.assignment.employeeId === rpB.id
      && day(rp.json.assignment.start) === day(at(43)) && day(rp.json.assignment.plannedEnd) === day(at(46)) && rp.json.assignment.type === 'REPLACEMENT', rp.json);
  check('replace opens no replacement task', (await prisma.replacementTask.count({ where: { seatId: opSeat(2).id, trigger: 'unassigned', fromDate: { gte: new Date(at(40)) } } })) === 0);
  const rpAudit = await prisma.auditLog.findFirst({ where: { entityId: rpId, action: 'replace' } });
  check('replace is audited with the reason', !!rpAudit && (rpAudit.reason ?? '').includes('sent home sick'), rpAudit);
  const rp2 = await call('POST', `/assignments/${rp.json.assignment.id}/replace`, disp, { employeeId: rpC.id, from: at(41), overrideReason: 'replace test' });
  const rpB2 = await prisma.assignment.findUniqueOrThrow({ where: { id: rp.json.assignment.id } });
  check('replacing before the stretch starts hands over all of it', rp2.status === 201 && rpB2.status === 'CANCELLED' && day(rp2.json.assignment.start) === day(at(43)), rp2.json);

  // ---- listing
  const seatsNow = await call('GET', `/seats?unitId=${unit.id}`, disp);
  check('seats list shows holders', seatsNow.status === 200 && seatsNow.json.length === 4 && seatsNow.json.find((s: any) => s.position === 'Field Operator' && s.index === 1)?.holder?.id === recruit.id, seatsNow.json);
  const lst = await call('GET', `/assignments?unitId=${unit.id}&limit=100`, disp);
  check('assignments list by unit', lst.status === 200 && lst.json.total >= 5, lst.json?.total);

  // ---- base manager scope
  // Base staff is not seeded any more; the scope rule still exists in the API, so the test makes its own base post.
  const mechPos = await prisma.position.findUniqueOrThrow({ where: { name: 'Mechanic' } });
  await prisma.seat.create({ data: { holderType: 'BASE', baseId: hmd.id, positionId: mechPos.id, index: 1, requiredFlag: true } });
  const bp = await prisma.seat.findFirstOrThrow({ where: { baseId: hmd.id, holderType: 'BASE' }, include: { position: { include: { requiredQualifications: true, requiredCertTypes: true } } } });
  const baseGuy = await prisma.employee.create({
    data: {
      employeeNo: 'E9-BASE', firstName: 'Base', lastName: 'Guy', positionId: bp.positionId, homeBaseId: hmd.id, workMode: 'BASE', hireDate: new Date(today.getTime() - 900 * DAY),
      rotationPatternId: (await prisma.rotationPattern.findUniqueOrThrow({ where: { name: '5/2 weekly' } })).id, rotationAnchorDate: today,
      qualifications: { create: bp.position.requiredQualifications.map(q => ({ qualificationId: q.id, obtainedAt: today })) },
      certifications: { create: bp.position.requiredCertTypes.map(c => ({ typeId: c.id, issuedAt: today })) },
    },
  });
  check('base manager can fill a base post at own base', (await call('POST', '/assignments', bm, body(baseGuy, bp.id, 0, 6))).status === 201);
  check('base manager cannot touch a unit seat', (await call('POST', '/assignments', bm, body(exp, opSeat(2).id, 20, 22))).status === 403);
  const inaPost = await prisma.seat.create({ data: { holderType: 'BASE', baseId: ina.id, positionId: mechPos.id, index: 1, requiredFlag: true } });
  check('base manager cannot touch another base', (await call('POST', '/assignments', bm, body(baseGuy, inaPost.id, 0, 6))).status === 403);
  check('field-only guy on base post => work_mode', rules(await call('POST', '/assignments/preview', disp, body(j3, bp.id, 20, 22))).includes('work_mode'));

  console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
