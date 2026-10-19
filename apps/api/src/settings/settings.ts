import {
  BadRequestException, Body, Controller, Get, Inject, Injectable, Module, Param, Put, Req,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Require } from '../auth/decorators';
import { audit } from '../common/validate';

// Every number in the plan is a default that Settings can change (plan header + section 22).
export const SETTING_DEFAULTS = {
  'rules.minExperiencedPerCrew': 1,
  'rules.chiefRequired': true,
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
  'org.showLeaveReasonToDispatcher': false,
  // Off: the manager publishes a draft plan directly and extensions apply at once. On: draft -> review -> approve.
  'workflow.requireApproval': false,
  'security.passwordMinLength': 8,
  'security.resetLinkMinutes': 60,
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

  @Get() @Require('settings', 'view')
  list() { return this.svc.all(); }

  @Put(':key') @Require('settings', 'edit')
  async update(@Req() req: { user?: { sub: string } }, @Param('key') key: string, @Body() body: { value: unknown }) {
    const before = (await this.svc.all())[key];
    const r = await this.svc.set(key, body?.value);
    await audit(this.prisma, req.user?.sub, 'Setting', key, 'update', { value: before }, { value: r.value });
    return r;
  }
}

@Module({ controllers: [SettingsController], providers: [SettingsService], exports: [SettingsService] })
export class SettingsModule {}
