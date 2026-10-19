import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertOctagon, AlertTriangle, CalendarDays, CheckCircle2, Clock, HeartPulse, Inbox, Radar, Repeat, Siren, Truck, UserMinus, UserX } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { api, ApiError } from './api'
import { useAuth } from './auth'
import { Modal, RuleDialog } from './dialogs'
import { errMsg, useApi, useLive } from './hooks'
import { countdown, fmtDate, plural, RULE_LABEL, TRIGGER_LABEL } from './labels'
import type { Violation } from './types'
import { PageGuide, Legend } from './guide'
import { useToast } from './ui'
import { PersonLink, SeatLabel } from './profiles'

interface Task {
  id: string; status: string; urgency: string; trigger: string; from: string; to: string; days: number; daysUntilStart: number | null
  seatId: string; seat: string; candidate: { id: string; name: string } | null; escalatedAt: string | null
}
interface Candidates {
  task: Task; seat: string; from: string; to: string; validCandidates: number
  candidates: { employeeId: string; score: number; explanation: string; employee?: string }[]
  ruledOut: { employeeId: string; employee?: string; because: string[] }[]
}

const DAY = 86_400_000
const addDays = (iso: string, n: number) => new Date(Date.parse(iso) + n * DAY).toISOString().slice(0, 10)
const minIso = (a: string, b: string) => (a < b ? a : b)
const todayIso = () => new Date().toISOString().slice(0, 10)
const URG: Record<string, { color: string; label: string; Icon: LucideIcon }> = {
  CRITICAL: { color: '#b91c1c', label: 'Critical', Icon: AlertOctagon },
  HIGH: { color: '#c2410c', label: 'High', Icon: AlertTriangle },
  NORMAL: { color: '#1d4ed8', label: 'Normal', Icon: Clock },
}
const TRIGGER_ICON: Record<string, LucideIcon> = { medical_leave: HeartPulse, leave: CalendarDays, unit_deployed: Truck, unassigned: UserMinus, employee_archived: UserX }
const isOpen = (t: Task) => ['OPEN', 'ESCALATED', 'CANDIDATE_PROPOSED'].includes(t.status)

