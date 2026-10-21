import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { CalendarOff, CalendarRange, HeartPulse, Pencil, Timer, User } from 'lucide-react'
import { api, ApiError } from './api'
import { Modal } from './dialogs'
import { errMsg, useApi } from './hooks'
import { PersonForm } from './personform'
import { useProfiles } from './profiles'
import { QuickCtx } from './quickctx'
import { useToast } from './ui'

const DAY = 86_400_000
const isoDay = (d: Date) => d.toISOString().slice(0, 10)
const today = () => isoDay(new Date())
const plus = (iso: string, n: number) => isoDay(new Date(Date.parse(iso) + n * DAY))

export interface Pattern { id: string; name: string; type: string; daysOn: number | null; daysOff: number | null; weeklyMask: string | null }
interface QuickPerson {
  id: string; firstName: string; lastName: string; backToBackId: string | null
  rotationPatternId: string | null; rotationAnchorDate: string | null; startState?: string | null
  assignments: { id: string; start: string; plannedEnd: string; status: string; seat: { unit: { code: string } | null } }[]
}

/** On or off on a day for a rotation pattern started on `anchor` (same rule as the API's isRotationOn). */
export function isOn(p: Pattern, anchor: string, day: string) {
  if (p.type === 'weekly') return (p.weeklyMask ?? '1111100')[new Date(day).getUTCDay()] === '1'
  if (p.type !== 'cycle') return true
  const on = p.daysOn ?? 28, cycle = on + (p.daysOff ?? 28)
  const diff = Math.round((Date.parse(day) - Date.parse(anchor)) / DAY)
  return ((diff % cycle) + cycle) % cycle < on
}

/** A row of small squares: working (filled) or off, from today, so a rotation can be checked at a glance. */
export function RotationStrip({ pattern, anchor, days = 56 }: { pattern: Pattern | undefined; anchor: string; days?: number }) {
  if (!pattern || !anchor) return <span className="muted">—</span>
  const start = today()
  return (
    <span className="rot-strip" aria-label="Next weeks, working days filled">
      {Array.from({ length: days }, (_, i) => { const d = plus(start, i); const on = isOn(pattern, anchor, d); return <i key={d} className={on ? 'on' : ''} title={`${d}: ${on ? 'working' : 'off'}`} /> })}
    </span>
  )
}

/** The next change for a rotation: "on until 12 Nov" or "off until 3 Dec, back on 4 Dec". */
export function rotationNow(p: Pattern | undefined, anchor: string | null) {
  if (!p || !anchor || p.type !== 'cycle') return null
  const t = today(); const on = isOn(p, anchor, t)
  let d = t; for (let i = 0; i < 400 && isOn(p, anchor, d) === on; i++) d = plus(d, 1)
  return { on, until: plus(d, -1), next: d }
}

type Dialog = { kind: 'medical' | 'leave' | 'extend' | 'rotation' | 'edit'; person: QuickPerson }

/** Quick actions for a person: a menu at the pointer, and the small dialogs it opens. Wraps the whole app. */
export function QuickProvider({ children }: { children: ReactNode }) {
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const open = useCallback((id: string, at: { x: number; y: number }) => setMenu({ id, ...at }), [])
  return (
    <QuickCtx.Provider value={open}>
      {children}
      {menu && <QuickMenu {...menu} onClose={() => setMenu(null)} onPick={d => { setMenu(null); setDialog(d) }} />}
      {dialog?.kind === 'medical' && <LeaveDialog person={dialog.person} medical onClose={() => setDialog(null)} />}
      {dialog?.kind === 'leave' && <LeaveDialog person={dialog.person} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'extend' && <ExtendDialog person={dialog.person} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'rotation' && <RotationDialog person={dialog.person} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'edit' && <PersonForm id={dialog.person.id} onClose={() => setDialog(null)} onDone={() => setDialog(null)} />}
    </QuickCtx.Provider>
  )
}

