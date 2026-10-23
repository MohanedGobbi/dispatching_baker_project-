import {
  BadRequestException, Body, Controller, Get, Inject, Module, NotFoundException, Param, Post, Res, UnprocessableEntityException,
} from '@nestjs/common';
import type { Response } from 'express';
import ExcelJS from 'exceljs';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsModule, SettingsService } from '../settings/settings';
import { audit } from '../common/validate';
import { startOfDay } from '../domain/status';
import { createUnitWithSeats } from '../units/units';
import { Cell, COLUMNS, Existing, Kind, KINDS, KEY_COLUMN, Lookups, mapHeaders, RowResult, SENIORITY, summarize, validateRows, WORK_MODES } from './sheets';

const SHEET: Record<Kind, string> = { bases: 'Bases', units: 'Units', employees: 'Employees' };
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 5000;
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function cellValue(v: ExcelJS.CellValue): Cell {
  if (v === null || v === undefined) return null;
  if (v instanceof Date || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'object') {
    if ('richText' in v) return v.richText.map(t => t.text).join('');
    if ('formula' in v || 'sharedFormula' in v) return cellValue((v as ExcelJS.CellFormulaValue).result as ExcelJS.CellValue);
    if ('text' in v) return String((v as ExcelJS.CellHyperlinkValue).text);
    if ('error' in v) return null;
  }
  return String(v);
}

/** Excel import and export (plan E27): templates, a validation report before anything is written, then commit. */
@Controller('transfer')
class TransferController {
  constructor(@Inject(PrismaService) private prisma: PrismaService, @Inject(SettingsService) private settings: SettingsService) {}

  private kind(k: string): Kind {
    if (!KINDS.includes(k as Kind)) throw new NotFoundException(`Unknown sheet "${k}". Use one of ${KINDS.join(', ')}`);
    return k as Kind;
  }

  @Get(':kind/template')
  async template(@Param('kind') k: string, @Res() res: Response) {
    const kind = this.kind(k);
    await this.send(res, await this.workbook(kind, []), `crewboard-${kind}-template.xlsx`);
  }

