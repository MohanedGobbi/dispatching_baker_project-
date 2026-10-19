import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from './api'
import { Modal } from './dialogs'
import { errMsg, useApi } from './hooks'
import { useToast } from './ui'

interface Named { id: string; name: string }
interface Base { id: string; code: string; name: string }
interface UnitRow { id: string; code: string; type: string; home: { code: string }; status: string }
const today = () => new Date().toISOString().slice(0, 10)
const plus = (d: string, n: number) => new Date(Date.parse(d) + n * 86_400_000).toISOString().slice(0, 10)

/** Add a unit (truck). Its crew seats are created from the unit type's template. */
export function AddUnitDialog({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const types = useApi<Named[]>('/catalogs/unit-types')
  const bases = useApi<Base[]>('/bases')
  const [f, setF] = useState({ code: '', unitTypeId: '', homeBaseId: '', plate: '', model: '', year: '', notes: '' })
  const [busy, setBusy] = useState(false)
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  const save = async () => {
    setBusy(true)
    try {
      const u = await api<{ id: string; code: string }>('/units', { method: 'POST', body: { code: f.code.trim(), unitTypeId: f.unitTypeId, homeBaseId: f.homeBaseId, plate: f.plate || undefined, model: f.model || undefined, year: f.year ? +f.year : undefined, notes: f.notes || undefined } })
      toast(`${u.code} ${t('added', 'added')}`); onDone(u.id); onClose()
    } catch (e) { toast(errMsg(e), 'error'); setBusy(false) }
  }
  return (
    <Modal title={t('addUnit', 'Add a unit')} onClose={onClose}>
      <div className="form2">
        <label>{t('unitCode', 'Unit code')} *<input value={f.code} onChange={set('code')} placeholder="HL-6812" autoFocus /></label>
        <label>{t('unitType', 'Type')} *<select value={f.unitTypeId} onChange={set('unitTypeId')}><option value="">–</option>{types.data?.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
        <label>{t('homeBase', 'Home base')} *<select value={f.homeBaseId} onChange={set('homeBaseId')}><option value="">–</option>{bases.data?.map(b => <option key={b.id} value={b.id}>{b.code} · {b.name}</option>)}</select></label>
        <div className="row3">
          <label>{t('plate', 'Plate')}<input value={f.plate} onChange={set('plate')} /></label>
          <label>{t('model', 'Model')}<input value={f.model} onChange={set('model')} /></label>
          <label>{t('year', 'Year')}<input type="number" value={f.year} onChange={set('year')} /></label>
        </div>
        <label>{t('notes', 'Notes')}<textarea rows={2} value={f.notes} onChange={set('notes')} /></label>
        <p className="muted" style={{ margin: 0 }}>{t('seatsAuto', 'Its crew seats (chief, operators, driver) are created from the type automatically.')}</p>
        <footer>
          <button type="button" onClick={onClose}>{t('cancel', 'Cancel')}</button>
          <button type="button" className="primary" disabled={busy || !f.code.trim() || !f.unitTypeId || !f.homeBaseId} onClick={save}>{t('addUnit', 'Add a unit')}</button>
        </footer>
      </div>
    </Modal>
  )
}

/** A new job (well work) and, optionally, the unit that goes to it. Deploying makes the unit's crew seats needed. */
export function NewJobDialog({ unitId, onClose, onDone }: { unitId?: string; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const types = useApi<Named[]>('/catalogs/unit-types')
  const bases = useApi<Base[]>('/bases')
  const units = useApi<{ items: UnitRow[] }>('/units?limit=200')
  const [f, setF] = useState({ wellName: '', rigName: '', client: '', baseId: '', siteId: '', serviceType: '', start: today(), end: plus(today(), 44), unitId: unitId ?? '' })
  const sites = useApi<{ id: string; name: string }[]>(f.baseId ? `/sites?baseId=${f.baseId}` : null)
  const [busy, setBusy] = useState(false)
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  const unit = units.data?.items.find(u => u.id === f.unitId)

  // a unit chosen first fills in its base and service type
  useEffect(() => {
    if (!unit || !bases.data) return
    const b = bases.data.find(x => x.code === unit.home.code)
    setF(x => ({ ...x, baseId: x.baseId || b?.id || '', serviceType: x.serviceType || unit.type }))
  }, [unit, bases.data])
  useEffect(() => { if (sites.data?.length && !sites.data.some(s => s.id === f.siteId)) setF(x => ({ ...x, siteId: sites.data![0].id })) }, [sites.data, f.siteId])
  const fit = useMemo(() => (units.data?.items ?? []).filter(u => (u.id === unitId || u.status === 'AVAILABLE') && (!f.serviceType || u.type === f.serviceType)), [units.data, f.serviceType, unitId])

  const save = async () => {
    setBusy(true)
    try {
      const job = await api<{ id: string; ref: string }>('/jobs', { method: 'POST', body: { wellName: f.wellName.trim(), rigName: f.rigName || undefined, client: f.client || undefined, siteId: f.siteId, serviceType: f.serviceType, plannedStart: f.start, plannedEnd: f.end } })
      if (f.unitId) {
        const d = await api<{ warnings: string[] }>(`/jobs/${job.id}/deploy`, { method: 'POST', body: { unitId: f.unitId } })
        toast(`${job.ref} · ${unit?.code ?? ''} ${t('deployed', 'deployed')}${d.warnings.length ? ` · ${d.warnings.join('; ')}` : ''}`)
      } else toast(`${job.ref} ${t('created', 'created')}`)
      onDone(); onClose()
    } catch (e) { toast(errMsg(e), 'error'); setBusy(false) }
  }
  return (
    <Modal title={t('newJob', 'New job')} onClose={onClose}>
      <div className="form2">
        <div className="row2">
          <label>{t('wellName', 'Well')} *<input value={f.wellName} onChange={set('wellName')} placeholder="HMD-12" autoFocus /></label>
          <label>{t('rig', 'Rig')}<input value={f.rigName} onChange={set('rigName')} /></label>
        </div>
        <label>{t('client', 'Client')}<input value={f.client} onChange={set('client')} /></label>
        <div className="row2">
          <label>{t('base', 'Base')} *<select value={f.baseId} onChange={e => setF({ ...f, baseId: e.target.value, siteId: '' })}><option value="">–</option>{bases.data?.map(b => <option key={b.id} value={b.id}>{b.code} · {b.name}</option>)}</select></label>
          <label>{t('site', 'Site')} *<select value={f.siteId} onChange={set('siteId')} disabled={!f.baseId}><option value="">–</option>{sites.data?.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        </div>
        <label>{t('serviceType', 'Service')} *<select value={f.serviceType} onChange={set('serviceType')}><option value="">–</option>{types.data?.map(x => <option key={x.id} value={x.name}>{x.name}</option>)}</select></label>
        <div className="row2">
          <label>{t('start', 'Start')} *<input type="date" value={f.start} onChange={set('start')} /></label>
          <label>{t('end', 'End')} *<input type="date" value={f.end} min={f.start} onChange={set('end')} /></label>
        </div>
        <label>{t('sendUnit', 'Unit to send')}<select value={f.unitId} onChange={set('unitId')}><option value="">{t('noUnitYet', 'Decide later')}</option>{fit.map(u => <option key={u.id} value={u.id}>{u.code} · {u.type} · {u.home.code}</option>)}</select></label>
        <p className="muted" style={{ margin: 0 }}>{t('jobHint', 'Once a unit is on a job, its empty crew seats appear in the replacement center and the planner fills them.')}</p>
        <footer>
          <button type="button" onClick={onClose}>{t('cancel', 'Cancel')}</button>
          <button type="button" className="primary" disabled={busy || !f.wellName.trim() || !f.siteId || !f.serviceType || f.end < f.start} onClick={save}>{f.unitId ? t('createDeploy', 'Create and send unit') : t('createJob', 'Create job')}</button>
        </footer>
      </div>
    </Modal>
  )
}
