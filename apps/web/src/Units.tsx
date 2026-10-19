import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowRightLeft, Ban, CheckCircle2, Pencil, Plus, Trash2, Truck, Wrench } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { api, ApiError } from './api'
import { Modal } from './dialogs'
import { PageGuide } from './guide'
import { errMsg, useApi, useDebounced, useLive } from './hooks'
import { fmtDate } from './labels'
import { UnitLink, useProfiles } from './profiles'
import { AddUnitDialog } from './unitforms'
import { Pill, useToast } from './ui'
import type { Severity } from './types'

interface UnitRow {
  id: string; code: string; type: string; typeId: string; colorKey: string; home: { code: string; name: string }; homeBaseId: string
  plate: string | null; model: string | null; year: number | null; notes: string | null
  status: string; job: { ref: string; wellName: string; rigName: string | null } | null; jobUntil: string | null; backBy: string | null
  crew: { filled: number; required: number }; problem: boolean
}

const STATUS: Record<string, { label: string; sev: Severity; color: string; Icon: LucideIcon }> = {
  AVAILABLE: { label: 'Available', sev: 'ok', color: '#15803d', Icon: CheckCircle2 },
  DEPLOYED: { label: 'On a job', sev: 'info', color: '#1d4ed8', Icon: Truck },
  UNDER_MAINTENANCE: { label: 'In the workshop', sev: 'warn', color: '#b45309', Icon: Wrench },
  IN_TRANSIT: { label: 'In transit', sev: 'info', color: '#0e7490', Icon: ArrowRightLeft },
  OUT_OF_SERVICE: { label: 'Out of service', sev: 'bad', color: '#b91c1c', Icon: Ban },
}

