import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CalendarDays, Plus } from 'lucide-react'
import { PageGuide } from './guide'
import { api } from './api'
import { Modal } from './dialogs'
import { errMsg, useApi, useDebounced, useLive } from './hooks'
import { fmtDate, plural } from './labels'
import { Pill, useToast } from './ui'
import { PersonLink } from './profiles'

interface LeaveRow {
  id: string; employeeId: string; start: string; end: string; status: string; longTerm: boolean
  type: { id: string; name: string; category: string }; decisionNote?: string | null
  employee: { id: string; firstName: string; lastName: string; homeBase: string }
}
interface Paged { total: number; items: LeaveRow[] }
interface QueueRow { leaveId: string; employee: { id: string; firstName: string; lastName: string; employeeNo: string; homeBase: { code: string } }; endedOn: string; waitingDays: number; leaveDays: number }
interface Overlap { week: string; base: string; profile: string; people: number }
interface LeaveType { id: string; name: string; category: string; needsDocument: boolean }
interface EmpHit { id: string; firstName: string; lastName: string; employeeNo: string; homeBase: { code: string } }

const days = (a: string, b: string) => Math.round((Date.parse(b.slice(0, 10)) - Date.parse(a.slice(0, 10))) / 86_400_000) + 1
const STATUS_SEV: Record<string, 'ok' | 'warn' | 'info' | 'bad'> = { SUBMITTED: 'warn', APPROVED: 'ok', RECORDED: 'ok', REJECTED: 'bad', CANCELLED: 'info' }
const STATUS_TEXT: Record<string, string> = { SUBMITTED: 'Waiting', APPROVED: 'Approved', RECORDED: 'Recorded', REJECTED: 'Rejected', CANCELLED: 'Cancelled' }

type Tab = 'requests' | 'all' | 'clearance' | 'overlaps'

export default function Leave() {
  const { t } = useTranslation()
  const [tab, setTab] = useState<Tab>('requests')
  const [creating, setCreating] = useState(false)

  return (
    <main className="page">
      <PageGuide id="leave" Icon={CalendarDays} color="var(--pal-purple-600)" title={t('leaveTitle', 'Leave')}
        purpose={t('leavePurpose', 'Leave requests to decide, who is away, and who must be cleared before working again.')}
        steps={[
          t('lvStep1', 'Approve or refuse requests. A warning shows when too many people of the same kind would be away at once.'),
          t('lvStep2', 'Approving frees the person\'s seat and opens a replacement task automatically.'),
          t('lvStep3', 'Medical leave is private: everyone else only sees "Unavailable".'),
          t('lvStep4', 'After a long medical leave the person waits here for clearance, possibly with limits such as "base posts only".'),
        ]}>
        <button type="button" className="primary" onClick={() => setCreating(true)}><Plus size={15} aria-hidden /> {t('newLeave', 'New leave')}</button>
      </PageGuide>
      <nav className="subtabs" aria-label="Leave sections">
        <button type="button" className={tab === 'requests' ? 'on' : ''} onClick={() => setTab('requests')}>{t('requests', 'Requests')}</button>
        <button type="button" className={tab === 'all' ? 'on' : ''} onClick={() => setTab('all')}>{t('allLeave', 'All leave')}</button>
        <button type="button" className={tab === 'clearance' ? 'on' : ''} onClick={() => setTab('clearance')}>{t('clearance', 'Fit-for-duty clearance')}</button>
        <button type="button" className={tab === 'overlaps' ? 'on' : ''} onClick={() => setTab('overlaps')}>{t('overlaps', 'Overlap warnings')}</button>
      </nav>
      {tab === 'requests' && <LeaveTable query="status=SUBMITTED" emptyText={t('noRequests', 'No requests are waiting.')} />}
      {tab === 'all' && <AllLeave />}
      {tab === 'clearance' && <Clearance />}
      {tab === 'overlaps' && <Overlaps />}
      {creating && <NewLeave onClose={() => setCreating(false)} />}
    </main>
  )
}

