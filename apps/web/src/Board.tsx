import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DndContext, DragOverlay, KeyboardSensor, MouseSensor, TouchSensor, useDroppable, useSensor, useSensors } from '@dnd-kit/core'
import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core'
import {
  AlertTriangle, CalendarClock, Plus, CheckCircle2, ChevronLeft, ChevronRight, Eye, EyeOff, LayoutGrid, Monitor, PieChart, Repeat,
  Search, Truck, UserPlus, Users, Wrench, X,
} from 'lucide-react'
import { api, ApiError, subscribeChanges } from './api'
import type { BoardData, Person, SeatCard, UnitCardData, Violation } from './types'
import { PersonChip, SeverityBadge, STATUS_META, useToast } from './ui'
import { AssignDialog, RuleDialog, addDaysIso } from './dialogs'
import { AssignPicker } from './assign'
import { SeatActionsButton, SeatActionsDialog } from './seatactions'
import type { SeatHolderRef } from './seatactions'
import type { FreePerson } from './assign'
import { BASE_COLORS, Donut, Legend, PageGuide, Ring } from './guide'
import { useProfiles } from './profiles'
import { AddUnitDialog, NewJobDialog } from './unitforms'
import { go } from './hooks'
import { useRanks } from './personform'

type StateFilter = 'all' | 'attention' | 'bad' | 'ok' | 'idle'
interface DragPayload { person: Person; seatId?: string; assignmentId?: string; until?: string; openEnded?: boolean }
type Pending =
  | { kind: 'assign'; person: Person; seat: SeatCard; unit: UnitCardData; transferFrom?: { assignmentId: string; label: string }; end?: string | null }
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
  const toast = useToast()

  const [date, setDate] = useState(todayIso())
  const [baseId, setBaseId] = useState('')
  const [kind, setKind] = useState<'' | 'OH' | 'CH'>('')
  const [stateF, setStateF] = useState<StateFilter>('all')
  const [lane, setLane] = useState('')
  const [search, setSearch] = useState('')
  const [q, setQ] = useState('')
  const [data, setData] = useState<BoardData | null>(null)
  const [error, setError] = useState('')
  const [tv, setTv] = useState(() => { try { return localStorage.getItem('crewboard.board.tv') === 'on' } catch { return false } })
  const [rankF, setRankF] = useState('')
  const [showPeople, setShowPeople] = useState(true)
  const [now, setNow] = useState(() => new Date())
  const { openPerson, openUnit } = useProfiles()
  const { ranks } = useRanks()
  const setDrawer = openPerson
  const [creating, setCreating] = useState<'' | 'unit' | 'job'>('')
  const [pending, setPending] = useState<Pending | null>(null)
  const [picking, setPicking] = useState<{ seat: SeatCard; unit: UnitCardData } | null>(null)
  const [acting, setActing] = useState<SeatHolderRef | null>(null)
  const [dragging, setDragging] = useState<DragPayload | null>(null)
  const [overview, setOverview] = useState(() => { try { return localStorage.getItem('crewboard.board.overview') !== 'hidden' } catch { return true } })
  const searchRef = useRef<HTMLInputElement>(null)
  const lanesRef = useRef<HTMLElement>(null)

  const readOnly = !!data?.past || data?.layer === 'draft'

  // ---- data
  const load = useCallback(async () => {
    const p = new URLSearchParams({ date, view: 'all' })
    if (q) p.set('q', q)
    try { setData(await api<BoardData>(`/board?${p}`)); setError('') } catch (e) { setError(e instanceof ApiError ? e.message : String(e)) }
  }, [date, q])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const stop = subscribeChanges(() => { clearTimeout(timer); timer = setTimeout(() => { void load() }, 250) })
    return () => { stop(); clearTimeout(timer) }
  }, [load])
  useEffect(() => { const h = setTimeout(() => setQ(search.trim()), 300); return () => clearTimeout(h) }, [search])
  useEffect(() => { try { localStorage.setItem('crewboard.board.overview', overview ? 'shown' : 'hidden') } catch { /* private mode */ } }, [overview])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); searchRef.current?.focus() }
      // Escape leaves the whiteboard unless it is closing a dialog or a profile first.
      if (e.key === 'Escape' && !document.querySelector('.modal-back, .pp-back')) setTv(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  useEffect(() => { try { localStorage.setItem('crewboard.board.tv', tv ? 'on' : 'off') } catch { /* private mode */ } }, [tv])
  useEffect(() => {
    if (!tv) return
    const h = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(h)
  }, [tv])

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
          await api('/assignments', { method: 'POST', body: { employeeId: from.person.id, seatId: seat, start: date, ...(from.openEnded ? { openEnded: true } : { end: from.until }) } })
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
    return data.bases.filter(b => !baseId || b.id === baseId)
  }, [data, baseId])
  const dayLabel = data ? new Date(data.date).toLocaleDateString(i18n.language, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : ''

  if (!data && !error) return <div className="loading">{t('loading', 'Loading the board…')}</div>
  const s = data?.summary
  const deployed = data?.units.filter(u => !isIdle(u)) ?? []
  const attention = deployed.filter(u => u.state === 'warn' || u.state === 'bad').length
  const openTasks = s ? Object.values(s.openReplacementTasks).reduce((a, b) => a + b, 0) : 0
  const critical = s?.openReplacementTasks.CRITICAL ?? 0
  const peopleSlices = s ? Object.entries(s.headcount).filter(([, v]) => v > 0).map(([k, v]) => ({ key: k, value: v, color: STATUS_META[k]?.color ?? 'var(--muted)', label: STATUS_META[k]?.label ?? k })) : []
  // Whiteboard: everyone on the board, the rank highlight, and who sits in which column.
  const everyone: Person[] = data ? [...data.units.flatMap(u => u.seats.flatMap(x => (x.holder ? [x.holder] : []))), ...Object.values(data.columns).flat()] : []
  const boardHits = rankF ? new Set(everyone.filter(p => p.rank === rankF).map(p => p.id)) : hits
  const baseCode = data?.bases.find(b => b.id === baseId)?.code
  const inLane = (p: Person) => (!rankF || p.rank === rankF) && (!baseCode || p.base === baseCode) && (!q || hits.has(p.id))
  const column = (...keys: string[]) => keys.flatMap(k => (data?.columns[k] as Person[] | undefined) ?? []).filter(inLane)
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
              t('boardStep3', 'Click the charts or the coloured chips to filter. Click a name to see that person\'s details.'),
              t('boardStep4', 'Click a unit\'s coloured header for its details: jobs, crew history, maintenance. From there you can send it to the workshop with a note, or give it a job.'),
              t('boardStep5', '"New job" sends a unit to a well; "Add a unit" registers a new truck. Change the date to look ahead or back in time.'),
            ]}>
            {<button type="button" className="primary" onClick={() => setCreating('job')}><Plus size={15} aria-hidden /> {t('newJob', 'New job')}</button>}
            <button type="button" onClick={() => setCreating('unit')}><Truck size={15} aria-hidden /> {t('addUnit', 'Add a unit')}</button>
            <button type="button" onClick={() => setOverview(!overview)}>{overview ? <EyeOff size={15} aria-hidden /> : <Eye size={15} aria-hidden />} {overview ? t('hideOverview', 'Hide overview') : t('showOverview', 'Show overview')}</button>
            <button type="button" title={t('tvMode', 'TV mode')} onClick={() => setTv(true)}><Monitor size={15} aria-hidden /> {t('tvShort', 'TV')}</button>
          </PageGuide>
        )}

        {!tv && (
          <div className="bd-toolbar">
            <span className="dates">
              <button type="button" aria-label="Previous day" onClick={() => setDate(addDaysIso(date, -1))}><ChevronLeft size={16} /></button>
              <input type="date" value={date} onChange={e => e.target.value && setDate(e.target.value)} aria-label="Date" />
              <button type="button" aria-label="Next day" onClick={() => setDate(addDaysIso(date, 1))}><ChevronRight size={16} /></button>
              <button type="button" onClick={() => setDate(todayIso())}>{t('today', 'Today')}</button>
              <button type="button" onClick={() => setDate(addDaysIso(todayIso(), 7))}>{t('nextWeek', 'In a week')}</button>
            </span>
            <span className="spacer" />
            <span className="search"><Search size={14} aria-hidden /><input ref={searchRef} value={search} onChange={e => setSearch(e.target.value)} placeholder={`${t('search', 'Find a person or unit')} (Ctrl+K)`} aria-label="Search" /></span>
          </div>
        )}

        {tv && data && (
          <header className="wb-head">
            <div className="wb-title">
              <img src="/icon.svg" alt="" aria-hidden width={30} height={30} />
              <strong>CrewBoard</strong>
              <span>{dayLabel}</span>
              <b className="wb-clock">{now.toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' })}</b>
            </div>
            <div className="wb-stats">
              <span><b>{deployed.length}</b> {t('onJob', 'on a job')}</span>
              <span><b>{data.units.length - deployed.length}</b> {t('atBase', 'at base')}</span>
              <span><b>{column('standby').length}</b> {t('free', 'free')}</span>
              {attention > 0 && <span className="bad"><b>{attention}</b> {t('needAttention', 'need attention')}</span>}
            </div>
            <span className="dates">
              <button type="button" aria-label="Previous day" onClick={() => setDate(addDaysIso(date, -1))}><ChevronLeft size={16} /></button>
              <input type="date" value={date} onChange={e => e.target.value && setDate(e.target.value)} aria-label="Date" />
              <button type="button" aria-label="Next day" onClick={() => setDate(addDaysIso(date, 1))}><ChevronRight size={16} /></button>
              {date !== todayIso() && <button type="button" onClick={() => setDate(todayIso())}>{t('today', 'Today')}</button>}
            </span>
            <span className="search"><Search size={14} aria-hidden /><input ref={searchRef} value={search} onChange={e => setSearch(e.target.value)} placeholder={`${t('search', 'Find a person or unit')} (Ctrl+K)`} aria-label="Search" />{search && <button type="button" className="clear" aria-label="Clear search" onClick={() => setSearch('')}><X size={14} /></button>}</span>
            <button type="button" className={showPeople ? 'on' : ''} aria-pressed={showPeople} onClick={() => setShowPeople(!showPeople)}><Users size={16} aria-hidden /> {t('people', 'People')}</button>
            <button type="button" onClick={() => setTv(false)} aria-label="Leave the whiteboard"><X size={16} aria-hidden /> {t('exit', 'Exit')}</button>
          </header>
        )}

        {data?.past && <div className="banner history">{t('historyBanner', 'History: this is how the board looked on')} {dayLabel}. {t('readOnly', 'Read only.')}</div>}
        {data?.layer === 'draft' && <div className="banner draft">{t('draftBanner', 'Draft plan layer: proposed people are dashed. Nothing here is live until the plan is published.')}</div>}
        {error && <div className="banner error" role="alert">{error}</div>}

        {data && s && !tv && (
          <section className="kpis2" aria-label="Today in numbers">
            <button type="button" className="kpi2" style={{ ['--c' as string]: 'var(--pal-blue-600)' }} onClick={() => setStateF('all')}>
              <Truck size={22} className="k-icon" aria-hidden /><strong>{deployed.length}</strong><span>{t('kpiDeployed', 'Units on a job')}</span><small>{data.units.length - deployed.length} {t('atBase', 'at base')}</small>
            </button>
            <button type="button" className={`kpi2${attention ? ' alert' : ''}`} style={{ ['--c' as string]: attention ? 'var(--pal-red-600)' : 'var(--pal-green-600)' }} onClick={() => setStateF(attention ? 'attention' : 'all')}>
              {attention ? <AlertTriangle size={22} className="k-icon" aria-hidden /> : <CheckCircle2 size={22} className="k-icon" aria-hidden />}
              <strong>{attention}</strong><span>{t('kpiAttention', 'Crews needing attention')}</span><small>{attention ? t('clickToSee', 'click to show them') : t('allCrewsOk', 'every crew follows the rules')}</small>
            </button>
            <button type="button" className={`kpi2${critical ? ' alert' : ''}`} style={{ ['--c' as string]: critical ? 'var(--pal-red-700)' : openTasks ? 'var(--pal-orange-600)' : 'var(--pal-green-600)' }} onClick={() => go('replacements')}>
              <Repeat size={22} className="k-icon" aria-hidden /><strong>{openTasks}</strong><span>{t('kpiTasks', 'Seats waiting for someone')}</span><small>{critical ? `${critical} ${t('critical', 'critical')} · ` : ''}{t('openCenter', 'open the replacement center')}</small>
            </button>
            <button type="button" className="kpi2" style={{ ['--c' as string]: 'var(--pal-teal-600)' }} onClick={() => go('crew-changes')}>
              <CalendarClock size={22} className="k-icon" aria-hidden /><strong>{s.crewChangesNext7Days}</strong><span>{t('kpiChanges', 'Crew changes this week')}</span><small>{t('seeList', 'see the list')}</small>
            </button>
          </section>
        )}

        {data && s && overview && !tv && (
          <section className="bd-overview" aria-label="Where everyone is">
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

        {data && (
          <div className={tv ? 'wb-filters' : 'card2'} style={{ gap: 8 }}>
            <div className="chips"><span className="chips-label">{t('fBase', 'Base')}</span>
              <button type="button" className={`fchip${!baseId ? ' on' : ''}`} style={{ ['--c' as string]: 'var(--pal-slate-700)' }} onClick={() => setBaseId('')}>{t('allBases', 'All bases')}</button>
              {data.bases.map(b => <button key={b.id} type="button" className={`fchip${baseId === b.id ? ' on' : ''}`} style={{ ['--c' as string]: colorOf(b.code) }} onClick={() => setBaseId(baseId === b.id ? '' : b.id)}><i />{b.code} <b>{data.units.filter(u => u.baseId === b.id).length}</b></button>)}
              <span className="chips-label" style={{ marginInlineStart: 10 }}>{t('fType', 'Type')}</span>
              {(['', 'OH', 'CH'] as const).map(k => <button key={k || 'all'} type="button" className={`fchip${kind === k ? ' on' : ''}`} style={{ ['--c' as string]: k === 'OH' ? 'var(--oh)' : k === 'CH' ? 'var(--ch)' : 'var(--pal-slate-700)' }} onClick={() => setKind(k)}>{k ? <><i />{k === 'OH' ? 'Open Hole' : 'Cased Hole'}</> : t('allTypes', 'All')}</button>)}
              <>
                <span className="chips-label" style={{ marginInlineStart: 10 }}>{t('fState', 'Crew')}</span>
                {([['all', 'Any', 'var(--pal-slate-700)'], ['attention', 'Needs attention', 'var(--pal-orange-600)'], ['bad', 'Rule broken', 'var(--pal-red-600)'], ['ok', 'All good', 'var(--pal-green-600)'], ['idle', 'No job', 'var(--pal-slate-500)']] as const).map(([k, l, c]) => (
                  <button key={k} type="button" className={`fchip${stateF === k ? ' on' : ''}`} style={{ ['--c' as string]: c }} onClick={() => setStateF(k)}>{k !== 'all' && <i />}{t(`fs_${k}`, l)}</button>
                ))}
              </>
              <span className="chips-label" style={{ marginInlineStart: 10 }}>{t('fRank', 'Rank')}</span>
              <button type="button" className={`fchip${!rankF ? ' on' : ''}`} style={{ ['--c' as string]: 'var(--pal-slate-700)' }} onClick={() => setRankF('')}>{t('anyRank', 'Any')}</button>
              {ranks.map(r => <button key={r.label} type="button" className={`fchip${rankF === r.label ? ' on' : ''}`} style={{ ['--c' as string]: r.position === 'Chief of Unit' ? 'var(--pal-violet-700)' : 'var(--pal-blue-700)' }} onClick={() => setRankF(rankF === r.label ? '' : r.label)}><i />{r.label} <b>{everyone.filter(p => p.rank === r.label).length}</b></button>)}
            </div>
          </div>
        )}

        {data && tv && (
          <div className={`wb-body${showPeople ? '' : ' solo'}`}>
            <div className="wb-units">
              {shownBases.map(b => {
                const units = data.units.filter(u => u.baseId === b.id && unitMatches(u))
                if (!units.length) return null
                return (
                  <section key={b.id} aria-label={b.name}>
                    {shownBases.length > 1 && <h2 className="wb-base" style={{ ['--c' as string]: colorOf(b.code) }}>{b.name}</h2>}
                    <div className="unit-grid">{units.map(u => <UnitCard key={u.id} unit={u} editable={!readOnly} hits={boardHits} onOpen={setDrawer} onUnit={() => openUnit(u.id)} onAssign={seat => setPicking({ seat, unit: u })} onAct={seat => seat.holder && setActing({ assignmentId: seat.holder.assignmentId, person: seat.holder, seat, unit: u, until: seat.holder.until, openEnded: seat.holder.openEnded, endPassed: seat.holder.endPassed })} />)}</div>
                  </section>
                )
              })}
              {!data.units.some(unitMatches) && <p className="empty-note">{t('noUnitsMatch', 'No unit matches.')}</p>}
            </div>
            {showPeople && (
              <aside className="wb-people" aria-label={t('peopleNotOnSeat', 'People not on a seat today')}>
                <Lane name="standby" title={t('col_standby', 'Free (standby)')} color={STATUS_META.STANDBY.color} people={column('standby')} hits={boardHits} editable={!readOnly} onOpen={setDrawer} />
                <Lane name="daysOff" title={t('col_daysOff', 'Days off')} color={STATUS_META.DAYS_OFF.color} people={column('daysOff')} hits={boardHits} editable={!readOnly} onOpen={setDrawer} />
                <Lane name="away" title={t('col_away', 'Away (leave, training, unavailable)')} color={STATUS_META.LEAVE.color} people={column('leave', 'unavailable', 'training', 'awaitingClearance')} hits={boardHits} editable={!readOnly} onOpen={setDrawer} />
                {!readOnly && <small className="muted">{t('wbHint', 'Drag a name onto a seat to assign it, or onto Free to take someone off. Click a name for the full profile.')}</small>}
              </aside>
            )}
          </div>
        )}

        {data && !tv && shownBases.map(b => {
          const units = data.units.filter(u => u.baseId === b.id && unitMatches(u))
          if (units.length === 0 && (baseId || stateF !== 'all' || kind || q)) return null
          const all = data.units.filter(u => u.baseId === b.id)
          return (
            <section key={b.id} className="base-sec" aria-label={b.name}>
              <div className="base-banner" style={{ ['--c' as string]: colorOf(b.code) }}>
                <h2>{b.code}</h2><span>{b.name}</span>
                <span className="bb-stats">
                  <em>{all.filter(u => !isIdle(u)).length} {t('onJob', 'on a job')}</em>
                  <em>{all.filter(u => !isIdle(u)).reduce((n, u) => n + u.crew.filled, 0)}/{all.filter(u => !isIdle(u)).reduce((n, u) => n + u.crew.required, 0)} {t('seatsFilled', 'seats filled')}</em>
                </span>
              </div>
              {units.length ? <div className="unit-grid">{units.map(u => <UnitCard key={u.id} unit={u} editable={!readOnly} hits={hits} onOpen={setDrawer} onUnit={() => openUnit(u.id)} onAssign={seat => setPicking({ seat, unit: u })} onAct={seat => seat.holder && setActing({ assignmentId: seat.holder.assignmentId, person: seat.holder, seat, unit: u, until: seat.holder.until, openEnded: seat.holder.openEnded, endPassed: seat.holder.endPassed })} />)}</div>
                : <p className="empty-note">{t('noUnits', 'No units based here.')}</p>}
            </section>
          )
        })}

        {data && !tv && (
          <section ref={lanesRef} aria-label="People not on a seat" className="base-sec">
            <div className="base-banner" style={{ ['--c' as string]: 'var(--pal-slate-700)' }}>
              <h2><Users size={18} aria-hidden /></h2><span>{t('peopleNotOnSeat', 'People not on a seat today')} · {t('dragHint', 'drag someone from standby onto a seat, or use Assign')}</span>
              {lane && <span className="bb-stats"><em style={{ cursor: 'pointer' }} onClick={() => setLane('')}>{t('showAllLanes', 'Show all')} ✕</em></span>}
            </div>
            <div className="lanes">
              {LANES.filter(([k]) => !lane || lane === k).filter(([k]) => ['standby', 'daysOff'].includes(k) || ((data.columns[k] as Person[] | undefined) ?? []).length > 0).map(([key, status, title]) => (
                <Lane key={key} name={key} title={t(`col_${key}`, title)} color={STATUS_META[status].color}
                  people={((data.columns[key] as Person[] | undefined) ?? []).filter(p => !baseId || p.base === data.bases.find(x => x.id === baseId)?.code)}
                  hits={hits} editable={!readOnly} onOpen={setDrawer} />
              ))}
            </div>
          </section>
        )}

        {creating === 'unit' && <AddUnitDialog onClose={() => setCreating('')} onDone={id => { void load(); openUnit(id) }} />}
        {creating === 'job' && <NewJobDialog onClose={() => setCreating('')} onDone={() => { void load() }} />}
        <DragOverlay>{dragging ? <div className="drag-ghost"><PersonChip person={dragging.person} compact /></div> : null}</DragOverlay>

        {picking && (
          <AssignPicker seat={picking.seat} unit={picking.unit} date={date} free={free} onClose={() => setPicking(null)}
            onPick={(p, end) => { const x = picking; setPicking(null); setPending({ kind: 'assign', person: p, seat: x.seat, unit: x.unit, end }) }} />
        )}
        {acting && <SeatActionsDialog target={acting} onClose={() => setActing(null)} onDone={text => { toast(text); void load() }} />}
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

function UnitCard({ unit, editable, hits, onOpen, onUnit, onAssign, onAct }: { unit: UnitCardData; editable: boolean; hits: Set<string>; onOpen: (id: string) => void; onUnit: () => void; onAssign: (s: SeatCard) => void; onAct: (s: SeatCard) => void }) {
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
          <small>{unit.job ? [unit.job.site, unit.job.well === unit.job.site ? null : unit.job.well, unit.job.rig].filter(Boolean).join(' · ') : unit.type}</small>
        </span>
      </header>
      <div className={`ucard-state sev-${sev}`}>
        {sev === 'ok' ? <CheckCircle2 size={14} aria-hidden /> : sev === 'info' ? <Wrench size={14} aria-hidden /> : <AlertTriangle size={14} aria-hidden />}
        {stateText}
        {unit.crewChange && <span className="cc"><CalendarClock size={13} aria-hidden /> {unit.crewChange.inDays === 0 ? t('ccToday', 'crew change today') : `${t('ccIn', 'crew change in')} ${unit.crewChange.inDays} ${t('d', 'd')}`}</span>}
      </div>
      {(problems.length > 0 || others.length > 0) && <div className="ucard-badges">{[...problems, ...others.filter(b => !/crew change/i.test(b.text))].map((b, n) => <SeverityBadge key={`${b.code}-${n}`} badge={b} />)}</div>}
      <div className="ucard-seats">
        {unit.seats.map(s => <Seat key={s.seatId} seat={s} unit={unit} editable={editable} hits={hits} onOpen={onOpen} onAssign={onAssign} onAct={onAct} />)}
      </div>
    </article>
  )
}

function Seat({ seat, unit, editable, hits, onOpen, onAssign, onAct }: { seat: SeatCard; unit: UnitCardData; editable: boolean; hits: Set<string>; onOpen: (id: string) => void; onAssign: (s: SeatCard) => void; onAct: (s: SeatCard) => void }) {
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
        ? <PersonChip person={seat.holder} highlight={hits.has(seat.holder.id)} onOpen={onOpen} draft={seat.holder.draft} onAct={editable && !seat.holder.draft ? () => onAct(seat) : undefined}
            drag={editable && !seat.holder.draft ? { id: `seat-person:${seat.seatId}`, data: { person: seat.holder, seatId: seat.seatId, assignmentId: seat.holder.assignmentId, until: seat.holder.until, openEnded: seat.holder.openEnded } } : undefined} />
        : editable
          ? <button type="button" className={`assign-btn${seat.required && !['AVAILABLE', 'UNDER_MAINTENANCE', 'OUT_OF_SERVICE'].includes(unit.status) ? ' req' : ''}`} onClick={() => onAssign(seat)}><UserPlus size={15} aria-hidden /> {t('assignSomeone', 'Assign someone')}</button>
          : <span className="empty-plain">{t('vacant', 'Empty')}</span>}
      <span className="seat-end">{editable && seat.holder && !seat.holder.draft && <SeatActionsButton name={seat.holder.name} onClick={() => onAct(seat)} />}{seat.issues.filter(i => i.code !== 'empty').map((i, n) => <span key={`${i.code}-${n}`} className={`issue sev-${i.severity}`} title={i.text}><AlertTriangle size={14} aria-label={i.text} /></span>)}</span>
    </div>
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
