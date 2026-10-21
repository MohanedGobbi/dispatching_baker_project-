import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowRightLeft, Ban, CalendarCheck, CheckCircle2, Pencil, Plus, Trash2, Truck, Wrench } from 'lucide-react'
import { api } from './api'
import { BulkBar, RowBox, SelectAllBox, useSelection } from './bulk'
import { PageGuide } from './guide'
import { errMsg, useApi, useDebounced, useLive, useRoute } from './hooks'
import { fmtDate } from './labels'
import { useProfiles } from './profiles'
import UnitPage from './UnitPage'
import { AddUnitDialog, DeleteUnit, EditUnit, MoveUnit } from './unitforms'
import { STATUS } from './unitstatus'
import type { UnitRow } from './unitforms'
import { Pill, useToast } from './ui'
import type { Severity } from './types'



const SERVICE_SEV: Record<string, Severity> = { overdue: 'bad', due_soon: 'warn', ok: 'ok' }

export default function Units() {
  const { parts } = useRoute()
  return parts[1] ? <UnitPage id={parts[1]} /> : <UnitList />
}

/** Fleet page: every unit (truck) with its status today, job, crew and details; add, edit, move, retire or delete. */
function UnitList() {
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
  const [busy, setBusy] = useState(false)

  const all = list.data?.items ?? []
  const serviceDue = (u: UnitRow) => u.nextService && u.nextService.state !== 'ok'
  const rows = status === 'PROBLEM' ? all.filter(u => u.problem) : status === 'SERVICE' ? all.filter(serviceDue) : status ? all.filter(u => u.status === status) : all
  const count = (s: string) => all.filter(u => u.status === s).length
  const pick = useSelection(rows.map(u => u.id))
  const applyBulk = async (action: string, value: string) => {
    setBusy(true)
    try {
      const r = await api<{ updated: number; failed: { code: string; reason: string }[] }>('/units/bulk', { method: 'POST', body: { ids: pick.ids, action, value } })
      const failed = r.failed.length ? ` · ${r.failed.map(f => `${f.code}: ${f.reason}`).join('; ')}` : ''
      toast(`${r.updated} ${t('unitsUpdated', 'units updated')}${failed}`, r.failed.length ? 'error' : 'ok'); await list.reload()
    } catch (e) { toast(errMsg(e), 'error') }
    setBusy(false)
  }
  const setService = async (u: UnitRow, out: boolean) => {
    try {
      await api(`/units/${u.id}/status`, { method: 'PUT', body: { status: out ? 'OUT_OF_SERVICE' : 'AVAILABLE' } })
      toast(out ? `${u.code}: ${t('outService', 'Out of service')}` : `${u.code}: ${t('backService', 'Back in service')}`); await list.reload()
    } catch (e) { toast(errMsg(e), 'error') }
  }

  return (
    <main className="page wide">
      <PageGuide id="units" Icon={Truck} color="var(--pal-sky-700)" title={t('unitsTitle', 'Units')}
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
        <button type="button" className={`kpi2${status === '' ? ' on' : ''}`} style={{ ['--c' as string]: 'var(--pal-slate-700)' }} onClick={() => setStatus('')} aria-pressed={status === ''}>
          <Truck size={22} className="k-icon" aria-hidden /><strong>{all.length}</strong><span>{t('allUnits', 'All units')}</span><small>{all.filter(u => u.problem).length ? `${all.filter(u => u.problem).length} ${t('crewShort', 'short of crew')}` : t('crewsOk', 'all crews complete')}</small>
        </button>
        <button type="button" className={`kpi2${status === 'SERVICE' ? ' on' : ''}${all.some(u => u.nextService?.state === 'overdue') ? ' alert' : ''}`} style={{ ['--c' as string]: all.some(u => u.nextService?.state === 'overdue') ? 'var(--pal-red-700)' : 'var(--pal-orange-900)' }} onClick={() => setStatus(status === 'SERVICE' ? '' : 'SERVICE')} aria-pressed={status === 'SERVICE'}>
          <CalendarCheck size={22} className="k-icon" aria-hidden /><strong>{all.filter(serviceDue).length}</strong><span>{t('serviceDue', 'Service due')}</span><small>{all.filter(u => u.nextService?.state === 'overdue').length} {t('overdueLc', 'overdue')}</small>
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
          <option value="">{t('anyStatus', 'Any status')}</option>{Object.entries(STATUS).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}<option value="PROBLEM">{t('crewShortOpt', 'On a job, short of crew')}</option><option value="SERVICE">{t('serviceDueOpt', 'Service due or overdue')}</option>
        </select>
        <span className="spacer" /><span className="muted">{rows.length} / {all.length}</span>
      </div>
      {list.error && <div className="banner error" role="alert">{list.error}</div>}

      <BulkBar count={pick.count} busy={busy} onApply={applyBulk} onClear={pick.clear}
        fields={[
          { key: 'unitType', label: t('unitType', 'Type'), options: (types.data ?? []).map(x => ({ value: x.id, label: x.name })) },
          { key: 'homeBase', label: t('homeBase', 'Home base'), options: (bases.data ?? []).map(b => ({ value: b.id, label: b.code })) },
          { key: 'status', label: t('status', 'Status'), options: [{ value: 'AVAILABLE', label: t('us_AVAILABLE', 'Available') }, { value: 'OUT_OF_SERVICE', label: t('outService', 'Out of service') }, { value: 'IN_TRANSIT', label: t('us_IN_TRANSIT', 'In transit') }] },
        ]} />

      <div className="table-scroll">
        <table className="table compact units-table">
          <thead><tr><th className="pick-col"><SelectAllBox all={pick.all} some={pick.some} onChange={pick.toggleAll} label={t('selectAllUnits', 'Select every unit shown')} /></th><th>{t('unit', 'Unit')}</th><th>{t('unitType', 'Type')}</th><th>{t('homeBase', 'Home base')}</th><th>{t('status', 'Status')}</th><th>{t('today', 'Today')}</th><th>{t('crew', 'Crew')}</th><th>{t('nextService', 'Next service')}</th><th>{t('vehicle', 'Plate · model · year')}</th><th /></tr></thead>
          <tbody>
            {rows.map(u => {
              const m = STATUS[u.status] ?? { label: u.status, sev: 'info' as Severity }
              return (
                <tr key={u.id} className={`${u.problem ? 'row-bad' : ''}${pick.has(u.id) ? ' picked' : ''}`}>
                  <td className="pick-col"><RowBox on={pick.has(u.id)} onChange={on => pick.toggle(u.id, on)} label={u.code} /></td>
                  <td><strong><a className="name-link unit" href={`#/units/${u.id}`}>{u.code}</a></strong>{u.notes && <small className="muted unit-note" title={u.notes}>{u.notes}</small>}</td>
                  <td><span className={`tag tag-${u.colorKey === 'amber' ? 'CH' : 'OH'}`}>{u.type}</span></td>
                  <td>{u.home.code}</td>
                  <td><Pill severity={m.sev}>{t(`us_${u.status}`, m.label)}</Pill></td>
                  <td>
                    {u.job ? <>{u.job.wellName}{u.job.rigName ? ` · ${u.job.rigName}` : ''}{u.jobUntil ? <small className="muted"> {t('until', 'until')} {fmtDate(u.jobUntil, i18n.language)}</small> : u.job.openEnded ? <small className="muted"> {t('openUntilEnded', 'until you end it')}</small> : null}</>
                      : u.backBy ? <span>{t('backBy', 'back by')} {fmtDate(u.backBy, i18n.language)}</span>
                      : <span className="muted">—</span>}
                  </td>
                  <td>{u.status === 'DEPLOYED' ? <Pill severity={u.problem ? 'bad' : 'ok'}>{u.crew.filled}/{u.crew.required}</Pill> : <span className="muted">{u.crew.filled}/{u.crew.required}</span>}</td>
                  <td>{u.nextService ? <><Pill severity={SERVICE_SEV[u.nextService.state]}>{fmtDate(u.nextService.due, i18n.language)}</Pill><small className="muted unit-note">{u.nextService.name}</small></> : <span className="muted">—</span>}</td>
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
            {list.data && rows.length === 0 && <tr><td colSpan={10} className="muted">{t('noUnitsMatch', 'No unit matches.')}</td></tr>}
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
