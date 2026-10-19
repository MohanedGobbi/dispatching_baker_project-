import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Wrench } from 'lucide-react'
import { PageGuide } from './guide'
import { api } from './api'
import { useAuth } from './auth'
import { Modal } from './dialogs'
import { errMsg, useApi, useDebounced, useLive } from './hooks'
import { fmtDate } from './labels'
import { Pill, useToast } from './ui'
import { PersonLink, UnitLink } from './profiles'

interface WO {
  id: string; unit: { id: string; code: string }; base: { id: string; code: string }; type: string; priority: string
  description: string | null; status: string; plannedStart: string; expectedReturn: string
  assignees: { id: string; name: string }[]
}
const COLUMNS: [string, string][] = [['OPEN', 'Open'], ['IN_PROGRESS', 'In progress'], ['WAITING_PARTS', 'Waiting for parts'], ['DONE', 'Done']]
const NEXT: Record<string, string[]> = { OPEN: ['IN_PROGRESS', 'WAITING_PARTS', 'DONE'], IN_PROGRESS: ['WAITING_PARTS', 'DONE'], WAITING_PARTS: ['IN_PROGRESS', 'DONE'] }
const LABEL: Record<string, string> = { IN_PROGRESS: 'Start', WAITING_PARTS: 'Waiting for parts', DONE: 'Done' }
const PRIORITY_SEV = { low: 'info', normal: 'info', high: 'warn', urgent: 'bad' } as const

/** Work-order board per base (plan screen 16): open, in progress, waiting for parts, done. */
export default function WorkOrders() {
  const { t, i18n } = useTranslation()
  const { can } = useAuth()
  const toast = useToast()
  const bases = useApi<{ id: string; code: string }[]>('/bases')
  const [baseId, setBaseId] = useState('')
  const orders = useApi<{ items: WO[] }>(`/work-orders?limit=200${baseId ? `&baseId=${baseId}` : ''}`)
  useLive(orders.reload)
  const [creating, setCreating] = useState(false)
  const editor = can('SUPER_ADMIN', 'OPS_MANAGER', 'BASE_MANAGER', 'CHIEF_OF_UNIT')

  const rows = orders.data?.items ?? []
  const move = async (id: string, status: string) => {
    try { const r = await api<{ unitBack?: boolean }>(`/work-orders/${id}/status`, { method: 'POST', body: { status } }); toast(r.unitBack ? t('unitBack', 'Done: the unit is available again') : t('updated', 'Updated')); await orders.reload() } catch (e) { toast(errMsg(e), 'error') }
  }

  return (
    <main className="page wide">
      <PageGuide id="workorders" Icon={Wrench} color="#b45309" title={t('woTitle', 'Work orders')}
        purpose={t('woPurpose', 'Units in the workshop. While a work order is open the unit is under maintenance and its crew seats are not needed.')}
        steps={[
          t('woStep1', 'Open a work order with the expected return date and the mechanics working on it.'),
          t('woStep2', 'Move it across the columns as the work goes on. "Done" makes the unit available again.'),
        ]}>
        {editor && <button type="button" className="primary" onClick={() => setCreating(true)}><Plus size={15} aria-hidden /> {t('newWo', 'New work order')}</button>}
      </PageGuide>
      <div className="filters">
        <select value={baseId} onChange={e => setBaseId(e.target.value)} aria-label="Base">
          <option value="">{t('allBases', 'All bases')}</option>{bases.data?.map(b => <option key={b.id} value={b.id}>{b.code}</option>)}
        </select>
      </div>
      {orders.error && <div className="banner error" role="alert">{orders.error}</div>}
      <div className="wo-board">
        {COLUMNS.map(([status, title]) => {
          const col = rows.filter(r => r.status === status)
          return (
            <section key={status} className="wo-col" aria-label={title}>
              <h2>{t(`wo_col_${status}`, title)} <span className="muted">{col.length}</span></h2>
              {col.map(w => (
                <article key={w.id} className="wo-card">
                  <header><strong><UnitLink id={w.unit.id} code={w.unit.code} /></strong><span className="muted">{w.base.code}</span><Pill severity={PRIORITY_SEV[w.priority as keyof typeof PRIORITY_SEV] ?? 'info'}>{w.priority}</Pill></header>
                  <p>{w.type.replace('_', ' ')}{w.description ? ` · ${w.description}` : ''}</p>
                  <small className="muted">{t('backBy', 'back by')} {fmtDate(w.expectedReturn, i18n.language)}</small>
                  <small>{w.assignees.length ? w.assignees.map((a, i) => <span key={a.id}>{i ? ', ' : ''}<PersonLink id={a.id}>{a.name}</PersonLink></span>) : <em className="muted">{t('unassigned', 'Nobody assigned')}</em>}</small>
                  {editor && (NEXT[w.status] ?? []).length > 0 && <div className="btn-row">{NEXT[w.status].map(n => <button type="button" key={n} onClick={() => void move(w.id, n)}>{t(`wo_${n}`, LABEL[n])}</button>)}</div>}
                </article>
              ))}
              {col.length === 0 && <p className="empty-note small">—</p>}
            </section>
          )
        })}
      </div>
      {creating && <NewWorkOrder onClose={() => setCreating(false)} onDone={() => void orders.reload()} />}
    </main>
  )
}

