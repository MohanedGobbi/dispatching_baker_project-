import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, ArrowRightLeft, Ban, CalendarCheck, CalendarClock, CheckCircle2, Download, FileText, Gauge, Pencil, Plus, Trash2, Truck, Wrench } from 'lucide-react'
import { api, download } from './api'
import { CrewChangeDialog } from './crewchange'
import type { ChangeRow } from './crewchange'
import { Modal } from './dialogs'
import { errMsg, go, useApi, useLive } from './hooks'
import { fmtDate } from './labels'
import { Legend } from './guide'
import { PersonLink } from './profiles'
import { SeatActionsButton, SeatActionsDialog } from './seatactions'
import type { SeatHolderRef } from './seatactions'
import { DeleteUnit, EditJobDialog, EditUnit, MoveUnit, NewJobDialog } from './unitforms'
import { STATUS } from './unitstatus'
import type { UnitRow } from './unitforms'
import { Pill, useToast } from './ui'
import type { Severity } from './types'

interface UnitD {
  id: string; code: string; status: string; plate: string | null; model: string | null; year: number | null; notes: string | null; homeBaseId: string; unitTypeId: string
  unitType: { name: string; colorKey: string }; homeBase: { code: string; name: string }
  seats: { id: string; position: string; index: number; required: boolean; requirements: SeatHolderRef['seat']['requirements'] | null; holder: { id: string; employeeNo: string; firstName: string; lastName: string; assignmentId: string; until: string; openEnded?: boolean } | null }[]
  deployments: { id: string; start: string; end: string; job: { id: string; ref: string; wellName: string; rigName: string | null; client: string | null; status: string; openEnded?: boolean } }[]
  workOrders: { id: string; type: string; priority: string; description: string | null; plannedStart: string; expectedReturn: string; status: string }[]
  crewMin?: number
  crewHistory: { id: string; start: string; plannedEnd: string; openEnded?: boolean; actualEnd: string | null; status: string; employee: { id: string; firstName: string; lastName: string }; seat: { index: number; position: { name: string } } }[]
}
interface History { months: { month: string; days: number; jobDays: number; workshopDays: number; idleDays: number }[]; utilisation: number; workshopShare: number }
interface Plan {
  id: string; name: string; everyDays: number; durationDays: number; leadDays: number; startFrom: string; lastDone: string | null; active: boolean; notes: string | null
  nextDue: string; state: 'overdue' | 'due_soon' | 'ok'; openWorkOrder: { id: string; status: string; plannedStart: string; expectedReturn: string } | null
}
interface Doc { id: string; kind: string; title: string; notes: string | null; expiresAt: string | null; validity: 'none' | 'valid' | 'expiring' | 'expired'; file: { id: string; name: string } | null }

const SERVICE: Record<Plan['state'], [Severity, string]> = { overdue: ['bad', 'Overdue'], due_soon: ['warn', 'Due soon'], ok: ['ok', 'Up to date'] }
const VALIDITY: Record<Doc['validity'], [Severity, string] | null> = { none: null, valid: ['ok', 'Valid'], expiring: ['warn', 'Expires within 30 days'], expired: ['bad', 'Expired'] }
const DOC_KINDS: [string, string][] = [['registration', 'Registration'], ['insurance', 'Insurance'], ['inspection', 'Inspection certificate'], ['other', 'Other']]
const WO_SEV: Record<string, Severity> = { OPEN: 'info', IN_PROGRESS: 'warn', WAITING_PARTS: 'warn', DONE: 'ok', CANCELLED: 'info' }
const OPEN_WO = ['OPEN', 'IN_PROGRESS', 'WAITING_PARTS']
const COLORS = { job: 'var(--pal-blue-700)', shop: 'var(--pal-amber-700)', idle: 'var(--border)' }
const isoToday = () => new Date().toISOString().slice(0, 10)
const plusDays = (d: string, n: number) => new Date(Date.parse(d) + n * 86_400_000).toISOString().slice(0, 10)

