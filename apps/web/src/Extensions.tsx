import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Timer } from 'lucide-react'
import { PageGuide } from './guide'
import { api, ApiError } from './api'
import { useAuth } from './auth'
import { Modal } from './dialogs'
import { errMsg, useApi, useLive } from './hooks'
import { fmtDate } from './labels'
import { Pill, useToast } from './ui'
import { PersonLink, UnitLink } from './profiles'

interface Ext {
  id: string; days: number; reason: string; status: string; acknowledgedAt: string | null; overrideReason: string | null; createdAt: string
  employee: { id: string; firstName: string; lastName: string; employeeNo: string }
  assignment: { start: string; plannedEnd: string; seat: { unit: { code: string } | null; base: { code: string } | null } }
}
interface Asg { id: string; start: string; plannedEnd: string; employee: { firstName: string; lastName: string }; seat: { position: { name: string }; unit: { code: string } | null; base: { code: string } | null } }
const REASONS: [string, string][] = [['no_replacement', 'No replacement available'], ['urgent_job', 'Urgent job'], ['replacement_late', 'Replacement is late'], ['medical_replacement', 'Replacing someone medically absent'], ['other', 'Other']]
const reasonLabel = (r: string) => REASONS.find(x => x[0] === r)?.[1] ?? r
const SEV = { REQUESTED: 'warn', APPROVED: 'ok', REJECTED: 'bad' } as const

