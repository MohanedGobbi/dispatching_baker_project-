import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, ApiError } from './api'
import { addDaysIso, Modal, RuleDialog } from './dialogs'
import { errMsg } from './hooks'
import { fmtDate } from './labels'
import type { Violation } from './types'
import { useToast } from './ui'

/** A crew change as the crew-change list gives it: the day someone leaves a seat and/or someone arrives. */
export interface ChangeRow {
  date: string; seatId: string; seat: string; unitId: string | null; unitCode: string | null
  outgoing: { id: string; name: string } | null; incoming: { id: string; name: string } | null
}

/**
 * Move a crew change to another day. `rows` are the handovers on that day the dialog can move together (the whole
 * unit); `only` narrows the default to one seat, with a box to take the rest of the unit along.
 */
export function CrewChangeDialog({ rows, only, onClose, onDone }: { rows: ChangeRow[]; only?: string; onClose: () => void; onDone: () => void }) {
  const { t, i18n } = useTranslation()
  const toast = useToast()
  const from = rows[0]?.date ?? ''
  const [to, setTo] = useState(from)
  const [all, setAll] = useState(!only)
  const [busy, setBusy] = useState(false)
  const [rule, setRule] = useState<Violation[] | null>(null)
  const picked = all || !only ? rows : rows.filter(r => r.seatId === only)
  const unit = rows[0]?.unitCode
  const send = async (overrideReason?: string) => {
    const r = await api<{ moved: number; seats: number }>('/assignments/crew-change', { method: 'POST', body: { seatIds: picked.map(x => x.seatId), from, to, overrideReason } })
    toast(`${t('ccMoved', 'Crew change moved to')} ${fmtDate(to, i18n.language)} · ${r.seats} ${r.seats === 1 ? t('seatLc', 'seat') : t('seatsLc', 'seats')}`); onDone()
  }
  const save = async () => {
    setBusy(true)
    try { await send(); onClose() } catch (e) {
      if (e instanceof ApiError && e.status === 422) setRule((e.body as { violations?: Violation[] }).violations ?? [])
      else toast(errMsg(e), 'error')
      setBusy(false)
    }
  }
  if (!rows.length) return null
  if (rule) return <RuleDialog title={t('ccMoveAnyway', 'Move the crew change anyway?')} violations={rule} summary={<>{fmtDate(from, i18n.language)} → <strong>{fmtDate(to, i18n.language)}</strong></>} onClose={onClose} onConfirm={send} />
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000)
  return (
    <Modal title={`${t('ccChangeDate', 'Change the crew change date')}${unit ? ` · ${unit}` : ''}`} onClose={onClose}>
      <div className="form2">
        <div className="row2">
          <label>{t('ccNow', 'Now')}<input type="date" value={from} disabled /></label>
          <label>{t('ccNew', 'New date')}{days ? ` (${days > 0 ? '+' : ''}${days} ${t('d', 'd')})` : ''}<input type="date" value={to} onChange={e => e.target.value && setTo(e.target.value)} autoFocus /></label>
        </div>
        <div className="quick-days">{[-7, -1, 1, 7].map(n => <button key={n} type="button" onClick={() => setTo(addDaysIso(to, n))}>{n > 0 ? '+' : '−'}{Math.abs(n)} {t('d', 'd')}</button>)}</div>
        <ul className="cc-moves">
          {picked.map(r => (
            <li key={r.seatId}><strong>{r.seat}</strong>: {r.outgoing ? `${r.outgoing.name} ${t('ccLeaves', 'leaves')}` : ''}{r.outgoing && r.incoming ? ', ' : ''}{r.incoming ? `${r.incoming.name} ${t('ccArrives', 'arrives')}` : ''}{!r.incoming && r.outgoing ? ` (${t('nobodyComing', 'nobody coming yet')})` : ''}</li>
          ))}
        </ul>
        {only && rows.length > 1 && <label className="check"><input type="checkbox" checked={all} onChange={e => setAll(e.target.checked)} /> {t('ccWholeUnit', 'The whole crew on')} {unit ?? t('thisUnit', 'this unit')} ({rows.length} {t('seatsLc', 'seats')})</label>}
        <p className="muted" style={{ margin: 0 }}>{t('ccHint', 'Whoever leaves on that day stays until the day before the new date, and whoever arrives starts on it. Everyone involved is told.')}</p>
        <footer>
          <button type="button" onClick={onClose}>{t('cancel', 'Cancel')}</button>
          <button type="button" className="primary" disabled={busy || to === from} onClick={() => void save()}>{t('save', 'Save')}</button>
        </footer>
      </div>
    </Modal>
  )
}
