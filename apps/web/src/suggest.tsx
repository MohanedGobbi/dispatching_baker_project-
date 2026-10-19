import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiError } from './api'
import { Modal, ViolationList } from './dialogs'
import { errMsg, useApi } from './hooks'
import { fmtDate, RULE_LABEL } from './labels'
import type { Violation } from './types'

export interface Suggestions {
  seat: string; from: string; to: string; validCandidates: number
  candidates: { employeeId: string; score: number; explanation: string; employee?: string }[]
  ruledOut: { employeeId: string; employee?: string; because: string[] }[]
}

/**
 * The best people for one seat and span, each with a one-line reason (plan 15.5 "fill one seat", 27.4 explanation line),
 * and a short list of who was ruled out and why. Choosing someone whose rules are broken asks for an override reason.
 */
export function SuggestDialog({ title, seatId, start, end, onPick, onClose }: {
  title: string; seatId: string; start: string; end: string
  onPick: (employeeId: string, overrideReason?: string) => Promise<void>
  onClose: () => void
}) {
  const { t, i18n } = useTranslation()
  const { data, error, loading } = useApi<Suggestions>(`/planning/seats/${seatId}/suggestions?start=${start}&end=${end}&top=6`)
  const [busy, setBusy] = useState('')
  const [blocked, setBlocked] = useState<{ id: string; name: string; violations: Violation[] } | null>(null)
  const [reason, setReason] = useState('')
  const [fail, setFail] = useState('')

  const pick = async (id: string, name: string, overrideReason?: string) => {
    setBusy(id); setFail('')
    try { await onPick(id, overrideReason); onClose() } catch (e) {
      if (e instanceof ApiError && e.status === 422) {
        setBlocked({ id, name, violations: (e.body as { violations?: Violation[] }).violations ?? [] })
      } else setFail(errMsg(e))
      setBusy('')
    }
  }

  return (
    <Modal title={title} onClose={onClose}>
      <p className="muted">{data?.seat} · {fmtDate(start, i18n.language)} → {fmtDate(end, i18n.language)}</p>
      {loading && <p className="muted">{t('checking', 'Checking the rules…')}</p>}
      {error && <p className="error">{error}</p>}
      {blocked ? (
        <>
          <p><strong>{blocked.name}</strong> {t('breaksRules', 'would break these rules:')}</p>
          <ViolationList violations={blocked.violations} />
          <label className="reason">{t('overrideReason', 'Reason to override the rules')}
            <input value={reason} onChange={e => setReason(e.target.value)} autoFocus />
          </label>
          {fail && <p className="error" role="alert">{fail}</p>}
          <footer>
            <button type="button" onClick={() => setBlocked(null)}>{t('back', 'Back')}</button>
            <button type="button" className="primary" disabled={!reason.trim() || !!busy} onClick={() => void pick(blocked.id, blocked.name, reason.trim())}>{t('proceed', 'Proceed anyway')}</button>
          </footer>
        </>
      ) : data && (
        <>
          {data.candidates.length === 0 && <p className="empty-note">{t('noCandidates', 'Nobody can take this seat for these days without breaking a rule.')}</p>}
          <ul className="cand-list">
            {data.candidates.map((c, i) => (
              <li key={c.employeeId}>
                <div>
                  <strong>{i === 0 ? '★ ' : ''}{c.employee}</strong>
                  <small className="why">{c.explanation}</small>
                </div>
                <button type="button" className={i === 0 ? 'primary' : ''} disabled={!!busy} onClick={() => void pick(c.employeeId, c.employee ?? '')}>{t('choose', 'Choose')}</button>
              </li>
            ))}
          </ul>
          {fail && <p className="error" role="alert">{fail}</p>}
          {data.ruledOut.length > 0 && (
            <details className="ruled-out">
              <summary>{t('ruledOut', 'Ruled out')} ({data.ruledOut.length}{data.validCandidates ? '' : '+'})</summary>
              <ul>{data.ruledOut.map(r => <li key={r.employeeId}><strong>{r.employee}</strong> — {r.because.map(b => RULE_LABEL[b] ?? b).join(', ')}</li>)}</ul>
              <small className="muted">{t('ruledOutHint', 'Someone ruled out only for being on days off or on leave can still be chosen by hand with a reason: pick a name from the board instead.')}</small>
            </details>
          )}
        </>
      )}
    </Modal>
  )
}
