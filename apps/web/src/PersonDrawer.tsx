import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { api } from './api'
import type { PersonalCalendar } from './types'
import { STATUS_META } from './ui'

const addDays = (iso: string, n: number) => new Date(Date.parse(iso) + n * 86_400_000).toISOString().slice(0, 10)

/** Details open in a side drawer so the dispatcher never loses their place on the board (plan 27.2 #6). */
export default function PersonDrawer({ id, date, onClose }: { id: string; date: string; onClose: () => void }) {
  const { t } = useTranslation()
  const [cal, setCal] = useState<PersonalCalendar | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let live = true
    setCal(null); setError('')
    api<PersonalCalendar>(`/calendar/employees/${id}?from=${date}&to=${addDays(date, 41)}`).then(c => { if (live) setCal(c) }).catch(e => { if (live) setError(String(e.message ?? e)) })
    return () => { live = false }
  }, [id, date])

  const today = cal?.summary.today
  const meta = today ? STATUS_META[today.status] : undefined
  return (
    <aside className="drawer" aria-label="Person details">
      <header>
        <h2>{cal ? `${cal.employee.firstName} ${cal.employee.lastName}` : '…'}</h2>
        <button type="button" aria-label="Close" onClick={onClose}><X size={18} /></button>
      </header>
      {error && <p className="error">{error}</p>}
      {cal && <>
        <p className="muted">{cal.employee.employeeNo} · {cal.employee.homeBase.code}</p>
        {meta && <p className="status-line" style={{ color: meta.color }}><meta.Icon size={16} aria-hidden /> <strong>{meta.label}</strong>{today?.label ? ` · ${today.label}` : ''}</p>}
        <dl className="facts">
          <dt>{t('nextDaysOff', 'Next days off')}</dt><dd>{cal.summary.nextDaysOff ?? '—'}</dd>
          <dt>{t('backOn', 'Back on')}</dt><dd>{cal.summary.nextBackOn ?? '—'}</dd>
        </dl>
        <h3>{t('next6Weeks', 'Next 6 weeks')}</h3>
        <div className="strip" role="img" aria-label="Status for each of the next 42 days">
          {cal.days.map(d => <i key={d.date} title={`${d.date} · ${STATUS_META[d.status]?.label ?? d.status}${d.label ? ` · ${d.label}` : ''}`} style={{ background: STATUS_META[d.status]?.color ?? 'var(--border)' }} />)}
        </div>
        <ul className="legend">
          {[...new Set(cal.days.map(d => d.status))].map(s => <li key={s}><i style={{ background: STATUS_META[s]?.color }} />{STATUS_META[s]?.label ?? s}</li>)}
        </ul>
      </>}
    </aside>
  )
}
