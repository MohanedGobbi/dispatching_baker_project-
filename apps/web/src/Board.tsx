import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DndContext, DragOverlay, KeyboardSensor, PointerSensor, useDroppable, useSensor, useSensors } from '@dnd-kit/core'
import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core'
import {
  AlertTriangle, ChevronLeft, ChevronRight, LayoutGrid, Monitor, Search, Users, Wrench, X,
} from 'lucide-react'
import { api, ApiError, subscribeChanges } from './api'
import { useAuth } from './auth'
import type { BoardData, Person, PlanSummary, SeatCard, StaffingRow, UnitCardData, Violation } from './types'
import { PersonChip, SeverityBadge, STATUS_META, useToast } from './ui'
import { AssignDialog, RuleDialog, addDaysIso } from './dialogs'
import PersonDrawer from './PersonDrawer'

type Tab = 'field' | 'base'
interface DragPayload { person: Person; seatId?: string; assignmentId?: string; until?: string }
type Pending =
  | { kind: 'assign'; person: Person; seat: SeatCard; unit: UnitCardData; transferFrom?: { assignmentId: string; label: string } }
  | { kind: 'swap'; first: { assignmentId: string; name: string; label: string }; second: { assignmentId: string; name: string; label: string }; violations: Violation[] }

const todayIso = () => new Date().toISOString().slice(0, 10)
const COLUMNS: [keyof typeof COLUMN_TITLES, string][] = [['standby', 'STANDBY'], ['daysOff', 'DAYS_OFF'], ['leave', 'LEAVE'], ['unavailable', 'UNAVAILABLE'], ['training', 'TRAINING'], ['awaitingClearance', 'AWAITING_CLEARANCE']]
const COLUMN_TITLES = { standby: 'Standby', daysOff: 'Days off', leave: 'Leave', unavailable: 'Unavailable', training: 'Training', awaitingClearance: 'Awaiting clearance' }

