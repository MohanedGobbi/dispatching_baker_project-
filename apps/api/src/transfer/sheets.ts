// Excel import/export (plan E27, section 31): column definitions per sheet and row validation. Pure: the lookups
// come in as plain maps, so this is unit tested without a database or a workbook.

export type Kind = 'bases' | 'units' | 'employees';
export const KINDS: Kind[] = ['bases', 'units', 'employees'];

type ColType = 'string' | 'number' | 'int' | 'date' | 'bool' | 'list' | 'enum' | 'email' | 'ref';
export interface Column {
  key: string; header: string; type: ColType; required?: boolean; hint: string
  /** For enum columns: the allowed values. */ values?: string[]
  /** For ref columns: which lookup resolves the name/code to an id, and the field it fills. */ ref?: { lookup: keyof Lookups; field: string }
}

export const SENIORITY = ['NEW_RECRUIT', 'JUNIOR', 'EXPERIENCED', 'SENIOR'];
export const WORK_MODES = ['FIELD', 'BASE', 'FLEXIBLE'];

export const COLUMNS: Record<Kind, Column[]> = {
  bases: [
    { key: 'code', header: 'Code', type: 'string', required: true, hint: 'Unique short code, e.g. HMD. Rows with an existing code update that base.' },
    { key: 'name', header: 'Name', type: 'string', required: true, hint: 'Full name' },
    { key: 'city', header: 'City', type: 'string', hint: '' },
    { key: 'address', header: 'Address', type: 'string', hint: '' },
    { key: 'lat', header: 'Latitude', type: 'number', hint: 'Decimal degrees, for the map' },
    { key: 'lng', header: 'Longitude', type: 'number', hint: 'Decimal degrees, for the map' },
    { key: 'phone', header: 'Phone', type: 'string', hint: '' },
    { key: 'unitCapacity', header: 'Unit capacity', type: 'int', hint: 'Units the yard can hold' },
    { key: 'bedCapacity', header: 'Bed capacity', type: 'int', hint: '' },
    { key: 'active', header: 'Active', type: 'bool', hint: 'yes / no (default yes)' },
  ],
  units: [
    { key: 'code', header: 'Code', type: 'string', required: true, hint: 'Unique unit code, e.g. HL-6700. Rows with an existing code update that unit.' },
    { key: 'unitType', header: 'Unit type', type: 'ref', required: true, ref: { lookup: 'unitTypes', field: 'unitTypeId' }, hint: 'Decides the crew seats. Cannot change on an existing unit.' },
    { key: 'homeBase', header: 'Home base', type: 'ref', required: true, ref: { lookup: 'bases', field: 'homeBaseId' }, hint: 'Base code. Cannot change on an existing unit (use a transfer).' },
    { key: 'plate', header: 'Plate', type: 'string', hint: '' },
    { key: 'model', header: 'Model', type: 'string', hint: '' },
    { key: 'year', header: 'Year', type: 'int', hint: '' },
    { key: 'notes', header: 'Notes', type: 'string', hint: '' },
  ],
  employees: [
    { key: 'employeeNo', header: 'Employee number', type: 'string', required: true, hint: 'Unique. Rows with an existing number update that person.' },
    { key: 'firstName', header: 'First name', type: 'string', required: true, hint: '' },
    { key: 'lastName', header: 'Last name', type: 'string', required: true, hint: '' },
    { key: 'position', header: 'Position', type: 'ref', required: true, ref: { lookup: 'positions', field: 'positionId' }, hint: 'One of the positions in the Lists sheet' },
    { key: 'homeBase', header: 'Home base', type: 'ref', required: true, ref: { lookup: 'bases', field: 'homeBaseId' }, hint: 'Base code' },
    { key: 'hireDate', header: 'Hire date', type: 'date', required: true, hint: 'Date cell, or YYYY-MM-DD, or DD/MM/YYYY' },
    { key: 'workMode', header: 'Work mode', type: 'enum', values: WORK_MODES, hint: 'FIELD (default), BASE or FLEXIBLE' },
    { key: 'contractType', header: 'Contract', type: 'string', hint: 'e.g. permanent, fixed-term' },
    { key: 'rotationPattern', header: 'Rotation pattern', type: 'ref', ref: { lookup: 'rotations', field: 'rotationPatternId' }, hint: 'e.g. 28/28. Needed with the anchor date for calendars' },
    { key: 'rotationAnchorDate', header: 'Rotation anchor date', type: 'date', hint: 'First day of a work period in the pattern (the rotation sheet)' },
    { key: 'priorFieldDays', header: 'Prior field days', type: 'int', hint: 'Field days worked before CrewBoard; drives seniority' },
    { key: 'seniorityOverride', header: 'Seniority override', type: 'enum', values: SENIORITY, hint: 'Leave empty to compute it' },
    { key: 'qualifications', header: 'Qualifications', type: 'list', hint: 'Comma separated, e.g. "Open Hole, Cased Hole". When filled, replaces the list.' },
    { key: 'email', header: 'Email', type: 'email', hint: '' },
    { key: 'phone', header: 'Phone', type: 'string', hint: '' },
    { key: 'homeCity', header: 'Home city', type: 'string', hint: '' },
    { key: 'active', header: 'Active', type: 'bool', hint: 'yes / no. Archiving through import is refused; use the employee screen' },
  ],
};

