import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowRight, Sparkles, Users } from 'lucide-react'
import { addDaysIso, Modal } from './dialogs'
import { useApi } from './hooks'
import { RULE_LABEL } from './labels'
import type { Person, SeatCard, UnitCardData } from './types'
import { initials, SENIORITY_LABEL, STATUS_META } from './ui'
import { PersonLink } from './profiles'

interface Suggest { candidates: { employeeId: string; score: number; explanation: string; employee?: string }[]; ruledOut: { employeeId: string; because: string[] }[] }
export interface FreePerson extends Person { status: string }

const SEN_COLOR: Record<string, string> = { NEW_RECRUIT: 'var(--pal-amber-700)', JUNIOR: 'var(--pal-sky-700)', EXPERIENCED: 'var(--pal-green-700)', SENIOR: 'var(--pal-violet-700)' }

/**
 * Click "Assign" on an empty seat: the planner's best picks for it, or anyone free today, searchable.
 * Choosing someone opens the usual rule check before anything is saved.
 */
export function AssignPicker({ seat, unit, date, free, onPick, onClose }: {
  seat: SeatCard; unit: UnitCardData; date: string; free: FreePerson[]
  onPick: (p: Person, end: string) => void; onClose: () => void
}) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<'best' | 'all'>('best')
  const [q, setQ] = useState('')
  const [days, setDays] = useState(7)
  const end = addDaysIso(date, days - 1)
  const sug = useApi<Suggest>(`/planning/seats/${seat.seatId}/suggestions?start=${date}&end=${end}&top=8`)
  const reasons = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of sug.data?.ruledOut ?? []) for (const b of r.because) m.set(b, (m.get(b) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [sug.data])
  const maxReason = reasons[0]?.[1] ?? 1
  const byId = useMemo(() => new Map(free.map(p => [p.id, p])), [free])
  const best = sug.data?.candidates ?? []
  const top = best[0]?.score || 1

  const list = useMemo(() => {
    const s = q.trim().toLowerCase()
    return free
      .filter(p => !s || p.name.toLowerCase().includes(s) || p.employeeNo.toLowerCase().includes(s))
      .sort((a, b) => Number(b.position === seat.position) - Number(a.position === seat.position)
        || Number(b.status === 'STANDBY') - Number(a.status === 'STANDBY')
        || a.name.localeCompare(b.name))
  }, [free, q, seat.position])

  const person = (id: string, name?: string): Person => byId.get(id) ?? { id, name: name ?? '?', employeeNo: '', position: seat.position, base: '', seniority: 'JUNIOR', tags: [], restrictions: [] }

  return (
    <Modal wide title={t('pickTitle', 'Who should take this seat?')} onClose={onClose}>
      <div className="picker">
        <div className="picker-seat">
          <strong>{unit.code}</strong><ArrowRight size={14} aria-hidden /><span>{seat.position} #{seat.index}</span>
          {seat.requirements.qualification && <span className="tag2" style={{ ['--c' as string]: unit.colorKey === 'amber' ? 'var(--ch)' : 'var(--oh)' }}>{seat.requirements.qualification}</span>}
          {seat.requirements.minSeniority && <span className="tag2" style={{ ['--c' as string]: 'var(--pal-green-600)' }}>{SENIORITY_LABEL[seat.requirements.minSeniority]}+</span>}
          <span className="muted">{t('from', 'from')} {date}</span>
          <span className="seg-days" role="group" aria-label={t('howLong', 'For how long')}>
            <span className="muted">{t('forHowLong', 'for')}</span>
            {[3, 7, 14, 28].map(d => <button key={d} type="button" className={days === d ? 'on' : ''} onClick={() => setDays(d)}>{d} {t('daysShort', 'days')}</button>)}
          </span>
        </div>
        <div className="picker-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'best'} className={tab === 'best' ? 'on' : ''} onClick={() => setTab('best')}><Sparkles size={14} aria-hidden /> {t('pickBest', 'Best matches')}</button>
          <button type="button" role="tab" aria-selected={tab === 'all'} className={tab === 'all' ? 'on' : ''} onClick={() => setTab('all')}><Users size={14} aria-hidden /> {t('pickAll', 'Everyone free today')} ({free.length})</button>
        </div>

        {tab === 'best' && (
          <>
            <p className="muted" style={{ marginTop: 0 }}>{t('pickBestHint', 'Ranked by the planner: qualified, rested, fair, and close to this base. Everyone shown follows the rules.')}</p>
            {sug.loading && <p className="muted">{t('checking', 'Checking the rules…')}</p>}
            {sug.error && <p className="error">{sug.error}</p>}
            {sug.data && best.length === 0 && <p className="empty-note">{days > 3 ? t('noCandidatesShorter', 'Nobody can cover all of these days without breaking a rule. Try a shorter stretch above, or pick from "Everyone free today" with a reason.') : t('noCandidates', 'Nobody can take this seat without breaking a rule. Pick from "Everyone free today" and give a reason.')}</p>}
            <ul className="pick-list">
              {best.map((c, i) => {
                const p = byId.get(c.employeeId)
                return (
                  <li key={c.employeeId} className={i === 0 ? 'best' : ''}>
                    <span className="rank" style={{ ['--c' as string]: i === 0 ? 'var(--pal-green-600)' : i < 3 ? 'var(--pal-blue-600)' : 'var(--pal-slate-500)' }}>{i + 1}</span>
                    <span className="who2">
                      <strong><PersonLink id={c.employeeId}>{c.employee}</PersonLink>{p && <small> · {p.position} · {p.base}</small>}</strong>
                      <span className="scorebar" title={`score ${c.score.toFixed(1)}`}><i style={{ width: `${Math.max(8, (c.score / top) * 100)}%` }} /></span>
                      <small>{c.explanation}</small>
                    </span>
                    <button type="button" className={i === 0 ? 'primary' : ''} onClick={() => onPick(person(c.employeeId, c.employee), end)}>{t('choose', 'Choose')}</button>
                  </li>
                )
              })}
            </ul>
            {reasons.length > 0 && (
              <details className="ruled-out" open={best.length === 0}>
                <summary>{t('whyOthers', 'Why others were ruled out')} ({sug.data?.ruledOut.length})</summary>
                <div className="reasons" style={{ marginTop: 8 }}>
                  {reasons.map(([k, n]) => <div key={k} className="reason-row"><span>{RULE_LABEL[k] ?? k}</span><div><i style={{ width: `${(n / maxReason) * 100}%` }} /></div><b>{n}</b></div>)}
                </div>
              </details>
            )}
          </>
        )}

        {tab === 'all' && (
          <>
            <input className="search2" value={q} onChange={e => setQ(e.target.value)} placeholder={t('searchPerson', 'Name or employee number')} autoFocus />
            <p className="muted" style={{ marginTop: 0 }}>{t('pickAllHint', 'People on standby or on days off. Calling someone back from days off needs a reason; the next step shows any rule that would be broken.')}</p>
            <ul className="pick-list">
              {list.map(p => {
                const st = STATUS_META[p.status] ?? STATUS_META.STANDBY
                return (
                  <li key={p.id}>
                    <span className="rank" style={{ ['--c' as string]: SEN_COLOR[p.seniority] ?? 'var(--pal-slate-500)' }} title={SENIORITY_LABEL[p.seniority]}>{initials(p.name)}</span>
                    <span className="who2">
                      <strong><PersonLink id={p.id}>{p.name}</PersonLink> <small>· {p.position} · {p.base}</small></strong>
                      <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                        <span className="st-dot" style={{ ['--c' as string]: st.color }}>{st.label}</span>
                        <span className="tag2" style={{ ['--c' as string]: SEN_COLOR[p.seniority] }}>{SENIORITY_LABEL[p.seniority]}</span>
                        {p.tags.filter(x => x === 'OH' || x === 'CH').map(x => <span key={x} className={`tag tag-${x}`}>{x}</span>)}
                        {p.position !== seat.position && <span className="tag2" style={{ ['--c' as string]: 'var(--pal-red-600)' }}>{t('otherPosition', 'other position')}</span>}
                      </span>
                    </span>
                    <button type="button" onClick={() => onPick(p, end)}>{t('choose', 'Choose')}</button>
                  </li>
                )
              })}
              {list.length === 0 && <li className="muted">{t('noPeople', 'Nobody matches.')}</li>}
            </ul>
          </>
        )}
      </div>
    </Modal>
  )
}