export default function Board() {
  const { t, i18n } = useTranslation()
  const { can } = useAuth()
  const toast = useToast()
  const editor = can('SUPER_ADMIN', 'OPS_MANAGER', 'DISPATCHER', 'BASE_MANAGER')

  const [tab, setTab] = useState<Tab>('field')
  const [date, setDate] = useState(todayIso())
  const [baseId, setBaseId] = useState('')
  const [problemsOnly, setProblemsOnly] = useState(false)
  const [search, setSearch] = useState('')
  const [q, setQ] = useState('')
  const [planId, setPlanId] = useState('')
  const [plans, setPlans] = useState<PlanSummary[]>([])
  const [data, setData] = useState<BoardData | null>(null)
  const [error, setError] = useState('')
  const [tv, setTv] = useState(false)
  const [tvIndex, setTvIndex] = useState(0)
  const [drawer, setDrawer] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [dragging, setDragging] = useState<DragPayload | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const readOnly = !editor || !!data?.past || data?.layer === 'draft'

  // ---- data
  const load = useCallback(async () => {
    const p = new URLSearchParams({ date, view: 'all' })
    if (baseId) p.set('baseId', baseId)
    if (problemsOnly) p.set('problemsOnly', 'true')
    if (q) p.set('q', q)
    if (planId) p.set('planId', planId)
    try { setData(await api<BoardData>(`/board?${p}`)); setError('') } catch (e) { setError(e instanceof ApiError ? e.message : String(e)) }
  }, [date, baseId, problemsOnly, q, planId])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const stop = subscribeChanges(() => { clearTimeout(timer); timer = setTimeout(() => void load(), 250) })
    return () => { stop(); clearTimeout(timer) }
  }, [load])
  useEffect(() => { const h = setTimeout(() => setQ(search.trim()), 300); return () => clearTimeout(h) }, [search])
  useEffect(() => {
    if (!can('SUPER_ADMIN', 'OPS_MANAGER', 'DISPATCHER', 'BASE_MANAGER')) return
    api<PlanSummary[]>('/planning/plans?status=DRAFT').then(setPlans).catch(() => setPlans([]))
  }, [can, data?.layer])

  // ---- keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); searchRef.current?.focus() }
      if (e.key === 'Escape') { setTv(false); setDrawer(null) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  // TV mode rotates between bases (plan 14.3, 27.6)
  useEffect(() => {
    if (!tv || !data || data.bases.length < 2) return
    const h = setInterval(() => setTvIndex(i => (i + 1) % data.bases.length), 15000)
    return () => clearInterval(h)
  }, [tv, data])

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor))

  // ---- drag and drop
  const onDragStart = (e: DragStartEvent) => setDragging((e.active.data.current as DragPayload) ?? null)
  const onDragEnd = async (e: DragEndEvent) => {
    setDragging(null)
    const from = e.active.data.current as DragPayload | undefined
    const over = e.over?.data.current as { type: 'seat'; seat: SeatCard; unit: UnitCardData } | { type: 'column'; name: string } | undefined
    if (!from || !over || readOnly) return

    if (over.type === 'column') {
      if (over.name !== 'standby' || !from.assignmentId) return
      try {
        await api(`/assignments/${from.assignmentId}/unassign`, { method: 'POST', body: { from: date, reason: 'Released on the board' } })
        const seat = from.seatId
        toast(`${from.person.name} released`, 'ok', seat && from.until ? async () => {
          await api('/assignments', { method: 'POST', body: { employeeId: from.person.id, seatId: seat, start: date, end: from.until } })
        } : undefined)
      } catch (err) { toast(err instanceof ApiError ? err.message : String(err), 'error') }
      return
    }

    const { seat, unit } = over
    if (from.seatId === seat.seatId) return
    if (seat.holder) {
      if (!from.assignmentId) { toast('That seat is taken: release the person first', 'error'); return }
      const label = (s: SeatCard, u: string) => `${u} · ${s.position} #${s.index}`
      const fromSeat = data?.units.flatMap(u => u.seats.map(s => ({ s, u }))).find(x => x.s.seatId === from.seatId)
      const first = { assignmentId: from.assignmentId, name: from.person.name, label: fromSeat ? label(fromSeat.s, fromSeat.u.code) : '' }
      const second = { assignmentId: seat.holder.assignmentId, name: seat.holder.name, label: label(seat, unit.code) }
      await trySwap(first, second)
      return
    }
    const fromSeat = from.seatId ? data?.units.flatMap(u => u.seats.map(s => ({ s, u }))).find(x => x.s.seatId === from.seatId) : undefined
    setPending({
      kind: 'assign', person: from.person, seat, unit,
      transferFrom: from.assignmentId ? { assignmentId: from.assignmentId, label: fromSeat ? `${fromSeat.u.code} · ${fromSeat.s.position} #${fromSeat.s.index}` : '' } : undefined,
    })
  }

  const trySwap = async (first: { assignmentId: string; name: string; label: string }, second: { assignmentId: string; name: string; label: string }, overrideReason?: string) => {
    try {
      await api('/assignments/swap', { method: 'POST', body: { firstId: first.assignmentId, secondId: second.assignmentId, overrideReason } })
      toast(`${first.name} ⇄ ${second.name}`)
    } catch (err) {
      if (err instanceof ApiError && err.status === 422) {
        const v = (err.body as { violations?: Violation[] }).violations ?? []
        setPending({ kind: 'swap', first, second, violations: v })
      } else toast(err instanceof ApiError ? err.message : String(err), 'error')
    }
  }

  // ---- what to show
  const shownBases = useMemo(() => {
    if (!data) return []
    return tv && data.bases.length ? [data.bases[tvIndex % data.bases.length]] : data.bases
  }, [data, tv, tvIndex])

  const hits = useMemo(() => new Set(data?.matches.employees ?? []), [data])
  const dayLabel = data ? new Date(data.date).toLocaleDateString(i18n.language, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : ''

  if (!data && !error) return <div className="loading">{t('loading', 'Loading the board…')}</div>

  return (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
      <div className={`app${tv ? ' tv' : ''}`}>
        {!tv && (
          <header className="topbar">
            <nav className="tabs" aria-label="Views">
              <button type="button" className={tab === 'field' ? 'on' : ''} onClick={() => setTab('field')}><LayoutGrid size={15} aria-hidden /> {t('fieldView', 'Field')}</button>
              <button type="button" className={tab === 'base' ? 'on' : ''} onClick={() => setTab('base')}><Wrench size={15} aria-hidden /> {t('baseView', 'Base staff')}</button>
            </nav>
            <div className="dates">
              <button type="button" aria-label="Previous day" onClick={() => setDate(addDaysIso(date, -1))}><ChevronLeft size={16} /></button>
              <input type="date" value={date} onChange={e => e.target.value && setDate(e.target.value)} aria-label="Date" />
              <button type="button" aria-label="Next day" onClick={() => setDate(addDaysIso(date, 1))}><ChevronRight size={16} /></button>
              <button type="button" onClick={() => setDate(todayIso())}>{t('today', 'Today')}</button>
              <button type="button" onClick={() => setDate(addDaysIso(todayIso(), 7))}>+7</button>
            </div>
            <select value={baseId} onChange={e => setBaseId(e.target.value)} aria-label="Base">
              <option value="">{t('allBases', 'All bases')}</option>
              {data?.bases.map(b => <option key={b.id} value={b.id}>{b.code}</option>)}
            </select>
            <label className="check"><input type="checkbox" checked={problemsOnly} onChange={e => setProblemsOnly(e.target.checked)} /> {t('problemsOnly', 'Problems only')}</label>
            {plans.length > 0 && (
              <select value={planId} onChange={e => setPlanId(e.target.value)} aria-label="Layer">
                <option value="">{t('liveLayer', 'Live')}</option>
                {plans.map(p => <option key={p.id} value={p.id}>{t('draftPlan', 'Draft plan')} v{p.version}</option>)}
              </select>
            )}
            <span className="search"><Search size={14} aria-hidden /><input ref={searchRef} value={search} onChange={e => setSearch(e.target.value)} placeholder={`${t('search', 'Search a person or unit')} (Ctrl+K)`} aria-label="Search" /></span>
            <span className="spacer" />
            <button type="button" aria-label="TV mode" title={t('tvMode', 'TV mode')} onClick={() => setTv(true)}><Monitor size={16} /></button>
          </header>
        )}

        {tv && (
          <header className="tv-head">
            <strong>{t('app')} · {shownBases[0]?.name}</strong>
            <span>{dayLabel}</span>
            <button type="button" onClick={() => setTv(false)} aria-label="Exit TV mode"><X size={18} /> Esc</button>
          </header>
        )}

        {data?.past && <div className="banner history">{t('historyBanner', 'History: this is how the board looked on')} {dayLabel}. {t('readOnly', 'Read only.')}</div>}
        {data?.layer === 'draft' && <div className="banner draft">{t('draftBanner', 'Draft plan layer: proposed people are dashed. Nothing here is live until the plan is published.')}</div>}
        {error && <div className="banner error" role="alert">{error}</div>}

        {data && !tv && <Summary data={data} />}

        {data && (
          <main className="board" data-testid="board">
            {shownBases.map(b => (
              <section className="column" key={b.id} aria-label={b.name}>
                <h2>{b.code} <small>{b.name}</small></h2>
                {tab === 'field'
                  ? (data.units.filter(u => u.baseId === b.id).map(u => <UnitCard key={u.id} unit={u} editable={!readOnly} hits={hits} onOpen={setDrawer} />))
                  : (data.staffing.filter(s => s.baseId === b.id).map(s => <StaffingPanel key={s.positionId} row={s} hits={hits} onOpen={setDrawer} />))}
                {tab === 'field' && data.units.filter(u => u.baseId === b.id).length === 0 && <p className="empty-note">{problemsOnly ? t('noProblems', 'No problems here.') : t('noUnits', 'No units based here.')}</p>}
                {tab === 'base' && data.staffing.filter(s => s.baseId === b.id).length === 0 && <p className="empty-note">{problemsOnly ? t('noProblems', 'No problems here.') : t('noStaffing', 'No staffing template for this base yet.')}</p>}
              </section>
            ))}
          </main>
        )}

        {data && !tv && !problemsOnly && <SideColumns data={data} hits={hits} editable={!readOnly} onOpen={setDrawer} />}

        {drawer && <PersonDrawer id={drawer} date={date} onClose={() => setDrawer(null)} />}
        <DragOverlay>{dragging ? <div className="drag-ghost"><PersonChip person={dragging.person} compact /></div> : null}</DragOverlay>

        {pending?.kind === 'assign' && (
          <AssignDialog person={pending.person} seat={pending.seat} unit={pending.unit} date={date} transferFrom={pending.transferFrom}
            onClose={() => setPending(null)} onDone={(text, undo) => { toast(text, 'ok', undo); void load() }} />
        )}
        {pending?.kind === 'swap' && (
          <RuleDialog title={t('swapTitle', 'Swap these two people?')} violations={pending.violations}
            summary={<><strong>{pending.first.name}</strong><span className="muted">{pending.first.label}</span> ⇄ <strong>{pending.second.name}</strong><span className="muted">{pending.second.label}</span></>}
            onClose={() => setPending(null)}
            onConfirm={async reason => { const p = pending; await api('/assignments/swap', { method: 'POST', body: { firstId: p.first.assignmentId, secondId: p.second.assignmentId, overrideReason: reason } }); toast(`${p.first.name} ⇄ ${p.second.name}`); void load() }} />
        )}
      </div>
    </DndContext>
  )
}