/** Extensions (plan 13): request, approve with an override reason when limits are exceeded, balances and reports. */
export default function Extensions() {
  const { t, i18n } = useTranslation()
  const { can } = useAuth()
  const toast = useToast()
  const [tab, setTab] = useState<'requests' | 'balances' | 'report'>('requests')
  const [status, setStatus] = useState('')
  const [creating, setCreating] = useState(false)
  const [deciding, setDeciding] = useState<{ ext: Ext; breaches?: string[]; reject?: boolean } | null>(null)
  const [adjusting, setAdjusting] = useState<{ id: string; name: string } | null>(null)
  const [groupBy, setGroupBy] = useState('reason')
  const list = useApi<{ items: Ext[] }>(tab === 'requests' ? `/extensions?limit=100${status ? `&status=${status}` : ''}` : null)
  const balances = useApi<{ id: string; firstName: string; lastName: string; employeeNo: string; homeBase: { code: string }; balance: number }[]>(tab === 'balances' ? '/extensions/balances' : null)
  const report = useApi<{ key: string; count: number; days: number }[]>(tab === 'report' ? `/extensions/report?groupBy=${groupBy}` : null)
  useLive(() => { void list.reload() })
  const approver = can('SUPER_ADMIN', 'OPS_MANAGER')
  const requester = can('SUPER_ADMIN', 'OPS_MANAGER', 'DISPATCHER', 'BASE_MANAGER', 'CHIEF_OF_UNIT')

  const approve = async (ext: Ext, overrideReason?: string, shiftSuccessor?: boolean) => {
    try {
      await api(`/extensions/${ext.id}/approve`, { method: 'POST', body: { overrideReason, shiftSuccessor } })
      toast(t('extApproved', 'Extension approved')); setDeciding(null); await list.reload()
    } catch (e) {
      if (e instanceof ApiError && e.status === 422) { const b = (e.body as { breaches?: string[] } | undefined)?.breaches ?? []; setDeciding({ ext, breaches: b }); return }
      if (e instanceof ApiError && e.status === 409 && /takes over/.test(e.message)) { setDeciding({ ext, breaches: [e.message] }); return }
      toast(errMsg(e), 'error')
    }
  }

  return (
    <main className="page wide">
      <PageGuide id="extensions" Icon={Timer} color="#ea580c" title={t('extTitle', 'Extensions')}
        purpose={t('extPurpose', 'Keeping someone on a unit past the planned end. Every extra day is owed back to them as rest.')}
        steps={[
          t('exStep1', 'A dispatcher or chief requests extra days and says why.'),
          t('exStep2', 'The operations manager approves; beyond the limits a reason is required.'),
          t('exStep3', '"Rest balances" shows who is owed the most rest, so their relief comes first.'),
        ]}>
        {requester && <button type="button" className="primary" onClick={() => setCreating(true)}><Plus size={15} aria-hidden /> {t('extNew', 'Request extension')}</button>}
      </PageGuide>
      <div className="subtabs" role="tablist">
        {(['requests', 'balances', 'report'] as const).map(k => <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{t(`ext_${k}`, { requests: 'Requests', balances: 'Rest balances', report: 'Report' }[k])}</button>)}
      </div>

      {tab === 'requests' && (
        <>
          <div className="filters"><select value={status} onChange={e => setStatus(e.target.value)} aria-label="Status"><option value="">{t('allStatuses', 'All')}</option><option value="REQUESTED">Requested</option><option value="APPROVED">Approved</option><option value="REJECTED">Rejected</option></select></div>
          {list.error && <div className="banner error" role="alert">{list.error}</div>}
          <table className="table">
            <thead><tr><th>{t('person', 'Person')}</th><th>{t('seat', 'Seat')}</th><th>{t('days', 'days')}</th><th>{t('reason', 'Reason')}</th><th>{t('status', 'Status')}</th><th /></tr></thead>
            <tbody>
              {list.data?.items.map(x => (
                <tr key={x.id}>
                  <th scope="row"><PersonLink id={x.employee.id}>{x.employee.firstName} {x.employee.lastName}</PersonLink><br /><small className="muted">{x.employee.employeeNo}</small></th>
                  <td>{x.assignment.seat.unit ? <UnitLink code={x.assignment.seat.unit.code} /> : x.assignment.seat.base?.code}<br /><small className="muted">{fmtDate(x.assignment.start, i18n.language)} – {fmtDate(x.assignment.plannedEnd, i18n.language)}</small></td>
                  <td>+{x.days}</td><td>{reasonLabel(x.reason)}{x.overrideReason && <><br /><small className="muted">{x.overrideReason}</small></>}</td>
                  <td><Pill severity={SEV[x.status as keyof typeof SEV] ?? 'info'}>{x.status.toLowerCase()}</Pill>{x.status === 'APPROVED' && !x.acknowledgedAt && <small className="muted"> · {t('extWaitingAck', 'not yet acknowledged')}</small>}</td>
                  <td className="row-actions">{approver && x.status === 'REQUESTED' && <><button type="button" onClick={() => approve(x)}>{t('approve', 'Approve')}</button><button type="button" onClick={() => setDeciding({ ext: x, reject: true })}>{t('reject', 'Reject')}</button></>}</td>
                </tr>
              ))}
              {list.data?.items.length === 0 && <tr><td colSpan={6} className="muted">{t('extNone', 'No extension requests.')}</td></tr>}
            </tbody>
          </table>
        </>
      )}

      {tab === 'balances' && (
        <section className="panel">
          <h2>{t('extBalances', 'Who is owed rest')}</h2>
          <table className="table"><thead><tr><th>{t('person', 'Person')}</th><th>{t('base', 'Base')}</th><th>{t('extOwed', 'Days owed')}</th><th /></tr></thead>
            <tbody>
              {balances.data?.map(b => <tr key={b.id}><th scope="row"><PersonLink id={b.id}>{b.firstName} {b.lastName}</PersonLink> <small className="muted">{b.employeeNo}</small></th><td>{b.homeBase.code}</td><td><Pill severity={b.balance >= 8 ? 'bad' : b.balance >= 5 ? 'warn' : 'info'}>{b.balance}</Pill></td>
                <td className="row-actions">{approver && <button type="button" onClick={() => setAdjusting({ id: b.id, name: `${b.firstName} ${b.lastName}` })}>{t('extAdjust', 'Adjust')}</button>}</td></tr>)}
              {balances.data?.length === 0 && <tr><td colSpan={4} className="muted">{t('anNobody', 'Nobody is owed rest days.')}</td></tr>}
            </tbody></table>
        </section>
      )}

      {tab === 'report' && (
        <section className="panel">
          <div className="filters"><label>{t('extGroup', 'Group by')} <select value={groupBy} onChange={e => setGroupBy(e.target.value)}>{['reason', 'base', 'employee', 'month'].map(g => <option key={g} value={g}>{g}</option>)}</select></label></div>
          <table className="table"><thead><tr><th>{groupBy}</th><th>{t('extCount', 'Extensions')}</th><th>{t('days', 'days')}</th></tr></thead>
            <tbody>{report.data?.map(r => <tr key={r.key}><th scope="row">{groupBy === 'reason' ? reasonLabel(r.key) : r.key}</th><td>{r.count}</td><td>{r.days}</td></tr>)}</tbody></table>
        </section>
      )}

      {creating && <RequestDialog onClose={() => setCreating(false)} onDone={() => { setCreating(false); void list.reload() }} />}
      {deciding && <DecideDialog {...deciding} onClose={() => setDeciding(null)} onApprove={(reason, shift) => approve(deciding.ext, reason, shift)} onDone={() => { setDeciding(null); void list.reload() }} />}
      {adjusting && <AdjustDialog who={adjusting} onClose={() => setAdjusting(null)} onDone={() => { setAdjusting(null); void balances.reload() }} />}
    </main>
  )
}

function RequestDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { t, i18n } = useTranslation()
  const toast = useToast()
  const asg = useApi<{ items: Asg[] }>('/assignments?status=ACTIVE&limit=200')
  const [id, setId] = useState(''); const [days, setDays] = useState(3); const [reason, setReason] = useState('no_replacement')
  const items = (asg.data?.items ?? []).filter(a => a.seat.position.name !== 'Mechanic')
  const submit = async () => {
    try {
      const r = await api<{ needsOverride: boolean; breaches: string[] }>('/extensions', { method: 'POST', body: { assignmentId: id, days, reason } })
      toast(r.needsOverride ? `${t('extSent', 'Request sent')} · ${r.breaches.join('; ')}` : t('extSent', 'Request sent')); onDone()
    } catch (e) { toast(errMsg(e), 'error') }
  }
  return (
    <Modal title={t('extNew', 'Request extension')} onClose={onClose}>
      <div className="form">
        <label>{t('person', 'Person')}<select value={id} onChange={e => setId(e.target.value)}><option value="">–</option>{items.map(a => <option key={a.id} value={a.id}>{a.employee.firstName} {a.employee.lastName} · {a.seat.unit?.code ?? a.seat.base?.code} · {t('until', 'until')} {fmtDate(a.plannedEnd, i18n.language)}</option>)}</select></label>
        <label>{t('extDays', 'Extra days')}<input type="number" min={1} max={30} value={days} onChange={e => setDays(+e.target.value)} /></label>
        <label>{t('reason', 'Reason')}<select value={reason} onChange={e => setReason(e.target.value)}>{REASONS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <div className="actions"><button type="button" onClick={onClose}>{t('cancel', 'Cancel')}</button><button type="button" className="primary" disabled={!id} onClick={submit}>{t('send', 'Send')}</button></div>
      </div>
    </Modal>
  )
}

function DecideDialog({ ext, breaches, reject, onClose, onApprove, onDone }: { ext: Ext; breaches?: string[]; reject?: boolean; onClose: () => void; onApprove: (reason: string, shift: boolean) => void; onDone: () => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const [reason, setReason] = useState(''); const [shift, setShift] = useState(false)
  const submitReject = async () => {
    try { await api(`/extensions/${ext.id}/reject`, { method: 'POST', body: { reason } }); toast(t('extRejected', 'Request rejected')); onDone() } catch (e) { toast(errMsg(e), 'error') }
  }
  const takeover = breaches?.some(b => /takes over/.test(b))
  return (
    <Modal title={reject ? t('extReject', 'Reject request') : t('extOverride', 'Approve beyond the limits')} onClose={onClose}>
      <div className="form">
        <p>{ext.employee.firstName} {ext.employee.lastName} · +{ext.days} {t('days', 'days')}</p>
        {breaches && breaches.length > 0 && <ul className="problem-list">{breaches.map(b => <li key={b}>{b}</li>)}</ul>}
        {takeover && <label className="check-row"><input type="checkbox" checked={shift} onChange={e => setShift(e.target.checked)} /> {t('extShift', "Delay the incoming person's start")}</label>}
        <label>{reject ? t('reason', 'Reason') : t('overrideReason', 'Override reason')}<textarea value={reason} onChange={e => setReason(e.target.value)} rows={3} /></label>
        <div className="actions"><button type="button" onClick={onClose}>{t('cancel', 'Cancel')}</button>
          {reject ? <button type="button" className="primary" disabled={!reason.trim()} onClick={submitReject}>{t('reject', 'Reject')}</button>
            : <button type="button" className="primary" disabled={!takeover && !reason.trim()} onClick={() => onApprove(reason, shift)}>{t('approve', 'Approve')}</button>}</div>
      </div>
    </Modal>
  )
}

function AdjustDialog({ who, onClose, onDone }: { who: { id: string; name: string }; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const [days, setDays] = useState(-1); const [note, setNote] = useState('')
  const submit = async () => { try { await api('/extensions/balance-adjust', { method: 'POST', body: { employeeId: who.id, days, note } }); toast(t('updated', 'Updated')); onDone() } catch (e) { toast(errMsg(e), 'error') } }
  return (
    <Modal title={`${t('extAdjust', 'Adjust')} · ${who.name}`} onClose={onClose}>
      <div className="form">
        <label>{t('extAdjDays', 'Days (negative = rest taken)')}<input type="number" value={days} onChange={e => setDays(+e.target.value)} /></label>
        <label>{t('note', 'Note')}<textarea value={note} onChange={e => setNote(e.target.value)} rows={2} /></label>
        <div className="actions"><button type="button" onClick={onClose}>{t('cancel', 'Cancel')}</button><button type="button" className="primary" disabled={!note.trim() || !days} onClick={submit}>{t('save', 'Save')}</button></div>
      </div>
    </Modal>
  )
}
