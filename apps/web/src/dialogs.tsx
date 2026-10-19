import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ArrowRight, X } from 'lucide-react'
import { api, ApiError } from './api'
import type { Person, Preview, SeatCard, UnitCardData, Violation } from './types'

const DAY = 86_400_000
export const addDaysIso = (iso: string, n: number) => new Date(Date.parse(iso) + n * DAY).toISOString().slice(0, 10)

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="modal-back" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <header><h2>{title}</h2><button type="button" aria-label="Close" onClick={onClose}><X size={18} /></button></header>
        {children}
      </div>
    </div>
  )
}

export function ViolationList({ violations }: { violations: Violation[] }) {
  if (violations.length === 0) return <p className="ok-line">No rule is broken.</p>
  const hard = violations.filter(v => v.severity === 'hard'), soft = violations.filter(v => v.severity === 'soft')
  return (
    <div className="violations">
      {hard.length > 0 && <ul className="hard">{hard.map((v, i) => <li key={i}><AlertTriangle size={14} aria-hidden /> {v.message}</li>)}</ul>}
      {soft.length > 0 && <ul className="soft">{soft.map((v, i) => <li key={i}><AlertTriangle size={14} aria-hidden /> {v.message}</li>)}</ul>}
    </div>
  )
}

/** A person is dropped on a seat: show what would happen first, then save. */
export function AssignDialog({ person, seat, unit, date, transferFrom, onClose, onDone }: {
  person: Person; seat: SeatCard; unit: UnitCardData; date: string
  transferFrom?: { assignmentId: string; label: string }
  onClose: () => void
  onDone: (text: string, undo?: () => Promise<void>) => void
}) {
  const { t } = useTranslation()
  const [end, setEnd] = useState(addDaysIso(date, 27))
  const [preview, setPreview] = useState<Preview | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [shortened, setShortened] = useState<string | null>(null)

  useEffect(() => {
    if (end < date) return
    let live = true
    setPreview(null)
    api<Preview>('/assignments/preview', { method: 'POST', body: { employeeId: person.id, seatId: seat.seatId, start: date, end, ignoreAssignmentId: transferFrom?.assignmentId } })
      .then(p => {
        if (!live) return
        // The seat is empty today but someone returns to it later: shorten the stretch instead of failing.
        if (p.seatTaken && p.freeUntil && p.freeUntil >= date && p.freeUntil < end) { setShortened(p.freeUntil); setEnd(p.freeUntil); return }
        setPreview(p)
      })
      .catch(e => { if (live) setError(e instanceof ApiError ? e.message : String(e)) })
    return () => { live = false }
  }, [person.id, seat.seatId, date, end, transferFrom?.assignmentId])

  const needsReason = !!preview && preview.hard > 0
  const crew = preview?.crews[0]
  const confirm = async () => {
    setBusy(true); setError('')
    try {
      // A move is one atomic request: if the new placement is refused nothing is released.
      const r = transferFrom
        ? await api<{ assignment: { id: string } }>(`/assignments/${transferFrom.assignmentId}/transfer`, { method: 'POST', body: { seatId: seat.seatId, start: date, end, overrideReason: needsReason ? reason.trim() : undefined } })
        : await api<{ assignment: { id: string } }>('/assignments', { method: 'POST', body: { employeeId: person.id, seatId: seat.seatId, start: date, end, overrideReason: needsReason ? reason.trim() : undefined } })
      onDone(`${person.name} → ${unit.code} · ${seat.position} #${seat.index}`, transferFrom ? undefined : async () => {
        await api(`/assignments/${r.assignment.id}/unassign`, { method: 'POST', body: { from: date, reason: 'Undone' } })
      })
      onClose()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e)); setBusy(false)
    }
  }

  return (
    <Modal title={transferFrom ? t('moveSeat', 'Move to another seat') : t('assignSeat', 'Assign to seat')} onClose={onClose}>
      <div className="move-line">
        <strong>{person.name}</strong>
        {transferFrom && <><span className="muted">{transferFrom.label}</span><ArrowRight size={16} aria-hidden /></>}
        {!transferFrom && <ArrowRight size={16} aria-hidden />}
        <strong>{unit.code} · {seat.position} #{seat.index}</strong>
      </div>
      <div className="dates">
        <label>{t('from', 'From')}<input type="date" value={date} disabled /></label>
        <label>{t('until', 'Until')}<input type="date" value={end} min={date} onChange={e => setEnd(e.target.value)} /></label>
      </div>
      {shortened && <p className="note">{t('shortened', 'The seat is free until')} {shortened}: {t('shortenedWhy', 'someone else takes it after that, so the end date was shortened.')}</p>}
      {!preview && !error && <p className="muted">{t('checking', 'Checking the rules…')}</p>}
      {preview?.seatTaken && <p className="error">{preview.seatTaken}</p>}
      {preview && <>
        <h3>{t('impact', 'What would happen')}</h3>
        {crew && <p className="crew-line">{crew.unitCode}: {crew.before.filled}/{crew.before.required} <ArrowRight size={13} aria-hidden /> <strong>{crew.after.filled}/{crew.after.required}</strong> {t('crewFilled', 'required seats filled')}</p>}
        <ViolationList violations={preview.violations} />
        {needsReason && (
          <label className="reason">{t('overrideReason', 'Reason to override the rules')}
            <input value={reason} onChange={e => setReason(e.target.value)} placeholder={t('overridePlaceholder', 'e.g. urgent job start, senior arrives day 3')} autoFocus />
          </label>
        )}
      </>}
      {error && <p className="error" role="alert">{error}</p>}
      <footer>
        <button type="button" onClick={onClose}>{t('cancel', 'Cancel')}</button>
        <button type="button" className="primary" disabled={busy || !preview || !!preview.seatTaken || (needsReason && !reason.trim())} onClick={confirm}>
          {needsReason ? t('assignAnyway', 'Assign anyway') : t('assignConfirm', 'Assign')}
        </button>
      </footer>
    </Modal>
  )
}

/** A swap or other change the rules refused: show why and let someone with a reason force it. */
export function RuleDialog({ title, summary, violations, onClose, onConfirm }: {
  title: string; summary: ReactNode; violations: Violation[]; onClose: () => void; onConfirm: (reason: string) => Promise<void>
}) {
  const { t } = useTranslation()
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return (
    <Modal title={title} onClose={onClose}>
      <div className="move-line">{summary}</div>
      <ViolationList violations={violations} />
      <label className="reason">{t('overrideReason', 'Reason to override the rules')}
        <input value={reason} onChange={e => setReason(e.target.value)} autoFocus />
      </label>
      {error && <p className="error" role="alert">{error}</p>}
      <footer>
        <button type="button" onClick={onClose}>{t('cancel', 'Cancel')}</button>
        <button type="button" className="primary" disabled={busy || !reason.trim()} onClick={async () => {
          setBusy(true); setError('')
          try { await onConfirm(reason.trim()); onClose() } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); setBusy(false) }
        }}>{t('proceed', 'Proceed anyway')}</button>
      </footer>
    </Modal>
  )
}
