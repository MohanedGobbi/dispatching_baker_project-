import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ArrowRight, CalendarClock, Repeat, UserMinus, UserCog } from 'lucide-react'
import { api, ApiError } from './api'
import { AssignPicker } from './assign'
import type { FreePerson, PickSeat, PickUnit } from './assign'
import { addDaysIso, Modal, RuleDialog, ViolationList } from './dialogs'
import { useStrictRules } from './hooks'
import type { BoardData, Person, Preview, Violation } from './types'

/** Someone holding a seat, as any screen that shows them knows it. */
export interface SeatHolderRef {
  assignmentId: string
  person: { id: string; name: string }
  seat: PickSeat
  unit: PickUnit
  /** Last day of their stretch on this seat (YYYY-MM-DD or ISO). */
  until: string
  /** No crew change date yet: `until` is only a placeholder far ahead. */
  openEnded?: boolean
  /** The planned end that passed while they were kept on the seat: the manager has to unassign them or set a date. */
  endPassed?: string | null
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10)
const errText = (e: unknown) => e instanceof ApiError ? e.message : String(e)

/** The small button shown next to a person on a seat. */
export function SeatActionsButton({ onClick, name }: { onClick: () => void; name: string }) {
  const { t } = useTranslation()
  return (
    <button type="button" className="seat-act" onClick={e => { e.stopPropagation(); onClick() }} onPointerDown={e => e.stopPropagation()}
      title={t('replaceOrUnassign', 'Replace or unassign')} aria-label={`${t('replaceOrUnassign', 'Replace or unassign')}: ${name}`}>
      <UserCog size={15} aria-hidden />
    </button>
  )
}

/**
 * Replace the person on a seat, or take them off it, from a chosen day (today by default).
 * The reason is optional and goes to the audit log. Rule checks are the same as for any assignment.
 */