/** One unit on a full page: today, a year of use, preventive maintenance, work orders, papers, jobs and crews. */
export default function UnitPage({ id }: { id: string }) {
  const { t, i18n } = useTranslation()
  const toast = useToast()
  const u = useApi<UnitD>(`/units/${id}`)
  const hist = useApi<History>(`/units/${id}/history?months=12`)
  const plans = useApi<Plan[]>(`/units/${id}/maintenance-plans`)
  const docs = useApi<Doc[]>(`/units/${id}/documents`)
  const bases = useApi<{ id: string; code: string }[]>('/bases')
  const changes = useApi<{ changes: ChangeRow[] }>('/calendar/crew-changes?days=30')
  const reloadAll = () => { void u.reload(); void hist.reload(); void plans.reload(); void docs.reload(); void changes.reload() }
  useLive(u.reload)
  useLive(changes.reload)
  const [moving, setMoving] = useState<{ date: string; only?: string } | null>(null)
  const [editingJob, setEditingJob] = useState<string | null>(null)
  const [dialog, setDialog] = useState<null | 'edit' | 'move' | 'delete' | 'workshop' | 'job' | 'doc' | { plan: Plan | null } | { book: Plan } | { done: Plan }>(null)
  const [acting, setActing] = useState<SeatHolderRef | null>(null)
  const x = u.data
  if (u.error) return <main className="page"><a className="back" href="#/units"><ArrowLeft size={15} aria-hidden /> {t('allUnits', 'All units')}</a><div className="banner error" role="alert">{u.error}</div></main>
  if (!x) return <main className="page"><p className="muted">…</p></main>

  const fmt = (d: string | null | undefined) => (d ? fmtDate(d, i18n.language) : '—')
  const today = isoToday()
  const st = STATUS[x.status] ?? { label: x.status, sev: 'info' as Severity, color: 'var(--pal-slate-500)' }
  const current = x.deployments.find(d => d.start.slice(0, 10) <= today && d.end.slice(0, 10) >= today)
  const filled = x.seats.filter(s => s.required && s.holder).length, required = x.seats.filter(s => s.required).length
  const short = !!current && filled < Math.min(required, x.crewMin ?? required) // a few empty seats are fine (Settings)
  const nextPlan = [...(plans.data ?? [])].filter(p => p.active).sort((a, b) => a.nextDue.localeCompare(b.nextDue))[0]
  const docIssues = (docs.data ?? []).filter(d => d.validity === 'expired' || d.validity === 'expiring').length
  const row: UnitRow = {
    id: x.id, code: x.code, type: x.unitType.name, typeId: x.unitTypeId, colorKey: x.unitType.colorKey, home: x.homeBase, homeBaseId: x.homeBaseId, plate: x.plate, model: x.model, year: x.year, notes: x.notes,
    status: x.status, job: current?.job ?? null, jobUntil: current?.end ?? null, backBy: null, crew: { filled, required }, problem: false,
  }
  const act = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); toast(ok); reloadAll() } catch (e) { toast(errMsg(e), 'error') } }
  const close = () => setDialog(null)
  // Crew changes on this unit in the next 30 days, by day: the whole crew usually changes together.
  const unitChanges = (changes.data?.changes ?? []).filter(c => c.unitId === x.id)
  const changeDays = [...new Set(unitChanges.map(c => c.date))]
  const changeOf = (seatId: string) => unitChanges.find(c => c.seatId === seatId)

  return (
    <main className="page wide unit-page">
      <a className="back" href="#/units"><ArrowLeft size={15} aria-hidden /> {t('allUnits', 'All units')}</a>
      {editingJob && <EditJobDialog jobId={editingJob} onClose={() => setEditingJob(null)} onDone={reloadAll} />}
      {moving && <CrewChangeDialog rows={unitChanges.filter(c => c.date === moving.date)} only={moving.only} onClose={() => setMoving(null)} onDone={reloadAll} />}
      {acting && <SeatActionsDialog target={acting} onClose={() => setActing(null)} onDone={text => { toast(text); reloadAll() }} />}
      <header className="page-head">
        <div>
          <h1><Truck size={22} aria-hidden /> {x.code} <span className={`tag tag-${x.unitType.colorKey === 'amber' ? 'CH' : 'OH'}`}>{x.unitType.name}</span></h1>
          <p className="muted">{x.homeBase.code} · {x.homeBase.name}{[x.plate, x.model, x.year].some(Boolean) ? ` · ${[x.plate, x.model, x.year].filter(Boolean).join(' · ')}` : ''}</p>
          <div className="badges"><Pill severity={st.sev}>{st.label}</Pill>{current && <span className="badge">{current.job.wellName}{current.job.rigName ? ` · ${current.job.rigName}` : ''} · {current.job.openEnded ? t('openUntilEnded', 'until you end it') : `${t('until', 'until')} ${fmt(current.end)}`}</span>}</div>
          {x.notes && <p className="note">{x.notes}</p>}
        </div>
        <div className="actions">
          <button type="button" onClick={() => setDialog('edit')}><Pencil size={14} aria-hidden /> {t('edit', 'Edit')}</button>
          <button type="button" onClick={() => setDialog('move')}><ArrowRightLeft size={14} aria-hidden /> {t('move', 'Move to another base')}</button>
          {!current && !['OUT_OF_SERVICE', 'UNDER_MAINTENANCE'].includes(x.status) && <button type="button" onClick={() => setDialog('job')}><Plus size={14} aria-hidden /> {t('giveJob', 'Give it a job')}</button>}
          {x.status !== 'UNDER_MAINTENANCE' && !current && <button type="button" onClick={() => setDialog('workshop')}><Wrench size={14} aria-hidden /> {t('toWorkshop', 'Send to the workshop')}</button>}
          {x.status === 'OUT_OF_SERVICE'
            ? <button type="button" onClick={() => void act(() => api(`/units/${id}/status`, { method: 'PUT', body: { status: 'AVAILABLE' } }), t('backService', 'Back in service'))}><CheckCircle2 size={14} aria-hidden /> {t('backService', 'Back in service')}</button>
            : !current && <button type="button" onClick={() => void act(() => api(`/units/${id}/status`, { method: 'PUT', body: { status: 'OUT_OF_SERVICE' } }), t('outService', 'Out of service'))}><Ban size={14} aria-hidden /> {t('outService', 'Out of service')}</button>}
          <button type="button" className="danger" onClick={() => setDialog('delete')}><Trash2 size={14} aria-hidden /> {t('delete', 'Delete')}</button>
        </div>
      </header>

      <section className="kpis2" aria-label={t('unitNumbers', 'Unit in numbers')}>
        <div className="kpi2" style={{ ['--c' as string]: COLORS.job }}><Gauge size={22} className="k-icon" aria-hidden /><strong>{hist.data ? `${hist.data.utilisation}%` : '…'}</strong><span>{t('utilisation12', 'On a job, last 12 months')}</span></div>
        <div className="kpi2" style={{ ['--c' as string]: COLORS.shop }}><Wrench size={22} className="k-icon" aria-hidden /><strong>{hist.data ? `${hist.data.workshopShare}%` : '…'}</strong><span>{t('workshop12', 'In the workshop')}</span></div>
        <div className={`kpi2${short ? ' alert' : ''}`} style={{ ['--c' as string]: short ? 'var(--pal-red-700)' : 'var(--pal-teal-700)' }}><Truck size={22} className="k-icon" aria-hidden /><strong>{filled}/{required}</strong><span>{t('crewToday', 'Crew seats filled today')}</span></div>
        <div className={`kpi2${nextPlan?.state === 'overdue' ? ' alert' : ''}`} style={{ ['--c' as string]: nextPlan ? (nextPlan.state === 'overdue' ? 'var(--pal-red-700)' : nextPlan.state === 'due_soon' ? 'var(--pal-amber-700)' : 'var(--pal-green-700)') : 'var(--pal-slate-600)' }}>
          <CalendarCheck size={22} className="k-icon" aria-hidden /><strong>{nextPlan ? new Date(nextPlan.nextDue).toLocaleDateString(i18n.language, { day: 'numeric', month: 'short', year: '2-digit', timeZone: 'UTC' }) : '—'}</strong><span>{nextPlan ? `${t('nextService', 'Next service')}: ${nextPlan.name}` : t('noService', 'No service plan')}</span>
        </div>
        <div className={`kpi2${docIssues ? ' alert' : ''}`} style={{ ['--c' as string]: docIssues ? 'var(--pal-red-700)' : 'var(--pal-slate-600)' }}><FileText size={22} className="k-icon" aria-hidden /><strong>{docIssues}</strong><span>{t('docIssues', 'Papers expired or expiring')}</span></div>
      </section>

      <section className="panel">
        <h2>{t('lastYear', 'The last 12 months')}</h2>
        <Legend items={[{ color: COLORS.job, label: t('onJob', 'On a job') }, { color: COLORS.shop, label: t('inWorkshop', 'In the workshop') }, { color: 'var(--pal-slate-300)', label: t('idle', 'At base, idle') }]} />
        {hist.data && <UsageChart months={hist.data.months} />}
      </section>

      <div className="unit-grid">
        <section className="panel">
          <h2>{t('crewNow', 'Crew today')}</h2>
          {changeDays.map(d => (
            <p key={d} className="cc-next">
              <CalendarClock size={14} aria-hidden /> {t('crewChange', 'Crew change')} <strong>{fmt(d)}</strong>
              <span className="muted">· {unitChanges.filter(c => c.date === d).length} {unitChanges.filter(c => c.date === d).length === 1 ? t('seatLc', 'seat') : t('seatsLc', 'seats')}</span>
              <button type="button" className="small-btn" onClick={() => setMoving({ date: d })}>{t('ccChangeDate2', 'Change date')}</button>
            </p>
          ))}
          <table className="table compact">
            <tbody>
              {x.seats.map(s => (
                <tr key={s.id}>
                  <td>{s.position} #{s.index}{!s.required && <small className="muted"> · {t('optional', 'optional')}</small>}</td>
                  <td>{s.holder ? <PersonLink id={s.holder.id}>{s.holder.firstName} {s.holder.lastName}</PersonLink> : <span className={short && s.required ? 'error' : 'muted'}>{t('empty', 'Empty')}</span>}</td>
                  <td className="muted">{s.holder?.openEnded && !changeOf(s.id) && <small>{t('noChangeYet', 'no crew change date yet')}</small>}{changeOf(s.id) && <button type="button" className="small-btn" onClick={() => setMoving({ date: changeOf(s.id)!.date, only: s.id })} title={t('ccChangeDate', 'Change the crew change date')}><CalendarClock size={13} aria-hidden /> {fmt(changeOf(s.id)!.date)}</button>}</td>
                  <td className="num">{s.holder && <SeatActionsButton name={`${s.holder.firstName} ${s.holder.lastName}`} onClick={() => { const h = s.holder!; setActing({ assignmentId: h.assignmentId, until: h.until, openEnded: h.openEnded, person: { id: h.id, name: `${h.firstName} ${h.lastName}` }, seat: { seatId: s.id, position: s.position, index: s.index, requirements: s.requirements ?? {} }, unit: { code: x.code, colorKey: x.unitType.colorKey } }) }} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="panel">
          <h2>{t('papers', 'Papers')} <button type="button" className="small-btn" onClick={() => setDialog('doc')}><Plus size={14} aria-hidden /> {t('addDoc', 'Add')}</button></h2>
          {docs.data?.length === 0 && <p className="muted">{t('noDocs', 'No papers recorded yet.')}</p>}
          <ul className="doc-list">
            {docs.data?.map(d => {
              const v = VALIDITY[d.validity]
              return (
                <li key={d.id}>
                  <FileText size={16} aria-hidden />
                  <div><strong>{d.title}</strong><small className="muted">{DOC_KINDS.find(k => k[0] === d.kind)?.[1] ?? d.kind}{d.expiresAt ? ` · ${t('expires', 'expires')} ${fmt(d.expiresAt)}` : ''}</small></div>
                  {v && <Pill severity={v[0]}>{v[1]}</Pill>}
                  {d.file && <button type="button" className="small-btn" aria-label={`${t('download', 'Download')} ${d.title}`} onClick={() => void download(`/files/${d.file!.id}`, d.file!.name).catch(e => toast(errMsg(e), 'error'))}><Download size={14} aria-hidden /></button>}
                  <button type="button" className="small-btn danger" aria-label={`${t('delete', 'Delete')} ${d.title}`} onClick={() => void act(() => api(`/unit-documents/${d.id}`, { method: 'DELETE' }), t('docRemoved', 'Removed'))}><Trash2 size={14} aria-hidden /></button>
                </li>
              )
            })}
          </ul>
        </section>
      </div>

      <section className="panel">
        <h2>{t('preventive', 'Preventive maintenance')} <button type="button" className="small-btn" onClick={() => setDialog({ plan: null })}><Plus size={14} aria-hidden /> {t('addService', 'Add a service')}</button></h2>
        <p className="muted">{t('preventiveHint', 'Each service repeats every N days. When one comes due, a work order is opened for the date it is due (after any job the unit is on). Finishing that work order records the service.')}</p>
        {plans.data?.length === 0 && <p className="muted">{t('noPlans', 'No service plan for this unit.')}</p>}
        {!!plans.data?.length && (
          <div className="table-scroll">
            <table className="table compact">
              <thead><tr><th>{t('service', 'Service')}</th><th>{t('every', 'Every')}</th><th>{t('lastDone', 'Last done')}</th><th>{t('nextDue', 'Next due')}</th><th>{t('status', 'Status')}</th><th>{t('workOrder', 'Work order')}</th><th /></tr></thead>
              <tbody>
                {plans.data?.map(p => (
                  <tr key={p.id} className={p.active ? '' : 'muted'}>
                    <td><strong>{p.name}</strong>{p.notes && <small className="muted unit-note">{p.notes}</small>}</td>
                    <td>{p.everyDays} {t('days', 'days')}<small className="muted"> · {p.durationDays} {t('inShop', 'in the shop')}</small></td>
                    <td>{fmt(p.lastDone)}</td>
                    <td>{fmt(p.nextDue)}</td>
                    <td>{p.active ? <Pill severity={SERVICE[p.state][0]}>{SERVICE[p.state][1]}</Pill> : <span className="muted">{t('paused', 'Paused')}</span>}</td>
                    <td>{p.openWorkOrder ? <span>{fmt(p.openWorkOrder.plannedStart)} → {fmt(p.openWorkOrder.expectedReturn)}</span> : <span className="muted">—</span>}</td>
                    <td className="row-actions">
                      {!p.openWorkOrder && p.active && <button type="button" onClick={() => setDialog({ book: p })}>{t('bookNow', 'Book')}</button>}
                      <button type="button" onClick={() => setDialog({ done: p })}>{t('markDone', 'Done')}</button>
                      <button type="button" onClick={() => setDialog({ plan: p })} aria-label={`${t('edit', 'Edit')} ${p.name}`}><Pencil size={14} aria-hidden /></button>
                      <button type="button" className="danger" onClick={() => void act(() => api(`/maintenance-plans/${p.id}`, { method: 'DELETE' }), t('planRemoved', 'Service removed'))} aria-label={`${t('delete', 'Delete')} ${p.name}`}><Trash2 size={14} aria-hidden /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="unit-grid">
        <section className="panel">
          <h2>{t('workOrders', 'Workshop visits')}</h2>
          {x.workOrders.length === 0 && <p className="muted">{t('noWos', 'Never been to the workshop.')}</p>}
          <ul className="doc-list">
            {x.workOrders.map(w => (
              <li key={w.id}>
                <Wrench size={16} aria-hidden />
                <div><strong>{w.description || w.type.replace('_', ' ')}</strong><small className="muted">{w.type.replace('_', ' ')} · {fmt(w.plannedStart)} → {fmt(w.expectedReturn)}</small></div>
                <Pill severity={WO_SEV[w.status] ?? 'info'}>{w.status.toLowerCase().replace('_', ' ')}</Pill>
                {OPEN_WO.includes(w.status) && <button type="button" onClick={() => void act(() => api(`/work-orders/${w.id}/status`, { method: 'POST', body: { status: 'DONE' } }), t('woDone', 'Repaired: unit available again'))}><CheckCircle2 size={14} aria-hidden /> {t('repaired', 'Repaired')}</button>}
              </li>
            ))}
          </ul>
        </section>
        <section className="panel">
          <h2>{t('jobs', 'Jobs')}</h2>
          {x.deployments.length === 0 && <p className="muted">{t('noJobs', 'No job yet.')}</p>}
          <ul className="doc-list">
            {x.deployments.map(d => (
              <li key={d.id}>
                <Truck size={16} aria-hidden />
                <div><strong>{d.job.wellName}{d.job.rigName ? ` · ${d.job.rigName}` : ''}</strong><small className="muted">{d.job.ref}{d.job.client ? ` · ${d.job.client}` : ''} · {fmt(d.start)} → {d.job.openEnded ? t('openEnd', 'open') : fmt(d.end)}</small></div>
                {!['COMPLETED', 'CANCELLED'].includes(d.job.status) && <button type="button" className="ghost" onClick={() => setEditingJob(d.job.id)}><Pencil size={14} aria-hidden /> {t('editJob', 'Edit job')}</button>}
                {d === current && <button type="button" className="ghost" onClick={() => void act(() => api(`/jobs/${d.job.id}/end`, { method: 'POST', body: {} }), t('jobEnded', 'Job ended, unit back at base'))}>{t('endJob', 'End job today')}</button>}
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section className="panel">
        <h2>{t('crewHistory', 'Crew history')}</h2>
        <div className="table-scroll">
          <table className="table compact">
            <thead><tr><th>{t('person', 'Person')}</th><th>{t('seat', 'Seat')}</th><th>{t('dates', 'Dates')}</th></tr></thead>
            <tbody>
              {x.crewHistory.map(a => (
                <tr key={a.id}><td><PersonLink id={a.employee.id}>{a.employee.firstName} {a.employee.lastName}</PersonLink></td><td>{a.seat.position.name} #{a.seat.index}</td><td>{fmt(a.start)} → {a.openEnded ? t('noChangeYet', 'no crew change date yet') : fmt(a.actualEnd ?? a.plannedEnd)}</td></tr>
              ))}
              {x.crewHistory.length === 0 && <tr><td colSpan={3} className="muted">{t('noCrewYet', 'Nobody has worked on this unit yet.')}</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      {dialog === 'edit' && <EditUnit unit={row} onClose={close} onDone={() => { close(); reloadAll() }} />}
      {dialog === 'move' && <MoveUnit unit={row} bases={bases.data ?? []} onClose={close} onDone={() => { close(); reloadAll() }} />}
      {dialog === 'delete' && <DeleteUnit unit={row} onClose={close} onRetire={() => { close(); void act(() => api(`/units/${id}/status`, { method: 'PUT', body: { status: 'OUT_OF_SERVICE' } }), t('outService', 'Out of service')) }} onDone={() => { close(); go('units') }} />}
      {dialog === 'job' && <NewJobDialog unitId={id} onClose={close} onDone={reloadAll} />}
      {dialog === 'workshop' && <WorkshopDialog code={x.code} onClose={close} onSave={(back, what) => act(async () => { await api(`/units/${id}/status`, { method: 'PUT', body: { status: 'UNDER_MAINTENANCE', expectedReturn: back, description: what || undefined } }); close() }, `${x.code} ${t('sentWorkshop', 'is in the workshop')}`)} />}
      {dialog === 'doc' && <DocDialog unitId={id} onClose={close} onDone={() => { close(); void docs.reload() }} />}
      {dialog && typeof dialog === 'object' && 'plan' in dialog && <PlanDialog unitId={id} plan={dialog.plan} onClose={close} onDone={() => { close(); void plans.reload() }} />}
      {dialog && typeof dialog === 'object' && 'book' in dialog && (
        <DateDialog title={`${t('bookService', 'Book')} · ${dialog.book.name}`} label={t('startsOn', 'Starts on')} initial={dialog.book.nextDue < today ? today : dialog.book.nextDue} min={today} onClose={close}
          onSave={date => act(async () => { await api(`/maintenance-plans/${dialog.book.id}/schedule`, { method: 'POST', body: { start: date } }); close() }, t('booked', 'Work order opened'))} />
      )}
      {dialog && typeof dialog === 'object' && 'done' in dialog && (
        <DateDialog title={`${t('recordService', 'Record a service')} · ${dialog.done.name}`} label={t('doneOn', 'Done on')} initial={today} max={today} onClose={close}
          note={t('doneNote', 'For a service done outside a work order. A work order finished in the workshop records it by itself.')}
          onSave={date => act(async () => { await api(`/maintenance-plans/${dialog.done.id}/done`, { method: 'POST', body: { date } }); close() }, t('recorded', 'Service recorded'))} />
      )}
    </main>
  )
}

/** Stacked bars: days on a job, in the workshop and idle, one bar per month. */
function UsageChart({ months }: { months: History['months'] }) {
  const { i18n } = useTranslation()
  const W = 760, H = 180, pad = 26, gap = 10
  const bw = (W - pad * 2 - gap * (months.length - 1)) / months.length
  const max = 31
  const y = (v: number) => (v / max) * (H - pad - 10)
  return (
    <div className="table-scroll">
      <svg className="usage-chart" viewBox={`0 0 ${W} ${H + 20}`} role="img" aria-label="Days on a job, in the workshop and idle per month">
        {months.map((m, i) => {
          const x = pad + i * (bw + gap)
          let top = H
          const seg = (v: number, fill: string, key: string) => { if (!v) return null; top -= y(v); return <rect style={{ fill: fill }} key={key} x={x} y={top} width={bw} height={y(v)} rx={3}><title>{`${m.month}: ${v} day(s)`}</title></rect> }
          const label = new Date(`${m.month}-01T00:00:00Z`).toLocaleDateString(i18n.language, { month: 'short', timeZone: 'UTC' })
          return (
            <g key={m.month}>
              {seg(m.jobDays, COLORS.job, 'j')}{seg(m.workshopDays, COLORS.shop, 'w')}{seg(m.idleDays, 'var(--pal-slate-300)', 'i')}
              <text x={x + bw / 2} y={H + 14} textAnchor="middle" className="usage-label">{label}</text>
              {m.jobDays > 0 && <text x={x + bw / 2} y={H - y(m.jobDays) / 2 + 4} textAnchor="middle" className="usage-val">{m.jobDays}</text>}
            </g>
          )
        })}
      </svg>
    </div>
  )
}

function WorkshopDialog({ code, onClose, onSave }: { code: string; onClose: () => void; onSave: (back: string, what: string) => void }) {
  const { t } = useTranslation()
  const [back, setBack] = useState(plusDays(isoToday(), 3))
  const [what, setWhat] = useState('')
  return (
    <Modal title={`${t('toWorkshop', 'Send to the workshop')} · ${code}`} onClose={onClose}>
      <div className="form2">
        <label>{t('whatWrong', 'What is wrong')}<input value={what} onChange={e => setWhat(e.target.value)} autoFocus /></label>
        <label>{t('expectedBack', 'Expected back')}<input type="date" value={back} min={isoToday()} onChange={e => setBack(e.target.value)} /></label>
        <footer><button type="button" onClick={onClose}>{t('cancel', 'Cancel')}</button><button type="button" className="primary" onClick={() => onSave(back, what.trim())}>{t('toWorkshop', 'Send to the workshop')}</button></footer>
      </div>
    </Modal>
  )
}

function DateDialog({ title, label, initial, min, max, note, onClose, onSave }: { title: string; label: string; initial: string; min?: string; max?: string; note?: string; onClose: () => void; onSave: (d: string) => void }) {
  const { t } = useTranslation()
  const [date, setDate] = useState(initial)
  return (
    <Modal title={title} onClose={onClose}>
      <div className="form2">
        {note && <p className="muted" style={{ margin: 0 }}>{note}</p>}
        <label>{label}<input type="date" value={date} min={min} max={max} onChange={e => setDate(e.target.value)} autoFocus /></label>
        <footer><button type="button" onClick={onClose}>{t('cancel', 'Cancel')}</button><button type="button" className="primary" disabled={!date} onClick={() => onSave(date)}>{t('save', 'Save')}</button></footer>
      </div>
    </Modal>
  )
}

function PlanDialog({ unitId, plan, onClose, onDone }: { unitId: string; plan: Plan | null; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const [f, setF] = useState({
    name: plan?.name ?? '', everyDays: String(plan?.everyDays ?? 90), durationDays: String(plan?.durationDays ?? 1), leadDays: String(plan?.leadDays ?? 14),
    lastDone: plan?.lastDone ?? '', notes: plan?.notes ?? '', active: plan?.active ?? true,
  })
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    const body = { name: f.name.trim(), everyDays: +f.everyDays, durationDays: +f.durationDays, leadDays: +f.leadDays, lastDone: f.lastDone || null, notes: f.notes.trim() || null, active: f.active }
    try {
      await api(plan ? `/maintenance-plans/${plan.id}` : `/units/${unitId}/maintenance-plans`, { method: plan ? 'PUT' : 'POST', body })
      toast(t('saved', 'Saved')); onDone()
    } catch (e) { toast(errMsg(e), 'error'); setBusy(false) }
  }
  return (
    <Modal title={plan ? `${t('editService', 'Edit service')} · ${plan.name}` : t('addService', 'Add a service')} onClose={onClose}>
      <div className="form2">
        <label>{t('serviceName', 'Service')} *<input value={f.name} onChange={set('name')} placeholder={t('servicePh', 'e.g. Engine service')} autoFocus /></label>
        <div className="row3">
          <label>{t('everyDays', 'Every (days)')} *<input type="number" min={1} value={f.everyDays} onChange={set('everyDays')} /></label>
          <label>{t('durationDays', 'Days in the shop')}<input type="number" min={1} value={f.durationDays} onChange={set('durationDays')} /></label>
          <label>{t('leadDays', 'Open it … days before')}<input type="number" min={0} value={f.leadDays} onChange={set('leadDays')} /></label>
        </div>
        <label>{t('lastDone', 'Last done')}<input type="date" value={f.lastDone} max={isoToday()} onChange={set('lastDone')} /></label>
        <label>{t('notes', 'Notes')}<input value={f.notes} onChange={set('notes')} /></label>
        {plan && <label className="check"><input type="checkbox" checked={f.active} onChange={e => setF({ ...f, active: e.target.checked })} /> {t('planActive', 'Active (unchecked: no work orders are opened)')}</label>}
        <footer><button type="button" onClick={onClose}>{t('cancel', 'Cancel')}</button><button type="button" className="primary" disabled={busy || !f.name.trim() || !(+f.everyDays > 0)} onClick={() => void save()}>{t('save', 'Save')}</button></footer>
      </div>
    </Modal>
  )
}

const toBase64 = (file: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader()
  r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''))
  r.onerror = () => reject(r.error)
  r.readAsDataURL(file)
})

function DocDialog({ unitId, onClose, onDone }: { unitId: string; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const [kind, setKind] = useState('insurance')
  const [title, setTitle] = useState('')
  const [expires, setExpires] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    try {
      let fileId: string | undefined
      if (file) fileId = (await api<{ id: string }>('/files', { method: 'POST', body: { name: file.name, mime: file.type || 'application/octet-stream', kind: 'general', dataBase64: await toBase64(file) } })).id
      await api(`/units/${unitId}/documents`, { method: 'POST', body: { kind, title: title.trim() || DOC_KINDS.find(k => k[0] === kind)![1], fileId, expiresAt: expires || undefined } })
      toast(t('docAdded', 'Added')); onDone()
    } catch (e) { toast(errMsg(e), 'error'); setBusy(false) }
  }
  return (
    <Modal title={t('addDocTitle', 'Add a paper')} onClose={onClose}>
      <div className="form2">
        <label>{t('kind', 'Kind')}<select value={kind} onChange={e => setKind(e.target.value)}>{DOC_KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <label>{t('title', 'Title')}<input value={title} onChange={e => setTitle(e.target.value)} placeholder={DOC_KINDS.find(k => k[0] === kind)?.[1]} /></label>
        <label>{t('expiresOn', 'Expires on (optional)')}<input type="date" value={expires} onChange={e => setExpires(e.target.value)} /></label>
        <label>{t('fileOpt', 'File (optional: PDF or photo)')}<input type="file" accept="application/pdf,image/*" onChange={e => setFile(e.target.files?.[0] ?? null)} /></label>
        <footer><button type="button" onClick={onClose}>{t('cancel', 'Cancel')}</button><button type="button" className="primary" disabled={busy} onClick={() => void save()}>{t('save', 'Save')}</button></footer>
      </div>
    </Modal>
  )
}
