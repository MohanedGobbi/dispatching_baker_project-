// Rule validator (plan 15.2 hard rules, 15.3 soft rules). Pure: callers load the facts, this decides.
// Hard violations need an override reason to save; soft ones are warnings.
import { isRotationOn, Pattern, Seniority, startOfDay } from './status';

const DAY = 86_400_000;
export const SENIORITY_ORDER: Seniority[] = ['NEW_RECRUIT', 'JUNIOR', 'EXPERIENCED', 'SENIOR'];
export const seniorityAtLeast = (have: Seniority, need: Seniority) => SENIORITY_ORDER.indexOf(have) >= SENIORITY_ORDER.indexOf(need);

export type RuleId =
  | 'position' | 'work_mode' | 'qualification' | 'certification' | 'availability' | 'rotation_off' | 'restriction'
  | 'double_booking' | 'max_consecutive' | 'seat_seniority' | 'crew_experienced' | 'crew_chief'
  | 'back_to_back' | 'same_base' | 'seniority_mix' | 'mentoring' | 'position_flexible';

export interface Violation { rule: RuleId; severity: 'hard' | 'soft'; message: string; date?: string }

export interface Range { start: Date; end: Date }

export interface CandidateFacts {
  id: string;
  positionId: string;
  workMode: 'FIELD' | 'BASE' | 'FLEXIBLE';
  homeBaseId: string;
  backToBackId: string | null;
  seniority: Seniority;
  qualifications: string[];                  // qualification names
  certs: { typeId: string }[];
  restrictions: { kind: string; start: Date; end: Date | null }[];
  rotation: Pattern | null;
  rotationAnchor: Date | null;
  unavailable: (Range & { reason: 'medical' | 'leave' | 'clearance' })[];
  otherAssignments: (Range & { seatId: string })[]; // non-cancelled, already excluding ignored ones
}

export interface SeatFacts {
  id: string;
  holderType: 'UNIT' | 'BASE';
  positionId: string;
  positionName: string;
  baseId: string | null;     // base posts: the base; unit seats: the unit's home base
  requirements: { qualification?: string; minSeniority?: Seniority };
  positionQualifications: string[];     // qualification names the position itself needs
  positionCertTypeIds: string[];
}

export interface RuleSettings { maxConsecutiveDays: number }

const fmt = (d: Date) => d.toISOString().slice(0, 10);
const eachDay = (r: Range) => { const out: Date[] = []; for (let t = startOfDay(r.start).getTime(); t <= r.end.getTime(); t += DAY) out.push(new Date(t)); return out; };
const overlaps = (a: Range, b: Range) => a.start <= b.end && b.start <= a.end;

/**
 * Rules about one person on one seat for a date range. Crew-level rules are in crewViolations.
 * `open`: the stay has no crew change date yet, so the rules that depend on how long it lasts (days off in the
 * rotation, longest stretch, leave further ahead) are left until a date is set; a double booking still counts.
 */
