import {
  BadRequestException, Body, Controller, Get, Inject, Injectable, Module, Param, Put, Req,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { audit } from '../common/validate';
import { DEFAULT_RANKS } from '../employees/ranks';

// Every number in the plan is a default that Settings can change (plan header + section 22).
export const SETTING_DEFAULTS = {
  'rules.minExperiencedPerCrew': 1,
  'rules.chiefRequired': true,
  // A deployed unit with at least this many crew seats filled is not short of crew (the other seats can stay empty).
  'rules.minCrewOnUnit': 3,
  // On: a broken hard rule needs an override reason to save. Off: rules only warn (a double booking still needs one).
  'rules.overrideReasonRequired': true,
  'rules.maxConsecutiveDays': 35,
  'rules.maxExtensionDaysPerRotation': 7,
  'rules.maxExtensionDaysPerQuarter': 14,
  'rules.clearanceRequiredAfterDays': 7,
  'rules.longTermAbsenceDays': 30,
  'rules.creditLostOffDaysOnMedical': false,
  'rules.travelDaysPolicy': 'separate',
  'rules.shiftNextRotationOnExtension': false,
  'recommendations.shortageMinDays': 5,
  'recommendations.hireLeadDays': 45,
  'recommendations.balanceThreshold': 5,
  'recommendations.workOrderBacklog': 3,
  'replacements.escalateWithinDays': 2,
  'planning.maxPeriodDays': 120,
  'leave.annualEntitlementDays': 30,
  'leave.overlapWarningThreshold': 3,
  'seniority.juniorMonths': 6,
  'seniority.juniorFieldDays': 60,
  'seniority.experiencedYears': 2,
  'seniority.experiencedFieldDays': 300,
  'seniority.seniorYears': 5,
  'seniority.seniorFieldDays': 800,
  'engine.weight.backToBack': 10,
  'engine.weight.fairness': 8,
  'engine.weight.sameBase': 5,
  'engine.weight.crewStability': 6,
  'engine.weight.seniorityMix': 6,
  'engine.weight.mentoring': 3,
  'engine.weight.baseStaffFirst': 4,
  'engine.weight.preferences': 2,
  'org.name': 'CrewBoard',
  'org.timezone': 'Africa/Algiers',
  'org.weekStart': 0,
  'org.workingDays': '1111100', // Sunday first; posts with the working_days window are only needed on these days
  // On: plans go draft -> review -> approved -> published, extensions are requested then approved. Off: both apply at once.
  'workflow.requireApproval': true,
  // The company's ranks, highest first; edited on the People screen (not listed in Settings).
  'people.ranks': DEFAULT_RANKS,
} as const;

export type SettingKey = keyof typeof SETTING_DEFAULTS;

/** A stored value must have the same JSON type as its default. */
export function validateSetting(key: string, value: unknown): string | null {
  if (!(key in SETTING_DEFAULTS)) return `Unknown setting "${key}"`;
  const def = SETTING_DEFAULTS[key as SettingKey] as unknown;
  if (Array.isArray(def)) return Array.isArray(value) ? null : `"${key}" must be an array`;
  if (typeof value !== typeof def) return `"${key}" must be a ${typeof def}`;
  if (typeof def === 'number' && (!Number.isFinite(value as number) || (value as number) < 0)) return `"${key}" must be a non-negative number`;
  return null;
}

@Injectable()
export class SettingsService {
  constructor(@Inject(PrismaService) private prisma: PrismaService) {}

  async all(): Promise<Record<string, unknown>> {
    const rows = await this.prisma.setting.findMany();
    return { ...SETTING_DEFAULTS, ...Object.fromEntries(rows.map(r => [r.key, r.value])) };
  }

  async set(key: string, value: unknown) {
    const err = validateSetting(key, value);
    if (err) throw new BadRequestException(err);
    await this.prisma.setting.upsert({ where: { key }, create: { key, value: value as never }, update: { value: value as never } });
    return { key, value };
  }
}

@Controller('settings')
class SettingsController {
  constructor(@Inject(SettingsService) private svc: SettingsService, @Inject(PrismaService) private prisma: PrismaService) {}

  @Get()
  list() { return this.svc.all(); }

  @Put(':key')
  async update(@Req() req: { user?: { sub: string } }, @Param('key') key: string, @Body() body: { value: unknown }) {
    const before = (await this.svc.all())[key];
    const r = await this.svc.set(key, body?.value);
    await audit(this.prisma, 'Setting', key, 'update', { value: before }, { value: r.value });
    return r;
  }
}

@Module({ controllers: [SettingsController], providers: [SettingsService], exports: [SettingsService] })
export class SettingsModule {}