/** Fleet page: every unit (truck) with its status today, job, crew and details; add, edit, move, retire or delete. */
export default function Units() {
  const { t, i18n } = useTranslation()
  const toast = useToast()
  const { openUnit } = useProfiles()
  const bases = useApi<{ id: string; code: string }[]>('/bases')
  const types = useApi<{ id: string; name: string }[]>('/catalogs/unit-types')
  const [text, setText] = useState('')
  const q = useDebounced(text.trim())
  const [baseId, setBaseId] = useState('')
  const [typeId, setTypeId] = useState('')
  const [status, setStatus] = useState('')
  // Status is filtered here rather than by the API so the tiles always count the whole fleet in view.
  const params = new URLSearchParams({ limit: '200', ...(q ? { q } : {}), ...(baseId ? { baseId } : {}), ...(typeId ? { typeId } : {}) })
  const list = useApi<{ total: number; items: UnitRow[] }>(`/units?${params}`)
  useLive(list.reload)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<UnitRow | null>(null)
  const [moving, setMoving] = useState<UnitRow | null>(null)
  const [deleting, setDeleting] = useState<UnitRow | null>(null)

  const all = list.data?.items ?? []
  const rows = status === 'PROBLEM' ? all.filter(u => u.problem) : status ? all.filter(u => u.status === status) : all
  const count = (s: string) => all.filter(u => u.status === s).length
  const setService = async (u: UnitRow, out: boolean) => {
    try {
      await api(`/units/${u.id}/status`, { method: 'PUT', body: { status: out ? 'OUT_OF_SERVICE' : 'AVAILABLE' } })
      toast(out ? `${u.code}: ${t('outService', 'Out of service')}` : `${u.code}: ${t('backService', 'Back in service')}`); await list.reload()
    } catch (e) { toast(errMsg(e), 'error') }
  }

  return (
    <main className="page wide">
      <PageGuide id="units" Icon={Truck} color="#0369a1" title={t('unitsTitle', 'Units')}
        purpose={t('unitsPurpose', 'The whole fleet: where each truck is based, what it is doing today, its crew and its details.')}
        steps={[
          t('unStep1', 'The tiles count units by status today; click one to show only those.'),
          t('unStep2', 'Click a unit code for its full profile: job, crew, maintenance history. Send it to the workshop from there.'),
          t('unStep3', '"Add a unit" creates the truck and its crew seats. Edit details, move it to another base, or take it out of service from the row.'),
          t('unStep4', 'Delete is only for a unit entered by mistake; a unit with any history is taken out of service instead.'),
        ]}>
        <button type="button" className="primary" onClick={() => setAdding(true)}><Plus size={15} aria-hidden /> {t('addUnit', 'Add a unit')}</button>
      </PageGuide>

      <section className="kpis2" aria-label={t('unitsByStatus', 'Units by status')}>
        <button type="button" className={`kpi2${status === '' ? ' on' : ''}`} style={{ ['--c' as string]: '#334155' }} onClick={() => setStatus('')} aria-pressed={status === ''}>
          <Truck size={22} className="k-icon" aria-hidden /><strong>{all.length}</strong><span>{t('allUnits', 'All units')}</span><small>{all.filter(u => u.problem).length ? `${all.filter(u => u.problem).length} ${t('crewShort', 'short of crew')}` : t('crewsOk', 'all crews complete')}</small>
        </button>
        {Object.entries(STATUS).map(([k, m]) => (
          <button key={k} type="button" className={`kpi2${status === k ? ' on' : ''}`} style={{ ['--c' as string]: m.color }} onClick={() => setStatus(status === k ? '' : k)} aria-pressed={status === k}>
            <m.Icon size={22} className="k-icon" aria-hidden /><strong>{count(k)}</strong><span>{t(`us_${k}`, m.label)}</span>
          </button>
        ))}
      </section>

      <div className="filters">
        <input value={text} onChange={e => setText(e.target.value)} placeholder={t('unitSearch', 'Code, plate, model or note')} aria-label={t('search', 'Search')} />
        <select value={baseId} onChange={e => setBaseId(e.target.value)} aria-label={t('base', 'Base')}><option value="">{t('allBases', 'All bases')}</option>{bases.data?.map(b => <option key={b.id} value={b.id}>{b.code}</option>)}</select>
        <select value={typeId} onChange={e => setTypeId(e.target.value)} aria-label={t('unitType', 'Type')}><option value="">{t('allTypes', 'All types')}</option>{types.data?.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
        <select value={status} onChange={e => setStatus(e.target.value)} aria-label={t('status', 'Status')}>
          <option value="">{t('anyStatus', 'Any status')}</option>{Object.entries(STATUS).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}<option value="PROBLEM">{t('crewShortOpt', 'On a job, short of crew')}</option>
        </select>
        <span className="spacer" /><span className="muted">{rows.length} / {all.length}</span>
      </div>
      {list.error && <div className="banner error" role="alert">{list.error}</div>}

      <div className="table-scroll">
        <table className="table compact units-table">
          <thead><tr><th>{t('unit', 'Unit')}</th><th>{t('unitType', 'Type')}</th><th>{t('homeBase', 'Home base')}</th><th>{t('status', 'Status')}</th><th>{t('today', 'Today')}</th><th>{t('crew', 'Crew')}</th><th>{t('vehicle', 'Plate · model · year')}</th><th /></tr></thead>
          <tbody>
            {rows.map(u => {
              const m = STATUS[u.status] ?? { label: u.status, sev: 'info' as Severity }
              return (
                <tr key={u.id} className={u.problem ? 'row-bad' : ''}>
                  <td><strong><UnitLink id={u.id} code={u.code} /></strong>{u.notes && <small className="muted unit-note" title={u.notes}>{u.notes}</small>}</td>
                  <td><span className={`tag tag-${u.colorKey === 'amber' ? 'CH' : 'OH'}`}>{u.type}</span></td>
                  <td>{u.home.code}</td>
                  <td><Pill severity={m.sev}>{t(`us_${u.status}`, m.label)}</Pill></td>
                  <td>
                    {u.job ? <>{u.job.wellName}{u.job.rigName ? ` · ${u.job.rigName}` : ''}{u.jobUntil && <small className="muted"> {t('until', 'until')} {fmtDate(u.jobUntil, i18n.language)}</small>}</>
                      : u.backBy ? <span>{t('backBy', 'back by')} {fmtDate(u.backBy, i18n.language)}</span>
                      : <span className="muted">—</span>}
                  </td>
                  <td>{u.status === 'DEPLOYED' ? <Pill severity={u.problem ? 'bad' : 'ok'}>{u.crew.filled}/{u.crew.required}</Pill> : <span className="muted">{u.crew.filled}/{u.crew.required}</span>}</td>
                  <td>{[u.plate, u.model, u.year].filter(Boolean).join(' · ') || <span className="muted">—</span>}</td>
                  <td className="row-actions">
                    <button type="button" onClick={() => setEditing(u)} aria-label={`${t('edit', 'Edit')} ${u.code}`} title={t('edit', 'Edit')}><Pencil size={14} aria-hidden /></button>
                    <button type="button" onClick={() => setMoving(u)} aria-label={`${t('move', 'Move to another base')} ${u.code}`} title={t('move', 'Move to another base')}><ArrowRightLeft size={14} aria-hidden /></button>
                    {u.status === 'AVAILABLE' && <button type="button" onClick={() => openUnit(u.id)} aria-label={`${t('workshop', 'Send to the workshop')} ${u.code}`} title={t('workshop', 'Send to the workshop')}><Wrench size={14} aria-hidden /></button>}
                    {u.status === 'OUT_OF_SERVICE'
                      ? <button type="button" onClick={() => void setService(u, false)} title={t('backService', 'Back in service')} aria-label={`${t('backService', 'Back in service')} ${u.code}`}><CheckCircle2 size={14} aria-hidden /></button>
                      : u.status !== 'DEPLOYED' && <button type="button" onClick={() => void setService(u, true)} title={t('outService', 'Out of service')} aria-label={`${t('outService', 'Out of service')} ${u.code}`}><Ban size={14} aria-hidden /></button>}
                    <button type="button" className="danger" onClick={() => setDeleting(u)} aria-label={`${t('delete', 'Delete')} ${u.code}`} title={t('delete', 'Delete')}><Trash2 size={14} aria-hidden /></button>
                  </td>
                </tr>
              )
            })}
            {list.data && rows.length === 0 && <tr><td colSpan={8} className="muted">{t('noUnitsMatch', 'No unit matches.')}</td></tr>}
          </tbody>
        </table>
      </div>

      {adding && <AddUnitDialog onClose={() => setAdding(false)} onDone={() => void list.reload()} />}
      {editing && <EditUnit unit={editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); void list.reload() }} />}
      {moving && <MoveUnit unit={moving} bases={bases.data ?? []} onClose={() => setMoving(null)} onDone={() => { setMoving(null); void list.reload() }} />}
      {deleting && <DeleteUnit unit={deleting} onClose={() => setDeleting(null)} onRetire={() => { const u = deleting; setDeleting(null); void setService(u, true) }} onDone={() => { setDeleting(null); void list.reload() }} />}
    </main>
  )
}