export const KEY_COLUMN: Record<Kind, string> = { bases: 'code', units: 'code', employees: 'employeeNo' };

export type Cell = string | number | boolean | Date | null;
export interface Lookups {
  bases: Map<string, string>        // code (upper case) -> id
  positions: Map<string, string>    // name (lower case) -> id
  unitTypes: Map<string, string>
  rotations: Map<string, string>
  qualifications: Map<string, string>
}
/** What is already stored, by key (upper-cased code / employee number), in import shape (references as ids). */
export type Existing = Map<string, { id: string; values: Record<string, unknown> }>;

export interface RowResult {
  row: number; key: string; action: 'create' | 'update' | 'unchanged' | 'error'
  errors: string[]; warnings: string[]
  /** Fields to write (references resolved to ids). Qualifications as ids under `qualificationIds`. */
  data: Record<string, unknown>
  changes: string[]
  id?: string
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
const lookupKey = (lookup: keyof Lookups, v: string) => (lookup === 'bases' ? v.trim().toUpperCase() : norm(v));

/** Map the header row to column keys. Headers match the column header or key, ignoring case and spacing. */
export function mapHeaders(kind: Kind, headers: Cell[]): { index: Map<string, number>; unknown: string[]; missing: string[] } {
  const index = new Map<string, number>();
  const unknown: string[] = [];
  headers.forEach((h, i) => {
    if (h === null || h === '') return;
    const text = norm(String(h)).replace(/\s*\*$/, '');
    const col = COLUMNS[kind].find(c => norm(c.header) === text || c.key.toLowerCase() === text.replace(/ /g, ''));
    if (col) index.set(col.key, i); else unknown.push(String(h));
  });
  const missing = COLUMNS[kind].filter(c => c.required && !index.has(c.key)).map(c => c.header);
  return { index, unknown, missing };
}

const isEmpty = (v: Cell) => v === null || (typeof v === 'string' && v.trim() === '');

function parseDate(v: Cell): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : new Date(Date.UTC(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate()));
  if (typeof v === 'number' && v > 59 && v < 2958466) return new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86_400_000); // Excel serial
  if (typeof v !== 'string') return null;
  const s = v.trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return valid(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/);
  if (m) return valid(+m[3], +m[2], +m[1]);
  return null;
}
function valid(y: number, mo: number, d: number): Date | null {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? dt : null;
}

function parseBool(v: Cell): boolean | null {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v === 1 ? true : v === 0 ? false : null;
  const s = norm(String(v));
  if (['yes', 'y', 'true', '1', 'oui', 'o', 'نعم'].includes(s)) return true;
  if (['no', 'n', 'false', '0', 'non', 'لا'].includes(s)) return false;
  return null;
}

const same = (a: unknown, b: unknown) => {
  if (a instanceof Date || b instanceof Date) return !!a && !!b && new Date(a as Date).getTime() === new Date(b as Date).getTime();
  if (Array.isArray(a) && Array.isArray(b)) return [...a].sort().join('|') === [...b].sort().join('|');
  return (a ?? null) === (b ?? null);
};

