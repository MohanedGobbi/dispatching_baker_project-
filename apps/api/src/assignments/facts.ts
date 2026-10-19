// Turns database rows into the plain facts the rule validator and the planning engine consume, so that a
// manual assignment, a plan publish and the auto-planner all judge a person by exactly the same facts.
import type { CandidateFacts, SeatFacts } from '../domain/rules';
import type { Pattern, Seniority } from '../domain/status';

export const FAR_FUTURE = new Date('9999-12-31T00:00:00Z');
const DAY = 86_400_000;

export interface EmployeeRow {
  id: string; positionId: string; workMode: 'FIELD' | 'BASE' | 'FLEXIBLE'; homeBaseId: string; backToBackId: string | null;
  rotationAnchorDate: Date | null;
  qualifications: { qualification: { name: string } }[];
  certifications: { typeId: string; expiresAt: Date }[];
  restrictions: { kind: string; start: Date; end: Date | null }[];
  rotationPattern: { type: string; daysOn: number | null; daysOff: number | null; weeklyMask: string | null } | null;
}
export interface LeaveRow { start: Date; end: Date; type: { category: string }; fitForDuty: { id: string } | null }
export interface SpanRow { seatId: string; start: Date; end: Date }

export function buildCandidate(
  e: EmployeeRow, seniority: Seniority, leaves: LeaveRow[], assignments: SpanRow[], clearanceAfterDays: number,
): CandidateFacts {
  const unavailable: CandidateFacts['unavailable'] = [];
  for (const l of leaves) {
    const medical = l.type.category === 'medical';
    unavailable.push({ start: l.start, end: l.end, reason: medical ? 'medical' : 'leave' });
    const days = Math.round((l.end.getTime() - l.start.getTime()) / DAY) + 1;
    // Ended medical leave, long enough to need it, no fit-for-duty yet: unavailable until HR clears the person.
    if (medical && !l.fitForDuty && days > clearanceAfterDays) {
      unavailable.push({ start: new Date(l.end.getTime() + DAY), end: FAR_FUTURE, reason: 'clearance' });
    }
  }
  return {
    id: e.id, positionId: e.positionId, workMode: e.workMode, homeBaseId: e.homeBaseId, backToBackId: e.backToBackId, seniority,
    qualifications: e.qualifications.map(q => q.qualification.name),
    certs: e.certifications.map(c => ({ typeId: c.typeId, expiresAt: c.expiresAt })),
    restrictions: e.restrictions.map(r => ({ kind: r.kind, start: r.start, end: r.end })),
    rotation: e.rotationPattern ? {
      type: e.rotationPattern.type as Pattern['type'], daysOn: e.rotationPattern.daysOn ?? undefined,
      daysOff: e.rotationPattern.daysOff ?? undefined, weeklyMask: e.rotationPattern.weeklyMask ?? undefined,
    } : null,
    rotationAnchor: e.rotationAnchorDate,
    unavailable,
    otherAssignments: assignments.map(a => ({ seatId: a.seatId, start: a.start, end: a.end })),
  };
}

export interface SeatRow {
  id: string; holderType: 'UNIT' | 'BASE'; positionId: string; baseId: string | null; requirements: unknown;
  position: { name: string; requiredQualifications: { name: string }[]; requiredCertTypes: { id: string }[] };
  unit?: { homeBaseId: string } | null;
}

export function readRequirements(json: unknown): { qualification?: string; minSeniority?: Seniority } {
  const r = (json ?? {}) as { qualification?: string; minSeniority?: Seniority };
  return { qualification: r.qualification, minSeniority: r.minSeniority };
}

export function buildSeatFacts(s: SeatRow): SeatFacts {
  return {
    id: s.id, holderType: s.holderType, positionId: s.positionId, positionName: s.position.name,
    baseId: s.holderType === 'UNIT' ? s.unit?.homeBaseId ?? null : s.baseId,
    requirements: readRequirements(s.requirements),
    positionQualifications: s.position.requiredQualifications.map(q => q.name),
    positionCertTypeIds: s.position.requiredCertTypes.map(c => c.id),
  };
}
