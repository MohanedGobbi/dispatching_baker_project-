import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Radar, Siren } from 'lucide-react'
import { api, ApiError } from './api'
import { useAuth } from './auth'
import { Modal, RuleDialog } from './dialogs'
import { errMsg, useApi, useLive } from './hooks'
import { countdown, fmtDate, plural, RULE_LABEL, TRIGGER_LABEL } from './labels'
import type { Violation } from './types'
import { Pill, UrgencyChip, useToast } from './ui'

interface Task {
  id: string; status: string; urgency: string; trigger: string; from: string; to: string; days: number; daysUntilStart: number | null
  seatId: string; seat: string; candidate: { id: string; name: string } | null; escalatedAt: string | null
}
interface Candidates {
  task: Task; seat: string; from: string; to: string; validCandidates: number
  candidates: { employeeId: string; score: number; explanation: string; employee?: string }[]
  ruledOut: { employeeId: string; employee?: string; because: string[] }[]
}

const addDays = (iso: string, n: number) => new Date(Date.parse(iso) + n * 86_400_000).toISOString().slice(0, 10)
const minIso = (a: string, b: string) => (a < b ? a : b)

/** Replacement center (plan 16): every seat that needs someone, most urgent first, with the best people one click away. */
export default function Replacements() {
  const { t, i18n } = useTranslation()
  const { can } = useAuth()
  const toast = useToast()
  const [urgency, setUrgency] = useState('')
  const [showAll, setShowAll] = useState(false)
  const qs = `?${showAll ? 'all=true&' : ''}${urgency ? `urgency=${urgency}` : ''}`
  const tasks = useApi<Task[]>(`/replacements${qs}`)
  const [selected, setSelected] = useState<string | null>(null)
  useLive(tasks.reload)

  const rows = tasks.data ?? []
  useEffect(() => { if (selected && !rows.some(r => r.id === selected)) setSelected(null) }, [rows, selected])
  const current = rows.find(r => r.id === selected) ?? null

  const run = async (label: string, fn: () => Promise<unknown>) => {
    try { await fn(); toast(label); void tasks.reload() } catch (e) { toast(errMsg(e), 'error') }
  }

  const counts = useMemo(() => ({
    critical: rows.filter(r => r.urgency === 'CRITICAL').length,
    high: rows.filter(r => r.urgency === 'HIGH').length,
    escalated: rows.filter(r => r.status === 'ESCALATED').length,
  }), [rows])

  return (
    <main className="page">
      <header className="page-head">
        <div>
          <h1>{t('replacementsTitle', 'Replacement center')}</h1>
          <p className="muted">{t('replacementsIntro', 'Every seat that needs someone, most urgent first.')}</p>
        </div>
        <div className="actions">
          <button type="button" onClick={() => void run(t('scanned', 'Scan finished'), async () => {
            const r = await api<{ created: number }>('/replacements/scan', { method: 'POST', body: {} })
            toast(`${plural(r.created, 'new task')} found`)
          })}><Radar size={15} aria-hidden /> {t('scan', 'Scan for uncovered seats')}</button>
          <button type="button" onClick={() => void run(t('escalatedDue', 'Escalated'), () => api('/replacements/escalate-due', { method: 'POST' }))}><Siren size={15} aria-hidden /> {t('escalateDue', 'Escalate what is due')}</button>
        </div>
      </header>

      <div className="filters">
        <Pill severity={counts.critical ? 'bad' : 'ok'}>{counts.critical} {t('critical', 'critical')}</Pill>
        <Pill severity={counts.high ? 'warn' : 'ok'}>{counts.high} {t('high', 'high')}</Pill>
        <Pill severity={counts.escalated ? 'warn' : 'ok'}>{counts.escalated} {t('escalated', 'escalated')}</Pill>
        <span className="spacer" />
        <select value={urgency} onChange={e => setUrgency(e.target.value)} aria-label="Urgency">
          <option value="">{t('allUrgencies', 'Any urgency')}</option><option value="CRITICAL">Critical</option><option value="HIGH">High</option><option value="NORMAL">Normal</option>
        </select>
        <label className="check"><input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} /> {t('includeClosed', 'Include finished')}</label>
      </div>

      {tasks.error && <div className="banner error" role="alert">{tasks.error}</div>}
      <div className="split">
        <section aria-label="Tasks">
          {!tasks.loading && rows.length === 0 && <p className="empty-note">{t('noTasks', 'Nothing needs a replacement. Press "Scan for uncovered seats" to check the next four weeks.')}</p>}
          <ul className="task-list">
            {rows.map(r => (
              <li key={r.id}>
                <button type="button" className={`task sev-${r.urgency === 'CRITICAL' ? 'bad' : r.urgency === 'HIGH' ? 'warn' : 'ok'}${r.id === selected ? ' on' : ''}`} onClick={() => setSelected(r.id)}>
                  <span className="task-top"><UrgencyChip urgency={r.urgency} /><strong>{r.seat}</strong></span>
                  <span className="task-mid">{fmtDate(r.from, i18n.language)} → {fmtDate(r.to, i18n.language)} · {plural(r.days, 'day')}</span>
                  <span className="task-bot muted">
                    {TRIGGER_LABEL[r.trigger] ?? r.trigger}
                    {r.status === 'OPEN' || r.status === 'ESCALATED' || r.status === 'CANDIDATE_PROPOSED' ? ` · ${countdown(r.daysUntilStart)}` : ''}
                    {r.status === 'ESCALATED' && ' · escalated'}
                    {r.status === 'CANDIDATE_PROPOSED' && r.candidate && ` · proposed: ${r.candidate.name}`}
                    {r.status === 'CLOSED' && ' · done'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
        <aside className="detail" aria-label="Task details">
          {current ? <TaskDetail key={current.id} task={current} canEdit={can('SUPER_ADMIN', 'OPS_MANAGER', 'DISPATCHER', 'BASE_MANAGER')} onChanged={() => void tasks.reload()} /> : <p className="empty-note">{t('pickTask', 'Pick a task to see who can take it.')}</p>}
        </aside>
      </div>
    </main>
  )
}

function TaskDetail({ task, canEdit, onChanged }: { task: Task; canEdit: boolean; onChanged: () => void }) {
  const { t, i18n } = useTranslation()
  const toast = useToast()
  const open = ['OPEN', 'ESCALATED', 'CANDIDATE_PROPOSED'].includes(task.status)
  const cands = useApi<Candidates>(open ? `/replacements/${task.id}/candidates?top=6` : null)
  const [start, setStart] = useState(task.from)
  const [end, setEnd] = useState(minIso(task.to, addDays(task.from, 27)))
  const [rule, setRule] = useState<{ employeeId: string; name: string; violations: Violation[] } | null>(null)
  const [closing, setClosing] = useState(false)
  const [closeReason, setCloseReason] = useState('')
  const [busy, setBusy] = useState(false)

  const confirm = useCallback(async (employeeId: string, name: string, overrideReason?: string) => {
    const r = await api<{ closed: boolean; remaining: { from: string; to: string }[] }>(`/replacements/${task.id}/confirm`, { method: 'POST', body: { employeeId, start, end, overrideReason } })
    toast(`${name} ${t('confirmedFor', 'confirmed')} · ${r.closed ? t('taskDone', 'task done') : `${r.remaining.length} ${t('partsLeft', 'part(s) still open')}`}`)
    onChanged()
  }, [task.id, start, end, toast, onChanged, t])

  const tryConfirm = async (employeeId: string, name: string) => {
    setBusy(true)
    try { await confirm(employeeId, name) } catch (e) {
      if (e instanceof ApiError && e.status === 422) setRule({ employeeId, name, violations: (e.body as { violations?: Violation[] }).violations ?? [] })
      else toast(errMsg(e), 'error')
    } finally { setBusy(false) }
  }

  const act = async (path: string, body: unknown, ok: string) => {
    try { await api(path, { method: 'POST', body }); toast(ok); onChanged() } catch (e) { toast(errMsg(e), 'error') }
  }

  return (
    <div>
      <h2>{task.seat}</h2>
      <p className="muted">{fmtDate(task.from, i18n.language)} → {fmtDate(task.to, i18n.language)} · {plural(task.days, 'day')} · {TRIGGER_LABEL[task.trigger] ?? task.trigger}</p>
      <p><UrgencyChip urgency={task.urgency} /> <span className="muted">{countdown(task.daysUntilStart)}</span></p>

      {!open && <p className="ok-line">{t('taskFinished', 'This task is finished.')}</p>}
      {open && (
        <>
          <div className="dates">
            <label>{t('covers', 'Cover from')}<input type="date" value={start} min={task.from} max={task.to} onChange={e => setStart(e.target.value)} /></label>
            <label>{t('until', 'Until')}<input type="date" value={end} min={start} max={task.to} onChange={e => setEnd(e.target.value)} /></label>
          </div>
          {end < task.to && <p className="note">{t('partialNote', 'The rest of the days stay open as a new task.')}</p>}

          <h3>{t('bestPeople', 'Best people for this seat')}</h3>
          {cands.loading && <p className="muted">{t('checking', 'Checking the rules…')}</p>}
          {cands.error && <p className="error">{cands.error}</p>}
          {cands.data && cands.data.candidates.length === 0 && <p className="empty-note">{t('noCandidates', 'Nobody can take this seat for these days without breaking a rule.')}</p>}
          <ul className="cand-list">
            {cands.data?.candidates.map((c, i) => (
              <li key={c.employeeId} className={task.candidate?.id === c.employeeId ? 'proposed' : ''}>
                <div><strong>{i === 0 ? '★ ' : ''}{c.employee}</strong><small className="why">{c.explanation}</small></div>
                {canEdit && (
                  <span className="row-actions">
                    <button type="button" disabled={busy || task.candidate?.id === c.employeeId} onClick={() => void act(`/replacements/${task.id}/propose`, { employeeId: c.employeeId }, `${c.employee} proposed`)}>{t('propose', 'Propose')}</button>
                    <button type="button" className="primary" disabled={busy} onClick={() => void tryConfirm(c.employeeId, c.employee ?? '')}>{t('confirm', 'Confirm')}</button>
                  </span>
                )}
              </li>
            ))}
          </ul>
          {cands.data && cands.data.ruledOut.length > 0 && (
            <details className="ruled-out">
              <summary>{t('ruledOut', 'Ruled out')} ({cands.data.ruledOut.length})</summary>
              <ul>{cands.data.ruledOut.map(r => <li key={r.employeeId}><strong>{r.employee}</strong> — {r.because.map(b => RULE_LABEL[b] ?? b).join(', ')}</li>)}</ul>
            </details>
          )}

          {canEdit && (
            <div className="row-actions end">
              {task.status !== 'ESCALATED' && <button type="button" onClick={() => void act(`/replacements/${task.id}/escalate`, {}, t('escalatedOk', 'Escalated to the ops manager'))}>{t('escalate', 'Escalate')}</button>}
              <button type="button" onClick={() => setClosing(true)}>{t('closeNoRepl', 'Close without a replacement')}</button>
            </div>
          )}
        </>
      )}

      {rule && (
        <RuleDialog title={t('confirmAnyway', 'Confirm despite the rules?')} violations={rule.violations}
          summary={<><strong>{rule.name}</strong><span className="muted">→ {task.seat}</span></>}
          onClose={() => setRule(null)} onConfirm={reason => confirm(rule.employeeId, rule.name, reason)} />
      )}
      {closing && (
        <Modal title={t('closeNoRepl', 'Close without a replacement')} onClose={() => setClosing(false)}>
          <label className="reason">{t('reason', 'Reason')}<input value={closeReason} onChange={e => setCloseReason(e.target.value)} autoFocus placeholder="e.g. unit stood down" /></label>
          <footer>
            <button type="button" onClick={() => setClosing(false)}>{t('cancel', 'Cancel')}</button>
            <button type="button" className="primary" disabled={!closeReason.trim()} onClick={() => { void act(`/replacements/${task.id}/close`, { reason: closeReason.trim() }, t('closedOk', 'Task closed')); setClosing(false) }}>{t('close', 'Close')}</button>
          </footer>
        </Modal>
      )}
    </div>
  )
}
