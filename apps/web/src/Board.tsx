import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DndContext, DragOverlay, KeyboardSensor, MouseSensor, TouchSensor, useDroppable, useSensor, useSensors } from '@dnd-kit/core'
import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core'
import {
  AlertTriangle, CalendarClock, Plus, CheckCircle2, ChevronLeft, ChevronRight, Eye, EyeOff, LayoutGrid, MapPin, Monitor, PieChart, Repeat,
  Search, Truck, UserPlus, Users, Wrench, X,
} from 'lucide-react'
import { api, ApiError, subscribeChanges } from './api'
import { useAuth } from './auth'
import type { BoardData, Person, PlanSummary, SeatCard, StaffingRow, UnitCardData, Violation } from './types'
import { PersonChip, SeverityBadge, STATUS_META, useToast } from './ui'
import { AssignDialog, RuleDialog, addDaysIso } from './dialogs'
import { AssignPicker } from './assign'
import type { FreePerson } from './assign'
import { FleetMap } from './fleetmap'
import type { MapData } from './fleetmap'
import { BASE_COLORS, Donut, Legend, PageGuide, Ring } from './guide'
import { useProfiles } from './profiles'
import { AddUnitDialog, NewJobDialog } from './unitforms'
import { go, useApi } from './hooks'

type Tab = 'field' | 'base'
type StateFilter = 'all' | 'attention' | 'bad' | 'ok' | 'idle'
interface DragPayload { person: Person; seatId?: string; assignmentId?: string; until?: string }
type Pending =
  | { kind: 'assign'; person: Person; seat: SeatCard; unit: UnitCardData; transferFrom?: { assignmentId: string; label: string }; end?: string }
  | { kind: 'swap'; first: { assignmentId: string; name: string; label: string }; second: { assignmentId: string; name: string; label: string }; violations: Violation[] }

const todayIso = () => new Date().toISOString().slice(0, 10)
const LANES: [string, string, string][] = [
  ['standby', 'STANDBY', 'Standby'], ['daysOff', 'DAYS_OFF', 'Days off'], ['leave', 'LEAVE', 'Leave'],
  ['unavailable', 'UNAVAILABLE', 'Unavailable'], ['training', 'TRAINING', 'Training'], ['awaitingClearance', 'AWAITING_CLEARANCE', 'Awaiting clearance'],
]
const ROLE_COLOR: Record<string, string> = { 'Chief of Unit': 'var(--pal-violet-700)', 'Field Operator': 'var(--pal-blue-700)', 'Field Driver': 'var(--pal-teal-700)' }
const SEAT_NAME: Record<string, string> = { 'Chief of Unit': 'Chief', 'Field Operator': 'Operator', 'Field Driver': 'Driver' }
const unitKind = (u: UnitCardData) => (u.colorKey === 'amber' || /cased/i.test(u.type) ? 'CH' : 'OH')
const isIdle = (u: UnitCardData) => u.status !== 'DEPLOYED'