function QuickMenu({ id, x, y, onClose, onPick }: { id: string; x: number; y: number; onClose: () => void; onPick: (d: Dialog) => void }) {
  const { t } = useTranslation()
  const { openPerson } = useProfiles()
  const p = useApi<QuickPerson>(`/employees/${id}`)
  const box = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  useLayoutEffect(() => {
    const el = box.current; if (!el) return
    const r = el.getBoundingClientRect()
    setPos({ left: Math.max(8, Math.min(x, innerWidth - r.width - 8)), top: Math.max(8, Math.min(y, innerHeight - r.height - 8)) })
  }, [x, y, p.data])
  useEffect(() => {
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) onClose() }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    const t0 = setTimeout(() => { document.addEventListener('mousedown', away); document.addEventListener('contextmenu', away) })
    window.addEventListener('keydown', key, true); window.addEventListener('scroll', onClose, true)
    return () => { clearTimeout(t0); document.removeEventListener('mousedown', away); document.removeEventListener('contextmenu', away); window.removeEventListener('keydown', key, true); window.removeEventListener('scroll', onClose, true) }
  }, [onClose])
  useEffect(() => { box.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus() }, [p.data])

  const person = p.data
  const seat = person ? currentSeat(person) : undefined
  const item = (Icon: typeof User, label: string, hint: string, run: () => void, disabled = false) => (
    <button type="button" role="menuitem" disabled={disabled || !person} onClick={run}><Icon size={15} aria-hidden /><span><b>{label}</b><small>{hint}</small></span></button>
  )
  return (
    <div ref={box} className="quick-menu" role="menu" style={pos} aria-label={t('quickActions', 'Quick actions')}>
      <header>{person ? `${person.firstName} ${person.lastName}` : '…'}</header>
      {item(User, t('openProfile', 'Open profile'), t('qmProfile', 'Schedule, history, details'), () => { onClose(); openPerson(id) })}
      {item(Pencil, t('editDetails', 'Edit details'), t('qmEdit', 'Name, rank, phone, partner'), () => onPick({ kind: 'edit', person: person! }))}
      {item(CalendarRange, t('workDays', 'Work and days off'), t('qmRotation', 'Rotation and first day of work'), () => onPick({ kind: 'rotation', person: person! }))}
      <hr />
      {item(HeartPulse, t('medicalLeave', 'Medical leave'), t('qmMedical', 'Off sick from / to'), () => onPick({ kind: 'medical', person: person! }))}
      {item(CalendarOff, t('daysOffLeave', 'Leave or extra days off'), t('qmLeave', 'Annual, recovery, exceptional…'), () => onPick({ kind: 'leave', person: person! }))}
      {item(Timer, t('extendWork', 'Extend days of work'), seat ? `${t('qmOn', 'On')} ${seat.seat.unit?.code ?? ''} ${t('until', 'until')} ${seat.plannedEnd.slice(0, 10)}` : t('qmNoSeat', 'Only when on a unit'), () => onPick({ kind: 'extend', person: person! }), !seat)}
    </div>
  )
}

const currentSeat = (p: QuickPerson) => p.assignments
  .filter(a => ['ACTIVE', 'CONFIRMED'].includes(a.status) && a.plannedEnd.slice(0, 10) >= today())
  .sort((a, b) => a.start.localeCompare(b.start))[0]