function NewWorkOrder({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const units = useApi<{ items: { id: string; code: string; home: { code: string } }[] }>('/units?limit=100')
  const [unitId, setUnitId] = useState('')
  const [type, setType] = useState('corrective')
  const [priority, setPriority] = useState('normal')
  const [description, setDescription] = useState('')
  const [back, setBack] = useState(new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10))
  const [text, setText] = useState('')
  const q = useDebounced(text.trim())
  const hits = useApi<{ items: { id: string; firstName: string; lastName: string; position: { name: string } }[] }>(q.length >= 2 ? `/employees?q=${encodeURIComponent(q)}&limit=6` : null)
  const [crew, setCrew] = useState<{ id: string; name: string }[]>([])
  const [busy, setBusy] = useState(false)

  const save = async () => {
    setBusy(true)
    try {
      await api('/work-orders', { method: 'POST', body: { unitId, type, priority, description: description || undefined, expectedReturn: back, assigneeIds: crew.map(c => c.id) } })
      toast(t('woCreated', 'Work order opened')); onDone(); onClose()
    } catch (e) { toast(errMsg(e), 'error'); setBusy(false) }
  }
  return (
    <Modal title={t('newWo', 'New work order')} onClose={onClose}>
      <label className="reason">{t('unit', 'Unit')}
        <select value={unitId} onChange={e => setUnitId(e.target.value)}><option value="">—</option>{units.data?.items.map(u => <option key={u.id} value={u.id}>{u.code} · {u.home.code}</option>)}</select>
      </label>
      <div className="dates">
        <label>{t('type', 'Type')}<select value={type} onChange={e => setType(e.target.value)}>{['preventive', 'corrective', 'inspection', 'tool_repair', 'other'].map(x => <option key={x} value={x}>{x.replace('_', ' ')}</option>)}</select></label>
        <label>{t('priority', 'Priority')}<select value={priority} onChange={e => setPriority(e.target.value)}>{['low', 'normal', 'high', 'urgent'].map(x => <option key={x} value={x}>{x}</option>)}</select></label>
        <label>{t('backBy', 'back by')}<input type="date" value={back} onChange={e => setBack(e.target.value)} /></label>
      </div>
      <label className="reason">{t('description', 'Description')}<input value={description} onChange={e => setDescription(e.target.value)} /></label>
      <label className="reason">{t('addMechanic', 'Add a mechanic or technician')}<input value={text} onChange={e => setText(e.target.value)} placeholder={t('searchPerson', 'Name or employee number')} /></label>
      {crew.length > 0 && <p>{crew.map(c => <span className="tag tag-OH" key={c.id}>{c.name} <button type="button" className="link" onClick={() => setCrew(crew.filter(x => x.id !== c.id))}>×</button></span>)}</p>}
      {hits.data && <ul className="cand-list">{hits.data.items.filter(h => !crew.some(c => c.id === h.id)).map(h => <li key={h.id}><div><strong>{h.firstName} {h.lastName}</strong><small className="why">{h.position.name}</small></div><button type="button" onClick={() => { setCrew([...crew, { id: h.id, name: `${h.firstName} ${h.lastName}` }]); setText('') }}>{t('add', 'Add')}</button></li>)}</ul>}
      <footer>
        <button type="button" onClick={onClose}>{t('cancel', 'Cancel')}</button>
        <button type="button" className="primary" disabled={busy || !unitId} onClick={() => void save()}>{t('save', 'Save')}</button>
      </footer>
    </Modal>
  )
}