  /** The same columns as the template, so an export can be edited and imported back. */
  @Get(':kind/export')
  async export(@Param('kind') k: string, @Res() res: Response) {
    const kind = this.kind(k);
    const [rows, names] = await Promise.all([this.existing(kind), this.names()]);
    const display = [...rows.values()].map(({ values: v }) => {
      const out: Record<string, unknown> = {};
      for (const c of COLUMNS[kind]) {
        if (c.type === 'ref') out[c.key] = names[c.ref!.lookup].get(v[c.ref!.field] as string) ?? null;
        else if (c.type === 'list') out[c.key] = ((v.qualificationIds as string[]) ?? []).map(id => names.qualifications.get(id)).filter(Boolean).join(', ');
        else if (c.type === 'bool') out[c.key] = v[c.key] === false ? 'no' : 'yes';
        else out[c.key] = v[c.key] ?? null;
      }
      return out;
    }).sort((a, b) => String(a[KEY_COLUMN[kind]]).localeCompare(String(b[KEY_COLUMN[kind]])));
    await audit(this.prisma, 'Export', kind, 'export', null, { rows: display.length });
    await this.send(res, await this.workbook(kind, display), `crewboard-${kind}-${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  /** Check a filled template. Nothing is written; the answer says, row by row, what commit would do. */
  @Post(':kind/validate')
  async validate(@Param('kind') k: string, @Body() body: { file?: string }) {
    const kind = this.kind(k);
    const { report } = await this.check(kind, body?.file);
    return report;
  }

  /** Write the valid rows. Refused while any row has an error, unless skipInvalid is set. */
  @Post(':kind/commit')
  async commit(@Param('kind') k: string, @Body() body: { file?: string; skipInvalid?: boolean }) {
    const kind = this.kind(k);
    const { report, rows } = await this.check(kind, body?.file);
    if (report.fatal.length) throw new BadRequestException({ message: report.fatal.join('; '), report });
    if (report.summary.errors && body.skipInvalid !== true) throw new UnprocessableEntityException({ message: `${report.summary.errors} row(s) have errors. Fix them or import the others with skipInvalid.`, report });

    const todo = rows.filter(r => r.action === 'create' || r.action === 'update');
    const written = await this.apply(kind, todo);
    await this.prisma.auditLog.createMany({
      data: written.map(w => ({ entity: SHEET[kind].slice(0, -1), entityId: w.id, action: w.created ? 'import_create' : 'import_update', after: w.after as never })),
    });
    const summary = { created: written.filter(w => w.created).length, updated: written.filter(w => !w.created).length, skipped: report.summary.errors, unchanged: report.summary.unchanged };
    await audit(this.prisma, 'Import', kind, 'import', null, summary);
    return { ...summary, report };
  }

  // ---------- helpers

  private async check(kind: Kind, file: unknown) {
    if (typeof file !== 'string' || !file) throw new BadRequestException('Send the workbook as base64 in "file"');
    const bytes = Buffer.from(file.replace(/^data:[^,]*,/, ''), 'base64');
    if (bytes.length > MAX_BYTES) throw new BadRequestException('The file is larger than 5 MB');
    const wb = new ExcelJS.Workbook();
    try { await wb.xlsx.load(bytes as never); } catch { throw new BadRequestException('This is not an Excel (.xlsx) file'); }
    const ws = wb.getWorksheet(SHEET[kind]) ?? wb.worksheets.find(w => !['Read me', 'Lists'].includes(w.name));
    if (!ws) throw new BadRequestException('The workbook has no data sheet');

    const width = ws.getRow(1).cellCount;
    const read = (r: ExcelJS.Row) => Array.from({ length: width }, (_, i) => cellValue(r.getCell(i + 1).value));
    const headers = read(ws.getRow(1));
    const { index, unknown, missing } = mapHeaders(kind, headers);
    const data: Cell[][] = [];
    for (let n = 2; n <= ws.rowCount; n++) data.push(read(ws.getRow(n)));
    // Drop-down validation makes empty rows exist in the file; only rows up to the last filled one count.
    while (data.length && data[data.length - 1].every(v => v === null || (typeof v === 'string' && !v.trim()))) data.pop();
    const fatal: string[] = [];
    if (missing.length) fatal.push(`Missing column(s): ${missing.join(', ')}`);
    if (data.length > MAX_ROWS) fatal.push(`More than ${MAX_ROWS} rows; split the file`);
    const rows = fatal.length ? [] : validateRows(kind, data, index, await this.lookups(), await this.existing(kind));
    const report = {
      sheet: ws.name, fatal, ignoredColumns: unknown, summary: summarize(rows),
      // Unchanged rows are only counted; the list shows what needs attention or will change.
      rows: rows.filter(r => r.action !== 'unchanged').map(r => ({ row: r.row, key: r.key, action: r.action, errors: r.errors, warnings: r.warnings, changes: r.changes })),
    };
    return { report, rows };
  }

  private async apply(kind: Kind, rows: RowResult[]): Promise<{ id: string; created: boolean; after: Record<string, unknown> }[]> {
    const today = startOfDay(new Date());
    const minExperienced = (await this.settings.all())['rules.minExperiencedPerCrew'] as number;
    const types = kind === 'units' ? await this.prisma.unitType.findMany({ include: { crewSeats: { include: { position: true, requiredQual: true } } } }) : [];
    return this.prisma.$transaction(async tx => {
      const out: { id: string; created: boolean; after: Record<string, unknown> }[] = [];
      for (const r of rows) {
        const { qualificationIds, ...fields } = r.data as Record<string, unknown> & { qualificationIds?: string[] };
        let id = r.id;
        if (kind === 'bases') {
          id = r.id ? (await tx.base.update({ where: { id: r.id }, data: fields as never })).id : (await tx.base.create({ data: fields as never })).id;
        } else if (kind === 'units') {
          if (r.id) await tx.unit.update({ where: { id: r.id }, data: fields as never });
          else id = (await createUnitWithSeats(tx, fields, types.find(t => t.id === fields.unitTypeId)!, minExperienced)).id;
        } else {
          if (r.id) await tx.employee.update({ where: { id: r.id }, data: fields as never });
          else id = (await tx.employee.create({ data: fields as never })).id;
          if (qualificationIds) {
            await tx.employeeQualification.deleteMany({ where: { employeeId: id!, qualificationId: { notIn: qualificationIds } } });
            const have = new Set((await tx.employeeQualification.findMany({ where: { employeeId: id! }, select: { qualificationId: true } })).map(q => q.qualificationId));
            const add = qualificationIds.filter(q => !have.has(q));
            if (add.length) await tx.employeeQualification.createMany({ data: add.map(q => ({ employeeId: id!, qualificationId: q, obtainedAt: today, validatedBy: 'import' })) });
          }
        }
        out.push({ id: id!, created: !r.id, after: { row: r.row, changes: r.changes, ...r.data } });
      }
      return out;
    }, { timeout: 120_000 });
  }

  private async lookups(): Promise<Lookups> {
    const [bases, positions, unitTypes, rotations, quals] = await Promise.all([
      this.prisma.base.findMany({ select: { id: true, code: true } }), this.prisma.position.findMany({ select: { id: true, name: true } }),
      this.prisma.unitType.findMany({ select: { id: true, name: true } }), this.prisma.rotationPattern.findMany({ select: { id: true, name: true } }),
      this.prisma.qualification.findMany({ select: { id: true, name: true } }),
    ]);
    const byName = (rows: { id: string; name: string }[]) => new Map(rows.map(r => [r.name.trim().toLowerCase().replace(/\s+/g, ' '), r.id]));
    return { bases: new Map(bases.map(b => [b.code.toUpperCase(), b.id])), positions: byName(positions), unitTypes: byName(unitTypes), rotations: byName(rotations), qualifications: byName(quals) };
  }

  /** id -> display name for each lookup, for exports. */
  private async names() {
    const [bases, positions, unitTypes, rotations, quals] = await Promise.all([
      this.prisma.base.findMany(), this.prisma.position.findMany(), this.prisma.unitType.findMany(), this.prisma.rotationPattern.findMany(), this.prisma.qualification.findMany(),
    ]);
    const m = (rows: { id: string; name: string }[]) => new Map(rows.map(r => [r.id, r.name]));
    return { bases: new Map(bases.map(b => [b.id, b.code])), positions: m(positions), unitTypes: m(unitTypes), rotations: m(rotations), qualifications: m(quals) };
  }

  private async existing(kind: Kind): Promise<Existing> {
    const pick = (o: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.map(k => [k, o[k] ?? null]));
    if (kind === 'bases') {
      const rows = await this.prisma.base.findMany();
      return new Map(rows.map(b => [b.code.toUpperCase(), { id: b.id, values: pick(b, ['code', 'name', 'city', 'address', 'lat', 'lng', 'phone', 'unitCapacity', 'bedCapacity', 'active']) }]));
    }
    if (kind === 'units') {
      const rows = await this.prisma.unit.findMany();
      return new Map(rows.map(u => [u.code.toUpperCase(), { id: u.id, values: pick(u, ['code', 'unitTypeId', 'homeBaseId', 'plate', 'model', 'year', 'notes']) }]));
    }
    const rows = await this.prisma.employee.findMany({ include: { qualifications: { select: { qualificationId: true } } } });
    return new Map(rows.map(e => [e.employeeNo.toUpperCase(), {
      id: e.id,
      values: {
        ...pick(e, ['employeeNo', 'firstName', 'lastName', 'positionId', 'homeBaseId', 'hireDate', 'workMode', 'contractType', 'rotationPatternId', 'rotationAnchorDate', 'priorFieldDays', 'seniorityOverride', 'email', 'phone', 'homeCity', 'active']),
        qualificationIds: e.qualifications.map(q => q.qualificationId),
      },
    }]));
  }

  private async workbook(kind: Kind, rows: Record<string, unknown>[]) {
    const names = await this.names();
    const wb = new ExcelJS.Workbook();
    wb.creator = 'CrewBoard';
    const ws = wb.addWorksheet(SHEET[kind], { views: [{ state: 'frozen', ySplit: 1 }] });
    const cols = COLUMNS[kind];
    ws.columns = cols.map(c => ({ header: c.required ? `${c.header} *` : c.header, key: c.key, width: Math.max(14, c.header.length + 4), style: c.type === 'date' ? { numFmt: 'yyyy-mm-dd' } : {} }));
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF9' } };
    cols.forEach((c, i) => { if (c.hint) ws.getRow(1).getCell(i + 1).note = c.hint; });
    for (const r of rows) ws.addRow(r);

    // Lists the drop-downs point at. Typing something else is allowed; the import reports it.
    const lists: [string, string[]][] = [
      ['Bases', [...names.bases.values()].sort()], ['Positions', [...names.positions.values()].sort()], ['Unit types', [...names.unitTypes.values()].sort()],
      ['Rotation patterns', [...names.rotations.values()].sort()], ['Qualifications', [...names.qualifications.values()].sort()],
      ['Work modes', WORK_MODES], ['Seniority', SENIORITY], ['Yes / no', ['yes', 'no']],
    ];
    const ls = wb.addWorksheet('Lists');
    lists.forEach(([title, values], i) => {
      const col = ls.getColumn(i + 1);
      col.width = Math.max(16, title.length + 4);
      ls.getCell(1, i + 1).value = title; ls.getCell(1, i + 1).font = { bold: true };
      values.forEach((v, j) => { ls.getCell(j + 2, i + 1).value = v; });
    });
    const listFor = (c: (typeof cols)[number]) => c.type === 'bool' ? 'Yes / no' : c.type === 'enum' ? (c.values === WORK_MODES ? 'Work modes' : 'Seniority')
      : c.type === 'ref' ? { bases: 'Bases', positions: 'Positions', unitTypes: 'Unit types', rotations: 'Rotation patterns', qualifications: 'Qualifications' }[c.ref!.lookup] : null;
    const last = Math.max(rows.length + 500, 1000);
    cols.forEach((c, i) => {
      const list = listFor(c);
      if (!list) return;
      const li = lists.findIndex(([t]) => t === list);
      const letter = ls.getColumn(li + 1).letter;
      const range = `Lists!$${letter}$2:$${letter}$${Math.max(lists[li][1].length + 1, 2)}`;
      const colLetter = ws.getColumn(i + 1).letter;
      for (let r = 2; r <= last; r++) ws.getCell(`${colLetter}${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: [range], showErrorMessage: false };
    });

    const rm = wb.addWorksheet('Read me');
    rm.columns = [{ header: 'Column', width: 24 }, { header: 'Required', width: 10 }, { header: 'What to enter', width: 90 }];
    rm.getRow(1).font = { bold: true };
    for (const c of cols) rm.addRow([c.header, c.required ? 'yes' : '', c.hint]);
    rm.addRow([]);
    rm.addRow(['How it works', '', `One row per ${kind === 'employees' ? 'person' : kind.slice(0, -1)}. A row whose ${cols.find(c => c.key === KEY_COLUMN[kind])!.header.toLowerCase()} already exists updates it; empty cells keep what is stored. Upload the file in CrewBoard: it is checked first and nothing is written until you confirm.`]);
    return wb;
  }

  private async send(res: Response, wb: ExcelJS.Workbook, filename: string) {
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    res.set({ 'content-type': XLSX, 'content-length': String(buf.length), 'content-disposition': `attachment; filename="${filename}"`, 'cache-control': 'private, no-store' });
    res.send(buf);
  }
}

@Module({ imports: [SettingsModule], controllers: [TransferController] })
export class TransferModule {}
