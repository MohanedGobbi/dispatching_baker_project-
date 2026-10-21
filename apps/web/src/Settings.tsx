import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from './api'
import { useAuth } from './auth'
import { errMsg, useApi } from './hooks'
import { useToast } from './ui'

const GROUPS: Record<string, string> = {
  rules: 'Crew rules', engine: 'Planning engine weights', seniority: 'Seniority levels', recommendations: 'Recommendations',
  replacements: 'Replacements', planning: 'Planning', leave: 'Leave', org: 'Organisation', workflow: 'Approvals', security: 'Sign-in and passwords',
}
const HINTS: Record<string, string> = {
  'rules.minExperiencedPerCrew': 'Experienced people required on every crew',
  'rules.minCrewOnUnit': 'A unit on a job with this many people is not short of crew (its other seats can stay empty)',
  'rules.maxConsecutiveDays': 'Longest stretch on a unit, in days',
  'rules.maxExtensionDaysPerRotation': 'Extension days allowed per rotation',
  'rules.maxExtensionDaysPerQuarter': 'Extension days allowed per quarter',
  'rules.clearanceRequiredAfterDays': 'Medical absence longer than this needs clearance before returning',
  'rules.longTermAbsenceDays': 'A medical absence this long counts as long-term',
  'rules.overrideReasonRequired': 'On: breaking a crew rule needs a written reason. Off: rules only warn and you can save anyway (a double booking still needs a reason)',
  'rules.shiftNextRotationOnExtension': 'On: the next rotation starts later. Off: extra days are owed as rest',
  'org.workingDays': 'Sunday first; 1 = working day. Base posts follow this',
  'recommendations.hireLeadDays': 'Days it takes to recruit and onboard someone',
  'recommendations.shortageMinDays': 'Shortage must last this many days before it is reported',
  'recommendations.balanceThreshold': 'Rest days owed before relief is recommended',
  'workflow.requireApproval': 'On: plans go draft → review → approved before publishing, extensions are requested then approved. Off: the manager publishes and extends directly',
  'security.passwordMinLength': 'Shortest password accepted',
  'security.resetLinkMinutes': 'How long an emailed reset link stays valid, in minutes',
}
type V = string | number | boolean | string[]

/** Every number in the product is a setting (plan 22); changes apply to the next calculation and are audited. */
export default function Settings() {
  const { t } = useTranslation()
  const { can } = useAuth()
  const toast = useToast()
  const all = useApi<Record<string, V>>('/settings')
  const [draft, setDraft] = useState<Record<string, V>>({})
  const editor = can('SUPER_ADMIN')
  const keys = Object.keys(all.data ?? {})
  const groups = Object.keys(GROUPS).map(g => [g, keys.filter(k => k.split('.')[0] === g)] as const).filter(([, ks]) => ks.length)
  const save = async (k: string) => {
    try { await api(`/settings/${k}`, { method: 'PUT', body: { value: draft[k] } }); toast(t('saved', 'Saved')); setDraft(({ [k]: _, ...rest }) => rest); await all.reload() } catch (e) { toast(errMsg(e), 'error') }
  }
  return (
    <main className="page">
      <header className="page-head"><div><h1>{t('setTitle', 'Settings')}</h1><p className="muted">{t('setIntro', 'The rules and numbers behind every calculation. Nothing is hard-coded.')}</p></div></header>
      {all.error && <div className="banner error" role="alert">{all.error}</div>}
      {groups.map(([g, ks]) => (
        <section key={g} className="panel">
          <h2>{t(`set_${g}`, GROUPS[g])}</h2>
          {ks.map(k => {
            const cur = all.data![k]; const val = k in draft ? draft[k] : cur
            const dirty = k in draft && JSON.stringify(draft[k]) !== JSON.stringify(cur)
            return (
              <div key={k} className="set-row">
                <div><code>{k.split('.').slice(1).join('.')}</code>{HINTS[k] && <small className="muted"> {HINTS[k]}</small>}</div>
                {typeof cur === 'boolean' ? <input type="checkbox" disabled={!editor} checked={val as boolean} onChange={e => setDraft({ ...draft, [k]: e.target.checked })} aria-label={k} />
                  : Array.isArray(cur) ? <input disabled={!editor} value={(val as string[]).join(', ')} onChange={e => setDraft({ ...draft, [k]: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })} aria-label={k} />
                  : typeof cur === 'number' ? <input type="number" disabled={!editor} value={val as number} onChange={e => setDraft({ ...draft, [k]: +e.target.value })} aria-label={k} />
                  : <input disabled={!editor} value={val as string} onChange={e => setDraft({ ...draft, [k]: e.target.value })} aria-label={k} />}
                {dirty && <button type="button" className="primary" onClick={() => save(k)}>{t('save', 'Save')}</button>}
              </div>
            )
          })}
        </section>
      ))}
    </main>
  )
}