function EditUnit({ unit, onClose, onDone }: { unit: UnitRow; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const [f, setF] = useState({ plate: unit.plate ?? '', model: unit.model ?? '', year: unit.year ? String(unit.year) : '', notes: unit.notes ?? '' })
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    try {
      await api(`/units/${unit.id}`, { method: 'PUT', body: { plate: f.plate.trim() || null, model: f.model.trim() || null, year: f.year ? +f.year : null, notes: f.notes.trim() || null } })
      toast(t('saved', 'Saved')); onDone()
    } catch (e) { toast(errMsg(e), 'error'); setBusy(false) }
  }
  return (
    <Modal title={`${t('editUnit', 'Edit unit')} · ${unit.code}`} onClose={onClose}>
      <div className="form2">
        <p className="muted" style={{ margin: 0 }}>{unit.type} · {unit.home.code}. {t('typeFixed', 'The type is fixed because it decides the crew seats; use "Move" to change the home base.')}</p>
        <div className="row3">
          <label>{t('plate', 'Plate')}<input value={f.plate} onChange={set('plate')} autoFocus /></label>
          <label>{t('model', 'Model')}<input value={f.model} onChange={set('model')} /></label>
          <label>{t('year', 'Year')}<input type="number" value={f.year} onChange={set('year')} /></label>
        </div>
        <label>{t('notes', 'Notes')}<textarea rows={3} value={f.notes} onChange={set('notes')} /></label>
        <footer>
          <button type="button" onClick={onClose}>{t('cancel', 'Cancel')}</button>
          <button type="button" className="primary" disabled={busy} onClick={() => void save()}>{t('save', 'Save')}</button>
        </footer>
      </div>
    </Modal>
  )
}

