import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, BarChart3, Check, Clock, X } from 'lucide-react'
import { PageGuide } from './guide'
import { api } from './api'
import { useAuth } from './auth'
import { errMsg, useApi, useLive } from './hooks'
import { fmtDate } from './labels'
import { Pill, useToast } from './ui'
import WhatIf from './WhatIf'
import './analytics.css'
import { UnitLink } from './profiles'

interface Point { date: string; required: number; available: number }
interface Heat { date: string; ratio: number | null; worst: string | null }
interface Forecast {
  dates: string[]; total: Record<string, Point[]>
  scopes: { id: string; code: string; series: Record<string, Point[]>; heat: Heat[] }[]
  shortages: { scope: string; profile: string; from: string; to: string; days: number; peakDeficit: number; worstRatio: number }[]
  minRatio: { value: number; date: string; profile: string } | null
  profiles: { key: string; label: string }[]
}
interface Kpi { key: string; label: string; value: number | null; unit: string; detail?: string }
interface Rec { id: string; key: string; type: string; severity: 'high' | 'medium' | 'low'; title: string; action: string; status: string; base: string | null }
interface Overview {
  date: string; headcount: Record<string, number>; unitsByBase: Record<string, Record<string, number>>
  crews: { deployed: number; compliant: number; nonCompliant: { id: string; code: string; base: string; type: string; required: number; filled: number; issues: string[] }[] }
  basePostsBelowMin: { base: string; position: string; present: number; min: number }[]; openTasks: Record<string, number>; crewChangesNext7Days: number
}
type Tab = 'overview' | 'forecast' | 'whatif' | 'people' | 'leave' | 'units' | 'staffing' | 'map'
const TABS: [Tab, string][] = [['overview', 'Overview'], ['forecast', 'Forecast'], ['whatif', 'What if'], ['people', 'People & fairness'], ['leave', 'Leave & absence'], ['units', 'Units & maintenance'], ['staffing', 'Base staffing'], ['map', 'Map']]
const STATUS_COLOR: Record<string, string> = { ON_UNIT: 'var(--st-unit)', ON_BASE_POST: 'var(--st-base)', STANDBY: 'var(--st-standby)', DAYS_OFF: 'var(--st-off)', UNAVAILABLE: 'var(--st-medical)', ON_LEAVE: 'var(--st-leave)' }
const STATUS_NAME: Record<string, string> = { ON_UNIT: 'On unit', ON_BASE_POST: 'Base post', STANDBY: 'Standby', DAYS_OFF: 'Days off', UNAVAILABLE: 'Unavailable', ON_LEAVE: 'On leave' }

/** Coverage colour: red under 70 %, amber under 100 %, green from 100 %, grey when nothing is required. */
const heatColor = (r: number | null) => r === null ? 'var(--border)' : r >= 1 ? 'var(--pal-green-200)' : r >= 0.7 ? 'var(--pal-amber-200)' : 'var(--pal-red-300)'