export function personViolations(c: CandidateFacts, seat: SeatFacts, range: Range, s: RuleSettings, open = false): Violation[] {
  const v: Violation[] = [];
  const hard = (rule: RuleId, message: string, date?: Date) => v.push({ rule, severity: 'hard', message, date: date && fmt(date) });
  const soft = (rule: RuleId, message: string) => v.push({ rule, severity: 'soft', message });

  // 10. work mode, plus the position the seat needs
  if (seat.holderType === 'UNIT' && c.workMode === 'BASE') hard('work_mode', 'Base-only employee cannot take a unit seat');
  if (seat.holderType === 'BASE' && c.workMode === 'FIELD') hard('work_mode', 'Field-only employee cannot take a base post');
  if (c.positionId !== seat.positionId) {
    if (c.workMode === 'FLEXIBLE') soft('position_flexible', `Flexible employee covering a ${seat.positionName} seat outside their own position`);
    else hard('position', `Seat needs a ${seat.positionName}`);
  }

  // 4. qualification (seat-specific, e.g. Open Hole / Cased Hole, and the position's own)
  const needQuals = new Set([...(seat.requirements.qualification ? [seat.requirements.qualification] : []), ...seat.positionQualifications]);
  for (const q of needQuals) if (!c.qualifications.includes(q)) hard('qualification', `Missing qualification: ${q}`);

  // seat-level minimum seniority
  if (seat.requirements.minSeniority && !seniorityAtLeast(c.seniority, seat.requirements.minSeniority)) {
    hard('seat_seniority', `Seat requires ${seat.requirements.minSeniority.toLowerCase().replace('_', ' ')} or above`);
  }

  // 5. mandatory certifications: held or not (certificates do not expire in this product)
  for (const typeId of seat.positionCertTypeIds) {
    if (!c.certs.some(x => x.typeId === typeId)) hard('certification', 'Missing a mandatory certification');
  }

  // 6. availability: leave, medical leave, awaiting clearance
  const now = open ? { start: range.start, end: range.start } : range;
  for (const u of c.unavailable) {
    if (!overlaps(u, now)) continue;
    const label = u.reason === 'medical' ? 'Unavailable (medical)' : u.reason === 'clearance' ? 'Awaiting fit-for-duty clearance' : 'On leave';
    // Medical detail stays private: the message says "Unavailable" without the reason when it is medical.
    hard('availability', `${u.reason === 'medical' ? 'Unavailable' : label} ${fmt(u.start < range.start ? range.start : u.start)} to ${fmt(u.end > range.end ? range.end : u.end)}`);
  }

  // 6b. rotation: cycle patterns must be "on" for the whole assignment (weekly schedules have natural weekends)
  if (!open && c.rotation?.type === 'cycle' && c.rotationAnchor) {
    const off = eachDay(range).filter(d => !isRotationOn(c.rotation!, c.rotationAnchor!, d));
    if (off.length) hard('rotation_off', `${off.length} day(s) fall in the employee's days off (first: ${fmt(off[0])})`, off[0]);
  }

  // 7. restrictions
  for (const r of c.restrictions) {
    if (!overlaps({ start: r.start, end: r.end ?? new Date(8.64e15) }, range)) continue;
    if ((r.kind === 'base_only' || r.kind === 'no_field') && seat.holderType === 'UNIT') hard('restriction', 'Restricted from field work');
  }

  // 8. one seat per person per day
  for (const o of c.otherAssignments) {
    if (overlaps(o, range)) { hard('double_booking', `Already assigned ${fmt(o.start)} to ${fmt(o.end)}`, o.start); break; }
  }

  // 9. max consecutive working days
  const length = Math.round((startOfDay(range.end).getTime() - startOfDay(range.start).getTime()) / DAY) + 1;
  if (!open && length > s.maxConsecutiveDays) hard('max_consecutive', `${length} days exceeds the ${s.maxConsecutiveDays}-day maximum`);

  // soft rules
  if (seat.baseId && c.homeBaseId !== seat.baseId) soft('same_base', 'Home base differs from the seat base (travel needed)');
  return v;
}

export interface CrewSeat { seatId: string; positionName: string; required: boolean; holder: { id: string; seniority: Seniority } | null }

export interface CrewSummary {
  filled: number; required: number; operatorsFilled: number; operatorsRequired: number;
  experienced: number; hasChief: boolean; newRecruits: number;
}

export function summarizeCrew(seats: CrewSeat[]): CrewSummary {
  const req = seats.filter(s => s.required);
  const ops = req.filter(s => s.positionName === 'Field Operator');
  const people = seats.filter(s => s.holder).map(s => s.holder!);
  return {
    filled: req.filter(s => s.holder).length, required: req.length,
    operatorsFilled: ops.filter(s => s.holder).length, operatorsRequired: ops.length,
    experienced: people.filter(p => seniorityAtLeast(p.seniority, 'EXPERIENCED')).length,
    hasChief: seats.some(s => s.positionName === 'Chief of Unit' && s.holder),
    newRecruits: people.filter(p => p.seniority === 'NEW_RECRUIT').length,
  };
}

/**
 * Crew-level rules (15.2 #2, #3). "Missing people" is a gap, not a violation, so experience is judged once the
 * operator seats are all filled; the chief rule fires when operators are in place but nobody leads.
 */
/** Enough crew on a unit: every required seat, or `minCrew` of them when the unit has more seats than that. */
export const crewEnough = (filled: number, required: number, minCrew: number) => filled >= Math.min(required, minCrew);

export function crewViolations(seats: CrewSeat[], date: Date, minExperienced: number, chiefRequired: boolean): Violation[] {
  const c = summarizeCrew(seats);
  const v: Violation[] = [];
  const at = fmt(date);
  if (c.operatorsRequired > 0 && c.operatorsFilled === c.operatorsRequired) {
    if (c.experienced < minExperienced) {
      v.push({ rule: 'crew_experienced', severity: 'hard', date: at, message: `No experienced operator in the crew (needs ${minExperienced}) from ${at}` });
    }
    if (chiefRequired && !c.hasChief) v.push({ rule: 'crew_chief', severity: 'hard', date: at, message: `Crew has no Chief of Unit from ${at}` });
    if (c.experienced >= minExperienced && c.experienced === 1 && c.newRecruits >= 2) {
      v.push({ rule: 'seniority_mix', severity: 'soft', date: at, message: 'One experienced person with two new recruits' });
    }
  }
  return v;
}

/** Soft rule: prefer the back-to-back partner as the replacement for someone. */
export function backToBackNote(candidateId: string, outgoingBackToBackId: string | null): Violation | null {
  return outgoingBackToBackId && candidateId !== outgoingBackToBackId
    ? { rule: 'back_to_back', severity: 'soft', message: 'Not the back-to-back partner of the person being replaced' } : null;
}
