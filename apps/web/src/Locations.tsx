import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Building2, MapPin, Pencil, Plus, Trash2 } from 'lucide-react'
import { api } from './api'
import { Modal } from './dialogs'
import { PageGuide } from './guide'
import { errMsg, useApi, useLive } from './hooks'
import { useToast } from './ui'

interface Base { id: string; code: string; name: string; city: string | null; address: string | null; phone: string | null; _count: { units: number; employees: number; sites: number } }
interface Site { id: string; name: string; type: string; baseId: string; client: string | null; travelHours: number | null; accessNotes: string | null; base: { code: string; name: string } }

const SITE_TYPES = ['well', 'rig', 'field', 'camp', 'other']

/** Bases (where units and people are based) and sites (wells and rigs the jobs go to), added and edited by hand. */
export default function Locations() {
  const { t } = useTranslation()
  const toast = useToast()
  const bases = useApi<Base[]>('/bases')
  const sites = useApi<Site[]>('/sites')
  const { reload: reloadBases } = bases, { reload: reloadSites } = sites
  useLive(useCallback(() => { void reloadBases(); void reloadSites() }, [reloadBases, reloadSites]))
  const [base, setBase] = useState<Base | 'new' | null>(null)
  const [site, setSite] = useState<Site | 'new' | null>(null)

  const archiveBase = async (b: Base) => {
    if (!window.confirm(`${t('archiveBaseQ', 'Remove the base')} ${b.name}?`)) return
    try { await api(`/bases/${b.id}`, { method: 'DELETE' }); toast(`${b.name} ${t('removed', 'removed')}`); void bases.reload() } catch (e) { toast(errMsg(e), 'error') }
  }
  const deleteSite = async (s: Site) => {
    if (!window.confirm(`${t('deleteSiteQ', 'Delete the site')} ${s.name}?`)) return
    try { await api(`/sites/${s.id}`, { method: 'DELETE' }); toast(`${s.name} ${t('deleted', 'deleted')}`); void sites.reload(); void bases.reload() } catch (e) { toast(errMsg(e), 'error') }
  }

  return (
    <main className="page wide">
      <PageGuide id="locations" Icon={MapPin} color="var(--pal-teal-700)" title={t('locationsTitle', 'Locations')}
        purpose={t('locationsPurpose', 'Your bases and the sites (wells, rigs) your units are sent to.')}
        steps={[
          t('loStep1', 'A base is where trucks and people are based. A base with units or people on it cannot be removed; move them first.'),
          t('loStep2', 'A site belongs to a base. Jobs are created at a site ("New job" on the board or a unit).'),
        ]}>
        <button type="button" onClick={() => setBase('new')}><Building2 size={15} aria-hidden /> {t('addBase', 'Add a base')}</button>
        <button type="button" className="primary" onClick={() => setSite('new')} disabled={!bases.data?.length}><Plus size={15} aria-hidden /> {t('addSite', 'Add a site')}</button>
      </PageGuide>

      <section className="card2">
        <h2><Building2 size={16} aria-hidden /> {t('bases', 'Bases')}</h2>
        {bases.error && <div className="banner error" role="alert">{bases.error}</div>}
        <div className="table-scroll">
          <table className="table compact">
            <thead><tr><th>{t('name', 'Name')}</th><th>{t('code', 'Code')}</th><th>{t('city', 'City')}</th><th>{t('phone', 'Phone')}</th><th>{t('units', 'Units')}</th><th>{t('people', 'People')}</th><th>{t('sites', 'Sites')}</th><th /></tr></thead>
            <tbody>
              {bases.data?.map(b => (
                <tr key={b.id}>
                  <td><strong>{b.name}</strong>{b.address && <small className="muted unit-note">{b.address}</small>}</td>
                  <td>{b.code}</td><td>{b.city ?? <span className="muted">—</span>}</td><td>{b.phone ?? <span className="muted">—</span>}</td>
                  <td>{b._count.units}</td><td>{b._count.employees}</td><td>{b._count.sites}</td>
                  <td className="row-actions">
                    <button type="button" onClick={() => setBase(b)} aria-label={`${t('edit', 'Edit')} ${b.name}`} title={t('edit', 'Edit')}><Pencil size={14} aria-hidden /></button>
                    <button type="button" className="danger" onClick={() => void archiveBase(b)} aria-label={`${t('remove', 'Remove')} ${b.name}`} title={t('remove', 'Remove')}><Trash2 size={14} aria-hidden /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card2">
        <h2><MapPin size={16} aria-hidden /> {t('sites', 'Sites')}</h2>
        {sites.error && <div className="banner error" role="alert">{sites.error}</div>}
        {sites.data?.length === 0 && <p className="empty-note">{t('noSites', 'No sites yet. Add the wells and rigs your units go to.')}</p>}
        {!!sites.data?.length && (
          <div className="table-scroll">
            <table className="table compact">
              <thead><tr><th>{t('name', 'Name')}</th><th>{t('siteType', 'Type')}</th><th>{t('base', 'Base')}</th><th>{t('client', 'Client')}</th><th>{t('travel', 'Travel (h)')}</th><th>{t('accessNotes', 'Access notes')}</th><th /></tr></thead>
              <tbody>
                {sites.data.map(s => (
                  <tr key={s.id}>
                    <td><strong>{s.name}</strong></td><td>{s.type}</td><td>{s.base.name}</td><td>{s.client ?? <span className="muted">—</span>}</td>
                    <td>{s.travelHours ?? <span className="muted">—</span>}</td><td>{s.accessNotes ?? <span className="muted">—</span>}</td>
                    <td className="row-actions">
                      <button type="button" onClick={() => setSite(s)} aria-label={`${t('edit', 'Edit')} ${s.name}`} title={t('edit', 'Edit')}><Pencil size={14} aria-hidden /></button>
                      <button type="button" className="danger" onClick={() => void deleteSite(s)} aria-label={`${t('delete', 'Delete')} ${s.name}`} title={t('delete', 'Delete')}><Trash2 size={14} aria-hidden /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {base && <BaseForm base={base === 'new' ? null : base} onClose={() => setBase(null)} onDone={() => { setBase(null); void bases.reload() }} />}
      {site && <SiteForm site={site === 'new' ? null : site} bases={bases.data ?? []} onClose={() => setSite(null)} onDone={() => { setSite(null); void sites.reload(); void bases.reload() }} />}
    </main>
  )
}

function BaseForm({ base, onClose, onDone }: { base: Base | null; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const [f, setF] = useState({ name: base?.name ?? '', code: base?.code ?? '', city: base?.city ?? '', address: base?.address ?? '', phone: base?.phone ?? '' })
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    const body = { name: f.name.trim(), code: f.code.trim().toUpperCase(), city: f.city.trim() || null, address: f.address.trim() || null, phone: f.phone.trim() || null }
    try {
      await api(base ? `/bases/${base.id}` : '/bases', { method: base ? 'PUT' : 'POST', body })
      toast(`${body.name} ${t('saved', 'saved')}`); onDone()
    } catch (e) { toast(errMsg(e), 'error'); setBusy(false) }
  }
  return (
    <Modal title={base ? `${t('editBase', 'Edit base')} · ${base.name}` : t('addBase', 'Add a base')} onClose={onClose}>
      <div className="form2">
        <div className="row2">
          <label>{t('name', 'Name')} *<input value={f.name} onChange={set('name')} placeholder="In Amenas" autoFocus /></label>
          <label>{t('shortCode', 'Short code')} *<input value={f.code} onChange={set('code')} placeholder="INA" maxLength={8} /></label>
        </div>
        <div className="row2">
          <label>{t('city', 'City')}<input value={f.city} onChange={set('city')} /></label>
          <label>{t('phone', 'Phone')}<input value={f.phone} onChange={set('phone')} inputMode="tel" /></label>
        </div>
        <label>{t('address', 'Address')}<input value={f.address} onChange={set('address')} /></label>
        <footer>
          <button type="button" onClick={onClose}>{t('cancel', 'Cancel')}</button>
          <button type="button" className="primary" disabled={busy || !f.name.trim() || !f.code.trim()} onClick={() => void save()}>{t('save', 'Save')}</button>
        </footer>
      </div>
    </Modal>
  )
}

function SiteForm({ site, bases, onClose, onDone }: { site: Site | null; bases: Base[]; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const [f, setF] = useState({ name: site?.name ?? '', type: site?.type ?? 'well', baseId: site?.baseId ?? bases[0]?.id ?? '', client: site?.client ?? '', travelHours: site?.travelHours != null ? String(site.travelHours) : '', accessNotes: site?.accessNotes ?? '' })
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    const body = { name: f.name.trim(), type: f.type, baseId: f.baseId, client: f.client.trim() || null, travelHours: f.travelHours ? +f.travelHours : null, accessNotes: f.accessNotes.trim() || null }
    try {
      await api(site ? `/sites/${site.id}` : '/sites', { method: site ? 'PUT' : 'POST', body })
      toast(`${body.name} ${t('saved', 'saved')}`); onDone()
    } catch (e) { toast(errMsg(e), 'error'); setBusy(false) }
  }
  return (
    <Modal title={site ? `${t('editSite', 'Edit site')} · ${site.name}` : t('addSite', 'Add a site')} onClose={onClose}>
      <div className="form2">
        <div className="row2">
          <label>{t('name', 'Name')} *<input value={f.name} onChange={set('name')} placeholder="MDZ-12" autoFocus /></label>
          <label>{t('siteType', 'Type')}<select value={f.type} onChange={set('type')}>{SITE_TYPES.map(x => <option key={x} value={x}>{x}</option>)}</select></label>
        </div>
        <div className="row2">
          <label>{t('base', 'Base')} *<select value={f.baseId} onChange={set('baseId')}>{bases.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
          <label>{t('travel', 'Travel from base (hours)')}<input type="number" min={0} step={0.5} value={f.travelHours} onChange={set('travelHours')} /></label>
        </div>
        <label>{t('client', 'Client')}<input value={f.client} onChange={set('client')} /></label>
        <label>{t('accessNotes', 'Access notes')}<textarea rows={2} value={f.accessNotes} onChange={set('accessNotes')} /></label>
        <footer>
          <button type="button" onClick={onClose}>{t('cancel', 'Cancel')}</button>
          <button type="button" className="primary" disabled={busy || !f.name.trim() || !f.baseId} onClick={() => void save()}>{t('save', 'Save')}</button>
        </footer>
      </div>
    </Modal>
  )
}