/** Dashboards of plan section 20: one screen per question, all computed from the same data as the board. */
export default function Analytics({ initial }: { initial?: Tab }) {
  const { t } = useTranslation()
  const { can } = useAuth()
  const [tab, setTab] = useState<Tab>(initial ?? 'overview')
  const tabs = TABS.filter(([k]) => k !== 'leave' || can('SUPER_ADMIN', 'OPS_MANAGER', 'HR', 'BASE_MANAGER'))
  return (
    <main className="page wide">
      <PageGuide id="analytics" Icon={BarChart3} color="var(--pal-green-600)" title={t('anTitle', 'Analytics')}
        purpose={t('anPurpose', 'Where the company will be short of people, who is overworked, and what to do about it.')}
        steps={[
          t('anStep1', 'Overview: today\'s numbers and recommendations you can accept, snooze or dismiss.'),
          t('anStep2', 'Forecast: the coming months, base by base. Red cells are days without enough people of a kind.'),
          t('anStep3', 'What if: try a change (a new job, people leaving) and see which days would go uncovered. Nothing is saved.'),
        ]} />
      <div className="subtabs" role="tablist">
        {tabs.map(([k, label]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{t(`an_${k}`, label)}</button>)}
      </div>
      {tab === 'overview' && <OverviewTab go={setTab} />}
      {tab === 'forecast' && <ForecastTab />}
      {tab === 'whatif' && <WhatIf />}
      {tab === 'people' && <PeopleTab />}
      {tab === 'leave' && <LeaveTab />}
      {tab === 'units' && <UnitsTab />}
      {tab === 'staffing' && <StaffingTab />}
      {tab === 'map' && <MapTab />}
    </main>
  )
}

function Loading({ q }: { q: { loading: boolean; error: string; data: unknown } }) {
  if (q.error) return <div className="banner error" role="alert">{q.error}</div>
  return q.loading && !q.data ? <p className="muted">…</p> : null
}

// ------------------------------------------------------------------ overview
function OverviewTab({ go }: { go: (t: Tab) => void }) {
  const { t } = useTranslation()
  const ov = useApi<Overview>('/analytics/overview')
  const kpis = useApi<{ kpis: Kpi[] }>('/analytics/kpis')
  const recs = useApi<Rec[]>('/analytics/recommendations')
  const fc = useApi<Forecast>('/analytics/forecast?days=90')
  useLive(() => { void ov.reload(); void kpis.reload() })
  const o = ov.data
  const totalPeople = o ? Object.values(o.headcount).reduce((a, b) => a + b, 0) : 0
  const alerts = fc.data?.shortages.filter(s => s.scope === 'all') ?? []
  return (
    <>
      <Loading q={ov} />
      {alerts.length > 0 && (
        <div className="banner warn an-alert" role="status">
          <AlertTriangle size={16} aria-hidden />
          <span>{alerts.slice(0, 3).map(s => `${fc.data!.profiles.find(p => p.key === s.profile)?.label ?? s.profile}: ${s.worstRatio * 100 | 0}% covered ${fmtDate(s.from)}–${fmtDate(s.to)}`).join(' · ')}</span>
          <button type="button" className="link" onClick={() => go('forecast')}>{t('seeForecast', 'See forecast')}</button>
        </div>
      )}
      {o && (
        <section className="an-kpis" aria-label="Today">
          <Card label={t('anPeople', 'People')} value={totalPeople} />
          <Card label={t('anCrews', 'Crews compliant')} value={`${o.crews.compliant}/${o.crews.deployed}`} tone={o.crews.compliant < o.crews.deployed ? 'warn' : 'ok'} />
          <Card label={t('anTasks', 'Open replacement tasks')} value={Object.values(o.openTasks).reduce((a, b) => a + b, 0)} tone={(o.openTasks.CRITICAL ?? 0) > 0 ? 'bad' : undefined} detail={o.openTasks.CRITICAL ? `${o.openTasks.CRITICAL} critical` : undefined} />
          <Card label={t('anChanges', 'Crew changes, next 7 days')} value={o.crewChangesNext7Days} />
          <Card label={t('anBelowMin', 'Base posts below minimum')} value={o.basePostsBelowMin.length} tone={o.basePostsBelowMin.length ? 'bad' : 'ok'} detail={`of ${(o as Overview & { basePostsTotal?: number }).basePostsTotal ?? '…'}`} />
        </section>
      )}
      <div className="an-grid">
        {o && (
          <section className="panel" aria-label="Headcount today">
            <h2>{t('anToday', 'Everyone today')}</h2>
            <div className="an-stack" role="img" aria-label="Headcount by status">
              {Object.entries(o.headcount).map(([k, v]) => <span key={k} style={{ flexGrow: v, background: STATUS_COLOR[k] ?? 'var(--muted)' }} title={`${STATUS_NAME[k] ?? k}: ${v}`} />)}
            </div>
            <ul className="an-legend">{Object.entries(o.headcount).map(([k, v]) => <li key={k}><i style={{ background: STATUS_COLOR[k] ?? 'var(--muted)' }} /> {STATUS_NAME[k] ?? k} <b>{v}</b></li>)}</ul>
            <h3>{t('anUnits', 'Units by base')}</h3>
            <table className="table an-compact"><tbody>
              {Object.entries(o.unitsByBase).map(([b, s]) => <tr key={b}><th scope="row">{b}</th><td>{Object.entries(s).map(([k, v]) => `${v} ${k.toLowerCase().replace(/_/g, ' ')}`).join(' · ')}</td></tr>)}
            </tbody></table>
          </section>
        )}
        {o && (
          <section className="panel" aria-label="Crews needing attention">
            <h2>{t('anCrewIssues', 'Crews not meeting the rules')}</h2>
            {o.crews.nonCompliant.length === 0 ? <p className="muted">{t('anAllGood', 'Every deployed crew is complete and compliant.')}</p> : (
              <ul className="an-list">{o.crews.nonCompliant.map(c => (
                <li key={c.id}><strong><UnitLink id={c.id} code={c.code} /></strong> <span className="muted">{c.base} · {c.type}</span> <span>{c.filled}/{c.required}</span>{c.issues.map(i => <Pill key={i} severity="warn">{i}</Pill>)}</li>
              ))}</ul>
            )}
            {o.basePostsBelowMin.length > 0 && <><h3>{t('anPostsLow', 'Base posts below minimum')}</h3><ul className="an-list">{o.basePostsBelowMin.map(p => <li key={p.base + p.position}>{p.base} · {p.position}: {p.present}/{p.min}</li>)}</ul></>}
          </section>
        )}
      </div>
      <section aria-label="KPIs">
        <h2>{t('anKpis', 'Key figures, last 30 days')}</h2>
        <Loading q={kpis} />
        <div className="an-kpis">{kpis.data?.kpis.map(k => <Card key={k.key} label={k.label} value={k.value === null ? '–' : `${k.value}${k.unit === '%' ? '%' : ''}`} detail={k.unit !== '%' && k.value !== null ? `${k.unit}${k.detail ? ' · ' + k.detail : ''}` : k.detail} small />)}</div>
      </section>
      <Recommendations recs={recs} />
    </>
  )
}

function Card({ label, value, detail, tone, small }: { label: string; value: string | number; detail?: string; tone?: 'ok' | 'warn' | 'bad'; small?: boolean }) {
  return <div className={`an-card${tone ? ' ' + tone : ''}${small ? ' small' : ''}`}><span className="an-label">{label}</span><strong>{value}</strong>{detail && <small className="muted">{detail}</small>}</div>
}

// ------------------------------------------------------------------ recommendations
function Recommendations({ recs }: { recs: { data: Rec[] | null; reload: () => Promise<void> } }) {
  const { t } = useTranslation()
  const { can } = useAuth()
  const toast = useToast()
  const editor = can('SUPER_ADMIN', 'OPS_MANAGER', 'DISPATCHER', 'BASE_MANAGER')
  const [busy, setBusy] = useState(false)
  const decide = async (id: string, status: string) => {
    try { await api(`/analytics/recommendations/${id}/status`, { method: 'POST', body: { status, days: 7 } }); await recs.reload() } catch (e) { toast(errMsg(e), 'error') }
  }
  const refresh = async () => {
    setBusy(true)
    try { const r = await api<{ created: number; total: number }>('/analytics/recommendations/run', { method: 'POST' }); toast(`${r.total} ${t('anFindings', 'findings')} (${r.created} ${t('anNew', 'new')})`); await recs.reload() } catch (e) { toast(errMsg(e), 'error') } finally { setBusy(false) }
  }
  const list = recs.data ?? []
  return (
    <section className="panel" aria-label="Recommendations">
      <div className="an-head"><h2>{t('anRecs', 'Recommendations')} <span className="muted">{list.length}</span></h2>{editor && <button type="button" onClick={refresh} disabled={busy}>{t('anRefresh', 'Check again')}</button>}</div>
      {list.length === 0 && <p className="muted">{t('anNoRecs', 'Nothing to act on right now.')}</p>}
      <ul className="an-recs">
        {list.map(r => (
          <li key={r.id} className={`sev-${r.severity}`}>
            <div><Pill severity={r.severity === 'high' ? 'bad' : r.severity === 'medium' ? 'warn' : 'info'}>{r.type.replace('_', ' ')}</Pill> <strong>{r.title}</strong>{r.base && <span className="muted"> · {r.base}</span>}<p className="muted">{r.action}</p></div>
            {editor && (
              <div className="row-actions">
                <button type="button" onClick={() => decide(r.id, 'ACCEPTED')} title={t('anAccept', 'Accept')}><Check size={14} aria-hidden /> {t('anAccept', 'Accept')}</button>
                <button type="button" onClick={() => decide(r.id, 'SNOOZED')} title={t('anSnooze', 'Snooze 7 days')}><Clock size={14} aria-hidden /> {t('anSnoozeShort', 'Snooze')}</button>
                <button type="button" onClick={() => decide(r.id, 'DISMISSED')} title={t('anDismiss', 'Dismiss')}><X size={14} aria-hidden /> {t('anDismissShort', 'Dismiss')}</button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

// ------------------------------------------------------------------ forecast
function ForecastTab() {
  const { t } = useTranslation()
  const [days, setDays] = useState(90)
  const [profile, setProfile] = useState('')
  const [pick, setPick] = useState<{ base: string; date: string } | null>(null)
  const fc = useApi<Forecast>(`/analytics/forecast?days=${days}`)
  const f = fc.data
  const bases = (f?.scopes ?? []).filter(s => s.id !== 'all')
  const weekly = days > 60 ? 7 : 1
  const rows = useMemo(() => {
    if (!f) return []
    const total: Heat[] = f.dates.map((date, i) => {
      let worst: string | null = null; let ratio: number | null = null
      for (const [p, series] of Object.entries(f.total)) {
        if (profile && p !== profile) continue
        const s = series[i]; if (!s || s.required === 0) continue
        const r = s.available / s.required
        if (ratio === null || r < ratio) { ratio = r; worst = p }
      }
      return { date, ratio: ratio === null ? null : Math.round(ratio * 100) / 100, worst }
    })
    const perBase = bases.map(b => ({ id: b.id, code: b.code, heat: !profile ? b.heat : f.dates.map((date, i) => { const s = b.series[profile]?.[i]; return { date, ratio: !s || s.required === 0 ? null : Math.round(s.available / s.required * 100) / 100, worst: profile } }) }))
    return [{ id: 'all', code: t('anAllBases', 'All bases'), heat: total }, ...perBase]
  }, [f, profile, bases, t])
  const label = (k: string | null) => (k && f?.profiles.find(p => p.key === k)?.label) || k || ''
  const shortages = (f?.shortages ?? []).filter(s => !profile || s.profile === profile).sort((a, b) => a.from.localeCompare(b.from))
  const baseCode = (id: string) => id === 'all' ? t('anAllBases', 'All bases') : bases.find(b => b.id === id)?.code ?? id
  const sel = pick ? rows.find(r => r.id === pick.base)?.heat.find(h => h.date === pick.date) : null
  const series = profile ? f?.total[profile] : null

  return (
    <>
      <div className="filters">
        <label>{t('anHorizon', 'Horizon')}{' '}<select value={days} onChange={e => setDays(+e.target.value)}>{[30, 60, 90, 180].map(d => <option key={d} value={d}>{d} {t('days', 'days')}</option>)}</select></label>
        <label>{t('anProfile', 'Profile')}{' '}<select value={profile} onChange={e => setProfile(e.target.value)}><option value="">{t('anWorst', 'Worst of all')}</option>{f?.profiles.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}</select></label>
        <span className="an-key"><i style={{ background: heatColor(1) }} /> ≥100%<i style={{ background: heatColor(0.8) }} /> 70–99%<i style={{ background: heatColor(0.2) }} /> &lt;70%<i style={{ background: heatColor(null) }} /> {t('anNone', 'none needed')}</span>
      </div>
      <Loading q={fc} />
      {f && (
        <section className="panel" aria-label="Coverage heatmap">
          <h2>{t('anHeat', 'Available people against what is needed')} <span className="muted">{f.minRatio ? `· ${t('anLowest', 'lowest')} ${Math.round(f.minRatio.value * 100)}% (${label(f.minRatio.profile)}, ${fmtDate(f.minRatio.date)})` : ''}</span></h2>
          <div className="an-heat-wrap">
            <table className="an-heat">
              <thead><tr><th />{f.dates.map((d, i) => i % weekly === 0 && <th key={d} colSpan={weekly} className="an-day">{d.slice(5)}</th>)}</tr></thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id}>
                    <th scope="row">{r.code}</th>
                    {r.heat.map(h => (
                      <td key={h.date} style={{ background: heatColor(h.ratio) }} className={pick?.base === r.id && pick.date === h.date ? 'sel' : ''}
                        title={`${r.code} ${h.date}: ${h.ratio === null ? t('anNone', 'none needed') : Math.round(h.ratio * 100) + '%'}${h.worst ? ' · ' + label(h.worst) : ''}`}
                        onClick={() => setPick({ base: r.id, date: h.date })} />
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pick && sel && (
            <p className="an-pick">{baseCode(pick.base)} · {fmtDate(pick.date)}: {sel.ratio === null ? t('anNone', 'none needed') : `${Math.round(sel.ratio * 100)}%`}{sel.worst ? ` · ${t('anWeakest', 'weakest')}: ${label(sel.worst)}` : ''}
              {' '}{(() => { const s = (pick.base === 'all' ? f.total : f.scopes.find(x => x.id === pick.base)?.series)?.[sel.worst ?? '']?.find(p => p.date === pick.date); return s ? `(${s.available} ${t('anAvail', 'available')} / ${s.required} ${t('anRequired', 'required')})` : '' })()}</p>
          )}
        </section>
      )}
      {series && f && <LineChart title={label(profile)} dates={f.dates} required={series.map(p => p.required)} available={series.map(p => p.available)} />}
      <section className="panel" aria-label="Shortages">
        <h2>{t('anShort', 'Shortage windows')} <span className="muted">{shortages.length}</span></h2>
        {shortages.length === 0 ? <p className="muted">{t('anNoShort', 'No shortages in this horizon.')}</p> : (
          <table className="table"><thead><tr><th>{t('anWhere', 'Where')}</th><th>{t('anProfile', 'Profile')}</th><th>{t('anFrom', 'From')}</th><th>{t('anTo', 'To')}</th><th>{t('days', 'days')}</th><th>{t('anPeak', 'Missing at worst')}</th><th>{t('anCover', 'Coverage')}</th></tr></thead>
            <tbody>{shortages.map((s, i) => <tr key={i}><td>{baseCode(s.scope)}</td><td>{label(s.profile)}</td><td>{fmtDate(s.from)}</td><td>{fmtDate(s.to)}</td><td>{s.days}</td><td>{s.peakDeficit}</td><td><Pill severity={s.worstRatio < 0.7 ? 'bad' : 'warn'}>{Math.round(s.worstRatio * 100)}%</Pill></td></tr>)}</tbody></table>
        )}
      </section>
    </>
  )
}

function LineChart({ title, dates, required, available }: { title: string; dates: string[]; required: number[]; available: number[] }) {
  const { t } = useTranslation()
  const W = 800, H = 180, P = 28
  const max = Math.max(1, ...required, ...available)
  const x = (i: number) => P + (i / Math.max(1, dates.length - 1)) * (W - 2 * P)
  const y = (v: number) => H - P - (v / max) * (H - 2 * P)
  const path = (a: number[]) => a.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const gaps = available.map((a, i) => a < required[i] ? i : -1).filter(i => i >= 0)
  return (
    <section className="panel" aria-label={`${title} over time`}>
      <h2>{title}</h2>
      <svg viewBox={`0 0 ${W} ${H}`} className="an-line" role="img" aria-label={`${title}: required and available per day`}>
        {[0, 0.5, 1].map(f => <g key={f}><line style={{ stroke: 'var(--border)' }} x1={P} x2={W - P} y1={y(max * f)} y2={y(max * f)} /><text style={{ fill: 'var(--muted)' }} x={4} y={y(max * f) + 4} fontSize="13">{Math.round(max * f)}</text></g>)}
        {gaps.map(i => <rect style={{ fill: 'var(--pal-red-300)' }} key={i} x={x(i) - 2} y={P / 2} width={4} height={H - P * 1.5} opacity=".45" />)}
        <path style={{ stroke: 'var(--bad)' }} d={path(required)} fill="none" strokeWidth="2" strokeDasharray="5 3" />
        <path style={{ stroke: 'var(--accent)' }} d={path(available)} fill="none" strokeWidth="2.5" />
        {[0, Math.floor(dates.length / 2), dates.length - 1].map(i => <text style={{ fill: 'var(--muted)' }} key={i} x={x(i)} y={H - 6} fontSize="13" textAnchor="middle">{dates[i].slice(5)}</text>)}
      </svg>
      <p className="an-key"><i style={{ background: 'var(--accent)' }} /> {t('anAvail', 'available')} <i style={{ background: 'var(--bad)' }} /> {t('anRequired', 'required')}</p>
    </section>
  )
}

// ------------------------------------------------------------------ people
function Bars({ rows, color = 'var(--accent)', unit = '' }: { rows: { label: string; value: number }[]; color?: string; unit?: string }) {
  const max = Math.max(1, ...rows.map(r => r.value))
  return <div className="an-bars">{rows.map(r => <div key={r.label} className="an-bar"><span>{r.label}</span><div><i style={{ width: `${(r.value / max) * 100}%`, background: color }} /></div><b>{r.value}{unit}</b></div>)}</div>
}

function PeopleTab() {
  const { t } = useTranslation()
  const d = useApi<{
    extensionHistogram: { label: string; people: number }[]; topExtensions: { name: string; base: string; days: number }[]
    balanceRanking: { name: string; base: string; days: number }[]; fieldDaysHistogram: { label: string; people: number }[]
    seniorityMix: ({ base: string } & Record<string, number | string>)[]
  }>('/analytics/people')
  const x = d.data
  const levels = ['NEW_RECRUIT', 'JUNIOR', 'EXPERIENCED', 'SENIOR']
  const colors = ['var(--pal-slate-400)', 'var(--pal-blue-400)', 'var(--pal-green-600)', 'var(--pal-amber-600)']
  return (
    <>
      <Loading q={d} />
      {x && (
        <div className="an-grid">
          <section className="panel"><h2>{t('anExtHist', 'Extension days per person')}</h2><Bars rows={x.extensionHistogram.map(r => ({ label: r.label, value: r.people }))} /></section>
          <section className="panel"><h2>{t('anFieldHist', 'Days in the field, career total')}</h2><Bars rows={x.fieldDaysHistogram.map(r => ({ label: r.label, value: r.people }))} color="var(--st-standby)" /></section>
          <section className="panel"><h2>{t('anOwed', 'Most rest days owed')}</h2>
            {x.balanceRanking.length === 0 ? <p className="muted">{t('anNobody', 'Nobody is owed rest days.')}</p> : <Bars rows={x.balanceRanking.map(r => ({ label: `${r.name} · ${r.base}`, value: r.days }))} color="var(--st-extended)" unit=" d" />}
          </section>
          <section className="panel"><h2>{t('anSeniority', 'Seniority by base')}</h2>
            {x.seniorityMix.map(r => {
              const total = levels.reduce((a, l) => a + (+r[l] || 0), 0) || 1
              return <div key={r.base} className="an-bar"><span>{r.base}</span><div className="an-seg">{levels.map((l, i) => <i key={l} style={{ width: `${((+r[l] || 0) / total) * 100}%`, background: colors[i] }} title={`${l.toLowerCase().replace('_', ' ')}: ${r[l]}`} />)}</div><b>{total}</b></div>
            })}
            <p className="an-key">{levels.map((l, i) => <span key={l}><i style={{ background: colors[i] }} /> {l.toLowerCase().replace('_', ' ')} </span>)}</p>
          </section>
        </div>
      )}
    </>
  )
}

// ------------------------------------------------------------------ leave
function LeaveTab() {
  const { t } = useTranslation()
  const d = useApi<{ byMonth: { month: string; types: Record<string, number> }[]; absenceByBase: { base: string; rate: number }[]; longTermAbsences: number; awaitingClearance: number }>('/analytics/leave')
  const x = d.data
  const kinds = useMemo(() => Array.from(new Set(x?.byMonth.flatMap(m => Object.keys(m.types)) ?? [])), [x])
  const palette = ['var(--st-leave)', 'var(--st-medical)', 'var(--st-training)', 'var(--ch)', 'var(--st-base)']
  const max = Math.max(1, ...(x?.byMonth.map(m => Object.values(m.types).reduce((a, b) => a + b, 0)) ?? [1]))
  return (
    <>
      <Loading q={d} />
      {x && (
        <>
          <div className="an-kpis">
            <Card label={t('anLong', 'Long-term absences')} value={x.longTermAbsences} />
            <Card label={t('anClear', 'Awaiting clearance')} value={x.awaitingClearance} tone={x.awaitingClearance ? 'warn' : undefined} />
          </div>
          <div className="an-grid">
            <section className="panel"><h2>{t('anLeaveMonth', 'Absence days per month')}</h2>
              <div className="an-cols" role="img" aria-label="Absence days per month">
                {x.byMonth.map(m => {
                  const sum = Object.values(m.types).reduce((a, b) => a + b, 0)
                  return <div key={m.month} className="an-col"><div className="an-colbar" style={{ height: `${(sum / max) * 100}%` }}>{kinds.map((k, i) => m.types[k] ? <i key={k} style={{ flexGrow: m.types[k], background: palette[i % palette.length] }} title={`${k}: ${m.types[k]}`} /> : null)}</div><small>{m.month.slice(2)}</small><b>{sum || ''}</b></div>
                })}
              </div>
              <p className="an-key">{kinds.map((k, i) => <span key={k}><i style={{ background: palette[i % palette.length] }} /> {k} </span>)}</p>
              <p className="muted">{t('anMedPrivacy', 'Medical absence is shown as a total only; names and reasons stay private.')}</p>
            </section>
            <section className="panel"><h2>{t('anAbsRate', 'Absence rate by base')}</h2><Bars rows={x.absenceByBase.map(r => ({ label: r.base, value: r.rate }))} color="var(--st-leave)" unit="%" /></section>
          </div>
        </>
      )}
    </>
  )
}

// ------------------------------------------------------------------ units
function UnitsTab() {
  const { t } = useTranslation()
  const d = useApi<{ days: number; units: { code: string; base: string; type: string; jobs: number; utilization: number; downtime: number }[] }>('/analytics/units')
  const x = d.data
  return (
    <>
      <Loading q={d} />
      {x && (
        <section className="panel">
          <h2>{t('anUtil', 'Unit utilization and downtime')} <span className="muted">· {x.days} {t('days', 'days')}</span></h2>
          <table className="table">
            <thead><tr><th>{t('unit', 'Unit')}</th><th>{t('base', 'Base')}</th><th>{t('type', 'Type')}</th><th>{t('jobs', 'Jobs')}</th><th>{t('anUtilShort', 'Working')}</th><th>{t('anDown', 'Workshop')}</th></tr></thead>
            <tbody>{x.units.map(u => (
              <tr key={u.code}><th scope="row"><UnitLink code={u.code} /></th><td>{u.base}</td><td>{u.type}</td><td>{u.jobs}</td>
                <td><div className="an-bar"><div><i style={{ width: `${Math.min(100, u.utilization)}%`, background: 'var(--st-unit)' }} /></div><b>{u.utilization}%</b></div></td>
                <td>{u.downtime ? <Pill severity="warn">{u.downtime}%</Pill> : '–'}</td></tr>
            ))}</tbody>
          </table>
        </section>
      )}
    </>
  )
}

// ------------------------------------------------------------------ base staffing
function StaffingTab() {
  const { t } = useTranslation()
  const d = useApi<{ from: string; to: string; rows: { base: string; position: string; min: number; target: number; series: { date: string; present: number }[] }[] }>('/analytics/base-staffing')
  const x = d.data
  return (
    <>
      <Loading q={d} />
      {x && (
        <section className="panel">
          <h2>{t('anStaffing', 'Base posts against their minimum')} <span className="muted">· {fmtDate(x.from)} – {fmtDate(x.to)}</span></h2>
          <div className="an-heat-wrap">
            <table className="an-heat">
              <thead><tr><th /><th /><th colSpan={x.rows[0]?.series.length}>{t('anDaysAcross', 'one cell per day')}</th></tr></thead>
              <tbody>{x.rows.map(r => (
                <tr key={r.base + r.position}>
                  <th scope="row">{r.base} · {r.position}</th><td className="muted nowrap">min {r.min}</td>
                  {r.series.map(s => <td key={s.date} className="an-num" style={{ background: s.present < r.min ? 'var(--pal-red-300)' : s.present < r.target ? 'var(--pal-amber-200)' : 'var(--pal-green-200)' }} title={`${s.date}: ${s.present} (min ${r.min}, target ${r.target})`}>{s.present}</td>)}
                </tr>
              ))}</tbody>
            </table>
          </div>
          <p className="an-key"><i style={{ background: 'var(--pal-red-300)' }} /> {t('anUnderMin', 'under minimum')} <i style={{ background: 'var(--pal-amber-200)' }} /> {t('anUnderTarget', 'under target')} <i style={{ background: 'var(--pal-green-200)' }} /> {t('anOk', 'at or above target')}</p>
        </section>
      )}
    </>
  )
}

// ------------------------------------------------------------------ map
interface MapData {
  bases: { id: string; code: string; name: string; lat: number; lng: number; people: number; standby: number; onUnit: number; units: number }[]
  sites: { id: string; name: string; lat: number; lng: number; well: string | null; rig: string | null; client: string | null }[]
}
/** A map drawn from coordinates alone, so it works offline in the field (no tiles to download). */
function MapTab() {
  const { t } = useTranslation()
  const d = useApi<MapData>('/analytics/map')
  const [sel, setSel] = useState<string | null>(null)
  const x = d.data
  const W = 760, H = 460, P = 40
  if (!x) return <Loading q={d} />
  const pts = [...x.bases, ...x.sites]
  const lat = pts.map(p => p.lat), lng = pts.map(p => p.lng)
  const [minLat, maxLat, minLng, maxLng] = [Math.min(...lat), Math.max(...lat), Math.min(...lng), Math.max(...lng)]
  const px = (g: number) => P + ((g - minLng) / Math.max(0.01, maxLng - minLng)) * (W - 2 * P)
  const py = (a: number) => H - P - ((a - minLat) / Math.max(0.01, maxLat - minLat)) * (H - 2 * P)
  const chosen = x.bases.find(b => b.id === sel)
  return (
    <section className="panel" aria-label="Map">
      <h2>{t('anMap', 'Bases and active well sites')}</h2>
      <svg viewBox={`0 0 ${W} ${H}`} className="an-map" role="img" aria-label="Map of bases and sites">
        {x.sites.map(s => <g key={s.id}><rect style={{ fill: 'var(--ch)' }} x={px(s.lng) - 5} y={py(s.lat) - 5} width="10" height="10" transform={`rotate(45 ${px(s.lng)} ${py(s.lat)})`}><title>{`${s.name}${s.well ? ' · ' + s.well : ''}${s.rig ? ' · ' + s.rig : ''}`}</title></rect></g>)}
        {x.bases.map(b => (
          <g key={b.id} className="an-base" onClick={() => setSel(b.id === sel ? null : b.id)} tabIndex={0} role="button" aria-label={`${b.code}: ${b.people} people`} onKeyDown={e => { if (e.key === 'Enter') setSel(b.id) }}>
            <circle style={{ fill: 'var(--accent)' }} cx={px(b.lng)} cy={py(b.lat)} r={10 + b.people / 6} opacity={b.id === sel ? 0.9 : 0.55} />
            <text x={px(b.lng)} y={py(b.lat) + 4} textAnchor="middle" fontSize="11" fontWeight="700" fill="#fff">{b.code}</text>
          </g>
        ))}
      </svg>
      <p className="an-key"><i style={{ background: 'var(--accent)' }} /> {t('anBase', 'base (size = people)')} <i style={{ background: 'var(--ch)', transform: 'rotate(45deg)' }} /> {t('anSite', 'well site')}</p>
      {chosen && <p className="an-pick"><strong>{chosen.name}</strong>: {chosen.people} {t('anPeople', 'People').toLowerCase()} · {chosen.onUnit} {t('anOnUnit', 'on units')} · {chosen.standby} {t('anStandby', 'on standby')} · {chosen.units} {t('anUnitsN', 'units')}</p>}
    </section>
  )
}
