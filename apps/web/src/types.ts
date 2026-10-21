export type Severity = 'ok' | 'info' | 'warn' | 'bad'
export type Seniority = 'NEW_RECRUIT' | 'JUNIOR' | 'EXPERIENCED' | 'SENIOR'

export interface Person {
  id: string; name: string; employeeNo: string; position: string; base: string
  seniority: Seniority; tags: string[]; restrictions: string[]; label?: string
  rank?: string | null // the person's rank tag, e.g. Specialist, OP2
}
export interface Holder extends Person { assignmentId: string; until: string; draft: boolean }
export interface Issue { code: string; severity: Severity; text: string }
export interface SeatCard {
  seatId: string; position: string; index: number; required: boolean
  requirements: { qualification?: string; minSeniority?: Seniority }
  holder: Holder | null; issues: Issue[]
}
export interface Badge { code: string; severity: Severity; text: string }
export interface UnitCardData {
  id: string; code: string; baseId: string; type: string; colorKey: 'green' | 'amber' | string
  status: string; job: { ref: string; well: string; rig: string | null; site: string } | null
  seats: SeatCard[]; badges: Badge[]; state: Severity; crew: { filled: number; required: number }
  crewChange: { inDays: number; date: string } | null; match: boolean
}
export interface StaffingRow {
  baseId: string; positionId: string; position: string; min: number; target: number; filled: number
  state: 'ok' | 'below_min' | 'below_target' | 'off_day'; severity: Severity
  people: (Person & { workOrder: { unit: string; type: string; status: string } | null })[]
}
export interface BoardData {
  date: string; past: boolean; layer: 'live' | 'draft'; planId: string | null
  bases: { id: string; code: string; name: string }[]
  units: UnitCardData[]; staffing: StaffingRow[]; columns: Record<string, Person[]>
  summary: {
    headcount: Record<string, number>; unitsByStatus: Record<string, number>; nonCompliantUnits: number
    unitsNeedingAttention: number; basePostsBelowMin: number; openReplacementTasks: Record<string, number>
    crewChangesNext7Days: number
  }
  matches: { units: string[]; employees: string[] }
}
export interface Violation { rule: string; severity: 'hard' | 'soft'; message: string; date?: string }
export interface Preview {
  violations: Violation[]; hard: number; soft: number; needsOverride: boolean; allowed: boolean; seatTaken: string | null; freeUntil: string | null
  crews: { unitCode: string; before: { filled: number; required: number }; after: { filled: number; required: number } }[]
}
export interface DayCell { date: string; status: string; label?: string }
export interface PersonalCalendar {
  employee: { id: string; firstName: string; lastName: string; employeeNo: string; homeBase: { code: string } }
  days: DayCell[]; summary: { today: DayCell | null; nextDaysOff: string | null; nextBackOn: string | null }
}
export interface PlanSummary { id: string; version: number; status: string; periodStart: string; periodEnd: string }