function LeaveDialog({ person, medical, onClose }: { person: QuickPerson; medical?: boolean; onClose: () => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const types = useApi<{ id: string; name: string; category: string }[]>('/catalogs/leave-types')
  const options = (types.data ?? []).filter(x => (medical ? x.category === 'medical' : x.category !== 'medical' && x.category !== 'absence'))
  const [typeId, setTypeId] = useState('')
  const [from, setFrom] = useState(today())
  const [to, setTo] = useState(plus(today(), medical ? 2 : 6))
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (!typeId && options.length) setTypeId(options[0].id) }, [options, typeId])
  const days = Math.round((Date.parse(to) - Date.parse(from)) / DAY) + 1
  const save = async () => {
    setBusy(true)
    try {
      const r = await api<{ effects: { released: { taskId?: string | null }[] } | null; warnings: string[] }>('/leaves', { method: 'POST', body: { employeeId: person.id, typeId, start: from, end: to, notes: notes.trim() || undefined } })
      const extra = [...r.warnings, r.effects?.released.length ? `${t('seatFreed', 'seat freed')}` : ''].filter(Boolean).join(' · ')
      toast(`${person.firstName} ${person.lastName}: ${options.find(o => o.id === typeId)?.name ?? ''} ${from} → ${to}${extra ? ` · ${extra}` : ''}`); onClose()
    } catch (e) { toast(errMsg(e), 'error'); setBusy(false) }
  }
  return (
    <Modal title={`${medical ? t('medicalLeave', 'Medical leave') : t('daysOffLeave', 'Leave or extra days off')} · ${person.firstName} ${person.lastName}`} onClose={onClose}>
      <div className="form2">
        {!medical && <label>{t('leaveType', 'Type')}<select value={typeId} onChange={e => setTypeId(e.target.value)}>{options.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label>}
        <div className="row2">
          <label>{t('from', 'From')}<input type="date" value={from} onChange={e => { setFrom(e.target.value); if (e.target.value > to) setTo(e.target.value) }} autoFocus /></label>
          <label>{t('until', 'Until')} ({days} {t('daysLc', 'days')})<input type="date" value={to} min={from} onChange={e => setTo(e.target.value)} /></label>
        </div>
        <div className="quick-days">{[1, 3, 7, 14, 28].map(n => <button key={n} type="button" onClick={() => setTo(plus(from, n - 1))}>{n} {t('daysLc', 'days')}</button>)}</div>
        <label>{t('notes', 'Notes')}<input value={notes} onChange={e => setNotes(e.target.value)} placeholder={medical ? t('medNotePh', 'Private: only you see it') : ''} /></label>
        <p className="muted" style={{ margin: 0 }}>{t('leaveFrees', 'If they are on a seat in these days, the seat is freed and shows up in the replacement center.')}</p>
        <footer>
          <button type="button" onClick={onClose}>{t('cancel', 'Cancel')}</button>
          <button type="button" className="primary" disabled={busy || !typeId || to < from} onClick={() => void save()}>{t('save', 'Save')}</button>
        </footer>
      </div>
    </Modal>
  )
}

const EXT_REASONS: [string, string][] = [['no_replacement', 'No replacement'], ['urgent_job', 'Urgent job'], ['replacement_late', 'Replacement arriving late'], ['medical_replacement', 'Covering a sick colleague'], ['other', 'Other']]