export function SeatActionsDialog({ target, onClose, onDone }: { target: SeatHolderRef; onClose: () => void; onDone: (message: string) => void }) {
  const { t } = useTranslation()
  const until = target.until.slice(0, 10)
  const today = isoDay(new Date())
  const [from, setFrom] = useState(today > until ? until : today)
  const [reason, setReason] = useState('')
  const [step, setStep] = useState<'choose' | 'pick' | 'confirm'>('choose')
  const [free, setFree] = useState<FreePerson[] | null>(null)
  const [next, setNext] = useState<Person | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const seatLabel = `${target.unit.code} · ${target.seat.position} #${target.seat.index}`
  const badDate = !from || from > until
  const open = !!target.openEnded
  const untilText = open ? t('noChangeYet', 'no crew change date yet') : `${t('until', 'until')} ${until}`
  // The crew change: the day after their last day on the seat, or not decided yet.
  const [change, setChange] = useState(open ? addDaysIso(today, 28) : addDaysIso(until, 1))
  const [rule, setRule] = useState<Violation[] | null>(null)
  const setEnd = async (body: { end: string } | { openEnded: true }, overrideReason?: string) => {
    await api(`/assignments/${target.assignmentId}/move`, { method: 'PUT', body: { ...body, overrideReason } })
    onDone(`${target.person.name}: ${'end' in body ? `${t('crewChange', 'crew change')} ${addDaysIso(body.end, 1)}` : t('noChangeYet', 'no crew change date yet')}`)
  }
  const saveChange = async (body: { end: string } | { openEnded: true }) => {
    setBusy(true); setError('')
    try { await setEnd(body); onClose() } catch (e) {
      if (e instanceof ApiError && e.status === 422) setRule((e.body as { violations?: Violation[] }).violations ?? [])
      else setError(errText(e))
      setBusy(false)
    }
  }

  // People free on the chosen day, for the picker's "everyone" list.
  useEffect(() => {
    if (step !== 'pick') return
    let live = true
    setFree(null)
    api<BoardData>(`/board?date=${from}`)
      .then(b => { if (live) setFree([...(b.columns.standby ?? []).map(p => ({ ...p, status: 'STANDBY' })), ...(b.columns.daysOff ?? []).map(p => ({ ...p, status: 'DAYS_OFF' }))]) })
      .catch(() => { if (live) setFree([]) })
    return () => { live = false }
  }, [step, from])

  const unassign = async () => {
    setBusy(true); setError('')
    try {
      const r = await api<{ replacementTask: unknown }>(`/assignments/${target.assignmentId}/unassign`, { method: 'POST', body: { from, reason: reason.trim() || undefined } })
      onDone(`${target.person.name} ${t('offSeat', 'is off')} ${seatLabel}${r.replacementTask ? ` · ${t('taskOpened', 'a replacement task was opened')}` : ''}`)
      onClose()
    } catch (e) { setError(errText(e)); setBusy(false) }
  }

  if (step === 'pick') {
    if (!free) return <Modal title={t('replaceTitle', 'Who replaces')} onClose={onClose}><p className="muted">{t('loading', 'Loading…')}</p></Modal>
    return (
      <AssignPicker seat={target.seat} unit={target.unit} date={from} fixedEnd={until} fixedOpen={open} free={free} exclude={target.person.id}
        title={`${t('whoReplaces', 'Who replaces')} ${target.person.name}?`}
        onClose={() => setStep('choose')} onPick={p => { setNext(p); setStep('confirm') }} />
    )
  }
  if (step === 'confirm' && next) {
    return <ReplaceConfirm target={target} next={next} from={from} until={until} reason={reason} setReason={setReason}
      onBack={() => setStep('pick')} onClose={onClose} onDone={onDone} />
  }
  if (rule) {
    return <RuleDialog title={t('ccMoveAnyway', 'Move the crew change anyway?')} violations={rule} summary={<><strong>{target.person.name}</strong> · {seatLabel} · {t('crewChange', 'crew change')} {change}</>}
      onClose={onClose} onConfirm={reason2 => setEnd({ end: addDaysIso(change, -1) }, reason2)} />
  }

  return (
    <Modal title={`${t('replaceOrUnassign', 'Replace or unassign')}: ${target.person.name}`} onClose={onClose}>
      <div className="move-line"><strong>{target.person.name}</strong><ArrowRight size={16} aria-hidden /><span>{seatLabel}</span><span className="muted">{untilText}</span></div>
      {target.endPassed && <p className="note"><AlertTriangle size={14} aria-hidden /> {t('endPassedNote', 'Their stay was planned to end on')} {target.endPassed}. {t('endPassedNote2', 'They stay on the seat until you unassign them or set a new date.')}</p>}
      <div className="cc-set">
        <CalendarClock size={15} aria-hidden />
        <label>{t('crewChange', 'Crew change')}<input type="date" value={change} min={today} onChange={e => e.target.value && setChange(e.target.value)} /></label>
        <button type="button" className="primary" disabled={busy || (!open && change === addDaysIso(until, 1))} onClick={() => void saveChange({ end: addDaysIso(change, -1) })}>{t('setDate', 'Set date')}</button>
        {!open && <button type="button" disabled={busy} onClick={() => void saveChange({ openEnded: true })}>{t('notDecided', 'Not decided yet')}</button>}
      </div>
      <div className="dates">
        <label>{t('fromDay', 'From')}<input type="date" value={from} max={until} onChange={e => setFrom(e.target.value)} /></label>
      </div>
      <label className="reason">{t('reasonOptional', 'Reason (optional, kept in the audit log)')}
        <input value={reason} onChange={e => setReason(e.target.value)} placeholder={t('reasonPh', 'e.g. sent home sick, needed on another unit')} />
      </label>
      <p className="muted" style={{ margin: '4px 0 0' }}>
        {t('unassignNote2', 'Unassign takes them off the seat from that day; if the seat is required, a replacement task opens for the empty days. Replace hands the seat to someone else from that day')} {untilText}.
      </p>
      {badDate && <p className="error">{t('dateAfterEnd', 'Pick a day on or before')} {until}.</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <footer>
        <button type="button" onClick={onClose}>{t('cancel', 'Cancel')}</button>
        <button type="button" className="danger" disabled={busy || badDate} onClick={unassign}><UserMinus size={15} aria-hidden /> {t('unassign', 'Unassign')}</button>
        <button type="button" className="primary" disabled={busy || badDate} onClick={() => setStep('pick')}><Repeat size={15} aria-hidden /> {t('replace', 'Replace…')}</button>
      </footer>
    </Modal>
  )
}

function ReplaceConfirm({ target, next, from, until, reason, setReason, onBack, onClose, onDone }: {
  target: SeatHolderRef; next: Person; from: string; until: string; reason: string; setReason: (s: string) => void
  onBack: () => void; onClose: () => void; onDone: (message: string) => void
}) {
  const { t } = useTranslation()
  const [preview, setPreview] = useState<Preview | null>(null)
  const [override, setOverride] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let live = true
    api<Preview>('/assignments/preview', { method: 'POST', body: { employeeId: next.id, seatId: target.seat.seatId, start: from, ...(target.openEnded ? { openEnded: true } : { end: until }), replacesId: target.assignmentId } })
      .then(p => { if (live) setPreview(p) })
      .catch(e => { if (live) setError(errText(e)) })
    return () => { live = false }
  }, [next.id, target.seat.seatId, target.assignmentId, from, until])

  const strict = useStrictRules()
  const broken = !!preview && preview.hard > 0
  const needsOverride = broken && (strict || preview.violations.some(v => v.rule === 'double_booking'))
  const crew = preview?.crews[0]
  const confirm = async () => {
    setBusy(true); setError('')
    try {
      await api(`/assignments/${target.assignmentId}/replace`, { method: 'POST', body: { employeeId: next.id, from, reason: reason.trim() || undefined, overrideReason: broken ? override.trim() || undefined : undefined } })
      onDone(`${next.name} ${t('replacesShort', 'replaces')} ${target.person.name} · ${target.unit.code} · ${target.seat.position} #${target.seat.index}`)
      onClose()
    } catch (e) { setError(errText(e)); setBusy(false) }
  }

  return (
    <Modal title={t('replaceConfirm', 'Replace on this seat?')} onClose={onClose}>
      <div className="move-line">
        <span className="muted">{target.person.name}</span><ArrowRight size={16} aria-hidden /><strong>{next.name}</strong>
        <span>{target.unit.code} · {target.seat.position} #{target.seat.index}</span>
      </div>
      <p className="muted" style={{ margin: 0 }}>{from} → {target.openEnded ? t('noChangeYet', 'no crew change date yet') : until}</p>
      {!preview && !error && <p className="muted">{t('checking', 'Checking the rules…')}</p>}
      {preview && <>
        <h3>{t('impact', 'What would happen')}</h3>
        {crew && <p className="crew-line">{crew.unitCode}: {crew.before.filled}/{crew.before.required} <ArrowRight size={13} aria-hidden /> <strong>{crew.after.filled}/{crew.after.required}</strong> {t('crewFilled', 'required seats filled')}</p>}
        <ViolationList violations={preview.violations} />
        {broken && (
          <label className="reason">{needsOverride ? t('overrideReason', 'Reason to override the rules') : t('overrideNote', 'Note (optional): why you are going ahead')}
            <input value={override} onChange={e => setOverride(e.target.value)} placeholder={t('overridePlaceholder', 'e.g. urgent job start, senior arrives day 3')} autoFocus />
          </label>
        )}
      </>}
      <label className="reason">{t('reasonOptional', 'Reason (optional, kept in the audit log)')}
        <input value={reason} onChange={e => setReason(e.target.value)} />
      </label>
      {error && <p className="error" role="alert">{error}</p>}
      <footer>
        <button type="button" onClick={onBack}>{t('back', 'Back')}</button>
        <button type="button" className="primary" disabled={busy || !preview || (needsOverride && !override.trim())} onClick={confirm}>
          {broken ? t('replaceAnyway', 'Replace anyway') : t('replaceDo', 'Replace')}
        </button>
      </footer>
    </Modal>
  )
}