/** Validate every data row. Empty cells leave an existing record's value unchanged; on a new record required cells must be filled. */
export function validateRows(kind: Kind, rows: Cell[][], index: Map<string, number>, lookups: Lookups, existing: Existing, firstRow = 2): RowResult[] {
  const cols = COLUMNS[kind];
  const keyCol = KEY_COLUMN[kind];
  const seen = new Map<string, number>();
  const out: RowResult[] = [];

  rows.forEach((cells, i) => {
    const rowNo = firstRow + i;
    const get = (k: string): Cell => { const at = index.get(k); return at === undefined ? null : (cells[at] ?? null); };
    if (cols.every(c => isEmpty(get(c.key)))) return; // blank line

    const errors: string[] = [], warnings: string[] = [];
    const rawKey = get(keyCol);
    const key = isEmpty(rawKey) ? '' : String(rawKey).trim();
    const upper = key.toUpperCase();
    if (!key) errors.push(`${cols.find(c => c.key === keyCol)!.header} is empty`);
    else if (seen.has(upper)) errors.push(`Same ${cols.find(c => c.key === keyCol)!.header.toLowerCase()} as row ${seen.get(upper)}`);
    else seen.set(upper, rowNo);
    const current = key ? existing.get(upper) : undefined;

    const data: Record<string, unknown> = {};
    for (const c of cols) {
      const v = get(c.key);
      if (isEmpty(v)) {
        if (c.required && !current) errors.push(`${c.header} is required`);
        continue;
      }
      const text = String(v).trim();
      switch (c.type) {
        case 'string': data[c.key] = c.key === keyCol && kind !== 'employees' ? text.toUpperCase() : text; break;
        case 'email':
          if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) data[c.key] = text; else errors.push(`${c.header}: "${text}" is not an email address`);
          break;
        case 'number': {
          const n = typeof v === 'number' ? v : Number(text.replace(',', '.'));
          if (Number.isFinite(n)) data[c.key] = n; else errors.push(`${c.header}: "${text}" is not a number`);
          break;
        }
        case 'int': {
          const n = typeof v === 'number' ? v : Number(text);
          if (Number.isInteger(n) && n >= 0) data[c.key] = n; else errors.push(`${c.header}: "${text}" must be a whole number`);
          break;
        }
        case 'date': {
          const d = parseDate(v);
          if (d) data[c.key] = d; else errors.push(`${c.header}: "${text}" is not a date (use YYYY-MM-DD or DD/MM/YYYY)`);
          break;
        }
        case 'bool': {
          const b = parseBool(v);
          if (b === null) errors.push(`${c.header}: "${text}" should be yes or no`); else data[c.key] = b;
          break;
        }
        case 'enum': {
          const hit = c.values!.find(x => x === text.toUpperCase().replace(/[\s-]+/g, '_'));
          if (hit) data[c.key] = hit; else errors.push(`${c.header}: "${text}" is not one of ${c.values!.join(', ')}`);
          break;
        }
        case 'ref': {
          const id = lookups[c.ref!.lookup].get(lookupKey(c.ref!.lookup, text));
          if (id) data[c.ref!.field] = id; else errors.push(`${c.header}: unknown "${text}"`);
          break;
        }
        case 'list': {
          const names = text.split(/[,;\n]/).map(s => s.trim()).filter(Boolean);
          const ids = names.map(n => lookups.qualifications.get(norm(n)));
          const bad = names.filter((_, j) => !ids[j]);
          if (bad.length) errors.push(`${c.header}: unknown ${bad.map(b => `"${b}"`).join(', ')}`);
          else data.qualificationIds = [...new Set(ids as string[])];
          break;
        }
      }
    }

    // Rules that need the whole row.
    if (current && kind === 'units') {
      for (const f of ['unitTypeId', 'homeBaseId'] as const) {
        if (data[f] !== undefined && data[f] !== current.values[f]) { errors.push(f === 'unitTypeId' ? 'Unit type cannot change on an existing unit' : 'Home base cannot change by import; use a unit transfer'); }
        delete data[f];
      }
    }
    if (kind === 'employees') {
      if (current && data.active === false && current.values.active !== false) errors.push('Archiving through import is refused; use the employee screen so assignments are released');
      if (!current && data.active === false) warnings.push('Created as archived');
      const pattern = data.rotationPatternId ?? current?.values.rotationPatternId;
      const anchor = data.rotationAnchorDate ?? current?.values.rotationAnchorDate;
      if (pattern && !anchor) warnings.push('Rotation pattern without an anchor date: no calendar until one is set');
      const hire = (data.hireDate ?? current?.values.hireDate) as Date | undefined;
      if (hire && hire.getTime() > Date.now() + 366 * 86_400_000) warnings.push('Hire date is more than a year ahead');
    }

    if (current) delete data[keyCol]; // the key found the record; its spelling is not a change
    const changes = current
      ? Object.keys(data).filter(k => !same(data[k], current.values[k]))
      : Object.keys(data);
    for (const k of Object.keys(data)) if (current && !changes.includes(k)) delete data[k];
    const action: RowResult['action'] = errors.length ? 'error' : !current ? 'create' : changes.length ? 'update' : 'unchanged';
    out.push({ row: rowNo, key: kind === 'employees' ? key : upper, action, errors, warnings, data, changes, id: current?.id });
  });
  return out;
}

export function summarize(rows: RowResult[]) {
  const count = (a: RowResult['action']) => rows.filter(r => r.action === a).length;
  return { rows: rows.length, create: count('create'), update: count('update'), unchanged: count('unchanged'), errors: count('error'), warnings: rows.reduce((n, r) => n + r.warnings.length, 0) };
}
