import { Inject, Injectable, Module } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { SettingsModule, SettingsService } from "../settings/settings";
import { computeSeniority, computeStatus, isRotationOn, startOfDay, Seniority, SeniorityRules } from "../domain/status";
import { countFieldDays } from "../domain/derived";

export function seniorityRules(s: Record<string, unknown>): SeniorityRules {
  return {
    juniorMonths: s['seniority.juniorMonths'] as number, juniorFieldDays: s['seniority.juniorFieldDays'] as number,
    experiencedYears: s['seniority.experiencedYears'] as number, experiencedFieldDays: s['seniority.experiencedFieldDays'] as number,
    seniorYears: s['seniority.seniorYears'] as number, seniorFieldDays: s['seniority.seniorFieldDays'] as number,
  };
}

@Injectable()
export class EmployeeInsightsService {
  constructor(
    @Inject(PrismaService) private prisma: PrismaService,
    @Inject(SettingsService) private settings: SettingsService,
  ) {}

  /** Batched computed fields so a list of N people costs a fixed number of queries. */
  async enrich<E extends { id: string; hireDate: Date; seniorityOverride: Seniority | null; active: boolean;
    rotationAnchorDate: Date | null; rotationPattern: { type: string; daysOn: number | null; daysOff: number | null; weeklyMask: string | null } | null }>(
    employees: E[], asOf: Date,
  ) {
    const ids = employees.map(e => e.id);
    const settings = await this.settings.all();
    const rules = seniorityRules(settings);
    const clearanceAfter = settings['rules.clearanceRequiredAfterDays'] as number;
    const [assignments, leaves] = await Promise.all([
      this.prisma.assignment.findMany({
        where: { employeeId: { in: ids }, status: { notIn: ['CANCELLED', 'DRAFT'] } },
        select: { employeeId: true, start: true, plannedEnd: true, originalEnd: true, actualEnd: true, seat: { select: { holderType: true } } },
      }),
      this.prisma.leave.findMany({
        where: { employeeId: { in: ids }, status: { in: ['APPROVED', 'ACTIVE', 'COMPLETED', 'RECORDED'] } },
        select: { employeeId: true, start: true, end: true, type: { select: { category: true } }, fitForDuty: { select: { id: true } } },
      }),
    ]);
    const yearStart = new Date(Date.UTC(asOf.getUTCFullYear(), 0, 1));
    return new Map(employees.map(e => {
      const mine = assignments.filter(a => a.employeeId === e.id);
      const unitSpans = mine.filter(a => a.seat.holderType === 'UNIT').map(a => ({ start: a.start, end: a.actualEnd ?? a.plannedEnd }));
      const fieldDays = ((e as { priorFieldDays?: number }).priorFieldDays ?? 0) + countFieldDays(unitSpans, asOf);
      const fieldDaysYear = countFieldDays(unitSpans.map(s => ({ ...s, start: s.start < yearStart ? yearStart : s.start })), asOf);
      const myLeaves = leaves.filter(l => l.employeeId === e.id);
      const medical = myLeaves.filter(l => l.type.category === 'medical');
      const clearancePending = medical.some(l => l.end < asOf && !l.fitForDuty
        && (l.end.getTime() - l.start.getTime()) / 86_400_000 + 1 > clearanceAfter);
      const pattern = e.rotationPattern && e.rotationAnchorDate
        ? isRotationOn({ type: e.rotationPattern.type as 'cycle' | 'weekly' | 'custom', daysOn: e.rotationPattern.daysOn ?? undefined,
            daysOff: e.rotationPattern.daysOff ?? undefined, weeklyMask: e.rotationPattern.weeklyMask ?? undefined }, e.rotationAnchorDate, asOf)
        // Before a first day of work is known, the manager's "right now" mark stands in for the rotation.
        : (e as { startState?: string | null }).startState !== 'DAYS_OFF';
      const status = computeStatus({
        active: e.active,
        medicalLeaves: medical.map(l => ({ start: l.start, end: l.end })),
        otherLeaves: myLeaves.filter(l => l.type.category !== 'medical').map(l => ({ start: l.start, end: l.end })),
        clearancePending,
        unitAssignments: mine.filter(a => a.seat.holderType === 'UNIT').map(a => ({ start: a.start, end: a.actualEnd ?? a.plannedEnd, plannedEnd: a.originalEnd ?? a.plannedEnd })),
        basePostAssignments: mine.filter(a => a.seat.holderType === 'BASE').map(a => ({ start: a.start, end: a.actualEnd ?? a.plannedEnd })),
        rotationOn: pattern,
      }, startOfDay(asOf));
      const seniority = computeSeniority(e.hireDate, fieldDays, asOf, e.seniorityOverride, rules);
      const years = Math.floor(((asOf.getTime() - e.hireDate.getTime()) / (365.25 * 86_400_000)) * 10) / 10;
      return [e.id, { seniority, fieldDays, fieldDaysYear, yearsOfService: years, status }] as const;
    }));
  }
}

@Module({ imports: [SettingsModule], providers: [EmployeeInsightsService], exports: [EmployeeInsightsService] })
export class InsightsModule {}
