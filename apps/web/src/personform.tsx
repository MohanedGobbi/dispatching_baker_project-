import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { api } from './api'
import { Modal } from './dialogs'
import { errMsg, useApi } from './hooks'
import { SENIORITY_LABEL, useToast } from './ui'

/** A rank (setting people.ranks, highest first). It decides the seats someone takes and their level for the crew rules. */
export interface Rank { label: string; position: string; seniority: string }
const FALLBACK: Rank[] = [
  { label: 'Chef crew', position: 'Chief of Unit', seniority: 'SENIOR' },
  { label: 'Specialist', position: 'Field Operator', seniority: 'SENIOR' },
  { label: 'OP2', position: 'Field Operator', seniority: 'EXPERIENCED' },
  { label: 'OP3', position: 'Field Operator', seniority: 'JUNIOR' },
]
const LEVELS = ['SENIOR', 'EXPERIENCED', 'JUNIOR', 'NEW_RECRUIT']

export function useRanks() {
  const s = useApi<Record<string, unknown>>('/settings')
  const list = s.data?.['people.ranks']
  return { ranks: Array.isArray(list) ? (list as Rank[]) : FALLBACK, reload: s.reload }
}
export const rankOf = (ranks: Rank[], tags: string[]) => ranks.find(r => tags.includes(r.label))
export const rankOrder = (ranks: Rank[], tags: string[]) => { const r = rankOf(ranks, tags); return r ? ranks.indexOf(r) : ranks.length }
export const seatKind = (r: Rank) => (r.position === 'Chief of Unit' ? 'chief' : 'operator')

export interface PersonRow {
  id: string; employeeNo: string; firstName: string; lastName: string; phone: string | null; tags: string[]; active: boolean
  backToBackId: string | null; position: { name: string }; homeBase: { code: string }; seniority: string; status: string
}
interface Named { id: string; name: string }
interface Base { id: string; code: string; name: string }
interface Detail extends PersonRow {
  hireDate: string; homeBaseId: string; managerNotes?: string | null; seniorityOverride: string | null
  email: string | null; emergencyContact: string | null; homeCity: string | null; contractType: string
  qualifications: { qualificationId: string }[]
}