function ExtendDialog({ person, onClose }: { person: QuickPerson; onClose: () => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const seat = currentSeat(person)
  const [days, setDays] = useState(3)
  const [reason, setReason] = useState('no_replacement')
  const [problem, setProblem] = useState<{ breaches?: string[]; successor?: string; extId: string } | null>(null)
  const [busy, setBusy] = useState(false)
  if (!seat) return null
  const end = plus(seat.plannedEnd.slice(0, 10), days)
  const approve = async (extId: string, opts: { overrideReason?: string; shiftSuccessor?: boolean }) => {
    try {
      await api(`/extensions/${extId}/approve`, { method: 'POST', body: opts })
      toast(`${person.firstName} ${person.lastName} ${t('extendedTo', 'stays until')} ${end}`); onClose()
    } catch (e) {
      if (e instanceof ApiError && e.status === 422) setProblem({ extId, breaches: (e.body as { breaches?: string[] }).breaches ?? [] })
      else if (e instanceof ApiError && e.status === 409 && /takes over/.test(e.message)) setProblem({ extId, successor: e.message })
      else { toast(errMsg(e), 'error'); setBusy(false) }
    }
  }
  const start = async () => {
    setBusy(true)
    try {
      const r = await api<{ extension: { id: string } }>('/extensions', { method: 'POST', body: { assignmentId: seat.id, days, reason } })
      await approve(r.extension.id, {})
    } catch (e) { toast(errMsg(e), 'error'); setBusy(false) }
  }
  return (
    <Modal title={`${t('extendWork', 'Extend days of work')} · ${person.firstName} ${person.lastName}`} onClose={onClose}>
      <div className="form2">
        <p style={{ margin: 0 }}>{seat.seat.unit?.code} · {t('until', 'until')} <b>{seat.plannedEnd.slice(0, 10)}</b> → <b>{end}</b></p>
        {problem?.breaches ? (
          <>
            <ul className="violations hard-list">{problem.breaches.map((b, i) => <li key={i}>{b}</li>)}</ul>
            <footer><button type="button" onClick={onClose}>{t('cancel', 'Cancel')}</button><button type="button" className="primary" onClick={() => void approve(problem.extId, { overrideReason: 'Extended by the manager' })}>{t('extendAnyway', 'Extend anyway')}</button></footer>
          </>
        ) : problem?.successor ? (
          <>
            <p className="note">{problem.successor.replace(/; set shiftSuccessor.*/, '')}.</p>
            <footer><button type="button" onClick={onClose}>{t('cancel', 'Cancel')}</button><button type="button" className="primary" onClick={() => void approve(problem.extId, { shiftSuccessor: true })}>{t('delayNext', 'Delay their start')}</button></footer>
          </>
        ) : (
          <>
            <div className="row2">
              <label>{t('extDays', 'Extra days')}<input type="number" min={1} max={30} value={days} onChange={e => setDays(Math.max(1, Math.min(30, +e.target.value || 1)))} autoFocus /></label>
              <label>{t('reason', 'Reason')}<select value={reason} onChange={e => setReason(e.target.value)}>{EXT_REASONS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            </div>
            <div className="quick-days">{[1, 3, 7, 14].map(n => <button key={n} type="button" className={days === n ? 'on' : ''} onClick={() => setDays(n)}>+{n}</button>)}</div>
            <p className="muted" style={{ margin: 0 }}>{t('extOwed', 'The extra days are owed back as rest.')}</p>
            <footer><button type="button" onClick={onClose}>{t('cancel', 'Cancel')}</button><button type="button" className="primary" disabled={busy} onClick={() => void start()}>{t('extNow', 'Extend')}</button></footer>
          </>
        )}
      </div>
    </Modal>
  )
}

/** Rotation for one person: the pattern and the first day of a work stretch; optionally the partner starts when they go off. */
export function RotationDialog({ person, onClose, onDone }: { person: QuickPerson; onClose: () => void; onDone?: () => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const patterns = useApi<Pattern[]>('/catalogs/rotation-patterns')
  const partner = useApi<{ id: string; firstName: string; lastName: string }>(person.backToBackId ? `/employees/${person.backToBackId}` : null)
  const [patternId, setPatternId] = useState(person.rotationPatternId ?? '')
  const [anchor, setAnchor] = useState(person.rotationAnchorDate?.slice(0, 10) ?? '')
  const [pairUp, setPairUp] = useState(!!person.backToBackId)
  const [startState, setStartState] = useState(person.startState ?? 'STANDBY')
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (!patternId && patterns.data?.length) setPatternId(patterns.data.find(p => p.name === '28/28')?.id ?? patterns.data[0].id) }, [patterns.data, patternId])
  const p = patterns.data?.find(x => x.id === patternId)
  const now = rotationNow(p, anchor || null)
  const partnerAnchor = p?.type === 'cycle' && anchor ? plus(anchor, p.daysOn ?? 28) : null
  const save = async () => {
    setBusy(true)
    try {
      await api(`/employees/${person.id}`, { method: 'PUT', body: { rotationPatternId: patternId || null, rotationAnchorDate: anchor || null, ...(anchor ? {} : { startState }) } })
      if (pairUp && person.backToBackId && partnerAnchor) await api(`/employees/${person.backToBackId}`, { method: 'PUT', body: { rotationPatternId: patternId, rotationAnchorDate: partnerAnchor } })
      toast(`${person.firstName} ${person.lastName}: ${t('rotationSaved', 'rotation saved')}`); onDone?.(); onClose()
    } catch (e) { toast(errMsg(e), 'error'); setBusy(false) }
  }
  return (
    <Modal title={`${t('workDays', 'Work and days off')} · ${person.firstName} ${person.lastName}`} onClose={onClose}>
      <div className="form2">
        <div className="row2">
          <label>{t('rotation', 'Rotation')}<select value={patternId} onChange={e => setPatternId(e.target.value)}>{patterns.data?.map(x => <option key={x.id} value={x.id}>{x.name}{x.type === 'cycle' ? ` (${x.daysOn} on, ${x.daysOff} off)` : ''}</option>)}</select></label>
          <label>{t('firstDayOn', 'First day of a work stretch')}<input type="date" value={anchor} onChange={e => setAnchor(e.target.value)} autoFocus /></label>
        </div>
        <div className="quick-days">
          <button type="button" onClick={() => setAnchor(today())} title={t('startsTodayHint', 'They go back to work today: counting starts now')}>{t('startsToday', 'Starts today')}</button>
          {p?.type === 'cycle' && <button type="button" onClick={() => setAnchor(plus(today(), -(p.daysOn ?? 28)))}>{t('offToday', 'Goes off today')}</button>}
          {anchor && <><button type="button" onClick={() => setAnchor(plus(anchor, -7))}>−7 {t('d', 'd')}</button><button type="button" onClick={() => setAnchor(plus(anchor, -1))}>−1</button><button type="button" onClick={() => setAnchor(plus(anchor, 1))}>+1</button><button type="button" onClick={() => setAnchor(plus(anchor, 7))}>+7 {t('d', 'd')}</button></>}
          {anchor && <button type="button" onClick={() => setAnchor('')}>{t('clear', 'Clear')}</button>}
        </div>
        {!anchor && (
          <label>{t('rightNow', 'Right now')}
            <span className="now-pick">
              <button type="button" className={startState !== 'DAYS_OFF' ? 'on' : ''} aria-pressed={startState !== 'DAYS_OFF'} onClick={() => setStartState('STANDBY')}>{t('working', 'Working')}</button>
              <button type="button" className={startState === 'DAYS_OFF' ? 'on' : ''} aria-pressed={startState === 'DAYS_OFF'} onClick={() => setStartState('DAYS_OFF')}>{t('daysOff', 'Days off')}</button>
            </span>
          </label>
        )}
        {anchor ? <>
          <RotationStrip pattern={p} anchor={anchor} />
          {now && <p style={{ margin: 0 }}>{now.on ? t('workingUntil', 'Working until') : t('offUntil', 'Off until')} <b>{now.until}</b>, {now.on ? t('offFrom', 'off from') : t('backOn', 'back on')} <b>{now.next}</b>.</p>}
        </> : <p className="muted" style={{ margin: 0 }}>{t('noAnchor2', 'Until a first day of work is known, this mark is what the board shows. Press "Starts today" on the day they go back to work (or "Goes off today" when they finish) and the system takes over from there.')}</p>}
        {person.backToBackId && partnerAnchor && (
          <label className="check"><input type="checkbox" checked={pairUp} onChange={e => setPairUp(e.target.checked)} /> {t('partnerOpposite', 'Partner')} {partner.data ? `${partner.data.firstName} ${partner.data.lastName}` : ''} {t('partnerStarts', 'works the opposite stretches (starts')} {partnerAnchor})</label>
        )}
        <footer>
          <button type="button" onClick={onClose}>{t('cancel', 'Cancel')}</button>
          <button type="button" className="primary" disabled={busy || !patternId} onClick={() => void save()}>{t('save', 'Save')}</button>
        </footer>
      </div>
    </Modal>
  )
}

export type { QuickPerson }
