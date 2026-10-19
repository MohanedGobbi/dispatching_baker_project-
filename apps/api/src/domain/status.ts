// Pure domain logic: seniority (7.2), rotation calendar (11) and status computation (25).
// No database access, so it is fully unit-testable and reusable by the planning engine.

export type Seniority = 'NEW_RECRUIT' | 'JUNIOR' | 'EXPERIENCED' | 'SENIOR';

export interface SeniorityRules {
  juniorMonths: number; juniorFieldDays: number;
  experiencedYears: number; experiencedFieldDays: number;
  seniorYears: number; seniorFieldDays: number;
}

// Defaults from plan section 7.2; overridable from Settings.
export const DEFAULT_SENIORITY_RULES: SeniorityRules = {
  juniorMonths: 6, juniorFieldDays: 60,
  experiencedYears: 2, experiencedFieldDays: 300,
  seniorYears: 5, seniorFieldDays: 800,
};

const DAY = 86_400_000;

export function startOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function computeSeniority(
  hireDate: Date, fieldDays: number, asOf: Date,
  override?: Seniority | null, rules: SeniorityRules = DEFAULT_SENIORITY_RULES,
): Seniority {
  if (override) return override;
  const years = (asOf.getTime() - hireDate.getTime()) / (365.25 * DAY);
  const months = years * 12;
  if (years >= rules.seniorYears && fieldDays >= rules.seniorFieldDays) return 'SENIOR';
  if (years >= rules.experiencedYears && fieldDays >= rules.experiencedFieldDays) return 'EXPERIENCED';
  if (months < rules.juniorMonths || fieldDays < rules.juniorFieldDays) return 'NEW_RECRUIT';
  return 'JUNIOR';
}

export interface Pattern {
  type: 'cycle' | 'weekly' | 'custom';
  daysOn?: number; daysOff?: number;
  weeklyMask?: string; // 7 chars, index 0 = Sunday, '1' = working
}

/** Expected rotation calendar: is the employee scheduled "on" on this date? */
export function isRotationOn(p: Pattern, anchor: Date, date: Date): boolean {
  if (p.type === 'weekly') {
    return (p.weeklyMask ?? '1111100')[startOfDay(date).getUTCDay()] === '1';
  }
  if (p.type === 'cycle') {
    const on = p.daysOn ?? 28, off = p.daysOff ?? 28;
    const diff = Math.floor((startOfDay(date).getTime() - startOfDay(anchor).getTime()) / DAY);
    const pos = ((diff % (on + off)) + (on + off)) % (on + off);
    return pos < on;
  }
  return true; // custom calendars are drawn manually
}

export type Status =
  | 'INACTIVE' | 'MEDICAL_LEAVE' | 'LEAVE' | 'AWAITING_CLEARANCE'
  | 'ON_UNIT' | 'EXTENDED' | 'ON_BASE_POST' | 'STANDBY' | 'DAYS_OFF';

export interface Range { start: Date; end: Date }
export interface StatusInput {
  active: boolean;
  medicalLeaves: Range[];
  otherLeaves: Range[];
  clearancePending: boolean; // a medical leave ended and has no FitForDuty yet
  unitAssignments: (Range & { plannedEnd: Date })[];
  basePostAssignments: Range[];
  rotationOn: boolean;
}

const within = (r: Range, d: Date) => d >= startOfDay(r.start) && d <= r.end;

/** Section 25: status is computed, never typed. Priority order is the spec's. */
export function computeStatus(i: StatusInput, date: Date): Status {
  if (!i.active) return 'INACTIVE';
  if (i.medicalLeaves.some(r => within(r, date))) return 'MEDICAL_LEAVE';
  if (i.otherLeaves.some(r => within(r, date))) return 'LEAVE';
  if (i.clearancePending) return 'AWAITING_CLEARANCE';
  const unit = i.unitAssignments.find(a => within(a, date));
  if (unit) return date > unit.plannedEnd ? 'EXTENDED' : 'ON_UNIT';
  if (i.basePostAssignments.some(r => within(r, date))) return 'ON_BASE_POST';
  return i.rotationOn ? 'STANDBY' : 'DAYS_OFF';
}
