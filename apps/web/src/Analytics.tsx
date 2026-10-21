import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, BarChart3 } from 'lucide-react'
import { PageGuide } from './guide'
import { useApi, useLive } from './hooks'
import { fmtDate } from './labels'
import { Pill } from './ui'
import { UnitLink } from './profiles'

interface Point { date: string; required: number; available: number }
interface Heat { date: string; ratio: number | null; worst: string | null }
interface Forecast {
  dates: string[]; total: Record<string, Point[]>
  scopes: { id: string; code: string; series: Record<string, Point[]>; heat: Heat[] }[]
  shortages: { scope: string; profile: string; from: string; to: string; days: number; peakDeficit: number; worstRatio: number }[]
  profiles: { key: string; label: string }[]
}
interface Overview {
  date: string; headcount: Record<string, number>; unitsByBase: Record<string, Record<string, number>>
  crews: { deployed: number; compliant: number; nonCompliant: { id: string; code: string; base: string; type: string; required: number; filled: number; issues: string[] }[] }
  openTasks: Record<string, number>; crewChangesNext7Days: number
}

const STATUS_COLOR: Record<string, string> = { ON_UNIT: 'var(--st-unit)', ON_BASE_POST: 'var(--st-base)', STANDBY: 'var(--st-standby)', DAYS_OFF: 'var(--st-off)', UNAVAILABLE: 'var(--st-medical)', ON_LEAVE: 'var(--st-leave)', AWAITING_CLEARANCE: 'var(--st-clearance)' }
const STATUS_NAME: Record<string, string> = { ON_UNIT: 'On a unit', ON_BASE_POST: 'Base post', STANDBY: 'Standby', DAYS_OFF: 'Days off', UNAVAILABLE: 'Unavailable', ON_LEAVE: 'Away', AWAITING_CLEARANCE: 'Awaiting clearance' }
const UNIT_COLOR: Record<string, string> = { DEPLOYED: 'var(--pal-blue-600)', AVAILABLE: 'var(--pal-green-600)', UNDER_MAINTENANCE: 'var(--pal-amber-700)', OUT_OF_SERVICE: 'var(--pal-slate-500)', IN_TRANSIT: 'var(--pal-violet-600)' }
const UNIT_NAME: Record<string, string> = { DEPLOYED: 'On a job', AVAILABLE: 'Available', UNDER_MAINTENANCE: 'In the workshop', OUT_OF_SERVICE: 'Out of service', IN_TRANSIT: 'In transit' }
const WEEKS = 12

/** Coverage colour: red under 70 %, amber under 100 %, green from 100 %, grey when nothing is required. */
const heatColor = (r: number | null) => r === null ? 'var(--border)' : r >= 1 ? 'var(--pal-green-200)' : r >= 0.7 ? 'var(--pal-amber-200)' : 'var(--pal-red-300)'

function Card({ label, value, detail, tone }: { label: string; value: string | number; detail?: string; tone?: 'ok' | 'warn' | 'bad' }) {
  return <div className={`an-card${tone ? ' ' + tone : ''}`}><span className="an-label">{label}</span><strong>{value}</strong>{detail && <small className="muted">{detail}</small>}</div>
}