// ---------------------------------------------------------------- pieces

function Summary({ data }: { data: BoardData }) {
  const { t } = useTranslation()
  const s = data.summary
  const deployed = s.unitsByStatus['DEPLOYED'] ?? 0
  const critical = s.openReplacementTasks['CRITICAL'] ?? 0
  const open = Object.values(s.openReplacementTasks).reduce((a, b) => a + b, 0)
  const cards: [string, number, string, 'ok' | 'warn' | 'bad'][] = [
    [t('kpiDeployed', 'Units on a job'), deployed, '', 'ok'],
    [t('kpiAttention', 'Units needing attention'), s.unitsNeedingAttention, '', s.nonCompliantUnits ? 'bad' : s.unitsNeedingAttention ? 'warn' : 'ok'],
    [t('kpiBelowMin', 'Base posts below minimum'), s.basePostsBelowMin, '', s.basePostsBelowMin ? 'bad' : 'ok'],
    [t('kpiTasks', 'Open replacement tasks'), open, critical ? `${critical} ${t('critical', 'critical')}` : '', critical ? 'bad' : open ? 'warn' : 'ok'],
    [t('kpiChanges', 'Crew changes in 7 days'), s.crewChangesNext7Days, '', 'ok'],
  ]
  return (
    <section className="summary" aria-label="Overview">
      {cards.map(([label, n, sub, sev]) => (
        <div className={`kpi sev-${sev}`} key={label}><strong>{n}</strong><span>{label}</span>{sub && <small>{sub}</small>}</div>
      ))}
    </section>
  )
}

