import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Check, Plus, Wand2 } from 'lucide-react'
import { PageGuide } from './guide'
import { api, ApiError } from './api'
import { useAuth } from './auth'
import { Modal, ViolationList } from './dialogs'
import { errMsg, go, useApi, useLive, useRequireApproval, useRoute } from './hooks'
import { fmtDate, FIX_LABEL, PLAN_LABEL, PLAN_STEPS, plural } from './labels'
import { SuggestDialog } from './suggest'
import { Pill, useToast } from './ui'
import type { Severity } from './types'
import { PersonLink, SeatLabel } from './profiles'

interface Gap {
  seatId: string; seat: string; from: string; to: string; required: boolean
  options: { kind: string; employeeId?: string; employee?: string; days?: number; needsOverride: boolean; label: string }[]
}
interface Summary { mode: string; stats: { slots: number; placements: number; gaps: number; coveredDays: number; gapDays: number; requiredGapDays: number }; gaps: Gap[]; engineMs: number }
interface PlanRow { id: string; version: number; status: string; periodStart: string; periodEnd: string; scope: string[]; createdAt: string; summary: Summary | null; decisionNote?: string | null; publishedAt?: string | null }
interface PlanAssignment {
  id: string; status: string; type: string; start: string; end: string; explanation: string | null; overrideReason: string | null
  employee: { id: string; firstName: string; lastName: string; employeeNo: string }; seatId: string; seat: string
}
interface PlanDetail extends PlanRow { assignments: PlanAssignment[] }
interface Diff {
  from: { version: number }; to: { version: number }
  added: { seat: string; from: string; to: string; employee: string }[]
  removed: { seat: string; from: string; to: string; employee: string }[]
  changed: { seat: string; from: string; to: string; employee: string; was: { employee: string; from: string; to: string } }[]
  unchanged: number
}
interface Problem { assignmentId: string; seatId: string; employeeId: string; start: string; end: string; reasons: string[] }

const STATUS_SEVERITY: Record<string, Severity> = { DRAFT: 'info', REVIEW: 'warn', APPROVED: 'ok', PUBLISHED: 'ok' }
const today = () => new Date().toISOString().slice(0, 10)
const addDays = (iso: string, n: number) => new Date(Date.parse(iso) + n * 86_400_000).toISOString().slice(0, 10)

export default function Plans() {
  const { parts } = useRoute()
  return parts[1] ? <PlanView id={parts[1]} /> : <PlanList />
}

// ---------------------------------------------------------------- list + new plan

