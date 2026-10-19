import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowRight, ClipboardList } from 'lucide-react'
import { PageGuide } from './guide'
import { useApi, useLive } from './hooks'
import { fmtDate, plural } from './labels'
import { Pill } from './ui'
import { PersonLink, SeatLabel } from './profiles'

interface Change {
  date: string; daysAway: number; seatId: string; seat: string
  outgoing: { id: string; name: string } | null; incoming: { id: string; name: string } | null
  status: 'confirmed' | 'suggested' | 'missing'; travel: { site: string; hours: number | null } | null
}
interface Data { from: string; days: number; changes: Change[]; counts: { confirmed: number; suggested: number; missing: number } }

/** Crew-change list (plan 11.3): every handover in the next 7 / 14 / 30 days and whether somebody is coming. */
export default function CrewChanges() {
  const { t, i18n } = useTranslation()
  const [days, setDays] = useState(14)
  const [baseId, setBaseId] = useState('')
  const bases = useApi<{ id: string; code: string }[]>('/bases')
  const data = useApi<Data>(`/calendar/crew-changes?days=${days}${baseId ? `&baseId=${baseId}` : ''}`)
  useLive(data.reload)
  const c = data.data

  const status = (s: Change['status']) =>
    s === 'confirmed' ? <Pill severity="ok">{t('confirmed', 'Confirmed')}</Pill>
      : s === 'suggested' ? <Pill severity="warn">{t('suggested', 'Suggested in a draft plan')}</Pill>
        : <Pill severity="bad">{t('missing', 'Nobody coming')}</Pill>

  return (
    <main className="page">
      <PageGuide id="changes" Icon={ClipboardList} color="#0d9488" title={t('changesTitle', 'Crew changes')}
        purpose={t('changesPurpose', 'Every handover in the coming days: who leaves a seat, who arrives, and whether someone is actually coming.')}
        steps={[
          t('ccStep1', 'Green rows are settled: someone is coming. Red rows have nobody to take over yet.'),
          t('ccStep2', 'Open the replacement center from a red row to find someone in time.'),
        ]} />
      <div className="filters">
        <div className="seg" role="group" aria-label="Range">
          {[7, 14, 30].map(n => <button key={n} type="button" className={days === n ? 'on' : ''} onClick={() => setDays(n)}>{n} {t('days', 'days')}</button>)}
        </div>
        <select value={baseId} onChange={e => setBaseId(e.target.value)} aria-label="Base">
          <option value="">{t('allBases', 'All bases')}</option>{bases.data?.map(b => <option key={b.id} value={b.id}>{b.code}</option>)}
        </select>
        <span className="spacer" />
        {c && <><Pill severity="ok">{c.counts.confirmed} {t('confirmed', 'Confirmed').toLowerCase()}</Pill><Pill severity={c.counts.suggested ? 'warn' : 'ok'}>{c.counts.suggested} {t('suggestedShort', 'suggested')}</Pill><Pill severity={c.counts.missing ? 'bad' : 'ok'}>{c.counts.missing} {t('missingShort', 'missing')}</Pill></>}
      </div>

      {data.error && <div className="banner error" role="alert">{data.error}</div>}
      {c && c.changes.length === 0 && <p className="empty-note">{t('noChanges', 'No crew changes in this period.')}</p>}
      {c && c.changes.length > 0 && (
        <table className="table">
          <thead><tr><th>{t('date', 'Date')}</th><th>{t('seat', 'Seat')}</th><th>{t('handover', 'Handover')}</th><th>{t('status', 'Status')}</th><th>{t('travel', 'Travel')}</th></tr></thead>
          <tbody>
            {c.changes.map(r => (
              <tr key={r.seatId + r.date} className={r.status === 'missing' ? 'row-bad' : ''}>
                <td className="nowrap"><strong>{fmtDate(r.date, i18n.language)}</strong><small className="why">{r.daysAway === 0 ? t('today', 'Today') : r.daysAway === 1 ? t('tomorrow', 'Tomorrow') : `${t('in', 'in')} ${plural(r.daysAway, 'day')}`}</small></td>
                <td><SeatLabel label={r.seat} /></td>
                <td className="handover">
                  <span>{r.outgoing ? <PersonLink id={r.outgoing.id}>{r.outgoing.name}</PersonLink> : <em className="muted">{t('newCrew', 'new crew')}</em>}</span>
                  <ArrowRight size={14} aria-hidden />
                  <span>{r.incoming ? <PersonLink id={r.incoming.id}>{r.incoming.name}</PersonLink> : <em className="gap-text">{t('nobody', 'nobody yet')}</em>}</span>
                </td>
                <td>{status(r.status)}{r.status === 'missing' && <a className="inline-link" href="#/replacements">{t('openCenter', 'Open replacement center')}</a>}</td>
                <td className="muted">{r.travel ? `${r.travel.site}${r.travel.hours ? ` · ${r.travel.hours} h` : ''}` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  )
}