function UnitCard({ unit, editable, hits, onOpen }: { unit: UnitCardData; editable: boolean; hits: Set<string>; onOpen: (id: string) => void }) {
  const { t } = useTranslation()
  const idle = unit.status !== 'DEPLOYED'
  return (
    <article className={`unit color-${unit.colorKey} state-${unit.state}${unit.match ? ' hit' : ''}`} aria-label={unit.code}>
      <header>
        <strong>{unit.code}</strong>
        <span className="type">{unit.type}</span>
        <span className="job">{unit.job ? `${unit.job.well}${unit.job.rig ? ` / ${unit.job.rig}` : ''}` : idle ? t(`unit_${unit.status}`, unit.status === 'AVAILABLE' ? 'Available at base' : unit.status.replace(/_/g, ' ').toLowerCase()) : ''}</span>
      </header>
      <div className="badges">{unit.badges.map((b, n) => <SeverityBadge key={`${b.code}-${n}`} badge={b} />)}</div>
      <div className="seats">
        {unit.seats.map(s => <Seat key={s.seatId} seat={s} unit={unit} editable={editable} hits={hits} onOpen={onOpen} />)}
      </div>
    </article>
  )
}

const SEAT_NAME: Record<string, string> = { 'Chief of Unit': 'Chief', 'Field Operator': 'Operator', 'Field Driver': 'Driver' }

