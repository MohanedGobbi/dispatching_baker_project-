// Live checks for E27: Excel templates, export -> edit -> validate -> commit, and the validation report.
// Isolated: rows it adds use codes starting with TRF.
import '../src/env';
import ExcelJS from 'exceljs';
import { API, prisma, call, check, login, finish } from './lib';

async function download(path: string, token: string) {
  const res = await fetch(API + path, { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, type: res.headers.get('content-type') ?? '', bytes: Buffer.from(await res.arrayBuffer()) };
}
const load = async (bytes: Buffer) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(bytes as never); return wb; };
const b64 = async (wb: ExcelJS.Workbook) => Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
/** Column number of a header in row 1 (headers of required columns end with " *"). */
const colOf = (ws: ExcelJS.Worksheet, header: string) => {
  let at = 0;
  ws.getRow(1).eachCell((c, n) => { if (String(c.value).replace(/ \*$/, '') === header) at = n; });
  return at;
};

async function main() {
  const [hr, disp, ops, admin] = await Promise.all(['hr', 'dispatcher', 'ops', 'admin'].map(login));
  const emp = await login('employee');
  const tag = `TRF${Date.now() % 1e5}`;

  // ================= access =================
  check('unknown sheet => 404', (await download('/transfer/rigs/template', admin)).status === 404);

  // ================= template =================
  const tpl = await download('/transfer/employees/template', hr);
  check('template is an xlsx', tpl.status === 200 && tpl.type.includes('spreadsheetml'));
  const twb = await load(tpl.bytes);
  check('template has data, Lists and Read me sheets', ['Employees', 'Lists', 'Read me'].every(n => twb.getWorksheet(n)));
  check('required columns are marked', String(twb.getWorksheet('Employees')!.getRow(1).getCell(1).value) === 'Employee number *');
  const lists = twb.getWorksheet('Lists')!;
  check('Lists sheet carries the positions', lists.getColumn(2).values.includes('Field Operator'));

  // ================= export -> validate unchanged =================
  const ex = await download('/transfer/employees/export', hr);
  const wb = await load(ex.bytes);
  const ws = wb.getWorksheet('Employees')!;
  const total = await prisma.employee.count();
  check('export has a row per person', ws.actualRowCount - 1 === total, { rows: ws.actualRowCount - 1, total });
  const same = await call('POST', '/transfer/employees/validate', hr, { file: await b64(wb) });
  check('a fresh export re-imports as all unchanged', same.status === 201 && same.json.summary.unchanged === total && same.json.summary.errors === 0 && same.json.rows.length === 0, same.json.summary);

  // ================= edit: one change, one new person, one bad row =================
  const c = (h: string) => colOf(ws, h);
  const target = ws.getRow(2);
  const targetNo = String(target.getCell(c('Employee number')).value);
  target.getCell(c('Last name')).value = 'Imported';
  const n = ws.actualRowCount + 1;
  const put = (row: number, values: Record<string, unknown>) => { for (const [h, v] of Object.entries(values)) ws.getRow(row).getCell(c(h)).value = v as ExcelJS.CellValue; };
  put(n, { 'Employee number': `${tag}-1`, 'First name': 'Nadia', 'Last name': 'Import', Position: 'Field Operator', 'Home base': 'HMD', 'Hire date': new Date(Date.UTC(2021, 4, 2)), 'Rotation pattern': '28/28', 'Rotation anchor date': '2026-10-01', Qualifications: 'Open Hole, Cased Hole', Email: 'nadia@example.test', Active: 'yes' });
  put(n + 1, { 'Employee number': `${tag}-2`, 'First name': 'Bad', 'Last name': 'Row', Position: 'Astronaut', 'Home base': 'HMD', 'Hire date': '31/02/2021' });
  const file = await b64(wb);
  const rep = await call('POST', '/transfer/employees/validate', hr, { file });
  const bad = rep.json.rows.find((r: any) => r.key === `${tag}-2`);
  check('report: 1 new, 1 changed, 1 with errors', rep.json.summary.create === 1 && rep.json.summary.update === 1 && rep.json.summary.errors === 1, rep.json.summary);
  check('report names the row and every problem', bad?.row === n + 1 && bad.errors.some((e: string) => e.includes('Astronaut')) && bad.errors.some((e: string) => e.includes('Hire date')), bad);
  check('report lists what changes on an update', rep.json.rows.find((r: any) => r.key === targetNo)?.changes.join() === 'lastName');
  check('validate writes nothing', !(await prisma.employee.findUnique({ where: { employeeNo: `${tag}-1` } })));
  const refused = await call('POST', '/transfer/employees/commit', hr, { file });
  check('commit is refused while a row has errors (422)', refused.status === 422 && refused.json.report.summary.errors === 1);
  const done = await call('POST', '/transfer/employees/commit', hr, { file, skipInvalid: true });
  check('skipInvalid imports the valid rows', done.status === 201 && done.json.created === 1 && done.json.updated === 1 && done.json.skipped === 1, done.json);
  const nadia = await prisma.employee.findUnique({ where: { employeeNo: `${tag}-1` }, include: { qualifications: true, rotationPattern: true } });
  check('new person stored with references, rotation sheet and qualifications', nadia?.rotationPattern?.name === '28/28' && nadia.rotationAnchorDate?.toISOString().slice(0, 10) === '2026-10-01' && nadia.qualifications.length === 2 && nadia.hireDate.toISOString().slice(0, 10) === '2021-05-02');
  check('the change landed', (await prisma.employee.findUnique({ where: { employeeNo: targetNo } }))?.lastName === 'Imported');
  check('each written row is audited', (await prisma.auditLog.count({ where: { entity: 'Employee', entityId: nadia!.id, action: 'import_create' } })) === 1
    && (await prisma.auditLog.count({ where: { entity: 'Import', entityId: 'employees', action: 'import' } })) >= 1);
  check('re-importing the same file changes nothing more', (await call('POST', '/transfer/employees/validate', hr, { file })).json.summary.unchanged === total + 1);
  check('the new person shows in the employee list', (await call('GET', `/employees?q=${tag}-1`, hr)).json.total === 1);

  // ================= units: new unit gets its crew seats =================
  const uwb = await load((await download('/transfer/units/template', ops)).bytes);
  const us = uwb.getWorksheet('Units')!;
  us.getRow(2).values = [`${tag}-U`, 'Open Hole', 'INA', 'P-123', '', 2024, ''];
  const existingUnit = await prisma.unit.findFirstOrThrow({ include: { unitType: true } });
  const otherType = (await prisma.unitType.findFirstOrThrow({ where: { id: { not: existingUnit.unitTypeId } } })).name;
  us.getRow(3).values = [existingUnit.code, otherType, '', '', '', '', ''];
  const ufile = await b64(uwb);
  const urep = await call('POST', '/transfer/units/validate', ops, { file: ufile });
  check('changing a unit type by import is refused', urep.json.rows.find((r: any) => r.key === existingUnit.code)?.errors[0]?.includes('Unit type'), urep.json.rows);
  const ucommit = await call('POST', '/transfer/units/commit', ops, { file: ufile, skipInvalid: true });
  const unit = await prisma.unit.findUnique({ where: { code: `${tag}-U` }, include: { seats: true, unitType: { include: { crewSeats: true } } } });
  check('new unit created with the crew seats of its type', ucommit.json.created === 1 && !!unit && unit.seats.length === unit.unitType.crewSeats.reduce((s, t) => s + t.count, 0) && unit.seats.length > 0, ucommit.json);

  // ================= bases and malformed files =================
  const bwb = new ExcelJS.Workbook();
  const bs = bwb.addWorksheet('Bases');
  bs.addRow(['code', 'name', 'latitude', 'longitude', 'active']);
  bs.addRow([`${tag}b`, 'Import base', '29,1', 6.2, 'Y']);
  const bcommit = await call('POST', '/transfer/bases/commit', ops, { file: await b64(bwb) });
  const base = await prisma.base.findUnique({ where: { code: `${tag}B` } });
  check('a hand-made sheet works: headers by key, code upper-cased, decimal comma, "Y"', bcommit.status === 201 && base?.lat === 29.1 && base.active === true, bcommit.json);
  const nwb = new ExcelJS.Workbook(); nwb.addWorksheet('Employees').addRow(['Employee number', 'First name']);
  const missing = await call('POST', '/transfer/employees/validate', hr, { file: await b64(nwb) });
  check('missing required columns are reported up front', missing.status === 201 && missing.json.fatal[0]?.includes('Last name'));
  check('missing columns block commit (400)', (await call('POST', '/transfer/employees/commit', hr, { file: await b64(nwb) })).status === 400);
  check('not an xlsx => 400', (await call('POST', '/transfer/employees/validate', hr, { file: Buffer.from('hello').toString('base64') })).status === 400);

  await finish();
}

main().catch(e => { console.error(e); process.exit(1); });