/** Replacement center (plan 16): every seat that needs someone, most urgent first, with the best people one click away. */
export default function Replacements() {
  const { t } = useTranslation()
  const { can } = useAuth()
  const toast = useToast()
  const [urgency, setUrgency] = useState('')
  const [showAll, setShowAll] = useState(false)
  const tasks = useApi<Task[]>(`/replacements${showAll ? '?all=true' : ''}`)
  const [selected, setSelected] = useState<string | null>(null)
  useLive(tasks.reload)

  const all = useMemo(() => tasks.data ?? [], [tasks.data])
  const rows = all.filter(r => !urgency || r.urgency === urgency)
  useEffect(() => { if (selected && !all.some(r => r.id === selected)) setSelected(null) }, [all, selected])
  useEffect(() => { if (!selected && rows.length) setSelected(rows.find(isOpen)?.id ?? rows[0].id) }, [rows, selected])
  const current = all.find(r => r.id === selected) ?? null

  const run = async (label: string, fn: () => Promise<unknown>) => {
    try { await fn(); toast(label); void tasks.reload() } catch (e) { toast(errMsg(e), 'error') }
  }
  const count = (u: string) => all.filter(r => r.urgency === u && isOpen(r)).length
  const escalated = all.filter(r => r.status === 'ESCALATED').length
  const lanes: [string, Task[]][] = [
    [t('laneNow', 'Uncovered now'), rows.filter(r => isOpen(r) && (r.daysUntilStart ?? 0) <= 0)],
    [t('laneWeek', 'Starting this week'), rows.filter(r => isOpen(r) && (r.daysUntilStart ?? 0) > 0 && (r.daysUntilStart ?? 0) <= 7)],
    [t('laneLater', 'Later'), rows.filter(r => isOpen(r) && (r.daysUntilStart ?? 0) > 7)],
    [t('laneDone', 'Finished'), rows.filter(r => !isOpen(r))],
  ]

  return (
    <main className="page wide rc">
      <PageGuide id="replacements" Icon={Repeat} color="#dc2626" title={t('replacementsTitle', 'Replacement center')}
        purpose={t('replacementsPurpose', 'Every seat that has lost its person or never had one, most urgent first, with the best people to fill it.')}
        steps={[
          t('rcStep1', 'Tasks appear by themselves when someone goes on leave, falls sick, or a unit gets a job without a crew. "Scan" checks the next four weeks for anything missed.'),
          t('rcStep2', 'Pick a task: the right side ranks the people who can take the seat, with the reason for each and why the others cannot.'),
          t('rcStep3', '"Confirm" puts the person on the seat and tells them, the person leaving and the chief. "Propose" only reserves them.'),
          t('rcStep4', 'Nobody suitable? Escalate to the operations manager, or close the task with a reason.'),
        ]}>
        <button type="button" onClick={() => void run(t('scanned', 'Scan finished'), async () => {
          const r = await api<{ created: number }>('/replacements/scan', { method: 'POST', body: {} })
          toast(`${plural(r.created, 'new task')} found`)
        })}><Radar size={15} aria-hidden /> {t('scan', 'Scan next 4 weeks')}</button>
        <button type="button" onClick={() => void run(t('escalatedDue', 'Escalated'), () => api('/replacements/escalate-due', { method: 'POST' }))}><Siren size={15} aria-hidden /> {t('escalateDue', 'Escalate what is due')}</button>
      </PageGuide>

      <section className="rc-kpis" aria-label="Summary">
        {(['CRITICAL', 'HIGH', 'NORMAL'] as const).map(u => {
          const m = URG[u]
          return (
            <button key={u} type="button" className="kpi2" style={{ ['--c' as string]: count(u) ? m.color : '#16a34a', outline: urgency === u ? '3px solid var(--text)' : undefined }} onClick={() => setUrgency(urgency === u ? '' : u)}>
              <m.Icon size={22} className="k-icon" aria-hidden /><strong>{count(u)}</strong><span>{t(`urg_${u}`, m.label)}</span>
              <small>{u === 'CRITICAL' ? t('critHint', 'seat empty today or tomorrow') : u === 'HIGH' ? t('highHint', 'within the week') : t('normHint', 'time to plan')}</small>
            </button>
          )
        })}
        <div className="kpi2" style={{ ['--c' as string]: escalated ? '#7c3aed' : '#475569' }}>
          <Siren size={22} className="k-icon" aria-hidden /><strong>{escalated}</strong><span>{t('escalated', 'Escalated')}</span><small>{t('escHint', 'waiting for the ops manager')}</small>
        </div>
      </section>

      {all.some(isOpen) && <Gantt tasks={rows.filter(isOpen)} selected={selected} onPick={setSelected} />}

      <div className="filters" style={{ margin: 0 }}>
        <label className="check"><input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} /> {t('includeClosed', 'Show finished tasks too')}</label>
        {urgency && <button type="button" onClick={() => setUrgency('')}>{t('clearFilter', 'Clear filter')} ✕</button>}
      </div>

      {tasks.error && <div className="banner error" role="alert">{tasks.error}</div>}
      {!tasks.loading && rows.length === 0 ? (
        <div className="card2 rc-empty"><CheckCircle2 size={44} aria-hidden /><h2>{t('allCovered', 'Every seat is covered')}</h2><p>{t('noTasks', 'Nothing needs a replacement. Press "Scan next 4 weeks" to double-check.')}</p></div>
      ) : (
        <div className="rc-body">
          <section className="rc-list" aria-label="Tasks">
            {lanes.filter(([, l]) => l.length).map(([title, list]) => (
              <div key={title} className="rc-list">
                <div className="rc-lane-title">{title} · {list.length}</div>
                {list.map(r => <TaskCard key={r.id} task={r} on={r.id === selected} onClick={() => setSelected(r.id)} />)}
              </div>
            ))}
          </section>
          <aside aria-label="Task details">
            {current ? <TaskDetail key={current.id} task={current} canEdit={can('SUPER_ADMIN', 'OPS_MANAGER', 'DISPATCHER', 'BASE_MANAGER')} onChanged={() => void tasks.reload()} />
              : <div className="card2 rc-empty"><Inbox size={40} aria-hidden /><p>{t('pickTask', 'Pick a task on the left to see who can take it.')}</p></div>}
          </aside>
        </div>
      )}
    </main>
  )
}

function TaskCard({ task, on, onClick }: { task: Task; on: boolean; onClick: () => void }) {
  const { i18n } = useTranslation()
  const m = URG[task.urgency] ?? URG.NORMAL
  const Icon = TRIGGER_ICON[task.trigger] ?? AlertTriangle
  const d = task.daysUntilStart ?? 0
  const open = isOpen(task)
  return (
    <button type="button" className={`tcard${on ? ' on' : ''}`} style={{ ['--c' as string]: open ? m.color : '#64748b' }} onClick={onClick}>
      <span className="count">{open ? (d <= 0 ? <><b>!</b><small>now</small></> : <><b>{d}</b><small>{d === 1 ? 'day' : 'days'}</small></>) : <><CheckCircle2 size={22} /><small>done</small></>}</span>
      <span className="t-main">
        <strong>{task.seat}</strong>
        <small>{fmtDate(task.from, i18n.language)} → {fmtDate(task.to, i18n.language)} · {plural(task.days, 'day')}</small>
        <span className="t-meta">
          <span className="tag2" style={{ ['--c' as string]: m.color }}><m.Icon size={11} aria-hidden /> {m.label}</span>
          <span className="tag2" style={{ ['--c' as string]: '#475569' }}><Icon size={11} aria-hidden /> {TRIGGER_LABEL[task.trigger] ?? task.trigger}</span>
          {task.status === 'ESCALATED' && <span className="tag2" style={{ ['--c' as string]: '#7c3aed' }}><Siren size={11} aria-hidden /> escalated</span>}
          {task.status === 'CANDIDATE_PROPOSED' && task.candidate && <span className="tag2" style={{ ['--c' as string]: '#2563eb' }}>→ {task.candidate.name}</span>}
        </span>
      </span>
    </button>
  )
}

