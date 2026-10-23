// Per-day status for people (plan section 25): the status is computed from rotation, leave, clearance and
// assignments, never typed in. Shared by the calendars, the dispatch board and (later) the portal.
import { Inject, Injectable, Module } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsModule, SettingsService } from '../settings/settings';
import { computeStatus, isRotationOn, Pattern, startOfDay, Status } from '../domain/status';

const DAY = 86_400_000;
const EFFECTIVE = ['APPROVED', 'RECORDED', 'ACTIVE', 'COMPLETED'];
export const iso = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (d: Date, n: number) => new Date(startOfDay(d).getTime() + n * DAY);

export type DayStatus = Status | 'TRAINING' | 'UNAVAILABLE';
export interface DayCell {
  date: string; status: DayStatus; label?: string; seatId?: string; assignmentId?: string;
  restrictions?: string[]; // active restriction kinds (shown as a badge on top of the status)
}

export interface Viewer { canSeeMedical: (employeeId: string) => boolean }
/** The manager, the only user, sees medical reasons (analytics passes a viewer that does not). */
export const MANAGER_VIEW: Viewer = { canSeeMedical: () => true };

@Injectable()
export class CalendarService {
  constructor(
    @Inject(PrismaService) private prisma: PrismaService,
    @Inject(SettingsService) private settings: SettingsService,
  ) {}

  /** One query per table for any number of people: `days` is the calendar of each person over [from, to]. */
  async buildDays(employeeIds: string[], from: Date, to: Date, viewer: Viewer): Promise<Map<string, DayCell[]>> {
    const settings = await this.settings.all();
    const clearanceAfter = settings['rules.clearanceRequiredAfterDays'] as number;
    const start = startOfDay(from), end = startOfDay(to);

    const [employees, leaves, assignments] = await Promise.all([
      this.prisma.employee.findMany({ where: { id: { in: employeeIds } }, include: { rotationPattern: true, restrictions: true } }),
      this.prisma.leave.findMany({
        where: { employeeId: { in: employeeIds }, status: { in: EFFECTIVE }, start: { lte: end }, end: { gte: addDays(start, -400) } },
        include: { type: true, fitForDuty: true },
      }),
      this.prisma.assignment.findMany({
        where: { employeeId: { in: employeeIds }, status: { in: ['CONFIRMED', 'ACTIVE', 'COMPLETED'] }, start: { lte: end }, plannedEnd: { gte: start } },
        include: { seat: { include: { unit: { select: { code: true } }, base: { select: { code: true } }, position: { select: { name: true } } } } },
      }),
    ]);

    const out = new Map<string, DayCell[]>();
    for (const e of employees) {
      const mine = assignments.filter(a => a.employeeId === e.id);
      const myLeaves = leaves.filter(l => l.employeeId === e.id);
      const medical = myLeaves.filter(l => l.type.category === 'medical');
      const pattern: Pattern | null = e.rotationPattern ? {
        type: e.rotationPattern.type as Pattern['type'], daysOn: e.rotationPattern.daysOn ?? undefined,
        daysOff: e.rotationPattern.daysOff ?? undefined, weeklyMask: e.rotationPattern.weeklyMask ?? undefined,
      } : null;
      const privileged = viewer.canSeeMedical(e.id);
      const cells: DayCell[] = [];

      for (let d = start; d <= end; d = addDays(d, 1)) {
        // Waiting for HR to clear the person: a long medical leave ended and clearance had not been given by that day.
        const pending = medical.some(l => l.end < d && (Math.round((l.end.getTime() - l.start.getTime()) / DAY) + 1) > clearanceAfter
          && (!l.fitForDuty || startOfDay(l.fitForDuty.clearedAt) > d));
        let status: DayStatus = computeStatus({
          active: e.active,
          medicalLeaves: medical.map(l => ({ start: l.start, end: l.end })),
          otherLeaves: myLeaves.filter(l => l.type.category !== 'medical').map(l => ({ start: l.start, end: l.end })),
          clearancePending: pending,
          unitAssignments: mine.filter(a => a.seat.holderType === 'UNIT').map(a => ({ start: a.start, end: a.actualEnd ?? a.plannedEnd, plannedEnd: a.originalEnd ?? a.plannedEnd })),
          basePostAssignments: mine.filter(a => a.seat.holderType === 'BASE').map(a => ({ start: a.start, end: a.actualEnd ?? a.plannedEnd })),
          // Before a first day of work is known, the manager's "right now" mark stands in for the rotation.
          rotationOn: pattern && e.rotationAnchorDate ? isRotationOn(pattern, e.rotationAnchorDate, d) : e.startState !== 'DAYS_OFF',
        }, d);

        // Weekly-schedule staff (5/2) are not at work on their weekend even if the assignment spans it.
        if (status === 'ON_BASE_POST' && pattern?.type === 'weekly' && e.rotationAnchorDate && !isRotationOn(pattern, e.rotationAnchorDate, d)) status = 'DAYS_OFF';

        const cell: DayCell = { date: iso(d), status };
        const restr = e.restrictions.filter(r => r.start <= d && (!r.end || r.end >= d)).map(r => r.kind);
        if (restr.length) cell.restrictions = restr;

        if (status === 'LEAVE') {
          const l = myLeaves.find(x => x.type.category !== 'medical' && x.start <= d && d <= x.end);
          if (l?.type.category === 'training') status = cell.status = 'TRAINING';
          cell.label = l?.type.name;
        } else if (status === 'ON_UNIT' || status === 'EXTENDED' || status === 'ON_BASE_POST') {
          const a = mine.find(x => x.start <= d && d <= (x.actualEnd ?? x.plannedEnd));
          if (a) {
            cell.label = `${a.seat.unit?.code ?? `${a.seat.base?.code} base`} · ${a.seat.position.name}`;
            cell.seatId = a.seatId; cell.assignmentId = a.id;
          }
        }
        // Medical detail stays private (12.3): others see only that the person is unavailable.
        if ((status === 'MEDICAL_LEAVE' || status === 'AWAITING_CLEARANCE') && !privileged) {
          cell.status = 'UNAVAILABLE'; cell.label = 'Unavailable';
        } else if (status === 'MEDICAL_LEAVE') cell.label = 'Medical leave';
        else if (status === 'AWAITING_CLEARANCE') cell.label = 'Awaiting clearance';
        cells.push(cell);
      }
      out.set(e.id, cells);
    }
    return out;
  }
}

/** Merge consecutive days with the same status and label into blocks (for the timeline). */
export function toBlocks(cells: DayCell[]) {
  const blocks: { from: string; to: string; status: DayStatus; label?: string; seatId?: string; restrictions?: string[] }[] = [];
  for (const c of cells) {
    const last = blocks[blocks.length - 1];
    const same = last && last.status === c.status && last.label === c.label && last.seatId === c.seatId && JSON.stringify(last.restrictions) === JSON.stringify(c.restrictions);
    if (same) last.to = c.date;
    else blocks.push({ from: c.date, to: c.date, status: c.status, label: c.label, seatId: c.seatId, restrictions: c.restrictions });
  }
  return blocks;
}

@Module({ imports: [SettingsModule], providers: [CalendarService], exports: [CalendarService] })
export class CalendarCoreModule {}