function AllLeave() {
  const { t } = useTranslation()
  const bases = useApi<{ id: string; code: string }[]>('/bases')
  const [status, setStatus] = useState('')
  const [baseId, setBaseId] = useState('')
  const [from, setFrom] = useState('')
  const query = [status && `status=${status}`, baseId && `baseId=${baseId}`, from && `from=${from}`].filter(Boolean).join('&')
  return (
    <>
      <div className="filters">
        <select value={status} onChange={e => setStatus(e.target.value)} aria-label="Status">
          <option value="">{t('anyStatus', 'Any status')}</option>
          {Object.entries(STATUS_TEXT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select value={baseId} onChange={e => setBaseId(e.target.value)} aria-label="Base">
          <option value="">{t('allBases', 'All bases')}</option>{bases.data?.map(b => <option key={b.id} value={b.id}>{b.code}</option>)}
        </select>
        <label>{t('endingAfter', 'Ending after')} <input type="date" value={from} onChange={e => setFrom(e.target.value)} /></label>
      </div>
      <LeaveTable query={query} emptyText={t('noLeave', 'No leave matches.')} />
    </>
  )
}

function LeaveTable({ query, emptyText }: { query: string; emptyText: string }) {
  const { t, i18n } = useTranslation()
  const toast = useToast()
  const list = useApi<Paged>(`/leaves?limit=100${query ? `&${query}` : ''}`)
  useLive(list.reload)
  const [rejecting, setRejecting] = useState<LeaveRow | null>(null)
  const [reason, setReason] = useState('')
  const [record, setRecord] = useState<{ documentUrl?: string; notes?: string } | null>(null)

  const act = async (path: string, body: unknown, ok: string) => {
    try { await api(path, { method: 'POST', body }); toast(ok); await list.reload() } catch (e) { toast(errMsg(e), 'error') }
  }
  const openRecord = async (id: string) => {
    try { setRecord(await api(`/leaves/${id}`)) } catch (e) { toast(errMsg(e), 'error') }
  }
  const rows = list.data?.items ?? []

  return (
    <>
      {list.error && <div className="banner error" role="alert">{list.error}</div>}
      {!list.loading && rows.length === 0 && <p className="empty-note">{emptyText}</p>}
      {rows.length > 0 && (
        <table className="table">
          <thead><tr><th>{t('person', 'Person')}</th><th>{t('type', 'Type')}</th><th>{t('dates', 'Dates')}</th><th>{t('status', 'Status')}</th><th /></tr></thead>
          <tbody>
            {rows.map(l => {
              const isMedical = l.type.category === 'medical'
              const mayDecide = l.status === 'SUBMITTED'
              return (
                <tr key={l.id}>
                  <td><strong><PersonLink id={l.employee.id}>{l.employee.firstName} {l.employee.lastName}</PersonLink></strong> <span className="muted">{l.employee.homeBase}</span></td>
                  <td>{l.type.name}{l.longTerm && <Pill severity="warn">{t('longTerm', 'long-term')}</Pill>}</td>
                  <td className="nowrap">{fmtDate(l.start, i18n.language)} → {fmtDate(l.end, i18n.language)} <span className="muted">· {plural(days(l.start, l.end), 'day')}</span></td>
                  <td><Pill severity={STATUS_SEV[l.status] ?? 'info'}>{STATUS_TEXT[l.status] ?? l.status}</Pill>{l.decisionNote && <small className="why">{l.decisionNote}</small>}</td>
                  <td className="row-actions end">
                    {mayDecide && <button type="button" className="primary" onClick={() => void act(`/leaves/${l.id}/approve`, {}, isMedical ? t('validated', 'Certificate validated') : t('approved', 'Approved'))}>{isMedical ? t('validate', 'Validate') : t('approve', 'Approve')}</button>}
                    {mayDecide && <button type="button" onClick={() => { setRejecting(l); setReason('') }}>{t('reject', 'Reject')}</button>}
                    {!mayDecide && ['APPROVED', 'RECORDED', 'SUBMITTED'].includes(l.status) && <button type="button" onClick={() => void act(`/leaves/${l.id}/cancel`, {}, t('cancelled', 'Cancelled'))}>{t('cancel', 'Cancel')}</button>}
                    {isMedical && <button type="button" onClick={() => void openRecord(l.id)}>{t('openRecord', 'Open record')}</button>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      {rejecting && (
        <Modal title={t('rejectLeave', 'Reject this request')} onClose={() => setRejecting(null)}>
          <p>{rejecting.employee.firstName} {rejecting.employee.lastName} · {rejecting.type.name}</p>
          <label className="reason">{t('reason', 'Reason')}<input value={reason} onChange={e => setReason(e.target.value)} autoFocus /></label>
          <footer>
            <button type="button" onClick={() => setRejecting(null)}>{t('cancel', 'Cancel')}</button>
            <button type="button" className="primary" disabled={!reason.trim()} onClick={() => { void act(`/leaves/${rejecting.id}/reject`, { reason: reason.trim() }, t('rejected', 'Rejected')); setRejecting(null) }}>{t('reject', 'Reject')}</button>
          </footer>
        </Modal>
      )}
      {record && (
        <Modal title={t('medicalRecord', 'Medical record')} onClose={() => setRecord(null)}>
          <p className="muted">{t('accessLogged', 'Opening this record is logged.')}</p>
          <dl className="facts"><dt>{t('certificate', 'Certificate')}</dt><dd>{record.documentUrl ?? '—'}</dd><dt>{t('notes', 'Notes')}</dt><dd>{record.notes ?? '—'}</dd></dl>
        </Modal>
      )}
    </>
  )
}

function Clearance() {
  const { t, i18n } = useTranslation()
  const toast = useToast()
  const queue = useApi<QueueRow[]>('/leaves/clearance/queue')
  useLive(queue.reload)
  const [row, setRow] = useState<QueueRow | null>(null)
  const [kind, setKind] = useState('')
  const [until, setUntil] = useState('')
  const rows = queue.data ?? []

  const clear = async () => {
    if (!row) return
    try {
      await api(`/leaves/${row.leaveId}/clearance`, { method: 'POST', body: kind ? { restriction: { kind, end: until || undefined } } : {} })
      toast(kind ? t('clearedRestricted', 'Cleared with a restriction') : t('cleared', 'Cleared for duty'))
      setRow(null); setKind(''); setUntil(''); await queue.reload()
    } catch (e) { toast(errMsg(e), 'error') }
  }

  return (
    <>
      {queue.error && <div className="banner error" role="alert">{queue.error}</div>}
      {!queue.loading && rows.length === 0 && <p className="empty-note">{t('noQueue', 'Nobody is waiting for clearance.')}</p>}
      {rows.length > 0 && (
        <table className="table">
          <thead><tr><th>{t('person', 'Person')}</th><th>{t('leaveEnded', 'Leave ended')}</th><th>{t('waiting', 'Waiting')}</th><th /></tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.leaveId}>
                <td><strong><PersonLink id={r.employee.id}>{r.employee.firstName} {r.employee.lastName}</PersonLink></strong> <span className="muted">{r.employee.employeeNo} · {r.employee.homeBase.code}</span></td>
                <td>{fmtDate(r.endedOn, i18n.language)} <span className="muted">· {plural(r.leaveDays, 'day')} of leave</span></td>
                <td>{plural(r.waitingDays, 'day')}</td>
                <td className="row-actions end"><button type="button" className="primary" onClick={() => setRow(r)}>{t('clear', 'Clear for duty')}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {row && (
        <Modal title={t('clearTitle', 'Clear for duty')} onClose={() => setRow(null)}>
          <p><strong>{row.employee.firstName} {row.employee.lastName}</strong></p>
          <label className="reason">{t('restriction', 'Restriction')}
            <select value={kind} onChange={e => setKind(e.target.value)}>
              <option value="">{t('noRestriction', 'No restriction: fully fit')}</option>
              <option value="base_only">{t('baseOnly', 'Base posts only (no field work)')}</option>
              <option value="no_field">{t('noField', 'No field work')}</option>
              <option value="no_night">{t('noNight', 'No night work')}</option>
            </select>
          </label>
          {kind && <label className="reason">{t('restrictionEnd', 'Restriction ends (optional)')}<input type="date" value={until} onChange={e => setUntil(e.target.value)} /></label>}
          {kind === 'base_only' || kind === 'no_field' ? <p className="note">{t('restrictionNote', 'Their unit seats from today are freed and replacement tasks are opened.')}</p> : null}
          <footer>
            <button type="button" onClick={() => setRow(null)}>{t('cancel', 'Cancel')}</button>
            <button type="button" className="primary" onClick={() => void clear()}>{t('clear', 'Clear for duty')}</button>
          </footer>
        </Modal>
      )}
    </>
  )
}

function Overlaps() {
  const { t, i18n } = useTranslation()
  const data = useApi<{ threshold: number; warnings: Overlap[] }>('/leaves/overlaps?weeks=12')
  const w = data.data?.warnings ?? []
  return (
    <>
      <p className="muted">{t('overlapIntro', 'Weeks when several people with the same profile are away at once.')} ({t('threshold', 'warning from')} {data.data?.threshold ?? '…'})</p>
      {!data.loading && w.length === 0 && <p className="ok-line">{t('noOverlaps', 'No week has too many people away.')}</p>}
      {w.length > 0 && (
        <table className="table">
          <thead><tr><th>{t('week', 'Week of')}</th><th>{t('base', 'Base')}</th><th>{t('profile', 'Profile')}</th><th>{t('away', 'Away')}</th></tr></thead>
          <tbody>{w.map((o, i) => <tr key={i}><td>{fmtDate(o.week, i18n.language)}</td><td>{o.base}</td><td>{o.profile}</td><td><Pill severity="warn">{o.people}</Pill></td></tr>)}</tbody>
        </table>
      )}
    </>
  )
}

function NewLeave({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const types = useApi<LeaveType[]>('/catalogs/leave-types')
  const [text, setText] = useState('')
  const q = useDebounced(text.trim())
  const hits = useApi<{ items: EmpHit[] }>(q.length >= 2 ? `/employees?q=${encodeURIComponent(q)}&limit=8` : null)
  const [person, setPerson] = useState<EmpHit | null>(null)
  const [typeId, setTypeId] = useState('')
  const [start, setStart] = useState(new Date().toISOString().slice(0, 10))
  const [end, setEnd] = useState(new Date().toISOString().slice(0, 10))
  const [doc, setDoc] = useState('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const type = types.data?.find(x => x.id === typeId)

  const save = async () => {
    if (!person || !typeId) return
    setBusy(true)
    try {
      const r = await api<{ warnings: string[]; effects: { released: unknown[] } | null }>('/leaves', { method: 'POST', body: { employeeId: person.id, typeId, start, end, documentUrl: doc || undefined, notes: notes || undefined } })
      toast(r.effects?.released.length ? `${t('leaveSaved', 'Leave saved')} · ${plural(r.effects.released.length, 'seat')} freed` : t('leaveSaved', 'Leave saved'))
      r.warnings.forEach(w => toast(w))
      onClose()
    } catch (e) { toast(errMsg(e), 'error'); setBusy(false) }
  }

  return (
    <Modal title={t('newLeave', 'New leave')} onClose={onClose}>
      <label className="reason">{t('person', 'Person')}
        {person
          ? <span className="picked"><strong>{person.firstName} {person.lastName}</strong> <span className="muted">{person.employeeNo} · {person.homeBase.code}</span> <button type="button" onClick={() => setPerson(null)}>{t('change', 'Change')}</button></span>
          : <input value={text} onChange={e => setText(e.target.value)} placeholder={t('searchPerson', 'Name or employee number')} autoFocus />}
      </label>
      {!person && hits.data && <ul className="cand-list">{hits.data.items.map(h => <li key={h.id}><div><strong>{h.firstName} {h.lastName}</strong><small className="why">{h.employeeNo} · {h.homeBase.code}</small></div><button type="button" onClick={() => setPerson(h)}>{t('choose', 'Choose')}</button></li>)}</ul>}
      <label className="reason">{t('type', 'Type')}
        <select value={typeId} onChange={e => setTypeId(e.target.value)}><option value="">—</option>{types.data?.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
      </label>
      <div className="dates">
        <label>{t('from', 'From')}<input type="date" value={start} onChange={e => { setStart(e.target.value); if (end < e.target.value) setEnd(e.target.value) }} /></label>
        <label>{t('until', 'Until')}<input type="date" value={end} min={start} onChange={e => setEnd(e.target.value)} /></label>
      </div>
      {type?.needsDocument && <label className="reason">{type.category === 'medical' ? t('certificate', 'Certificate') : t('document', 'Document')} (URL)<input value={doc} onChange={e => setDoc(e.target.value)} placeholder="https://…" /></label>}
      <label className="reason">{t('notes', 'Notes')}<input value={notes} onChange={e => setNotes(e.target.value)} /></label>
      {type?.category === 'medical' && <p className="note">{t('medicalNote', 'No diagnosis is recorded. Only the manager and the person can see the certificate; everyone else sees "Unavailable".')}</p>}
      <footer>
        <button type="button" onClick={onClose}>{t('cancel', 'Cancel')}</button>
        <button type="button" className="primary" disabled={busy || !person || !typeId || end < start} onClick={() => void save()}>{t('save', 'Save')}</button>
      </footer>
    </Modal>
  )
}