export default function Board() {
  const { t, i18n } = useTranslation()
  const { can } = useAuth()
  const toast = useToast()
  const editor = can('SUPER_ADMIN', 'OPS_MANAGER', 'DISPATCHER', 'BASE_MANAGER')

  const [tab, setTab] = useState<Tab>('field')
  const [date, setDate] = useState(todayIso())
  const [baseId, setBaseId] = useState('')
  const [kind, setKind] = useState<'' | 'OH' | 'CH'>('')
  const [stateF, setStateF] = useState<StateFilter>('all')
  const [lane, setLane] = useState('')
  const [search, setSearch] = useState('')
  const [q, setQ] = useState('')
  const [planId, setPlanId] = useState('')
  const [plans, setPlans] = useState<PlanSummary[]>([])
  const [data, setData] = useState<BoardData | null>(null)
  const [error, setError] = useState('')
  const [tv, setTv] = useState(false)
  const [tvIndex, setTvIndex] = useState(0)
  const { openPerson, openUnit } = useProfiles()
  const setDrawer = openPerson
  const [creating, setCreating] = useState<'' | 'unit' | 'job'>('')
  const [pending, setPending] = useState<Pending | null>(null)
  const [picking, setPicking] = useState<{ seat: SeatCard; unit: UnitCardData } | null>(null)
  const [dragging, setDragging] = useState<DragPayload | null>(null)
  const [overview, setOverview] = useState(() => { try { return localStorage.getItem('crewboard.board.overview') !== 'hidden' } catch { return true } })
  const searchRef = useRef<HTMLInputElement>(null)
  const lanesRef = useRef<HTMLElement>(null)
  const map = useApi<MapData>(can('SUPER_ADMIN', 'OPS_MANAGER', 'DISPATCHER', 'BASE_MANAGER', 'HR') ? '/analytics/map' : null)

  const readOnly = !editor || !!data?.past || data?.layer === 'draft'

  // ---- data
  const load = useCallback(async () => {
    const p = new URLSearchParams({ date, view: 'all' })
    if (q) p.set('q', q)
    if (planId) p.set('planId', planId)
    try { setData(await api<BoardData>(`/board?${p}`)); setError('') } catch (e) { setError(e instanceof ApiError ? e.message : String(e)) }
  }, [date, q, planId])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const stop = subscribeChanges(() => { clearTimeout(timer); timer = setTimeout(() => { void load(); void map.reload() }, 250) })
    return () => { stop(); clearTimeout(timer) }
  }, [load, map.reload])
  useEffect(() => { const h = setTimeout(() => setQ(search.trim()), 300); return () => clearTimeout(h) }, [search])
  useEffect(() => {
    if (!editor) return
    api<PlanSummary[]>('/planning/plans?status=DRAFT').then(setPlans).catch(() => setPlans([]))
  }, [editor, data?.layer])
  useEffect(() => { try { localStorage.setItem('crewboard.board.overview', overview ? 'shown' : 'hidden') } catch { /* private mode */ } }, [overview])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); searchRef.current?.focus() }
      if (e.key === 'Escape') setTv(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  useEffect(() => {
    if (!tv || !data || data.bases.length < 2) return
    const h = setInterval(() => setTvIndex(i => (i + 1) % data.bases.length), 15000)
    return () => clearInterval(h)
  }, [tv, data])

  // Mouse: drag after a few pixels. Touch: press and hold, so a swipe still scrolls the board.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
    useSensor(KeyboardSensor),
  )

  // ---- drag and drop (still works; clicking "Assign" does the same without dragging)
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
    const label = (s: SeatCard, u: string) => `${u} · ${s.position} #${s.index}`
    const fromSeat = from.seatId ? data?.units.flatMap(u => u.seats.map(s => ({ s, u }))).find(x => x.s.seatId === from.seatId) : undefined
    if (seat.holder) {
      if (!from.assignmentId) { toast(t('seatTaken', 'That seat is taken: release the person first'), 'error'); return }
      await trySwap({ assignmentId: from.assignmentId, name: from.person.name, label: fromSeat ? label(fromSeat.s, fromSeat.u.code) : '' }, { assignmentId: seat.holder.assignmentId, name: seat.holder.name, label: label(seat, unit.code) })
      return
    }
    setPending({ kind: 'assign', person: from.person, seat, unit, transferFrom: from.assignmentId ? { assignmentId: from.assignmentId, label: fromSeat ? label(fromSeat.s, fromSeat.u.code) : '' } : undefined })
  }
  const trySwap = async (first: { assignmentId: string; name: string; label: string }, second: { assignmentId: string; name: string; label: string }) => {
    try {
      await api('/assignments/swap', { method: 'POST', body: { firstId: first.assignmentId, secondId: second.assignmentId } })
      toast(`${first.name} ⇄ ${second.name}`)
    } catch (err) {
      if (err instanceof ApiError && err.status === 422) setPending({ kind: 'swap', first, second, violations: (err.body as { violations?: Violation[] }).violations ?? [] })
      else toast(err instanceof ApiError ? err.message : String(err), 'error')
    }
  }

  // ---- derived
  const codes = useMemo(() => [...(data?.bases ?? [])].map(b => b.code).sort(), [data])
  const colorOf = useCallback((code: string) => BASE_COLORS[Math.max(0, codes.indexOf(code)) % BASE_COLORS.length], [codes])
  const hits = useMemo(() => new Set(data?.matches.employees ?? []), [data])
  const free = useMemo<FreePerson[]>(() => [
    ...(data?.columns.standby ?? []).map(p => ({ ...p, status: 'STANDBY' })),
    ...(data?.columns.daysOff ?? []).map(p => ({ ...p, status: 'DAYS_OFF' })),
  ], [data])
  const unitMatches = (u: UnitCardData) =>
    (!baseId || u.baseId === baseId) && (!kind || unitKind(u) === kind) &&
    (stateF === 'all' || (stateF === 'attention' && (u.state === 'warn' || u.state === 'bad')) || (stateF === 'bad' && u.state === 'bad') ||
      (stateF === 'ok' && !isIdle(u) && (u.state === 'ok' || u.state === 'info')) || (stateF === 'idle' && isIdle(u))) &&
    (!q || u.match || u.seats.some(s => s.holder && hits.has(s.holder.id)))
  const shownBases = useMemo(() => {
    if (!data) return []
    const list = data.bases.filter(b => !baseId || b.id === baseId)
    return tv && list.length ? [list[tvIndex % list.length]] : list
  }, [data, baseId, tv, tvIndex])
  const dayLabel = data ? new Date(data.date).toLocaleDateString(i18n.language, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : ''

  if (!data && !error) return <div className="loading">{t('loading', 'Loading the board…')}</div>
  const s = data?.summary
  const deployed = data?.units.filter(u => !isIdle(u)) ?? []
  const attention = deployed.filter(u => u.state === 'warn' || u.state === 'bad').length
  const openTasks = s ? Object.values(s.openReplacementTasks).reduce((a, b) => a + b, 0) : 0
  const critical = s?.openReplacementTasks.CRITICAL ?? 0
  const peopleSlices = s ? Object.entries(s.headcount).filter(([, v]) => v > 0).map(([k, v]) => ({ key: k, value: v, color: STATUS_META[k]?.color ?? 'var(--muted)', label: STATUS_META[k]?.label ?? k })) : []
  const pickLane = (status: string) => {
    const l = LANES.find(x => x[1] === status)
    if (!l) { setLane(''); return }
    setLane(lane === l[0] ? '' : l[0])
    setTimeout(() => lanesRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
  }

  return (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
      <div className={`bd${tv ? ' app tv' : ''}`}>
        {!tv && (
          <PageGuide id="board" Icon={LayoutGrid} color="var(--pal-blue-600)" title={t('boardTitle', 'Dispatch board')}
            purpose={t('boardPurpose', 'Where everyone is on the chosen day: every unit with its crew, every base, and who is free.')}
            steps={[
              t('boardStep1', 'The coloured cards are units. Green header = Open Hole, amber = Cased Hole, grey = at base without a job. A red outline means the crew breaks a rule.'),
              t('boardStep2', 'Press "Assign someone" on an empty seat to see the best people for it, or drag a person from the lanes below onto a seat.'),
              t('boardStep3', 'Click the map, the charts or the coloured chips to filter. Click a name to see that person\'s details.'),
              t('boardStep4', 'Click a unit\'s coloured header for its details: jobs, crew history, maintenance. From there you can send it to the workshop with a note, or give it a job.'),
              t('boardStep5', '"New job" sends a unit to a well; "Add a unit" registers a new truck. Change the date to look ahead or back in time.'),
            ]}>
            {editor && <button type="button" className="primary" onClick={() => setCreating('job')}><Plus size={15} aria-hidden /> {t('newJob', 'New job')}</button>}
            {can('SUPER_ADMIN', 'OPS_MANAGER') && <button type="button" onClick={() => setCreating('unit')}><Truck size={15} aria-hidden /> {t('addUnit', 'Add a unit')}</button>}
            <button type="button" onClick={() => setOverview(!overview)}>{overview ? <EyeOff size={15} aria-hidden /> : <Eye size={15} aria-hidden />} {overview ? t('hideOverview', 'Hide overview') : t('showOverview', 'Show overview')}</button>
            <button type="button" title={t('tvMode', 'TV mode')} onClick={() => setTv(true)}><Monitor size={15} aria-hidden /> {t('tvShort', 'TV')}</button>
          </PageGuide>
        )}

        {!tv && (
          <div className="bd-toolbar">
            <span className="seg2" role="tablist">
              <button type="button" role="tab" aria-selected={tab === 'field'} className={tab === 'field' ? 'on' : ''} onClick={() => setTab('field')}><Truck size={15} aria-hidden /> {t('fieldView', 'Units in the field')}</button>
              <button type="button" role="tab" aria-selected={tab === 'base'} className={tab === 'base' ? 'on' : ''} onClick={() => setTab('base')}><Wrench size={15} aria-hidden /> {t('baseView', 'Base staff')}</button>
            </span>
            <span className="dates">
              <button type="button" aria-label="Previous day" onClick={() => setDate(addDaysIso(date, -1))}><ChevronLeft size={16} /></button>
              <input type="date" value={date} onChange={e => e.target.value && setDate(e.target.value)} aria-label="Date" />
              <button type="button" aria-label="Next day" onClick={() => setDate(addDaysIso(date, 1))}><ChevronRight size={16} /></button>
              <button type="button" onClick={() => setDate(todayIso())}>{t('today', 'Today')}</button>
              <button type="button" onClick={() => setDate(addDaysIso(todayIso(), 7))}>{t('nextWeek', 'In a week')}</button>
            </span>
            {plans.length > 0 && (
              <select value={planId} onChange={e => setPlanId(e.target.value)} aria-label="Layer">
                <option value="">{t('liveLayer', 'Live board')}</option>
                {plans.map(p => <option key={p.id} value={p.id}>{t('draftPlan', 'Draft plan')} v{p.version}</option>)}
              </select>
            )}
            <span className="spacer" />
            <span className="search"><Search size={14} aria-hidden /><input ref={searchRef} value={search} onChange={e => setSearch(e.target.value)} placeholder={`${t('search', 'Find a person or unit')} (Ctrl+K)`} aria-label="Search" /></span>
          </div>
        )}

        {tv && (
          <header className="tv-head">
            <strong>{t('app')} · {shownBases[0]?.name}</strong><span>{dayLabel}</span>
            <button type="button" onClick={() => setTv(false)} aria-label="Exit TV mode"><X size={18} /> Esc</button>
          </header>
        )}

        {data?.past && <div className="banner history">{t('historyBanner', 'History: this is how the board looked on')} {dayLabel}. {t('readOnly', 'Read only.')}</div>}
        {data?.layer === 'draft' && <div className="banner draft">{t('draftBanner', 'Draft plan layer: proposed people are dashed. Nothing here is live until the plan is published.')}</div>}
        {error && <div className="banner error" role="alert">{error}</div>}

        {data && s && !tv && (
          <section className="kpis2" aria-label="Today in numbers">
            <button type="button" className="kpi2" style={{ ['--c' as string]: 'var(--pal-blue-600)' }} onClick={() => { setStateF('all'); setTab('field') }}>
              <Truck size={22} className="k-icon" aria-hidden /><strong>{deployed.length}</strong><span>{t('kpiDeployed', 'Units on a job')}</span><small>{data.units.length - deployed.length} {t('atBase', 'at base')}</small>
            </button>
            <button type="button" className="kpi2" style={{ ['--c' as string]: attention ? 'var(--pal-red-600)' : 'var(--pal-green-600)' }} onClick={() => { setStateF(attention ? 'attention' : 'all'); setTab('field') }}>
              {attention ? <AlertTriangle size={22} className="k-icon" aria-hidden /> : <CheckCircle2 size={22} className="k-icon" aria-hidden />}
              <strong>{attention}</strong><span>{t('kpiAttention', 'Crews needing attention')}</span><small>{attention ? t('clickToSee', 'click to show them') : t('allCrewsOk', 'every crew follows the rules')}</small>
            </button>
            <button type="button" className="kpi2" style={{ ['--c' as string]: critical ? 'var(--pal-red-700)' : openTasks ? 'var(--pal-orange-600)' : 'var(--pal-green-600)' }} onClick={() => go('replacements')}>
              <Repeat size={22} className="k-icon" aria-hidden /><strong>{openTasks}</strong><span>{t('kpiTasks', 'Seats waiting for someone')}</span><small>{critical ? `${critical} ${t('critical', 'critical')} · ` : ''}{t('openCenter', 'open the replacement center')}</small>
            </button>
            <button type="button" className="kpi2" style={{ ['--c' as string]: s.basePostsBelowMin ? 'var(--pal-red-600)' : 'var(--pal-indigo-600)' }} onClick={() => setTab('base')}>
              <Wrench size={22} className="k-icon" aria-hidden /><strong>{s.basePostsBelowMin}</strong><span>{t('kpiBelowMin', 'Base posts below minimum')}</span><small>{t('seeBaseStaff', 'see base staff')}</small>
            </button>
            <button type="button" className="kpi2" style={{ ['--c' as string]: 'var(--pal-teal-600)' }} onClick={() => go('crew-changes')}>
              <CalendarClock size={22} className="k-icon" aria-hidden /><strong>{s.crewChangesNext7Days}</strong><span>{t('kpiChanges', 'Crew changes this week')}</span><small>{t('seeList', 'see the list')}</small>
            </button>
          </section>
        )}

        {data && s && overview && !tv && (
          <section className="bd-overview" aria-label="Where everyone is">
            <div className="card2">
              <h2><MapPin size={16} aria-hidden /> {t('whereTitle', 'Where the units are working')}<small>{t('clickBase', 'click a base to filter')}</small></h2>
              {map.data ? <FleetMap map={map.data} units={data.units} colorOf={colorOf} selected={baseId} onBase={id => setBaseId(id)} />
                : <p className="hint">{map.error ? t('mapUnavailable', 'The map is not available for your role.') : t('loading', 'Loading…')}</p>}
              <Legend items={[{ color: 'var(--pal-blue-600)', label: t('lgOnUnit', 'on a unit'), shape: 'ring' }, { color: 'var(--pal-teal-600)', label: t('lgStandby', 'standby'), shape: 'ring' }, { color: 'var(--pal-slate-400)', label: t('lgOther', 'off / leave / base'), shape: 'ring' }, { color: 'var(--pal-green-600)', label: t('lgCrewOk', 'crew OK') }, { color: 'var(--pal-amber-600)', label: t('lgCrewWarn', 'warning') }, { color: 'var(--pal-red-600)', label: t('lgCrewBad', 'rule broken') }]} />
            </div>
            <div className="card2">
              <h2><PieChart size={16} aria-hidden /> {t('peopleToday', 'Everyone today')}<small>{t('clickSlice', 'click to find them')}</small></h2>
              <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
                <Donut slices={peopleSlices} size={150} caption={t('people', 'people')} active={LANES.find(l => l[0] === lane)?.[1]} onPick={pickLane} />
                <div className="status-list" style={{ flex: 1, gridTemplateColumns: '1fr' }}>
                  {peopleSlices.map(sl => (
                    <button key={sl.key} type="button" className={`status-pick${LANES.find(l => l[0] === lane)?.[1] === sl.key ? ' on' : ''}`} style={{ ['--c' as string]: sl.color }} onClick={() => pickLane(sl.key)}>
                      <i />{sl.label}<b>{sl.value}</b>
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="card2">
              <h2><Truck size={16} aria-hidden /> {t('crewHealth', 'Crews by base')}<small>{t('clickBaseRow', 'click to filter')}</small></h2>
              <div className="health">
                {data.bases.map(b => {
                  const us = data.units.filter(u => u.baseId === b.id)
                  const n = (f: (u: UnitCardData) => boolean) => us.filter(f).length
                  const ok = n(u => !isIdle(u) && (u.state === 'ok' || u.state === 'info')), warn = n(u => !isIdle(u) && u.state === 'warn'), bad = n(u => !isIdle(u) && u.state === 'bad'), idle = n(isIdle)
                  const tot = Math.max(1, us.length)
                  return (
                    <button key={b.id} type="button" className={`health-row${baseId === b.id ? ' on' : ''}`} onClick={() => setBaseId(baseId === b.id ? '' : b.id)} title={`${b.name}: ${ok} OK, ${warn} warning, ${bad} broken, ${idle} at base`}>
                      <span className="base-tag" style={{ ['--c' as string]: colorOf(b.code) }}>{b.code}</span>
                      <span className="stackbar">
                        <i style={{ width: `${ok / tot * 100}%`, background: 'var(--pal-green-600)' }} /><i style={{ width: `${warn / tot * 100}%`, background: 'var(--pal-amber-500)' }} />
                        <i style={{ width: `${bad / tot * 100}%`, background: 'var(--pal-red-600)' }} /><i style={{ width: `${idle / tot * 100}%`, background: 'var(--pal-slate-300)' }} />
                      </span>
                      <small className="muted">{ok + warn + bad}/{us.length} {t('onJob', 'on a job')}</small>
                    </button>
                  )
                })}
              </div>
              <Legend items={[{ color: 'var(--pal-green-600)', label: t('lgOk', 'OK'), shape: 'bar' }, { color: 'var(--pal-amber-500)', label: t('lgWarn', 'warning'), shape: 'bar' }, { color: 'var(--pal-red-600)', label: t('lgBad', 'rule broken'), shape: 'bar' }, { color: 'var(--pal-slate-300)', label: t('lgIdle', 'no job'), shape: 'bar' }]} />
            </div>
          </section>
        )}

        {data && !tv && (
          <div className="card2" style={{ gap: 8 }}>
            <div className="chips"><span className="chips-label">{t('fBase', 'Base')}</span>
              <button type="button" className={`fchip${!baseId ? ' on' : ''}`} style={{ ['--c' as string]: 'var(--pal-slate-700)' }} onClick={() => setBaseId('')}>{t('allBases', 'All bases')}</button>
              {data.bases.map(b => <button key={b.id} type="button" className={`fchip${baseId === b.id ? ' on' : ''}`} style={{ ['--c' as string]: colorOf(b.code) }} onClick={() => setBaseId(baseId === b.id ? '' : b.id)}><i />{b.code} <b>{data.units.filter(u => u.baseId === b.id).length}</b></button>)}
              <span className="chips-label" style={{ marginInlineStart: 10 }}>{t('fType', 'Type')}</span>
              {(['', 'OH', 'CH'] as const).map(k => <button key={k || 'all'} type="button" className={`fchip${kind === k ? ' on' : ''}`} style={{ ['--c' as string]: k === 'OH' ? 'var(--oh)' : k === 'CH' ? 'var(--ch)' : 'var(--pal-slate-700)' }} onClick={() => setKind(k)}>{k ? <><i />{k === 'OH' ? 'Open Hole' : 'Cased Hole'}</> : t('allTypes', 'All')}</button>)}
              {tab === 'field' && <>
                <span className="chips-label" style={{ marginInlineStart: 10 }}>{t('fState', 'Crew')}</span>
                {([['all', 'Any', 'var(--pal-slate-700)'], ['attention', 'Needs attention', 'var(--pal-orange-600)'], ['bad', 'Rule broken', 'var(--pal-red-600)'], ['ok', 'All good', 'var(--pal-green-600)'], ['idle', 'No job', 'var(--pal-slate-500)']] as const).map(([k, l, c]) => (
                  <button key={k} type="button" className={`fchip${stateF === k ? ' on' : ''}`} style={{ ['--c' as string]: c }} onClick={() => setStateF(k)}>{k !== 'all' && <i />}{t(`fs_${k}`, l)}</button>
                ))}
              </>}
            </div>
          </div>
        )}

        {data && shownBases.map(b => {
          const units = data.units.filter(u => u.baseId === b.id && unitMatches(u))
          const rows = data.staffing.filter(r => r.baseId === b.id)
          if (tab === 'field' && units.length === 0 && (baseId || stateF !== 'all' || kind || q)) return null
          const all = data.units.filter(u => u.baseId === b.id)
          return (
            <section key={b.id} className="base-sec" aria-label={b.name}>
              <div className="base-banner" style={{ ['--c' as string]: colorOf(b.code) }}>
                <h2>{b.code}</h2><span>{b.name}</span>
                <span className="bb-stats">
                  <em>{all.filter(u => !isIdle(u)).length} {t('onJob', 'on a job')}</em>
                  <em>{all.filter(u => !isIdle(u)).reduce((n, u) => n + u.crew.filled, 0)}/{all.filter(u => !isIdle(u)).reduce((n, u) => n + u.crew.required, 0)} {t('seatsFilled', 'seats filled')}</em>
                  {rows.some(r => r.state === 'below_min') && <em>⚠ {t('postsLow', 'base posts low')}</em>}
                </span>
              </div>
              {tab === 'field' ? (
                units.length ? <div className="unit-grid">{units.map(u => <UnitCard key={u.id} unit={u} editable={!readOnly} hits={hits} onOpen={setDrawer} onUnit={() => openUnit(u.id)} onAssign={seat => setPicking({ seat, unit: u })} />)}</div>
                  : <p className="empty-note">{t('noUnits', 'No units based here.')}</p>
              ) : (
                rows.length ? <div className="unit-grid">{rows.map(r => <StaffingPanel key={r.positionId} row={r} hits={hits} onOpen={setDrawer} />)}</div>
                  : <p className="empty-note">{t('noStaffing', 'No staffing template for this base yet.')}</p>
              )}
            </section>
          )
        })}

        {data && !tv && (
          <section ref={lanesRef} aria-label="People not on a seat" className="base-sec">
            <div className="base-banner" style={{ ['--c' as string]: 'var(--pal-slate-700)' }}>
              <h2><Users size={18} aria-hidden /></h2><span>{t('peopleNotOnSeat', 'People not on a seat today')}{editor ? ` · ${t('dragHint', 'drag someone from standby onto a seat, or use Assign')}` : ''}</span>
              {lane && <span className="bb-stats"><em style={{ cursor: 'pointer' }} onClick={() => setLane('')}>{t('showAllLanes', 'Show all')} ✕</em></span>}
            </div>
            <div className="lanes">
              {LANES.filter(([k]) => !lane || lane === k).map(([key, status, title]) => (
                <Lane key={key} name={key} title={t(`col_${key}`, title)} color={STATUS_META[status].color}
                  people={((data.columns[key] as Person[] | undefined) ?? []).filter(p => !baseId || p.base === data.bases.find(x => x.id === baseId)?.code)}
                  hits={hits} editable={!readOnly} onOpen={setDrawer} />
              ))}
            </div>
          </section>
        )}

        {creating === 'unit' && <AddUnitDialog onClose={() => setCreating('')} onDone={id => { void load(); void map.reload(); openUnit(id) }} />}
        {creating === 'job' && <NewJobDialog onClose={() => setCreating('')} onDone={() => { void load(); void map.reload() }} />}
        <DragOverlay>{dragging ? <div className="drag-ghost"><PersonChip person={dragging.person} compact /></div> : null}</DragOverlay>

        {picking && (
          <AssignPicker seat={picking.seat} unit={picking.unit} date={date} free={free} onClose={() => setPicking(null)}
            onPick={(p, end) => { const x = picking; setPicking(null); setPending({ kind: 'assign', person: p, seat: x.seat, unit: x.unit, end }) }} />
        )}
        {pending?.kind === 'assign' && (
          <AssignDialog person={pending.person} seat={pending.seat} unit={pending.unit} date={date} transferFrom={pending.transferFrom} initialEnd={pending.end}
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

function UnitCard({ unit, editable, hits, onOpen, onUnit, onAssign }: { unit: UnitCardData; editable: boolean; hits: Set<string>; onOpen: (id: string) => void; onUnit: () => void; onAssign: (s: SeatCard) => void }) {
  const { t } = useTranslation()
  const idle = isIdle(unit)
  const problems = unit.badges.filter(b => b.severity === 'bad' || b.severity === 'warn')
  const others = unit.badges.filter(b => b.severity === 'info')
  const stateText = idle ? t(`unit_${unit.status}`, unit.status === 'AVAILABLE' ? 'At base, no job' : unit.status.replace(/_/g, ' ').toLowerCase())
    : problems.length ? `${problems.length} ${problems.length === 1 ? t('issue', 'issue') : t('issues', 'issues')}` : t('crewOk', 'Crew complete and compliant')
  const sev = idle ? 'info' : unit.state === 'bad' ? 'bad' : unit.state === 'warn' ? 'warn' : 'ok'
  return (
    <article className={`ucard color-${unit.colorKey} state-${unit.state}${idle ? ' idle' : ''}${unit.match ? ' hit' : ''}`} aria-label={unit.code}>
      <header className="ucard-head clickable" role="button" tabIndex={0} title={t('openUnit', 'Open the unit: details, jobs, maintenance')} onClick={onUnit} onKeyDown={e => { if (e.key === 'Enter') onUnit() }}>
        <Ring value={unit.crew.filled} max={unit.crew.required} color="#fff" size={44} />
        <span className="uh-text">
          <strong>{unit.code}<span className="type-pill">{unitKind(unit)}</span></strong>
          <small>{unit.job ? `${unit.job.well}${unit.job.rig ? ` · ${unit.job.rig}` : ''} · ${unit.job.site}` : unit.type}</small>
        </span>
      </header>
      <div className={`ucard-state sev-${sev}`}>
        {sev === 'ok' ? <CheckCircle2 size={14} aria-hidden /> : sev === 'info' ? <Wrench size={14} aria-hidden /> : <AlertTriangle size={14} aria-hidden />}
        {stateText}
        {unit.crewChange && <span className="cc"><CalendarClock size={13} aria-hidden /> {unit.crewChange.inDays === 0 ? t('ccToday', 'crew change today') : `${t('ccIn', 'crew change in')} ${unit.crewChange.inDays} ${t('d', 'd')}`}</span>}
      </div>
      {(problems.length > 0 || others.length > 0) && <div className="ucard-badges">{[...problems, ...others.filter(b => !/crew change/i.test(b.text))].map((b, n) => <SeverityBadge key={`${b.code}-${n}`} badge={b} />)}</div>}
      <div className="ucard-seats">
        {unit.seats.map(s => <Seat key={s.seatId} seat={s} unit={unit} editable={editable} hits={hits} onOpen={onOpen} onAssign={onAssign} />)}
      </div>
    </article>
  )
}

function Seat({ seat, unit, editable, hits, onOpen, onAssign }: { seat: SeatCard; unit: UnitCardData; editable: boolean; hits: Set<string>; onOpen: (id: string) => void; onAssign: (s: SeatCard) => void }) {
  const { t } = useTranslation()
  const drop = useDroppable({ id: `seat:${seat.seatId}`, data: { type: 'seat', seat, unit }, disabled: !editable })
  const need = seat.requirements.minSeniority === 'EXPERIENCED' || seat.requirements.minSeniority === 'SENIOR'
  const badIssue = seat.issues.find(i => i.severity === 'bad')
  return (
    <div ref={drop.setNodeRef} className={`seat2${drop.isOver ? ' over' : ''}${badIssue && seat.holder ? ' bad' : ''}${!seat.required ? ' optional' : ''}`}>
      <span className="role-pill" style={{ ['--c' as string]: ROLE_COLOR[seat.position] ?? 'var(--pal-slate-500)' }} title={`${seat.position}${need ? ' · needs an experienced person' : ''}${seat.required ? '' : ' · optional'}`}>
        {SEAT_NAME[seat.position] ?? seat.position}{seat.position === 'Field Operator' ? ` ${seat.index}` : ''}{need && <em>★</em>}
      </span>
      {seat.holder
        ? <PersonChip person={seat.holder} highlight={hits.has(seat.holder.id)} onOpen={onOpen} draft={seat.holder.draft}
            drag={editable && !seat.holder.draft ? { id: `seat-person:${seat.seatId}`, data: { person: seat.holder, seatId: seat.seatId, assignmentId: seat.holder.assignmentId, until: seat.holder.until } } : undefined} />
        : editable
          ? <button type="button" className={`assign-btn${seat.required && !['AVAILABLE', 'UNDER_MAINTENANCE', 'OUT_OF_SERVICE'].includes(unit.status) ? ' req' : ''}`} onClick={() => onAssign(seat)}><UserPlus size={15} aria-hidden /> {t('assignSomeone', 'Assign someone')}</button>
          : <span className="empty-plain">{t('vacant', 'Empty')}</span>}
      <span>{seat.issues.filter(i => i.code !== 'empty').map((i, n) => <span key={`${i.code}-${n}`} className={`issue sev-${i.severity}`} title={i.text}><AlertTriangle size={14} aria-label={i.text} /></span>)}</span>
    </div>
  )
}

function StaffingPanel({ row, hits, onOpen }: { row: StaffingRow; hits: Set<string>; onOpen: (id: string) => void }) {
  const { t } = useTranslation()
  const label = { ok: t('staffOk', 'Fully staffed'), below_target: t('staffBelowTarget', 'Below target'), below_min: t('staffBelowMin', 'Below minimum'), off_day: t('staffOffDay', 'Not needed today') }[row.state]
  const col = row.severity === 'bad' ? 'var(--pal-red-600)' : row.severity === 'warn' ? 'var(--pal-amber-600)' : row.state === 'off_day' ? 'var(--pal-slate-500)' : 'var(--pal-indigo-600)'
  return (
    <article className="ucard" style={{ ['--u' as string]: col }}>
      <header className="ucard-head">
        <Ring value={row.filled} max={Math.max(row.min, 1)} color="#fff" size={44} />
        <span className="uh-text"><strong>{row.position}</strong><small>{label} · {t('min', 'min')} {row.min} · {t('target', 'target')} {row.target}</small></span>
      </header>
      <div className="ucard-seats">
        {row.people.length === 0 && <span className="empty-plain">{t('nobodyPresent', 'Nobody present')}</span>}
        {row.people.map(p => (
          <div key={p.id} className="staff-person">
            <PersonChip person={p} highlight={hits.has(p.id)} onOpen={onOpen} compact />
            {p.workOrder && <span className="tag2" style={{ ['--c' as string]: 'var(--pal-amber-700)' }} title={`${p.workOrder.type} · ${p.workOrder.status}`}><Wrench size={11} aria-hidden /> {p.workOrder.unit}</span>}
          </div>
        ))}
      </div>
    </article>
  )
}

function Lane({ name, title, color, people, hits, editable, onOpen }: {
  name: string; title: string; color: string; people: Person[]; hits: Set<string>; editable: boolean; onOpen: (id: string) => void
}) {
  const drop = useDroppable({ id: `col:${name}`, data: { type: 'column', name }, disabled: !editable || name !== 'standby' })
  const [open, setOpen] = useState(name === 'standby' || name === 'daysOff')
  return (
    <section ref={drop.setNodeRef} className={`lane${drop.isOver ? ' over' : ''}`} style={{ ['--c' as string]: color }}>
      <button type="button" className="lane-head" onClick={() => setOpen(!open)} aria-expanded={open}>{title}<b>{people.length}</b></button>
      {open && <div className="lane-list">
        {people.length === 0 && <small className="muted">—</small>}
        {people.map(p => (
          <PersonChip key={p.id} person={p} highlight={hits.has(p.id)} onOpen={onOpen}
            drag={editable && (name === 'standby' || name === 'daysOff') ? { id: `col-person:${name}:${p.id}`, data: { person: p } } : undefined} />
        ))}
      </div>}
    </section>
  )
}