function PlanList() {
  const { t, i18n } = useTranslation()
  const { can } = useAuth()
  const approval = useRequireApproval()
  const toast = useToast()
  const plans = useApi<PlanRow[]>('/planning/plans')
  const bases = useApi<{ id: string; code: string; name: string }[]>('/bases')
  useLive(plans.reload)
  const [open, setOpen] = useState(false)
  const [start, setStart] = useState(today())
  const [end, setEnd] = useState(addDays(today(), 27))
  const [picked, setPicked] = useState<string[]>([])
  const [mode, setMode] = useState<'full' | 'repair'>('full')
  const [busy, setBusy] = useState(false)
  const baseCode = (id: string) => bases.data?.find(b => b.id === id)?.code ?? '?'

  const create = async () => {
    setBusy(true)
    try {
      const p = await api<{ id: string }>('/planning/plans', { method: 'POST', body: { start, end, baseIds: picked.length ? picked : undefined, mode } })
      go(`plans/${p.id}`)
    } catch (e) { toast(errMsg(e), 'error') } finally { setBusy(false) }
  }

  return (
    <main className="page">
      <PageGuide id="plans" Icon={Wand2} color="var(--pal-violet-600)" title={t('plansTitle', 'Plans')}
        purpose={t('plansPurpose', 'Let the planner propose who works where for the coming weeks, check it, then publish it to everyone.')}
        steps={[
          t('plStep1', '"New plan": choose the weeks and bases. The planner fills every seat it can while following every rule.'),
          t('plStep2', 'Open the draft: each assignment says why that person was chosen; empty seats come with ways to fix them.'),
          approval ? t('plStep3', 'Change anything by hand, then submit. A manager approves and publishes it.') : t('plStep3direct', 'Change anything by hand, then publish it.'),
          t('plStep4', 'Publishing makes the plan live on the board and notifies everyone concerned. Until then nothing changes.'),
        ]}>
        {can('SUPER_ADMIN', 'OPS_MANAGER', 'DISPATCHER', 'BASE_MANAGER') && <button type="button" className="primary" onClick={() => setOpen(!open)}><Plus size={15} aria-hidden /> {t('newPlan', 'New plan')}</button>}
      </PageGuide>

      {open && (
        <section className="panel" aria-label="New plan">
          <div className="dates">
            <label>{t('from', 'From')}<input type="date" value={start} onChange={e => setStart(e.target.value)} /></label>
            <label>{t('until', 'Until')}<input type="date" value={end} min={start} onChange={e => setEnd(e.target.value)} /></label>
          </div>
          <fieldset>
            <legend>{t('whatToPlan', 'What to plan')}</legend>
            <label className="check"><input type="radio" checked={mode === 'full'} onChange={() => setMode('full')} /> {t('modeFull', 'The whole period: every seat that needs someone')}</label>
            <label className="check"><input type="radio" checked={mode === 'repair'} onChange={() => setMode('repair')} /> {t('modeRepair', 'Repair: only the seats open replacement tasks are waiting for')}</label>
          </fieldset>
          <fieldset>
            <legend>{t('whichBases', 'Bases (none ticked = all)')}</legend>
            <div className="check-row">
              {bases.data?.map(b => (
                <label className="check" key={b.id}><input type="checkbox" checked={picked.includes(b.id)} onChange={e => setPicked(e.target.checked ? [...picked, b.id] : picked.filter(x => x !== b.id))} /> {b.code}</label>
              ))}
            </div>
          </fieldset>
          <p className="muted">{t('planNote2', 'This creates a draft. Nothing changes on the board until the plan is published.')}</p>
          <div className="actions"><button type="button" className="primary" disabled={busy || end < start} onClick={() => void create()}><Wand2 size={15} aria-hidden /> {busy ? t('planning', 'Planning…') : t('suggestPlan', 'Suggest a plan')}</button></div>
        </section>
      )}

      {plans.error && <div className="banner error" role="alert">{plans.error}</div>}
      {!plans.loading && (plans.data?.length ?? 0) === 0 && <p className="empty-note">{t('noPlans', 'No plans yet. Create one to see the engine at work.')}</p>}
      {(plans.data?.length ?? 0) > 0 && (
        <table className="table">
          <thead><tr><th>#</th><th>{t('status', 'Status')}</th><th>{t('period', 'Period')}</th><th>{t('bases', 'Bases')}</th><th>{t('coverage', 'Coverage')}</th><th>{t('created', 'Created')}</th></tr></thead>
          <tbody>
            {plans.data!.map(p => {
              const s = p.summary?.stats
              return (
                <tr key={p.id} className="click" onClick={() => go(`plans/${p.id}`)}>
                  <td><a href={`#/plans/${p.id}`}>v{p.version}</a></td>
                  <td><Pill severity={STATUS_SEVERITY[p.status] ?? 'info'}>{PLAN_LABEL[p.status] ?? p.status}</Pill></td>
                  <td>{fmtDate(p.periodStart, i18n.language)} → {fmtDate(p.periodEnd, i18n.language)}{p.summary?.mode === 'repair' ? ' · repair' : ''}</td>
                  <td>{p.scope.length === (bases.data?.length ?? -1) ? t('allBases', 'All bases') : p.scope.map(baseCode).join(', ')}</td>
                  <td>{s ? <>{s.placements} {t('placements', 'placements')}{s.gaps ? <> · <strong className="gap-text">{plural(s.gaps, 'gap')}</strong></> : ' · no gaps'}</> : '—'}</td>
                  <td className="muted">{new Date(p.createdAt).toLocaleString(i18n.language)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </main>
  )
}

// ---------------------------------------------------------------- one plan

function PlanView({ id }: { id: string }) {
  const { t, i18n } = useTranslation()
  const { can } = useAuth()
  const toast = useToast()
  const plan = useApi<PlanDetail>(`/planning/plans/${id}`)
  useLive(plan.reload)
  const [tab, setTab] = useState<'assignments' | 'gaps' | 'changes'>('assignments')
  const [suggest, setSuggest] = useState<null | { title: string; seatId: string; start: string; end: string; onPick: (e: string, r?: string) => Promise<void> }>(null)
  const [problems, setProblems] = useState<Problem[] | null>(null)
  const [reasonFor, setReasonFor] = useState<'reject' | null>(null)
  const [reason, setReason] = useState('')

  const p = plan.data
  const planner = can('SUPER_ADMIN', 'OPS_MANAGER', 'DISPATCHER', 'BASE_MANAGER')
  const manager = can('SUPER_ADMIN', 'OPS_MANAGER')
  const editable = p?.status === 'DRAFT' && planner
  const approval = useRequireApproval()
  const steps: readonly string[] = approval ? PLAN_STEPS : ['DRAFT', 'PUBLISHED']

  const act = async (path: string, body: unknown, ok: string) => {
    try { await api(path, { method: 'POST', body }); toast(ok); await plan.reload() } catch (e) { toast(errMsg(e), 'error') }
  }
  const publish = async (skipInvalid: boolean) => {
    try {
      const r = await api<{ published: number; skipped: number }>(`/planning/plans/${id}/publish`, { method: 'POST', body: { skipInvalid } })
      toast(`Published: ${plural(r.published, 'assignment')}${r.skipped ? `, ${r.skipped} skipped` : ''}`)
      setProblems(null); await plan.reload()
    } catch (e) {
      if (e instanceof ApiError && e.status === 422) setProblems((e.body as { problems?: Problem[] }).problems ?? [])
      else toast(errMsg(e), 'error')
    }
  }

  const grouped = useMemo(() => {
    const m = new Map<string, PlanAssignment[]>()
    for (const a of p?.assignments ?? []) (m.get(a.seat) ?? m.set(a.seat, []).get(a.seat)!).push(a)
    return [...m.entries()].sort(([x], [y]) => x.localeCompare(y))
  }, [p])

  if (plan.error) return <main className="page"><div className="banner error">{plan.error}</div><a href="#/plans">← {t('allPlans', 'All plans')}</a></main>
  if (!p) return <main className="page"><p className="loading">{t('loading', 'Loading…')}</p></main>
  const stats = p.summary?.stats
  const gaps = p.summary?.gaps ?? []

  const changePerson = (a: PlanAssignment) => setSuggest({
    title: `${t('changePerson', 'Change person')}: ${a.seat}`, seatId: a.seatId, start: a.start.slice(0, 10), end: a.end.slice(0, 10),
    onPick: async (employeeId, overrideReason) => {
      await api(`/planning/plans/${id}/assignments/${a.id}`, { method: 'PUT', body: { employeeId, overrideReason } })
      toast(t('changed', 'Changed')); await plan.reload()
    },
  })
  const fillGap = (g: Gap) => {
    const end = addDays(g.from, 27) < g.to ? addDays(g.from, 27) : g.to
    setSuggest({
      title: `${t('findSomeone', 'Find someone')}: ${g.seat}`, seatId: g.seatId, start: g.from, end,
      onPick: async (employeeId, overrideReason) => {
        await api(`/planning/plans/${id}/assignments`, { method: 'POST', body: { employeeId, seatId: g.seatId, start: g.from, end, overrideReason } })
        toast(t('added', 'Added to the draft')); await plan.reload()
      },
    })
  }
  const remove = async (a: PlanAssignment) => {
    try { await api(`/planning/plans/${id}/assignments/${a.id}`, { method: 'DELETE' }); toast(t('removed', 'Removed from the draft')); await plan.reload() } catch (e) { toast(errMsg(e), 'error') }
  }

  return (
    <main className="page">
      <a className="back" href="#/plans"><ArrowLeft size={15} aria-hidden /> {t('allPlans', 'All plans')}</a>
      <header className="page-head">
        <div>
          <h1>{t('plan', 'Plan')} v{p.version} <small className="muted">{fmtDate(p.periodStart, i18n.language)} → {fmtDate(p.periodEnd, i18n.language)}{p.summary?.mode === 'repair' ? ' · repair' : ''}</small></h1>
          <ol className="stepper" aria-label="Plan status">
            {steps.map((s, i) => {
              const at = Math.max(steps.indexOf(p.status), 0)
              return <li key={s} className={i < at ? 'done' : i === at ? 'now' : ''}>{i < at && <Check size={12} aria-hidden />} {PLAN_LABEL[s]}</li>
            })}
          </ol>
          {p.decisionNote && <p className="note">{t('lastNote', 'Last note')}: {p.decisionNote}</p>}
        </div>
        <div className="actions">
          {p.status === 'DRAFT' && planner && approval && <button type="button" className="primary" disabled={!p.assignments.length} onClick={() => void act(`/planning/plans/${id}/submit`, {}, t('submitted', 'Sent for review'))}>{t('submit', 'Send for review')}</button>}
          {p.status !== 'PUBLISHED' && manager && !approval && <button type="button" className="primary" disabled={!p.assignments.length} onClick={() => void publish(false)}>{t('publish', 'Publish')}</button>}
          {p.status === 'DRAFT' && planner && <button type="button" onClick={async () => { try { await api(`/planning/plans/${id}`, { method: 'DELETE' }); toast(t('discarded', 'Plan discarded')); go('plans') } catch (e) { toast(errMsg(e), 'error') } }}>{t('discard', 'Discard')}</button>}
          {p.status === 'REVIEW' && manager && approval && <button type="button" className="primary" onClick={() => void act(`/planning/plans/${id}/approve`, {}, t('approved', 'Approved'))}>{t('approve', 'Approve')}</button>}
          {p.status === 'APPROVED' && manager && approval && <button type="button" className="primary" onClick={() => void publish(false)}>{t('publish', 'Publish')}</button>}
          {['REVIEW', 'APPROVED'].includes(p.status) && manager && approval && <button type="button" onClick={() => setReasonFor('reject')}>{t('sendBack', 'Send back…')}</button>}
          {p.status === 'REVIEW' && !manager && <span className="muted">{t('waitingApproval', 'Waiting for the ops manager')}</span>}
        </div>
      </header>

      {stats && (
        <section className="summary" aria-label="Plan summary">
          <div className="kpi sev-ok"><strong>{stats.placements}</strong><span>{t('placements', 'Placements')}</span></div>
          <div className="kpi sev-ok"><strong>{stats.coveredDays}</strong><span>{t('seatDays', 'Seat-days covered')}</span></div>
          <div className={`kpi sev-${stats.requiredGapDays ? 'bad' : 'ok'}`}><strong>{stats.gaps}</strong><span>{t('gaps', 'Gaps')}</span>{stats.requiredGapDays > 0 && <small>{plural(stats.requiredGapDays, 'required seat-day')}</small>}</div>
          <div className="kpi sev-ok"><strong>{p.summary?.engineMs ?? 0} ms</strong><span>{t('engineTime', 'Engine time')}</span></div>
        </section>
      )}

      <nav className="subtabs" aria-label="Plan sections">
        <button type="button" className={tab === 'assignments' ? 'on' : ''} onClick={() => setTab('assignments')}>{t('assignments', 'Assignments')} ({p.assignments.length})</button>
        <button type="button" className={tab === 'gaps' ? 'on' : ''} onClick={() => setTab('gaps')}>{t('gaps', 'Gaps')} ({gaps.length})</button>
        <button type="button" className={tab === 'changes' ? 'on' : ''} onClick={() => setTab('changes')}>{t('changes', 'Changes')}</button>
      </nav>

      {tab === 'assignments' && (
        <>
          {p.assignments.length === 0 && <p className="empty-note">{t('noAssignments', 'The engine placed nobody: every seat that needed someone is a gap.')}</p>}
          {grouped.map(([seat, rows]) => (
            <section key={seat} className="seat-group">
              <h3>{seat}</h3>
              <table className="table compact">
                <tbody>
                  {rows.map(a => (
                    <tr key={a.id}>
                      <td className="nowrap">{fmtDate(a.start, i18n.language)} → {fmtDate(a.end, i18n.language)}</td>
                      <td><strong><PersonLink id={a.employee.id}>{a.employee.firstName} {a.employee.lastName}</PersonLink></strong>{a.type === 'REPLACEMENT' && <span className="tag tag-restr">replacement</span>}{a.overrideReason && <Pill severity="warn">override: {a.overrideReason}</Pill>}
                        <small className="why">{a.explanation}</small></td>
                      <td className="row-actions end">
                        {editable && <button type="button" onClick={() => changePerson(a)}>{t('change', 'Change')}</button>}
                        {editable && <button type="button" onClick={() => void remove(a)}>{t('remove', 'Remove')}</button>}
                        {!editable && a.status !== 'DRAFT' && <Pill severity="ok">{a.status.toLowerCase()}</Pill>}
                        {!editable && a.status === 'DRAFT' && <Pill severity="info">draft</Pill>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))}
        </>
      )}

      {tab === 'gaps' && (
        <>
          {gaps.length === 0 && <p className="ok-line">{t('noGaps', 'No gaps: every seat is covered.')}</p>}
          {gaps.map((g, i) => (
            <section key={`${g.seatId}-${g.from}-${i}`} className="gap">
              <header>
                <strong><SeatLabel label={g.seat ?? ''} /></strong>
                <span>{fmtDate(g.from, i18n.language)} → {fmtDate(g.to, i18n.language)}</span>
                <Pill severity={g.required ? 'bad' : 'info'}>{g.required ? t('required', 'Required') : t('optional', 'Optional')}</Pill>
                {editable && <button type="button" className="primary" onClick={() => fillGap(g)}>{t('findSomeone', 'Find someone')}</button>}
              </header>
              <ol className="fixes" aria-label="Ways to fix this gap, best first">
                {g.options.map((o, k) => (
                  <li key={k}><strong>{FIX_LABEL[o.kind] ?? o.kind}</strong> <span>{o.label}</span>{o.needsOverride && <Pill severity="warn">{t('needsReason', 'needs a reason')}</Pill>}</li>
                ))}
              </ol>
            </section>
          ))}
        </>
      )}

      {tab === 'changes' && <ChangesTab id={id} />}

      {suggest && <SuggestDialog {...suggest} onClose={() => setSuggest(null)} />}

      {problems && (
        <Modal title={t('publishProblems', 'Some drafts no longer work')} onClose={() => setProblems(null)}>
          <p className="muted">{t('publishProblemsIntro', 'Things changed since this plan was made (leave, qualifications, other assignments). These drafts break a rule now:')}</p>
          <ul className="problem-list">
            {problems.map(x => {
              const a = p.assignments.find(y => y.id === x.assignmentId)
              return <li key={x.assignmentId}><strong>{a?.seat}</strong> · {a?.employee.firstName} {a?.employee.lastName} · {fmtDate(x.start, i18n.language)} → {fmtDate(x.end, i18n.language)}<ViolationList violations={x.reasons.map(m => ({ rule: 'x', severity: 'hard' as const, message: m }))} /></li>
            })}
          </ul>
          <p className="muted">{t('skipNote', 'Publishing the rest leaves the skipped days as open replacement tasks.')}</p>
          <footer>
            <button type="button" onClick={() => setProblems(null)}>{t('cancel', 'Cancel')}</button>
            <button type="button" className="primary" onClick={() => void publish(true)}>{t('publishValid', 'Publish the valid ones')}</button>
          </footer>
        </Modal>
      )}

      {reasonFor && (
        <Modal title={t('sendBack', 'Send back…')} onClose={() => setReasonFor(null)}>
          <label className="reason">{t('reason', 'Reason')}<input value={reason} onChange={e => setReason(e.target.value)} autoFocus /></label>
          <footer>
            <button type="button" onClick={() => setReasonFor(null)}>{t('cancel', 'Cancel')}</button>
            <button type="button" className="primary" disabled={!reason.trim()} onClick={() => { void act(`/planning/plans/${id}/reject`, { reason: reason.trim() }, t('sentBack', 'Sent back to the dispatcher')); setReasonFor(null); setReason('') }}>{t('sendBack', 'Send back…')}</button>
          </footer>
        </Modal>
      )}
    </main>
  )
}

function ChangesTab({ id }: { id: string }) {
  const { t, i18n } = useTranslation()
  const diff = useApi<Diff>(`/planning/plans/${id}/diff`)
  if (diff.loading) return <p className="muted">{t('loading', 'Loading…')}</p>
  if (diff.error) return <p className="empty-note">{diff.error.includes('earlier') ? t('noBaseline', 'There is no earlier published plan to compare with yet.') : diff.error}</p>
  const d = diff.data!
  const row = (r: { seat: string; from: string; to: string; employee: string }, extra?: string) => <li key={`${r.seat}${r.from}${r.employee}`}><strong>{r.seat}</strong> · {fmtDate(r.from, i18n.language)} → {fmtDate(r.to, i18n.language)} · {r.employee}{extra && <span className="muted"> ({extra})</span>}</li>
  return (
    <section>
      <p className="muted">{t('comparedWith', 'Compared with version')} {d.from.version} · {d.unchanged} {t('unchanged', 'unchanged')}</p>
      <h3>{t('added', 'Added')} ({d.added.length})</h3><ul className="diff add">{d.added.map(r => row(r))}</ul>
      <h3>{t('removedTitle', 'Removed')} ({d.removed.length})</h3><ul className="diff del">{d.removed.map(r => row(r))}</ul>
      <h3>{t('changedTitle', 'Changed')} ({d.changed.length})</h3><ul className="diff chg">{d.changed.map(r => row(r, `was ${r.was.employee}`))}</ul>
    </section>
  )
}