function MoveUnit({ unit, bases, onClose, onDone }: { unit: UnitRow; bases: { id: string; code: string }[]; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const others = bases.filter(b => b.id !== unit.homeBaseId)
  const [baseId, setBaseId] = useState(others[0]?.id ?? '')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    try {
      await api(`/units/${unit.id}/transfer`, { method: 'POST', body: { baseId, reason: reason.trim() || undefined } })
      toast(`${unit.code} → ${others.find(b => b.id === baseId)?.code}`); onDone()
    } catch (e) { toast(errMsg(e), 'error'); setBusy(false) }
  }
  return (
    <Modal title={`${t('move', 'Move to another base')} · ${unit.code}`} onClose={onClose}>
      <div className="form2">
        <p className="muted" style={{ margin: 0 }}>{t('moveFrom', 'Based at')} {unit.home.code} ({unit.home.name}).</p>
        <label>{t('newBase', 'New home base')}<select value={baseId} onChange={e => setBaseId(e.target.value)}>{others.map(b => <option key={b.id} value={b.id}>{b.code}</option>)}</select></label>
        <label>{t('reason', 'Reason')}<input value={reason} onChange={e => setReason(e.target.value)} placeholder={t('moveReasonPh', 'e.g. rebalancing the fleet')} /></label>
        <footer>
          <button type="button" onClick={onClose}>{t('cancel', 'Cancel')}</button>
          <button type="button" className="primary" disabled={busy || !baseId} onClick={() => void save()}>{t('moveIt', 'Move')}</button>
        </footer>
      </div>
    </Modal>
  )
}

function DeleteUnit({ unit, onClose, onRetire, onDone }: { unit: UnitRow; onClose: () => void; onRetire: () => void; onDone: () => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const [refused, setRefused] = useState('')
  const [busy, setBusy] = useState(false)
  const remove = async () => {
    setBusy(true)
    try { await api(`/units/${unit.id}`, { method: 'DELETE' }); toast(`${unit.code} ${t('deleted', 'deleted')}`); onDone() } catch (e) {
      if (e instanceof ApiError && e.status === 409) setRefused(e.message); else toast(errMsg(e), 'error')
      setBusy(false)
    }
  }
  return (
    <Modal title={`${t('delete', 'Delete')} ${unit.code}?`} onClose={onClose}>
      {refused ? (
        <>
          <p>{refused}</p>
          <footer>
            <button type="button" onClick={onClose}>{t('cancel', 'Cancel')}</button>
            {unit.status !== 'OUT_OF_SERVICE' && unit.status !== 'DEPLOYED' && <button type="button" className="primary" onClick={onRetire}>{t('outService', 'Out of service')}</button>}
          </footer>
        </>
      ) : (
        <>
          <p>{t('deleteUnitText', 'This removes the unit and its crew seats for good. It is meant for a unit entered by mistake; a unit with any history cannot be deleted.')}</p>
          <footer>
            <button type="button" onClick={onClose}>{t('cancel', 'Cancel')}</button>
            <button type="button" className="primary danger-fill" disabled={busy} onClick={() => void remove()}>{t('delete', 'Delete')}</button>
          </footer>
        </>
      )}
    </Modal>
  )
}
