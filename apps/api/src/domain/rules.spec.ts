import { describe, it, expect } from 'vitest';
import { personViolations, crewViolations, CandidateFacts, SeatFacts, CrewSeat } from './rules';

const d = (s: string) => new Date(s + 'T00:00:00Z');
const settings = { maxConsecutiveDays: 35 };

const op: CandidateFacts = {
  id: 'e1', positionId: 'pOp', workMode: 'FIELD', homeBaseId: 'hmd', backToBackId: null, seniority: 'EXPERIENCED',
  qualifications: ['Open Hole'], certs: [{ typeId: 'h2s' }], restrictions: [],
  rotation: { type: 'cycle', daysOn: 28, daysOff: 28 }, rotationAnchor: d('2026-10-01'),
  unavailable: [], otherAssignments: [],
};
const seat: SeatFacts = {
  id: 's1', holderType: 'UNIT', positionId: 'pOp', positionName: 'Field Operator', baseId: 'hmd',
  requirements: { qualification: 'Open Hole' }, positionQualifications: [], positionCertTypeIds: ['h2s'],
};
const range = { start: d('2026-10-05'), end: d('2026-10-20') };
const rules = (c: Partial<CandidateFacts> = {}, s: Partial<SeatFacts> = {}, r = range) =>
  personViolations({ ...op, ...c }, { ...seat, ...s }, r, settings).filter(v => v.severity === 'hard').map(v => v.rule);

describe('personViolations (hard rules)', () => {
  it('a valid candidate has no hard violations', () => expect(rules()).toEqual([]));
  it('rule 4: wrong qualification (CH-only on an OH seat)', () => expect(rules({ qualifications: ['Cased Hole'] })).toContain('qualification'));
  it('rule 5: a mandatory certification must be held (certificates never expire)', () => {
    expect(rules({ certs: [{ typeId: 'h2s' }] })).not.toContain('certification');
    expect(rules({ certs: [] })).toContain('certification');
  });
  it('rule 6: leave, medical and clearance block; message hides the medical reason', () => {
    expect(rules({ unavailable: [{ start: d('2026-10-10'), end: d('2026-10-12'), reason: 'leave' }] })).toContain('availability');
    const med = personViolations({ ...op, unavailable: [{ start: d('2026-10-10'), end: d('2026-10-12'), reason: 'medical' }] }, seat, range, settings);
    expect(med[0].message.toLowerCase()).not.toContain('medical');
    expect(med[0].message).toContain('Unavailable');
  });
  it('rule 6: days off in the rotation block (cycle patterns only)', () => {
    expect(rules({}, {}, { start: d('2026-10-25'), end: d('2026-11-05') })).toContain('rotation_off'); // 28 on from Oct 1 ends Oct 28
    expect(rules({ rotation: { type: 'weekly', weeklyMask: '1111100' } }, {}, { start: d('2026-10-25'), end: d('2026-11-05') })).not.toContain('rotation_off');
  });
  it('rule 7: base-only restriction blocks unit seats but not base posts', () => {
    const restr = [{ kind: 'base_only', start: d('2026-10-01'), end: d('2026-11-30') }];
    expect(rules({ restrictions: restr })).toContain('restriction');
    expect(rules({ restrictions: restr, workMode: 'FLEXIBLE' }, { holderType: 'BASE' })).not.toContain('restriction');
  });
  it('rule 8: double booking', () => {
    expect(rules({ otherAssignments: [{ start: d('2026-10-18'), end: d('2026-10-30'), seatId: 'x' }] })).toContain('double_booking');
  });
  it('rule 9: too many consecutive days', () => {
    expect(rules({}, {}, { start: d('2026-10-01'), end: d('2026-11-15') })).toContain('max_consecutive');
  });
  it('rule 10: work mode and position', () => {
    expect(rules({ workMode: 'BASE' })).toContain('work_mode');
    expect(rules({ workMode: 'FIELD' }, { holderType: 'BASE' })).toContain('work_mode');
    expect(rules({ positionId: 'other' })).toContain('position');
    const flex = personViolations({ ...op, workMode: 'FLEXIBLE', positionId: 'other' }, seat, range, settings);
    expect(flex.find(v => v.rule === 'position_flexible')?.severity).toBe('soft');
    expect(flex.some(v => v.rule === 'position')).toBe(false);
  });
  it('seat-level seniority', () => {
    expect(rules({ seniority: 'JUNIOR' }, { requirements: { qualification: 'Open Hole', minSeniority: 'EXPERIENCED' } })).toContain('seat_seniority');
    expect(rules({ seniority: 'SENIOR' }, { requirements: { qualification: 'Open Hole', minSeniority: 'EXPERIENCED' } })).not.toContain('seat_seniority');
  });
  it('soft: different home base is a warning only', () => {
    const v = personViolations({ ...op, homeBaseId: 'ina' }, seat, range, settings);
    expect(v.find(x => x.rule === 'same_base')?.severity).toBe('soft');
  });
});

describe('crewViolations', () => {
  const seatOf = (pos: string, level?: 'NEW_RECRUIT' | 'JUNIOR' | 'EXPERIENCED' | 'SENIOR', i = 0): CrewSeat =>
    ({ seatId: `${pos}${i}`, positionName: pos, required: true, holder: level ? { id: `${pos}${i}`, seniority: level } : null });
  const date = d('2026-10-19');

  it('acceptance 1: recruit joins two juniors => no experienced operator', () => {
    const crew = [seatOf('Chief of Unit', 'JUNIOR'), seatOf('Field Operator', 'JUNIOR', 1), seatOf('Field Operator', 'JUNIOR', 2), seatOf('Field Operator', 'NEW_RECRUIT', 3)];
    expect(crewViolations(crew, date, 1, true).map(v => v.rule)).toContain('crew_experienced');
  });
  it('an experienced chief satisfies the crew rule', () => {
    const crew = [seatOf('Chief of Unit', 'EXPERIENCED'), seatOf('Field Operator', 'JUNIOR', 1), seatOf('Field Operator', 'JUNIOR', 2), seatOf('Field Operator', 'NEW_RECRUIT', 3)];
    expect(crewViolations(crew, date, 1, true).filter(v => v.severity === 'hard')).toEqual([]);
  });
  it('an incomplete crew is a gap, not a violation', () => {
    const crew = [seatOf('Chief of Unit', 'JUNIOR'), seatOf('Field Operator', 'JUNIOR', 1), seatOf('Field Operator', undefined, 2), seatOf('Field Operator', undefined, 3)];
    expect(crewViolations(crew, date, 1, true)).toEqual([]);
  });
  it('chief required once operators are in place', () => {
    const crew = [seatOf('Chief of Unit'), seatOf('Field Operator', 'SENIOR', 1)];
    expect(crewViolations(crew, date, 1, true).map(v => v.rule)).toContain('crew_chief');
    expect(crewViolations(crew, date, 1, false).map(v => v.rule)).not.toContain('crew_chief');
  });
  it('soft warning: one experienced with two new recruits', () => {
    const crew = [seatOf('Chief of Unit', 'EXPERIENCED'), seatOf('Field Operator', 'NEW_RECRUIT', 1), seatOf('Field Operator', 'NEW_RECRUIT', 2), seatOf('Field Operator', 'JUNIOR', 3)];
    const v = crewViolations(crew, date, 1, true);
    expect(v.find(x => x.rule === 'seniority_mix')?.severity).toBe('soft');
  });
});