function Seat({ seat, unit, editable, hits, onOpen }: { seat: SeatCard; unit: UnitCardData; editable: boolean; hits: Set<string>; onOpen: (id: string) => void }) {
  const { t } = useTranslation()
  const drop = useDroppable({ id: `seat:${seat.seatId}`, data: { type: 'seat', seat, unit }, disabled: !editable })
  const need = seat.requirements.minSeniority === 'EXPERIENCED' ? 'Experienced' : seat.requirements.minSeniority === 'SENIOR' ? 'Senior' : ''
  const badIssue = seat.issues.find(i => i.severity === 'bad')
  return (
    <div ref={drop.setNodeRef} className={`seat${drop.isOver ? ' over' : ''}${badIssue ? ' bad' : ''}${!seat.required ? ' optional' : ''}`}>
      <span className="role">{SEAT_NAME[seat.position] ?? seat.position}{seat.index > 1 || seat.position === 'Field Operator' ? ` ${seat.index}` : ''}{need && <em title={`${need} or above`}>★</em>}</span>
      {seat.holder
        ? <PersonChip person={seat.holder} highlight={hits.has(seat.holder.id)} onOpen={onOpen} draft={seat.holder.draft}
            drag={editable && !seat.holder.draft ? { id: `seat-person:${seat.seatId}`, data: { person: seat.holder, seatId: seat.seatId, assignmentId: seat.holder.assignmentId, until: seat.holder.until } } : undefined} />
        : <span className="empty-seat">{editable ? t('assign', '+ Assign') : t('vacant', 'Empty')}</span>}
      {seat.issues.filter(i => i.code !== 'empty').map((i, n) => <span key={`${i.code}-${n}`} className={`issue sev-${i.severity}`} title={i.text}><AlertTriangle size={13} aria-label={i.text} /></span>)}
    </div>
  )
}

function StaffingPanel({ row, hits, onOpen }: { row: StaffingRow; hits: Set<string>; onOpen: (id: string) => void }) {
  const { t } = useTranslation()
  const label = { ok: t('staffOk', 'Fully staffed'), below_target: t('staffBelowTarget', 'Below target'), below_min: t('staffBelowMin', 'Below minimum'), off_day: t('staffOffDay', 'Not needed today') }[row.state]
  return (
    <article className={`staffing sev-${row.severity}${row.state === 'off_day' ? ' off' : ''}`}>
      <header><strong>{row.position}</strong><span className={`badge sev-${row.severity}`}>{row.filled} / {row.min} / {row.target}</span></header>
      <div className="meter" aria-label={`${row.filled} present, minimum ${row.min}, target ${row.target}`}>
        {Array.from({ length: Math.max(row.target, row.filled) }, (_, i) => <i key={i} className={`${i < row.filled ? 'full' : ''}${i < row.min ? ' req' : ''}`} />)}
      </div>
      <small className="muted">{label}</small>
      {row.people.map(p => (
        <div key={p.id} className="staff-person">
          <PersonChip person={p} highlight={hits.has(p.id)} onOpen={onOpen} compact />
          {p.workOrder && <span className="wo" title={`${p.workOrder.type} · ${p.workOrder.status}`}><Wrench size={12} aria-hidden /> {p.workOrder.unit}</span>}
        </div>
      ))}
    </article>
  )
}

function Column({ name, title, color, people, hits, editable, onOpen }: {
  name: string; title: string; color: string; people: Person[]; hits: Set<string>; editable: boolean; onOpen: (id: string) => void
}) {
  const drop = useDroppable({ id: `col:${name}`, data: { type: 'column', name }, disabled: !editable || name !== 'standby' })
  const [open, setOpen] = useState(name === 'standby')
  return (
    <section ref={drop.setNodeRef} className={`side${drop.isOver ? ' over' : ''}`}>
      <button type="button" className="side-head" onClick={() => setOpen(!open)} aria-expanded={open} style={{ borderColor: color }}>
        <span style={{ color }}>{title}</span><b>{people.length}</b>
      </button>
      {open && <div className="side-list">
        {people.length === 0 && <small className="muted">—</small>}
        {people.map(p => (
          <PersonChip key={p.id} person={p} highlight={hits.has(p.id)} onOpen={onOpen}
            drag={editable && (name === 'standby' || name === 'daysOff') ? { id: `col-person:${name}:${p.id}`, data: { person: p } } : undefined} />
        ))}
      </div>}
    </section>
  )
}

function SideColumns({ data, hits, editable, onOpen }: { data: BoardData; hits: Set<string>; editable: boolean; onOpen: (id: string) => void }) {
  const { t } = useTranslation()
  return (
    <section className="sides" aria-label="People not on a seat">
      <h3><Users size={15} aria-hidden /> {t('peopleNotOnSeat', 'People not on a seat')}</h3>
      <div className="side-grid">
        {COLUMNS.map(([key, status]) => (
          <Column key={key} name={key} title={t(`col_${key}`, COLUMN_TITLES[key])} color={STATUS_META[status].color}
            people={(data.columns[key] as Person[] | undefined) ?? []} hits={hits} editable={editable} onOpen={onOpen} />
        ))}
      </div>
    </section>
  )
}