/** Add or edit one person: name, rank, contact, partner, skills, notes. Used on the People screen and the person panel. */
export function PersonForm({ id, onClose, onDone }: { id: string | null; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const { ranks } = useRanks()
  const detail = useApi<Detail>(id ? `/employees/${id}` : null)
  const list = useApi<{ items: PersonRow[] }>('/employees?limit=200')
  const people = useMemo(() => list.data?.items ?? [], [list.data])
  const positions = useApi<Named[]>('/catalogs/positions')
  const quals = useApi<Named[]>('/catalogs/qualifications')
  const bases = useApi<Base[]>('/bases')
  const nextNo = useMemo(() => {
    const n = Math.max(0, ...people.map(p => /^E(\d+)$/.exec(p.employeeNo)?.[1]).filter(Boolean).map(Number))
    return `E${String(n + 1).padStart(3, '0')}`
  }, [people])
  const blank = { firstName: '', lastName: '', employeeNo: '', rank: '', phone: '', email: '', emergencyContact: '', homeCity: '', contractType: 'permanent', hireDate: new Date().toISOString().slice(0, 10), homeBaseId: '', partnerId: '', notes: '' }
  const [f, setF] = useState(blank)
  const [skills, setSkills] = useState<Set<string> | null>(null)
  const [busy, setBusy] = useState(false)
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF(x => ({ ...x, [k]: e.target.value }))

  useEffect(() => {
    const d = detail.data
    if (!d) return
    setF({
      firstName: d.firstName, lastName: d.lastName, employeeNo: d.employeeNo, rank: rankOf(ranks, d.tags)?.label ?? '', phone: d.phone ?? '', email: d.email ?? '',
      emergencyContact: d.emergencyContact ?? '', homeCity: d.homeCity ?? '', contractType: d.contractType, hireDate: d.hireDate.slice(0, 10), homeBaseId: d.homeBaseId,
      partnerId: d.backToBackId ?? '', notes: d.managerNotes ?? '',
    })
    setSkills(new Set(d.qualifications.map(q => q.qualificationId)))
  }, [detail.data, ranks])
  useEffect(() => { if (!id && !f.rank && ranks.length) setF(x => ({ ...x, rank: ranks[ranks.length - 1].label })) }, [id, ranks, f.rank])
  useEffect(() => { if (!id && quals.data && !skills) setSkills(new Set(quals.data.map(q => q.id))) }, [id, quals.data, skills])
  useEffect(() => { if (!f.homeBaseId && bases.data?.length) setF(x => ({ ...x, homeBaseId: bases.data![0].id })) }, [bases.data, f.homeBaseId])

  const r = ranks.find(x => x.label === f.rank)
  const save = async () => {
    setBusy(true)
    try {
      const positionId = positions.data?.find(p => p.name === (r?.position ?? 'Field Operator'))?.id
      const before = detail.data
      const otherTags = (before?.tags ?? []).filter(x => !ranks.some(rr => rr.label === x))
      const s = (v: string) => v.trim() || null
      const body = {
        firstName: f.firstName.trim(), lastName: f.lastName.trim(), employeeNo: f.employeeNo.trim() || nextNo,
        phone: s(f.phone), email: s(f.email), emergencyContact: s(f.emergencyContact), homeCity: s(f.homeCity), contractType: f.contractType,
        hireDate: f.hireDate, homeBaseId: f.homeBaseId, managerNotes: s(f.notes), tags: r ? [r.label, ...otherTags] : otherTags,
        backToBackId: f.partnerId || null, ...(positionId ? { positionId } : {}),
      }
      const saved = id ? await api<{ id: string }>(`/employees/${id}`, { method: 'PUT', body }) : await api<{ id: string }>('/employees', { method: 'POST', body })
      // the rank's level (cleared when no rank is set, so it is worked out from the hire date again)
      if (!id || before?.seniorityOverride !== (r?.seniority ?? null)) {
        await api(`/employees/${saved.id}/seniority`, { method: 'PUT', body: r ? { level: r.seniority, reason: `Rank: ${r.label}` } : { level: null } })
      }
      // partners point at each other; an old partner is let go
      const oldPartner = before?.backToBackId ?? null
      if (oldPartner && oldPartner !== f.partnerId) await api(`/employees/${oldPartner}`, { method: 'PUT', body: { backToBackId: null } })
      if (f.partnerId && f.partnerId !== oldPartner) {
        const theirOld = people.find(p => p.id === f.partnerId)?.backToBackId
        if (theirOld && theirOld !== saved.id) await api(`/employees/${theirOld}`, { method: 'PUT', body: { backToBackId: null } })
        await api(`/employees/${f.partnerId}`, { method: 'PUT', body: { backToBackId: saved.id } })
      }
      const had = new Set(before?.qualifications.map(q => q.qualificationId) ?? [])
      for (const q of skills ?? []) if (!had.has(q)) await api(`/employees/${saved.id}/qualifications`, { method: 'POST', body: { qualificationId: q } })
      for (const q of had) if (!skills?.has(q)) await api(`/employees/${saved.id}/qualifications/${q}`, { method: 'DELETE' })
      toast(`${f.firstName} ${f.lastName} ${id ? t('saved', 'saved') : t('added', 'added')}`); onDone()
    } catch (e) { toast(errMsg(e), 'error'); setBusy(false) }
  }

  const loading = !!id && !detail.data
  return (
    <Modal title={id ? `${t('editPerson', 'Edit')} · ${f.firstName} ${f.lastName}` : t('addPerson', 'Add a person')} onClose={onClose}>
      {loading ? <p className="muted">{t('loading', 'Loading…')}</p> : (
        <div className="form2">
          <div className="row2">
            <label>{t('firstName', 'First name')} *<input value={f.firstName} onChange={set('firstName')} autoFocus /></label>
            <label>{t('lastName', 'Last name')} *<input value={f.lastName} onChange={set('lastName')} /></label>
          </div>
          <div className="row3">
            <label>{t('rank', 'Rank')}<select value={f.rank} onChange={set('rank')}>{ranks.map(x => <option key={x.label} value={x.label}>{x.label}</option>)}<option value="">{t('noRank', 'No rank set')}</option></select></label>
            <label>{t('empNo', 'Employee number')}<input value={f.employeeNo} onChange={set('employeeNo')} placeholder={nextNo} /></label>
            <label>{t('hireDate', 'Hire date')}<input type="date" value={f.hireDate} onChange={set('hireDate')} /></label>
          </div>
          <p className="muted" style={{ margin: 0 }}>{r ? `${r.label}: ${seatKind(r) === 'chief' ? t('rankChief', 'takes chief seats') : t('rankOp', 'takes operator seats')}, ${(SENIORITY_LABEL[r.seniority] ?? r.seniority).toLowerCase()} ${t('forRules', 'for the crew rules')}.` : t('rankNone', 'Without a rank the level is worked out from the hire date.')}</p>
          <div className="row2">
            <label>{t('phone', 'Phone')}<input value={f.phone} onChange={set('phone')} inputMode="tel" /></label>
            <label>{t('email', 'Email')}<input type="email" value={f.email} onChange={set('email')} /></label>
          </div>
          <div className="row2">
            <label>{t('emergencyContact', 'Emergency contact')}<input value={f.emergencyContact} onChange={set('emergencyContact')} /></label>
            <label>{t('homeCity', 'Home city')}<input value={f.homeCity} onChange={set('homeCity')} /></label>
          </div>
          <div className="row2">
            <label>{t('contract', 'Contract')}<select value={f.contractType} onChange={set('contractType')}>{['permanent', 'fixed-term', 'contractor', 'trainee'].map(c => <option key={c} value={c}>{c}</option>)}</select></label>
            <label>{t('homeBase', 'Home base')}<select value={f.homeBaseId} onChange={set('homeBaseId')}>{bases.data?.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
          </div>
          <label>{t('partner', 'Back-to-back partner')}
            <select value={f.partnerId} onChange={set('partnerId')}>
              <option value="">{t('noPartner', 'None')}</option>
              {[...people].filter(p => p.id !== id && p.active).sort((a, b) => a.lastName.localeCompare(b.lastName)).map(p => <option key={p.id} value={p.id}>{p.lastName} {p.firstName} · {rankOf(ranks, p.tags)?.label ?? p.position.name}{p.backToBackId && p.backToBackId !== id ? ` (${t('hasPartner', 'has a partner')})` : ''}</option>)}
            </select>
          </label>
          <fieldset className="checks">
            <legend>{t('skills', 'Can work on')}</legend>
            {quals.data?.map(q => (
              <label key={q.id} className="check"><input type="checkbox" checked={!!skills?.has(q.id)} onChange={e => { const n = new Set(skills); if (e.target.checked) n.add(q.id); else n.delete(q.id); setSkills(n) }} /> {q.name}</label>
            ))}
          </fieldset>
          <label>{t('notes', 'Notes')}<textarea rows={2} value={f.notes} onChange={set('notes')} /></label>
          <footer>
            <button type="button" onClick={onClose}>{t('cancel', 'Cancel')}</button>
            <button type="button" className="primary" disabled={busy || !f.firstName.trim() || !f.lastName.trim() || !f.homeBaseId} onClick={() => void save()}>{id ? t('save', 'Save') : t('addPerson', 'Add a person')}</button>
          </footer>
        </div>
      )}
    </Modal>
  )
}

/** Edit the ranks: rename, add, remove, reorder, and choose the seats and level each one gives. */
export function ManageRanks({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const { ranks } = useRanks()
  const [rows, setRows] = useState<(Rank & { was?: string })[] | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (!rows) setRows(ranks.map(r => ({ ...r, was: r.label }))) }, [ranks, rows])
  const list = rows ?? []
  const upd = (i: number, patch: Partial<Rank>) => setRows(list.map((r, n) => (n === i ? { ...r, ...patch } : r)))
  const move = (i: number, d: number) => { const n = [...list]; const [x] = n.splice(i, 1); n.splice(i + d, 0, x); setRows(n) }
  const removed = ranks.filter(r => !list.some(x => x.was === r.label))
  const save = async () => {
    setBusy(true)
    try { await api('/ranks', { method: 'PUT', body: { ranks: list } }); toast(t('ranksSaved', 'Ranks saved')); onDone() } catch (e) { toast(errMsg(e), 'error'); setBusy(false) }
  }
  return (
    <Modal title={t('manageRanks', 'Ranks')} onClose={onClose} wide>
      <div className="form2">
        <p className="muted" style={{ margin: 0 }}>{t('ranksHelp', 'Highest first. Renaming a rank renames it on everyone who has it; changing its seats or level updates them too.')}</p>
        <div className="rank-rows">
          {list.map((r, i) => (
            <div key={i} className="rank-row">
              <input value={r.label} onChange={e => upd(i, { label: e.target.value })} aria-label={t('rankName', 'Rank name')} placeholder={t('rankName', 'Rank name')} />
              <select value={r.position} onChange={e => upd(i, { position: e.target.value })} aria-label={t('seats', 'Seats')}>
                <option value="Chief of Unit">{t('chiefSeats', 'Chief seats')}</option><option value="Field Operator">{t('operatorSeats', 'Operator seats')}</option>
              </select>
              <select value={r.seniority} onChange={e => upd(i, { seniority: e.target.value })} aria-label={t('level', 'Level')}>
                {LEVELS.map(l => <option key={l} value={l}>{SENIORITY_LABEL[l]}</option>)}
              </select>
              <span className="row-actions">
                <button type="button" disabled={i === 0} onClick={() => move(i, -1)} aria-label={t('up', 'Move up')}><ArrowUp size={14} aria-hidden /></button>
                <button type="button" disabled={i === list.length - 1} onClick={() => move(i, 1)} aria-label={t('down', 'Move down')}><ArrowDown size={14} aria-hidden /></button>
                <button type="button" className="danger" disabled={list.length === 1} onClick={() => setRows(list.filter((_, n) => n !== i))} aria-label={`${t('delete', 'Delete')} ${r.label}`}><Trash2 size={14} aria-hidden /></button>
              </span>
            </div>
          ))}
        </div>
        <button type="button" onClick={() => setRows([...list, { label: '', position: 'Field Operator', seniority: 'JUNIOR' }])} style={{ justifySelf: 'start' }}><Plus size={14} aria-hidden /> {t('addRank', 'Add a rank')}</button>
        {removed.length > 0 && <p className="note">{t('rankRemoved', 'Removed')}: {removed.map(r => r.label).join(', ')}. {t('rankRemovedHelp', 'People with these ranks keep their seats but lose the rank.')}</p>}
        <footer>
          <button type="button" onClick={onClose}>{t('cancel', 'Cancel')}</button>
          <button type="button" className="primary" disabled={busy || list.some(r => !r.label.trim())} onClick={() => void save()}>{t('save', 'Save')}</button>
        </footer>
      </div>
    </Modal>
  )
}
