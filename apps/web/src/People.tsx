import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Archive, ListOrdered, Pencil, Plus, Users } from 'lucide-react'
import { api } from './api'
import { BulkBar, RowBox, SelectAllBox, useSelection } from './bulk'
import { Modal } from './dialogs'
import { PageGuide } from './guide'
import { errMsg, useApi, useLive } from './hooks'
import { ManageRanks, PersonForm, rankOf, rankOrder, seatKind, useRanks } from './personform'
import type { PersonRow } from './personform'
import { PersonLink } from './profiles'
import { useQuick } from './quickctx'
import { SENIORITY_LABEL, STATUS_META, useToast } from './ui'

const LEVELS = ['SENIOR', 'EXPERIENCED', 'JUNIOR', 'NEW_RECRUIT']

/** Everyone in the company: add people, change their rank or details, pair back-to-back partners, archive leavers. */
export default function People() {
  const { t } = useTranslation()
  const toast = useToast()
  const { ranks, reload: reloadRanks } = useRanks()
  const [text, setText] = useState('')
  const [rank, setRank] = useState('')
  const [archived, setArchived] = useState(false)
  const list = useApi<{ total: number; items: PersonRow[] }>(`/employees?limit=200${archived ? '&active=false' : ''}`)
  useLive(list.reload)
  const [editing, setEditing] = useState<string | null>(null) // employee id, or 'new'
  const [leaving, setLeaving] = useState<PersonRow | null>(null)
  const [ranking, setRanking] = useState(false)
  const [busy, setBusy] = useState(false)
  const bases = useApi<{ id: string; code: string; name: string }[]>('/bases')
  const quick = useQuick()

  const all = useMemo(() => list.data?.items ?? [], [list.data])
  const byId = useMemo(() => new Map(all.map(p => [p.id, p])), [all])
  const q = text.trim().toLowerCase()
  const rows = all
    .filter(p => !rank || (rank === '-' ? !rankOf(ranks, p.tags) : p.tags.includes(rank)))
    .filter(p => !q || `${p.firstName} ${p.lastName} ${p.lastName} ${p.firstName} ${p.employeeNo} ${p.phone ?? ''}`.toLowerCase().includes(q))
    .sort((a, b) => rankOrder(ranks, a.tags) - rankOrder(ranks, b.tags) || a.lastName.localeCompare(b.lastName))
  const pick = useSelection(rows.map(p => p.id))

  const applyBulk = async (action: string, value: string) => {
    setBusy(true)
    try {
      const r = await api<{ updated: number }>('/employees/bulk', { method: 'POST', body: { ids: pick.ids, action, value } })
      toast(`${r.updated} ${t('peopleUpdated', 'people updated')}`); await list.reload()
    } catch (e) { toast(errMsg(e), 'error') }
    setBusy(false)
  }

  return (
    <main className="page wide">
      <PageGuide id="people" Icon={Users} color="var(--pal-indigo-600)" title={t('peopleTitle', 'People')}
        purpose={t('peoplePurpose', 'Everyone in the crews: their rank, back-to-back partner and details. Add or change anyone by hand.')}
        steps={[
          t('peStep1', 'The rank sets whether someone takes chief or operator seats and how experienced they count for the crew rules. "Ranks" lets you rename, add or reorder them.'),
          t('peStep2', 'Back-to-back partners share a seat: one is on while the other is off. Setting a partner links both people.'),
          t('peStep3', 'Archive someone who leaves: their seats are freed and appear in the replacement center.'),
        ]}>
        <button type="button" onClick={() => setRanking(true)}><ListOrdered size={15} aria-hidden /> {t('manageRanks', 'Ranks')}</button>
        <button type="button" className="primary" onClick={() => setEditing('new')}><Plus size={15} aria-hidden /> {t('addPerson', 'Add a person')}</button>
      </PageGuide>

      <section className="kpis2" aria-label={t('peopleByRank', 'People by rank')}>
        <button type="button" className={`kpi2${rank === '' ? ' on' : ''}`} style={{ ['--c' as string]: 'var(--pal-slate-700)' }} onClick={() => setRank('')} aria-pressed={rank === ''}>
          <Users size={22} className="k-icon" aria-hidden /><strong>{all.length}</strong><span>{archived ? t('archivedPeople', 'Archived') : t('everyone', 'Everyone')}</span>
        </button>
        {ranks.map(r => (
          <button key={r.label} type="button" className={`kpi2${rank === r.label ? ' on' : ''}`} style={{ ['--c' as string]: seatKind(r) === 'chief' ? 'var(--pal-violet-700)' : 'var(--pal-blue-700)' }} onClick={() => setRank(rank === r.label ? '' : r.label)} aria-pressed={rank === r.label}>
            <strong>{all.filter(p => p.tags.includes(r.label)).length}</strong><span>{r.label}</span><small>{SENIORITY_LABEL[r.seniority]}</small>
          </button>
        ))}
      </section>

      <div className="filters">
        <input value={text} onChange={e => setText(e.target.value)} placeholder={t('personSearch', 'Name, number or phone')} aria-label={t('search', 'Search')} />
        <select value={rank} onChange={e => setRank(e.target.value)} aria-label={t('rank', 'Rank')}>
          <option value="">{t('anyRank', 'Any rank')}</option>{ranks.map(r => <option key={r.label} value={r.label}>{r.label}</option>)}<option value="-">{t('noRank', 'No rank set')}</option>
        </select>
        <label className="check"><input type="checkbox" checked={archived} onChange={e => setArchived(e.target.checked)} /> {t('showArchived', 'Archived people')}</label>
        <span className="spacer" /><span className="muted">{rows.length} / {all.length}</span>
      </div>
      {list.error && <div className="banner error" role="alert">{list.error}</div>}

      <BulkBar count={pick.count} busy={busy} onApply={applyBulk} onClear={pick.clear}
        fields={[
          { key: 'rank', label: t('setRank', 'Rank'), options: ranks.map(r => ({ value: r.label, label: r.label })) },
          { key: 'seniority', label: t('setLevel', 'Level'), options: [...LEVELS.map(l => ({ value: l, label: SENIORITY_LABEL[l] })), { value: '', label: t('levelFromRank', 'from the rank again') }] },
          { key: 'homeBase', label: t('setBase', 'Base'), options: (bases.data ?? []).map(b => ({ value: b.id, label: b.name })) },
        ]} />

      <div className="table-scroll">
        <table className="table compact">
          <thead><tr><th className="pick-col"><SelectAllBox all={pick.all} some={pick.some} onChange={pick.toggleAll} label={t('selectAll', 'Select everyone shown')} /></th><th>{t('name', 'Name')}</th><th>{t('empNo', 'No.')}</th><th>{t('rank', 'Rank')}</th><th>{t('level', 'Level')}</th><th>{t('today', 'Today')}</th><th>{t('partner', 'Back-to-back partner')}</th><th>{t('phone', 'Phone')}</th><th /></tr></thead>
          <tbody>
            {rows.map(p => {
              const st = STATUS_META[p.status] ?? STATUS_META.STANDBY
              const partner = p.backToBackId ? byId.get(p.backToBackId) : undefined
              return (
                <tr key={p.id} className={pick.has(p.id) ? 'picked' : ''}>
                  <td className="pick-col"><RowBox on={pick.has(p.id)} onChange={on => pick.toggle(p.id, on)} label={`${p.firstName} ${p.lastName}`} /></td>
                  <td><strong><PersonLink id={p.id}>{p.firstName} {p.lastName}</PersonLink></strong></td>
                  <td>{p.employeeNo}</td>
                  <td>{rankOf(ranks, p.tags)?.label ?? <span className="muted">{p.position.name}</span>}</td>
                  <td>{SENIORITY_LABEL[p.seniority] ?? p.seniority}</td>
                  <td><span className="st-dot" style={{ ['--c' as string]: st.color }}>{st.label}</span></td>
                  <td>{partner ? <PersonLink id={partner.id}>{partner.firstName} {partner.lastName}</PersonLink> : p.backToBackId ? <span className="muted">{t('archivedPartner', 'archived')}</span> : <span className="muted">—</span>}</td>
                  <td>{p.phone ?? <span className="muted">—</span>}</td>
                  <td className="row-actions">
                    {quick && <button type="button" onClick={e => { const b = e.currentTarget.getBoundingClientRect(); quick(p.id, { x: b.left - 200, y: b.bottom + 4 }) }} aria-label={`${t('quickActions', 'Quick actions')} ${p.firstName} ${p.lastName}`} title={t('quickActionsHint', 'Medical leave, days off, extend, rotation')}>⋯</button>}
                    <button type="button" onClick={() => setEditing(p.id)} aria-label={`${t('edit', 'Edit')} ${p.firstName} ${p.lastName}`} title={t('edit', 'Edit')}><Pencil size={14} aria-hidden /></button>
                    {p.active && <button type="button" className="danger" onClick={() => setLeaving(p)} aria-label={`${t('archive', 'Archive')} ${p.firstName} ${p.lastName}`} title={t('archive', 'Archive (left the company)')}><Archive size={14} aria-hidden /></button>}
                  </td>
                </tr>
              )
            })}
            {list.data && rows.length === 0 && <tr><td colSpan={9} className="muted">{t('noPeopleMatch', 'Nobody matches.')}</td></tr>}
          </tbody>
        </table>
      </div>

      {editing && <PersonForm id={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); void list.reload() }} />}
      {ranking && <ManageRanks onClose={() => setRanking(false)} onDone={() => { setRanking(false); setRank(''); void reloadRanks(); void list.reload() }} />}
      {leaving && (
        <Modal title={`${t('archive', 'Archive')} ${leaving.firstName} ${leaving.lastName}?`} onClose={() => setLeaving(null)}>
          <p>{t('archiveText', 'Use this when someone leaves the company. Their current and future seats are freed (they show up in the replacement center) and their partner link is removed. Their history stays.')}</p>
          <footer>
            <button type="button" onClick={() => setLeaving(null)}>{t('cancel', 'Cancel')}</button>
            <button type="button" className="primary danger-fill" onClick={async () => {
              try {
                const r = await api<{ replacementTasks: number }>(`/employees/${leaving.id}/archive`, { method: 'POST', body: {} })
                toast(`${leaving.firstName} ${leaving.lastName} ${t('archivedLc', 'archived')}${r.replacementTasks ? ` · ${r.replacementTasks} ${t('seatsFreed', 'seat(s) to cover')}` : ''}`)
                setLeaving(null); void list.reload()
              } catch (e) { toast(errMsg(e), 'error') }
            }}>{t('archive', 'Archive')}</button>
          </footer>
        </Modal>
      )}
    </main>
  )
}