/** The next four weeks with one bar per open task: how soon, how long, how urgent. */
function Gantt({ tasks, selected, onPick }: { tasks: Task[]; selected: string | null; onPick: (id: string) => void }) {
  const { t, i18n } = useTranslation()
  const n = 28, start = todayIso()
  const days = Array.from({ length: n }, (_, i) => addDays(start, i))
  const idx = (d: string) => Math.round((Date.parse(d) - Date.parse(start)) / DAY)
  const sorted = [...tasks].sort((a, b) => a.from.localeCompare(b.from)).slice(0, 14)
  return (
    <section className="card2 rc-gantt" aria-label="Next four weeks">
      <h2><CalendarDays size={16} aria-hidden /> {t('nextWeeks', 'The next four weeks')}<small>{t('ganttHint', 'each bar is a seat without a person; click one to open it')}</small></h2>
      <div className="gantt" style={{ ['--n' as string]: n }}>
        <span />
        {days.map((d, i) => {
          const dt = new Date(d)
          return <span key={d} className={`g-day${i === 0 ? ' today' : ''}${[5, 6].includes(dt.getUTCDay()) ? ' we' : ''}`}>{i === 0 ? t('todayShort', 'today') : dt.getUTCDate()}</span>
        })}
        {sorted.map(r => {
          const s = Math.max(0, idx(r.from)), e = Math.min(n - 1, idx(r.to))
          if (e < 0 || s > n - 1) return null
          const m = URG[r.urgency] ?? URG.NORMAL
          return [
            <button key={`${r.id}-n`} type="button" className="g-name" onClick={() => onPick(r.id)} title={r.seat}>{r.seat.replace(' · Field Operator', ' · Op').replace(' · Chief of Unit', ' · Chief')}</button>,
            <button key={`${r.id}-b`} type="button" className={`g-bar${selected === r.id ? ' on' : ''}`} style={{ gridColumn: `${s + 2} / ${e + 3}`, background: `linear-gradient(90deg, ${m.color}, color-mix(in srgb, ${m.color} 70%, #000))` }}
              onClick={() => onPick(r.id)} title={`${r.seat}: ${fmtDate(r.from, i18n.language)} → ${fmtDate(r.to, i18n.language)}`}>{plural(r.days, 'day')}</button>,
            e < n - 1 ? <span key={`${r.id}-f`} style={{ gridColumn: `${e + 3} / ${n + 2}` }} /> : null,
          ]
        })}
      </div>
      <Legend items={Object.values(URG).map(u => ({ color: u.color, label: u.label, shape: 'bar' as const }))} />
    </section>
  )
}