/** The whole analytics area in one page: today's key numbers, a few simple charts, and the coming weeks' coverage. */
export default function Analytics() {
  const { t } = useTranslation()
  const ov = useApi<Overview>('/analytics/overview')
  const fc = useApi<Forecast>(`/analytics/forecast?days=${WEEKS * 7}`)
  useLive(() => { void ov.reload(); void fc.reload() })
  const o = ov.data, f = fc.data

  const totalPeople = o ? Object.values(o.headcount).reduce((a, b) => a + b, 0) : 0
  const openTasks = o ? Object.values(o.openTasks).reduce((a, b) => a + b, 0) : 0
  const unitStatus = useMemo(() => {
    const m = new Map<string, number>()
    for (const s of Object.values(o?.unitsByBase ?? {})) for (const [k, v] of Object.entries(s)) m.set(k, (m.get(k) ?? 0) + v)
    return m
  }, [o])
  const units = [...unitStatus.values()].reduce((a, b) => a + b, 0)

  // Worst coverage of each week, per base, from the daily forecast.
  const weekly = useMemo(() => {
    if (!f) return []
    const rows = [{ id: 'all', code: t('anAllBases', 'All bases'), heat: f.dates.map((date, i) => {
      let ratio: number | null = null
      for (const series of Object.values(f.total)) { const s = series[i]; if (!s || s.required === 0) continue; const r = s.available / s.required; if (ratio === null || r < ratio) ratio = r }
      return { date, ratio, worst: null } as Heat
    }) }, ...f.scopes.filter(s => s.id !== 'all')]
    return rows.map(r => ({
      id: r.id, code: r.code,
      weeks: Array.from({ length: WEEKS }, (_, w) => {
        const days = r.heat.slice(w * 7, w * 7 + 7).map(h => h.ratio).filter((x): x is number => x !== null)
        return { from: r.heat[w * 7]?.date ?? '', ratio: days.length ? Math.min(...days) : null }
      }),
    }))
  }, [f, t])
  const shortages = (f?.shortages ?? []).filter(s => s.scope === 'all').sort((a, b) => a.from.localeCompare(b.from)).slice(0, 4)
  const profileName = (k: string) => f?.profiles.find(p => p.key === k)?.label ?? k

  return (
    <main className="page wide">
      <PageGuide id="analytics" Icon={BarChart3} color="var(--pal-green-600)" title={t('anTitle', 'Analytics')}
        purpose={t('anPurpose', 'How the company stands today and where it will be short of people in the coming weeks.')}
        steps={[
          t('anStep1', 'The numbers at the top are today. Red means something needs you.'),
          t('anStep2', 'The charts show who is doing what and how the fleet is used.'),
          t('anStep3', 'The coverage table looks 12 weeks ahead: red weeks are short of people, so plan or recall someone before then.'),
        ]} />
      {(ov.error || fc.error) && <div className="banner error" role="alert">{ov.error || fc.error}</div>}

      {o && (
        <section className="an-kpis" aria-label="Today">
          <Card label={t('anPeople', 'People')} value={totalPeople} />
          <Card label={t('anUnitsOn', 'Units on a job')} value={unitStatus.get('DEPLOYED') ?? 0} detail={`${t('anOf', 'of')} ${units}`} />
          <Card label={t('anCrews', 'Crews compliant')} value={`${o.crews.compliant}/${o.crews.deployed}`} tone={o.crews.compliant < o.crews.deployed ? 'bad' : 'ok'} />
          <Card label={t('anTasks', 'Seats waiting for someone')} value={openTasks} tone={(o.openTasks.CRITICAL ?? 0) > 0 ? 'bad' : openTasks ? 'warn' : 'ok'} detail={o.openTasks.CRITICAL ? `${o.openTasks.CRITICAL} ${t('critical', 'critical')}` : undefined} />
        </section>
      )}

      {o && (
        <div className="an-grid">
          <section className="panel" aria-label="Everyone today">
            <h2>{t('anToday', 'Everyone today')}</h2>
            <div className="an-stack" role="img" aria-label="People by status">
              {Object.entries(o.headcount).filter(([, v]) => v > 0).map(([k, v]) => <span key={k} style={{ flexGrow: v, background: STATUS_COLOR[k] ?? 'var(--muted)' }} title={`${STATUS_NAME[k] ?? k}: ${v}`} />)}
            </div>
            <ul className="an-legend">{Object.entries(o.headcount).filter(([, v]) => v > 0).map(([k, v]) => <li key={k}><i style={{ background: STATUS_COLOR[k] ?? 'var(--muted)' }} /> {STATUS_NAME[k] ?? k} <b>{v}</b></li>)}</ul>
          </section>
          <section className="panel" aria-label="Fleet">
            <h2>{t('anFleet', 'The fleet')}</h2>
            <div className="an-stack" role="img" aria-label="Units by status">
              {[...unitStatus.entries()].filter(([, v]) => v > 0).map(([k, v]) => <span key={k} style={{ flexGrow: v, background: UNIT_COLOR[k] ?? 'var(--muted)' }} title={`${UNIT_NAME[k] ?? k}: ${v}`} />)}
            </div>
            <ul className="an-legend">{[...unitStatus.entries()].filter(([, v]) => v > 0).map(([k, v]) => <li key={k}><i style={{ background: UNIT_COLOR[k] ?? 'var(--muted)' }} /> {UNIT_NAME[k] ?? k} <b>{v}</b></li>)}</ul>
            <table className="table an-compact"><tbody>
              {Object.entries(o.unitsByBase).map(([b, s]) => <tr key={b}><th scope="row">{b}</th><td>{Object.entries(s).map(([k, v]) => `${v} ${(UNIT_NAME[k] ?? k).toLowerCase()}`).join(' · ')}</td></tr>)}
            </tbody></table>
          </section>
        </div>
      )}

      {o && o.crews.nonCompliant.length > 0 && (
        <section className="panel" aria-label="Needs attention">
          <h2>{t('anAttention', 'Needs attention')}</h2>
          <ul className="an-list">
            {o.crews.nonCompliant.map(c => (
              <li key={c.id}><strong><UnitLink id={c.id} code={c.code} /></strong> <span className="muted">{c.base} · {c.type}</span> <span>{c.filled}/{c.required}</span>{c.issues.map(i => <Pill key={i} severity="warn">{i}</Pill>)}</li>
            ))}
          </ul>
        </section>
      )}

      {f && (
        <section className="panel" aria-label="Coverage">
          <h2>{t('anCoverage', 'Coverage, next 12 weeks')} <span className="muted">{t('anCoverageHint', 'the worst day of each week')}</span></h2>
          {shortages.length > 0 && (
            <div className="banner warn an-alert" role="status">
              <AlertTriangle size={16} aria-hidden />
              <span>{shortages.map(s => `${profileName(s.profile)}: ${Math.round(s.worstRatio * 100)}% ${fmtDate(s.from)} – ${fmtDate(s.to)}`).join(' · ')}</span>
            </div>
          )}
          <div className="an-heat-wrap">
            <table className="an-heat an-weeks">
              <thead><tr><th />{weekly[0]?.weeks.map((w, i) => <th key={i} className="an-day">{w.from.slice(5)}</th>)}</tr></thead>
              <tbody>
                {weekly.map(r => (
                  <tr key={r.id}>
                    <th scope="row">{r.code}</th>
                    {r.weeks.map((w, i) => <td key={i} className="an-num" style={{ background: heatColor(w.ratio) }} title={`${r.code}, ${t('anWeekOf', 'week of')} ${w.from}: ${w.ratio === null ? t('anNone', 'none needed') : Math.round(w.ratio * 100) + '%'}`}>{w.ratio === null ? '' : Math.round(w.ratio * 100)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="an-key"><i style={{ background: heatColor(1) }} /> ≥100% <i style={{ background: heatColor(0.8) }} /> 70–99% <i style={{ background: heatColor(0.2) }} /> &lt;70% <i style={{ background: heatColor(null) }} /> {t('anNone', 'none needed')}</p>
        </section>
      )}
    </main>
  )
}
