// Plain words for the codes the API speaks (plan 27.2 #3: "Needs a replacement", not "Replacement task: Open").

export const TRIGGER_LABEL: Record<string, string> = {
  medical_leave: 'Medical leave', leave: 'Approved leave', restriction: 'Restriction added', unassigned: 'Taken off the seat',
  employee_archived: 'Employee left', split: 'Left mid-rotation', unit_deployed: 'New job, no crew yet',
  crew_change_gap: 'Crew change, nobody coming', plan_skipped: 'Planned person no longer available', gap: 'Seat not covered',
}

export const RULE_LABEL: Record<string, string> = {
  rotation_off: 'on days off', availability: 'unavailable', qualification: 'missing qualification', certification: 'missing a mandatory certificate',
  seat_seniority: 'not senior enough', restriction: 'restricted from this work', double_booking: 'already on another seat',
  work_mode: 'wrong work mode', position: 'different position', max_consecutive: 'too many days in a row', crew: 'would break the crew rules',
  crew_experienced: 'no experienced person in the crew', crew_chief: 'no chief of unit',
}

export const FIX_LABEL: Record<string, string> = {
  move_from_idle_unit: 'Move from an idle unit', extend_outgoing: 'Extend the outgoing person', postpone_leave: 'Postpone leave',
  recall_from_days_off: 'Call back from days off', hire: 'Hire or reinforce',
}

export const PLAN_STEPS = ['DRAFT', 'REVIEW', 'APPROVED', 'PUBLISHED'] as const
export const PLAN_LABEL: Record<string, string> = { DRAFT: 'Draft', REVIEW: 'Under review', APPROVED: 'Approved', PUBLISHED: 'Published' }

export const URGENCY_LABEL: Record<string, string> = { CRITICAL: 'Critical', HIGH: 'High', NORMAL: 'Normal' }

/** "Mon, Oct 19"; the year is added when it is not the current one, so a date next year is never mistaken for this one. */
export const fmtDate = (iso: string, lang = 'en') => {
  const d = new Date(iso.slice(0, 10))
  const otherYear = d.getUTCFullYear() !== new Date().getUTCFullYear()
  return d.toLocaleDateString(lang, { weekday: 'short', day: 'numeric', month: 'short', ...(otherYear ? { year: 'numeric' } : {}), timeZone: 'UTC' })
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export const countdown = (daysUntil: number | null) => {
  if (daysUntil === null) return ''
  if (daysUntil < 0) return `uncovered for ${plural(-daysUntil, 'day')}`
  if (daysUntil === 0) return 'uncovered today'
  return `starts in ${plural(daysUntil, 'day')}`
}
