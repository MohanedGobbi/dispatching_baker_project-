import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from './api'
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
interface Backups { dir: string; backups: { name: string; at: string; sizeBytes: number }[] }

const mb = (bytes: number) => `${(bytes / 1_048_576).toFixed(1)} MB`

/** The database and uploaded files are copied once a day on their own; this adds a copy on demand. */
function BackupPanel() {
  const { t } = useTranslation()
  const toast = useToast()
  const list = useApi<Backups>('/backups')
  const [busy, setBusy] = useState(false)
  const now = async () => {
    setBusy(true)
    try { await api('/backups', { method: 'POST' }); toast(t('backupDone', 'Backup made')); await list.reload() } catch (e) { toast(errMsg(e), 'error') } finally { setBusy(false) }
  }
  const latest = list.data?.backups[0]
  return (
    <section className="panel">
      <h2>{t('set_backups', 'Backups')}</h2>
      <div className="set-row">
        <div>
          {latest ? <>{t('backupLatest', 'Last backup')}: <strong>{new Date(latest.at).toLocaleString()}</strong> ({mb(latest.sizeBytes)})</> : t('backupNone', 'No backup yet')}
          <small className="muted"> {t('backupHint', 'A copy of all data and files is made every day. The 14 newest are kept, then one per month. Copy this folder to a USB drive from time to time:')} <code>{list.data?.dir}</code></small>
        </div>
        {<button type="button" className="primary" disabled={busy} onClick={now}>{busy ? t('backupBusy', 'Backing up…') : t('backupNow', 'Back up now')}</button>}
      </div>
      {list.error && <div className="banner error" role="alert">{list.error}</div>}
    </section>
  )
}

/** Every number in the product is a setting (plan 22); changes apply to the next calculation and are audited. */
export default function Settings() {
  const { t } = useTranslation()
  const toast = useToast()
  const all = useApi<Record<string, V>>('/settings')
  const [draft, setDraft] = useState<Record<string, V>>({})
  const keys = Object.keys(all.data ?? {})
  const groups = Object.keys(GROUPS).map(g => [g, keys.filter(k => k.split('.')[0] === g)] as const).filter(([, ks]) => ks.length)
  const save = async (k: string) => {
    try { await api(`/settings/${k}`, { method: 'PUT', body: { value: draft[k] } }); toast(t('saved', 'Saved')); setDraft(({ [k]: _, ...rest }) => rest); await all.reload() } catch (e) { toast(errMsg(e), 'error') }
  }
  return (
    <main className="page">
      <header className="page-head"><div><h1>{t('setTitle', 'Settings')}</h1><p className="muted">{t('setIntro', 'The rules and numbers behind every calculation. Nothing is hard-coded.')}</p></div></header>
      {all.error && <div className="banner error" role="alert">{all.error}</div>}
      <BackupPanel />
      {groups.map(([g, ks]) => (
        <section key={g} className="panel">
          <h2>{t(`set_${g}`, GROUPS[g])}</h2>
          {ks.map(k => {
            const cur = all.data![k]; const val = k in draft ? draft[k] : cur
            const dirty = k in draft && JSON.stringify(draft[k]) !== JSON.stringify(cur)
            return (
              <div key={k} className="set-row">
                <div><code>{k.split('.').slice(1).join('.')}</code>{HINTS[k] && <small className="muted"> {HINTS[k]}</small>}</div>
                {typeof cur === 'boolean' ? <input type="checkbox" checked={val as boolean} onChange={e => setDraft({ ...draft, [k]: e.target.checked })} aria-label={k} />
                  : Array.isArray(cur) ? <input value={(val as string[]).join(', ')} onChange={e => setDraft({ ...draft, [k]: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })} aria-label={k} />
                  : typeof cur === 'number' ? <input type="number" value={val as number} onChange={e => setDraft({ ...draft, [k]: +e.target.value })} aria-label={k} />
                  : <input value={val as string} onChange={e => setDraft({ ...draft, [k]: e.target.value })} aria-label={k} />}
                {dirty && <button type="button" className="primary" onClick={() => save(k)}>{t('save', 'Save')}</button>}
              </div>
            )
          })}
        </section>
      ))}
      <section className="panel">
        <h2>{t('set_about', 'About')}</h2>
        <p>CrewBoard {__APP_VERSION__} · {t('aboutWhat', 'Crew rotation and dispatch')}</p>
        <p>{t('madeBy', 'Made by')} <strong>Mohaned Gobbi</strong> <span className="muted">· © 2026 Mohaned Gobbi</span></p>
      </section>
    </main>
  )
}
