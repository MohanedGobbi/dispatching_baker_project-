import { describe, it, expect } from 'vitest';
import { mapHeaders, validateRows, summarize, Lookups, Existing } from './sheets';

const lookups: Lookups = {
  bases: new Map([['HMD', 'b1'], ['INA', 'b2']]),
  positions: new Map([['field operator', 'p1']]),
  unitTypes: new Map([['open hole', 't1'], ['cased hole', 't2']]),
  rotations: new Map([['28/28', 'r1']]),
  qualifications: new Map([['open hole', 'q1'], ['cased hole', 'q2']]),
};
const HEAD = ['Employee number', 'First name', 'Last name', 'Position', 'Home base', 'Hire date', 'Rotation pattern', 'Qualifications', 'Email', 'Active'];
const { index } = mapHeaders('employees', HEAD);

describe('import headers', () => {
  it('match header text or key, any case, and report what is missing or unknown', () => {
    const m = mapHeaders('employees', ['employeeno', 'FIRST NAME', 'Last  name', 'Shoe size']);
    expect(m.index.get('employeeNo')).toBe(0);
    expect(m.index.get('lastName')).toBe(2);
    expect(m.unknown).toEqual(['Shoe size']);
    expect(m.missing).toEqual(['Position', 'Home base', 'Hire date']);
  });
});

describe('import rows', () => {
  it('creates a valid new person with references resolved', () => {
    const [r] = validateRows('employees', [['E9001', 'Ali', 'Ben', 'Field operator', 'hmd', '2020-03-01', '28/28', 'Open Hole, cased hole', 'a@b.dz', 'yes']], index, lookups, new Map());
    expect(r.action).toBe('create');
    expect(r.data).toMatchObject({ employeeNo: 'E9001', positionId: 'p1', homeBaseId: 'b1', rotationPatternId: 'r1', qualificationIds: ['q1', 'q2'], active: true });
    expect((r.data.hireDate as Date).toISOString()).toBe('2020-03-01T00:00:00.000Z');
    expect(r.warnings).toContain('Rotation pattern without an anchor date: no calendar until one is set');
  });

  it('reports every problem on the row, not just the first', () => {
    const [r] = validateRows('employees', [['E9002', '', 'X', 'Pilot', 'ZZZ', '31/02/2020', '', 'Diving', 'not-an-email', 'maybe']], index, lookups, new Map());
    expect(r.action).toBe('error');
    expect(r.errors).toEqual(expect.arrayContaining([
      'First name is required', 'Position: unknown "Pilot"', 'Home base: unknown "ZZZ"', expect.stringContaining('Hire date'),
      'Qualifications: unknown "Diving"', expect.stringContaining('not an email'), expect.stringContaining('yes or no'),
    ]));
  });

  it('updates only changed, filled cells; blank cells keep the stored value', () => {
    const existing: Existing = new Map([['E1', { id: 'e1', values: { employeeNo: 'E1', firstName: 'Ali', lastName: 'Ben', positionId: 'p1', homeBaseId: 'b1', hireDate: new Date('2020-03-01'), active: true, qualificationIds: ['q2', 'q1'] } }]]);
    const rows = validateRows('employees', [
      ['e1', 'Ali', 'Benali', '', '', '01/03/2020', '', 'Cased Hole, Open Hole', '', ''],
      ['E1', 'Ali', '', '', '', '', '', '', '', ''],
    ], index, lookups, existing);
    expect(rows[0]).toMatchObject({ action: 'update', changes: ['lastName'], id: 'e1' });
    expect(rows[1].errors[0]).toMatch(/Same employee number as row 2/);
  });

  it('refuses archiving and unit type or base changes by import', () => {
    const existing: Existing = new Map([['E1', { id: 'e1', values: { active: true } }]]);
    const [r] = validateRows('employees', [['E1', '', '', '', '', '', '', '', '', 'no']], index, lookups, existing);
    expect(r.errors[0]).toMatch(/Archiving/);
    const u = mapHeaders('units', ['Code', 'Unit type', 'Home base', 'Plate']).index;
    const units: Existing = new Map([['HL-1', { id: 'u1', values: { code: 'HL-1', unitTypeId: 't1', homeBaseId: 'b1', plate: null } }]]);
    const [a, b] = validateRows('units', [['hl-1', 'Cased Hole', 'HMD', ''], ['HL-2', 'Open hole', 'INA', 'P-2']], u, lookups, units);
    expect(a.errors).toEqual(['Unit type cannot change on an existing unit']);
    expect(b).toMatchObject({ action: 'create', key: 'HL-2', data: { code: 'HL-2', unitTypeId: 't1', homeBaseId: 'b2', plate: 'P-2' } });
  });

  it('accepts Excel date cells and serial numbers, skips blank lines, and sums up', () => {
    const b = mapHeaders('bases', ['Code', 'Name', 'Latitude', 'Active']).index;
    const rows = validateRows('bases', [['new', 'New base', '31,5', 'oui'], [null, '', null, null], ['HMD', 'Hassi', 31.6, true]], b, lookups,
      new Map([['HMD', { id: 'b1', values: { code: 'HMD', name: 'Hassi', lat: 31.6, active: true } }]]));
    expect(rows.map(r => r.action)).toEqual(['create', 'unchanged']);
    expect(rows[0].data).toMatchObject({ code: 'NEW', lat: 31.5, active: true });
    expect(summarize(rows)).toMatchObject({ rows: 2, create: 1, unchanged: 1, errors: 0 });
    const [d] = validateRows('employees', [['E5', 'A', 'B', 'Field Operator', 'HMD', 43891, '', '', '', '']], index, lookups, new Map());
    expect((d.data.hireDate as Date).toISOString().slice(0, 10)).toBe('2020-03-01');
  });
});