function TaskDetail({ task, canEdit, onChanged }: { task: Task; canEdit: boolean; onChanged: () => void }) {
  const { t, i18n } = useTranslation()
  const toast = useToast()
  const open = isOpen(task)
  const cands = useApi<Candidates>(open ? `/replacements/${task.id}/candidates?top=6` : null)
  const [start, setStart] = useState(task.from)
  const [end, setEnd] = useState(minIso(task.to, addDays(task.from, 27)))
  const [rule, setRule] = useState<{ employeeId: string; name: string; violations: Violation[] } | null>(null)
  const [closing, setClosing] = useState(false)
  const [closeReason, setCloseReason] = useState('')
  const [busy, setBusy] = useState(false)
  const m = URG[task.urgency] ?? URG.NORMAL

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

  const reasons = useMemo(() => {
    const c = new Map<string, number>()
    for (const r of cands.data?.ruledOut ?? []) for (const b of r.because) c.set(b, (c.get(b) ?? 0) + 1)
    return [...c.entries()].sort((a, b) => b[1] - a[1])
  }, [cands.data])
  const top = cands.data?.candidates[0]?.score || 1
  const spanDays = Math.round((Date.parse(task.to) - Date.parse(task.from)) / DAY) + 1
  const covered = (i: number) => { const d = addDays(task.from, i); return d >= start && d <= end }

  return (
    <div className="rc-detail">
      <div className="rc-detail-head" style={{ ['--c' as string]: open ? m.color : '#475569' }}>
        <h2 className="on-color"><SeatLabel label={task.seat} /></h2>
        <div className="row">
          <span><m.Icon size={13} aria-hidden /> {m.label}</span>
          <span><CalendarDays size={13} aria-hidden /> {fmtDate(task.from, i18n.language)} → {fmtDate(task.to, i18n.language)}</span>
          <span>{TRIGGER_LABEL[task.trigger] ?? task.trigger}</span>
          {open && <span><Clock size={13} aria-hidden /> {countdown(task.daysUntilStart)}</span>}
        </div>
      </div>
      <div className="rc-detail-body">
        {!open && <p className="ok-line"><CheckCircle2 size={15} aria-hidden /> {t('taskFinished', 'This task is finished.')}</p>}
        {open && (
          <>
            <h3>{t('whichDays', 'Which days to cover')}</h3>
            <div className="dates">
              <label>{t('covers', 'From')}<input type="date" value={start} min={task.from} max={task.to} onChange={e => setStart(e.target.value)} /></label>
              <label>{t('until', 'Until')}<input type="date" value={end} min={start} max={task.to} onChange={e => setEnd(e.target.value)} /></label>
            </div>
            <div className="cover-strip" title={t('coverStrip', 'Blue days are covered by this choice')}>{Array.from({ length: Math.min(spanDays, 60) }, (_, i) => <i key={i} className={covered(i) ? 'in' : ''} />)}</div>
            {end < task.to && <p className="note" style={{ margin: 0 }}>{t('partialNote', 'The grey days stay open as a new task.')}</p>}

            <h3>{t('bestPeople', 'Best people for this seat')}</h3>
            {cands.loading && <p className="muted">{t('checking', 'Checking the rules…')}</p>}
            {cands.error && <p className="error">{cands.error}</p>}
            {cands.data && cands.data.candidates.length === 0 && <p className="empty-note">{t('noCandidates', 'Nobody can take this seat for these days without breaking a rule. Try fewer days, or escalate.')}</p>}
            <ul className="cand2">
              {cands.data?.candidates.map((c, i) => (
                <li key={c.employeeId} className={`${i === 0 ? 'top' : ''}${task.candidate?.id === c.employeeId ? ' proposed' : ''}`}>
                  <span className="medal">{i + 1}</span>
                  <div>
                    <strong><PersonLink id={c.employeeId}>{c.employee}</PersonLink></strong>{task.candidate?.id === c.employeeId && <span className="tag2" style={{ ['--c' as string]: '#2563eb', marginInlineStart: 6 }}>{t('proposed', 'proposed')}</span>}
                    <div className="scorebar" style={{ margin: '4px 0' }} title={`${t('fit', 'fit')} ${Math.round(c.score / top * 100)}%`}><i style={{ width: `${Math.max(8, c.score / top * 100)}%` }} /></div>
                    <small className="why">{c.explanation}</small>
                  </div>
                  {canEdit && (
                    <span className="acts">
                      <button type="button" disabled={busy || task.candidate?.id === c.employeeId} onClick={() => void act(`/replacements/${task.id}/propose`, { employeeId: c.employeeId }, `${c.employee} proposed`)}>{t('propose', 'Propose')}</button>
                      <button type="button" className="primary" disabled={busy} onClick={() => void tryConfirm(c.employeeId, c.employee ?? '')}>{t('confirm', 'Confirm')}</button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
            {reasons.length > 0 && (
              <details className="ruled-out" open={cands.data?.candidates.length === 0}>
                <summary>{t('whyOthers', 'Why others cannot take it')} ({cands.data?.ruledOut.length})</summary>
                <div className="reasons" style={{ marginTop: 8 }}>
                  {reasons.map(([k, n]) => <div key={k} className="reason-row"><span>{RULE_LABEL[k] ?? k}</span><div><i style={{ width: `${(n / reasons[0][1]) * 100}%` }} /></div><b>{n}</b></div>)}
                </div>
              </details>
            )}
            {canEdit && (
              <div className="row-actions end">
                {task.status !== 'ESCALATED' && <button type="button" onClick={() => void act(`/replacements/${task.id}/escalate`, {}, t('escalatedOk', 'Escalated to the ops manager'))}><Siren size={14} aria-hidden /> {t('escalate', 'Escalate')}</button>}
                <button type="button" onClick={() => setClosing(true)}>{t('closeNoRepl', 'Close without a replacement')}</button>
              </div>
            )}
          </>
        )}
      </div>

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
