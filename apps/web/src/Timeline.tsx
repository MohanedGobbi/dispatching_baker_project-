import { useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, CalendarRange, MapPin } from 'lucide-react'
import { useApi, useDebounced, useLive } from './hooks'
import { fmtDate } from './labels'
import type { PersonalCalendar } from './types'
import { BASE_COLORS, Donut, Legend, PageGuide } from './guide'
import { initials, STATUS_META } from './ui'
import { useProfiles } from './profiles'

interface Block { from: string; to: string; status: string; label?: string; restrictions?: string[] }
interface Row { employeeId: string; name: string; employeeNo: string; base: string; position: string; group: string; blocks: Block[] }
interface Data { from: string; to: string; groupBy: string; rows: Row[] }

const DAY = 86_400_000
const iso = (d: Date) => d.toISOString().slice(0, 10)
const addDays = (s: string, n: number) => iso(new Date(Date.parse(s) + n * DAY))
const dayIndex = (from: string, d: string) => Math.round((Date.parse(d) - Date.parse(from)) / DAY)
const color = (s: string) => STATUS_META[s]?.color ?? 'var(--border)'

/** Team timeline (plan 11.3): a row per person, a coloured block per stretch. Click a person to focus on them alone. */
export default function Timeline() {
  const { t, i18n } = useTranslation()
  const [from, setFrom] = useState(iso(new Date()))
  const [span, setSpan] = useState(28)
  const [baseId, setBaseId] = useState('')
  const [positionId, setPositionId] = useState('')
  const [groupBy, setGroupBy] = useState('base')
  const [search, setSearch] = useState('')
  const q = useDebounced(search.trim())
  const [focus, setFocus] = useState<Row | null>(null)

  const to = addDays(from, span - 1)
  const bases = useApi<{ id: string; code: string }[]>('/bases')
  const positions = useApi<{ id: string; name: string; category: string }[]>('/catalogs/positions')
  const qs = new URLSearchParams({ from, to, groupBy })
  if (baseId) qs.set('baseId', baseId)
  if (positionId) qs.set('positionId', positionId)
  if (q) qs.set('q', q)
  const data = useApi<Data>(`/calendar/timeline?${qs}`)
  useLive(data.reload)

  const codes = useMemo(() => (bases.data ?? []).map(b => b.code).sort(), [bases.data])
  const days = useMemo(() => Array.from({ length: span }, (_, i) => addDays(from, i)), [from, span])
  const todayIdx = dayIndex(from, iso(new Date()))
  const groups = useMemo(() => {
    const m = new Map<string, Row[]>()
    for (const r of data.data?.rows ?? []) (m.get(r.group) ?? m.set(r.group, []).get(r.group)!).push(r)
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [data.data])
  const used = useMemo(() => [...new Set((data.data?.rows ?? []).flatMap(r => r.blocks.map(b => b.status)))], [data.data])
  const style = { '--n': span } as CSSProperties
  const groupColor = (g: string) => groupBy === 'base' && codes.includes(g) ? BASE_COLORS[codes.indexOf(g) % BASE_COLORS.length] : 'var(--pal-slate-600)'

  if (focus) return <main className="page wide"><Focus row={focus} codes={codes} onBack={() => setFocus(null)} /></main>

  return (
    <main className="page wide">
      <PageGuide id="timeline" Icon={CalendarRange} color="var(--pal-cyan-600)" title={t('timelineTitle', 'Timeline')}
        purpose={t('timelinePurpose', 'Everyone\'s next weeks at a glance: one line per person, one colour per kind of day.')}
        steps={[
          t('tlStep1', 'Blue blocks are days on a unit, teal is standby, grey is days off, purple is leave. The legend below lists every colour shown.'),
          t('tlStep2', 'Click a name to open that person\'s own timeline, calendar and statistics; everyone else is hidden until you go back.'),
          t('tlStep3', 'Narrow the list with base, position or a name; group by unit to see crews together.'),
        ]} />

      <div className="card2" style={{ gap: 8 }}>
        <div className="filters" style={{ margin: 0 }}>
          <label>{t('from', 'From')} <input type="date" value={from} onChange={e => e.target.value && setFrom(e.target.value)} /></label>
          <span className="seg-days">{[14, 28, 56, 90].map(n => <button key={n} type="button" className={span === n ? 'on' : ''} onClick={() => setSpan(n)}>{n} {t('days', 'days')}</button>)}</span>
          <select value={positionId} onChange={e => setPositionId(e.target.value)} aria-label="Position">
            <option value="">{t('allPositions', 'All positions')}</option>{positions.data?.filter(p => p.category !== 'MANAGEMENT').map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <select value={groupBy} onChange={e => setGroupBy(e.target.value)} aria-label="Group by">
            <option value="base">{t('groupBase', 'Group by base')}</option><option value="position">{t('groupPosition', 'Group by position')}</option><option value="unit">{t('groupUnit', 'Group by unit')}</option>
          </select>
          <input className="plain" value={search} onChange={e => setSearch(e.target.value)} placeholder={t('searchPerson', 'Name or employee number')} aria-label="Search" />
        </div>
        <div className="chips">
          <span className="chips-label">{t('fBase', 'Base')}</span>
          <button type="button" className={`fchip${!baseId ? ' on' : ''}`} style={{ ['--c' as string]: 'var(--pal-slate-700)' }} onClick={() => setBaseId('')}>{t('allBases', 'All bases')}</button>
          {bases.data?.map(b => <button key={b.id} type="button" className={`fchip${baseId === b.id ? ' on' : ''}`} style={{ ['--c' as string]: BASE_COLORS[codes.indexOf(b.code) % BASE_COLORS.length] }} onClick={() => setBaseId(baseId === b.id ? '' : b.id)}><i />{b.code}</button>)}
        </div>
        <Legend items={used.map(s => ({ color: color(s), label: STATUS_META[s]?.label ?? s, shape: 'bar' as const }))} />
      </div>

      {data.error && <div className="banner error" role="alert">{data.error}</div>}
      {!data.loading && (data.data?.rows.length ?? 0) === 0 && <p className="empty-note">{t('noPeople', 'Nobody matches these filters.')}</p>}

      {groups.length > 0 && (
        <div className="tl tl2" style={{ ...style, marginTop: 16 }} role="region" aria-label="Team timeline">
          <div className="tl-row tl-head" aria-hidden>
            <span className="tl-name" />
            {days.map((d, i) => {
              const dt = new Date(d)
              const weekend = [5, 6].includes(dt.getUTCDay())
              return <span key={d} className={`tl-day${weekend ? ' we' : ''}${i === todayIdx ? ' today' : ''}`} title={fmtDate(d, i18n.language)}>{dt.getUTCDate() === 1 || i === 0 ? <b>{dt.toLocaleDateString(i18n.language, { month: 'short', timeZone: 'UTC' })}</b> : null}{dt.getUTCDate()}</span>
            })}
          </div>
          {groups.map(([group, rows]) => (
            <div key={group} role="group" aria-label={group}>
              <div className="tl-group" style={{ ["--c" as string]: groupColor(group) }}>{group} <span style={{ opacity: .85 }}>· {rows.length}</span></div>
              {rows.map(r => (
                <div className="tl-row" key={r.employeeId}>
                  <button type="button" className="tl-name" onClick={() => setFocus(r)} title={t('openTimeline', 'Show only this person')}>{r.name}<small>{r.position} · {r.base}</small></button>
                  {r.blocks.map((b, i) => {
                    const s = Math.max(0, dayIndex(from, b.from)), e = Math.min(span - 1, dayIndex(from, b.to))
                    const label = `${fmtDate(b.from, i18n.language)} → ${fmtDate(b.to, i18n.language)} · ${STATUS_META[b.status]?.label ?? b.status}${b.label ? ` · ${b.label}` : ''}${b.restrictions?.length ? ` · restricted: ${b.restrictions.join(', ')}` : ''}`
                    return (
                      <i key={i} className={`tl-block${b.restrictions?.length ? ' restricted' : ''}`} style={{ gridColumn: `${s + 2} / ${e + 3}`, background: color(b.status) }} title={label} role="img" aria-label={label} onClick={() => setFocus(r)}>
                        {e - s >= 2 && b.label ? b.label.split(' · ')[0] : ''}
                      </i>
                    )
                  })}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </main>
  )
}

/** One person, alone: where they are today, their stretches as a big strip, a month calendar, and how their days split up. */
function Focus({ row, codes, onBack }: { row: Row; codes: string[]; onBack: () => void }) {
  const { t, i18n } = useTranslation()
  const { openPerson } = useProfiles()
  const today = iso(new Date())
  const [from, setFrom] = useState(addDays(today, -28))
  const span = 91
  const to = addDays(from, span - 1)
  const cal = useApi<PersonalCalendar>(`/calendar/employees/${row.employeeId}?from=${from}&to=${to}`)
  const days = useMemo(() => cal.data?.days ?? [], [cal.data])

  // merge consecutive days with the same status and label into stretches
  const stretches = useMemo(() => {
    const out: { from: string; to: string; status: string; label?: string; n: number }[] = []
    for (const d of days) {
      const last = out[out.length - 1]
      if (last && last.status === d.status && last.label === d.label && dayIndex(last.to, d.date) === 1) { last.to = d.date; last.n++ } else out.push({ from: d.date, to: d.date, status: d.status, label: d.label, n: 1 })
    }
    return out
  }, [days])
  const counts = useMemo(() => {
    const m = new Map<string, number>()
    for (const d of days) m.set(d.status, (m.get(d.status) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [days])
  const now = cal.data?.summary.today
  const nowMeta = now ? STATUS_META[now.status] : undefined
  const baseCol = codes.includes(row.base) ? BASE_COLORS[codes.indexOf(row.base) % BASE_COLORS.length] : 'var(--pal-cyan-600)'
  const months = useMemo(() => {
    const m = new Map<string, typeof days>()
    for (const d of days) { const k = d.date.slice(0, 7); (m.get(k) ?? m.set(k, []).get(k)!).push(d) }
    return [...m.entries()]
  }, [days])
  const todayIdx = dayIndex(from, today)

  return (
    <div className="focus">
      <header className="focus-head" style={{ ['--c' as string]: nowMeta?.color ?? baseCol }}>
        <button type="button" onClick={onBack}><ArrowLeft size={15} aria-hidden /> {t('backToAll', 'Everyone')}</button>
        <button type="button" onClick={() => openPerson(row.employeeId)}>{t('fullProfile', 'Full profile')}</button>
        <span className="big-av" aria-hidden>{initials(row.name)}</span>
        <div>
          <h2>{row.name}</h2>
          <p>{row.position} · {row.employeeNo} · <MapPin size={13} aria-hidden /> {row.base}</p>
        </div>
        <div className="fh-now">
          <small>{t('today', 'Today')}</small>
          <b>{nowMeta?.label ?? '…'}{now?.label ? ` · ${now.label}` : ''}</b>
          <small>{cal.data?.summary.nextDaysOff ? `${t('nextOff', 'Next days off')}: ${fmtDate(cal.data.summary.nextDaysOff, i18n.language)}` : ''}{cal.data?.summary.nextDaysOff && cal.data?.summary.nextBackOn ? ' · ' : ''}{cal.data?.summary.nextBackOn ? `${t('backOn', 'Back on')}: ${fmtDate(cal.data.summary.nextBackOn, i18n.language)}` : ''}</small>
        </div>
      </header>

      <div className="filters" style={{ margin: 0 }}>
        <button type="button" onClick={() => setFrom(addDays(from, -28))}>← {t('earlier', '4 weeks earlier')}</button>
        <button type="button" onClick={() => setFrom(addDays(today, -28))}>{t('aroundToday', 'Around today')}</button>
        <button type="button" onClick={() => setFrom(addDays(from, 28))}>{t('later', '4 weeks later')} →</button>
        <span className="muted">{fmtDate(from, i18n.language)} – {fmtDate(to, i18n.language)}</span>
      </div>
      {cal.error && <div className="banner error" role="alert">{cal.error}</div>}

      <section className="card2">
        <h2>{t('stretches', 'Stretches over 13 weeks')}<small>{t('stripHint', 'each block is a run of the same kind of day')}</small></h2>
        <div className="big-strip" style={{ ['--n' as string]: span }}>
          {stretches.map((s, i) => (
            <div key={i} className="bs-block" style={{ gridColumn: `${dayIndex(from, s.from) + 1} / ${dayIndex(from, s.to) + 2}`, background: color(s.status) }} title={`${fmtDate(s.from, i18n.language)} → ${fmtDate(s.to, i18n.language)} · ${STATUS_META[s.status]?.label ?? s.status}${s.label ? ' · ' + s.label : ''}`}>
              {s.n >= 5 && <><span>{STATUS_META[s.status]?.label ?? s.status}</span><small>{s.label ? s.label.split(' · ')[0] : `${s.n} ${t('days', 'days')}`}</small></>}
            </div>
          ))}
          {todayIdx >= 0 && todayIdx < span && <span style={{ position: 'absolute', insetInlineStart: `${(todayIdx + 0.5) / span * 100}%`, top: 0, bottom: 0, width: 2, background: 'var(--text)' }} aria-hidden />}
        </div>
        <div className="strip-axis" style={{ ['--n' as string]: span }}>
          {Array.from({ length: span }, (_, i) => addDays(from, i)).map((d, i) => <span key={d} className={i === todayIdx ? 'today' : ''}>{i % 7 === 0 || i === todayIdx ? (i === todayIdx ? t('todayShort', 'today') : new Date(d).toLocaleDateString(i18n.language, { day: 'numeric', month: 'short', timeZone: 'UTC' })) : ''}</span>)}
        </div>
      </section>

      <div className="focus-grid">
        <section className="card2">
          <h2>{t('howDaysSplit', 'How the days split up')}</h2>
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <Donut slices={counts.map(([k, v]) => ({ key: k, value: v, color: color(k), label: STATUS_META[k]?.label ?? k }))} size={170} caption={t('days', 'days')} />
          </div>
          <div className="reasons">
            {counts.map(([k, v]) => <div key={k} className="reason-row" style={{ gridTemplateColumns: '130px 1fr auto' }}><span className="st-dot" style={{ ['--c' as string]: color(k) }}>{STATUS_META[k]?.label ?? k}</span><div><i style={{ width: `${v / (counts[0]?.[1] || 1) * 100}%`, background: color(k) }} /></div><b>{v}</b></div>)}
          </div>
          <h2 style={{ marginTop: 6 }}>{t('stretchList', 'Stretch by stretch')}</h2>
          <ul className="stretch-list">
            {stretches.filter(s => s.to >= addDays(today, -7)).slice(0, 10).map((s, i) => (
              <li key={i} style={{ ['--c' as string]: color(s.status) }}>
                <span><b>{STATUS_META[s.status]?.label ?? s.status}</b>{s.label ? <small> · {s.label}</small> : null}<br /><small>{fmtDate(s.from, i18n.language)} → {fmtDate(s.to, i18n.language)}</small></span>
                <b>{s.n} {t('d', 'd')}</b>
              </li>
            ))}
          </ul>
        </section>
        <section className="card2">
          <h2>{t('calendar', 'Calendar')}</h2>
          <div className="months">
            {months.map(([m, ds]) => {
              const first = new Date(`${m}-01T00:00:00Z`)
              const pad = (first.getUTCDay() + 6) % 7
              const inMonth = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate()
              const byDate = new Map(ds.map(d => [d.date, d]))
              return (
                <div key={m} className="month">
                  <h3>{first.toLocaleDateString(i18n.language, { month: 'long', year: 'numeric', timeZone: 'UTC' })}</h3>
                  <div className="month-grid">
                    {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => <span key={i} className="dow">{d}</span>)}
                    {Array.from({ length: pad }, (_, i) => <span key={`p${i}`} />)}
                    {Array.from({ length: inMonth }, (_, i) => {
                      const date = `${m}-${String(i + 1).padStart(2, '0')}`
                      const d = byDate.get(date)
                      return <span key={date} className={`d${d ? '' : ' none'}${date === today ? ' today' : ''}`} style={d ? { ['--c' as string]: color(d.status) } : undefined} title={d ? `${fmtDate(date, i18n.language)} · ${STATUS_META[d.status]?.label ?? d.status}${d.label ? ' · ' + d.label : ''}` : undefined}>{i + 1}</span>
                    })}
                  </div>
                </div>
              )
            })}
          </div>
          <Legend items={counts.map(([k]) => ({ color: color(k), label: STATUS_META[k]?.label ?? k }))} />
        </section>
      </div>
    </div>
  )
}
