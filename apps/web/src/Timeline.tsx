import { useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { useApi, useDebounced, useLive } from './hooks'
import { fmtDate } from './labels'
import PersonDrawer from './PersonDrawer'
import { STATUS_META } from './ui'

interface Block { from: string; to: string; status: string; label?: string; restrictions?: string[] }
interface Row { employeeId: string; name: string; employeeNo: string; base: string; position: string; group: string; blocks: Block[] }
interface Data { from: string; to: string; groupBy: string; rows: Row[] }

const DAY = 86_400_000
const iso = (d: Date) => d.toISOString().slice(0, 10)
const addDays = (s: string, n: number) => iso(new Date(Date.parse(s) + n * DAY))
const dayIndex = (from: string, d: string) => Math.round((Date.parse(d) - Date.parse(from)) / DAY)

/** Team timeline (plan 11.3): a row per person, a coloured block per stretch of the same status. */
export default function Timeline() {
  const { t, i18n } = useTranslation()
  const [from, setFrom] = useState(iso(new Date()))
  const [span, setSpan] = useState(28)
  const [baseId, setBaseId] = useState('')
  const [positionId, setPositionId] = useState('')
  const [groupBy, setGroupBy] = useState('base')
  const [search, setSearch] = useState('')
  const q = useDebounced(search.trim())
  const [open, setOpen] = useState<string | null>(null)

  const to = addDays(from, span - 1)
  const bases = useApi<{ id: string; code: string }[]>('/bases')
  const positions = useApi<{ id: string; name: string; category: string }[]>('/catalogs/positions')
  const qs = new URLSearchParams({ from, to, groupBy })
  if (baseId) qs.set('baseId', baseId)
  if (positionId) qs.set('positionId', positionId)
  if (q) qs.set('q', q)
  const data = useApi<Data>(`/calendar/timeline?${qs}`)
  useLive(data.reload)

  const days = useMemo(() => Array.from({ length: span }, (_, i) => addDays(from, i)), [from, span])
  const todayIdx = dayIndex(from, iso(new Date()))
  const groups = useMemo(() => {
    const m = new Map<string, Row[]>()
    for (const r of data.data?.rows ?? []) (m.get(r.group) ?? m.set(r.group, []).get(r.group)!).push(r)
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [data.data])
  const used = useMemo(() => [...new Set((data.data?.rows ?? []).flatMap(r => r.blocks.map(b => b.status)))], [data.data])
  const style = { '--n': span } as CSSProperties

  return (
    <main className="page wide">
      <header className="page-head">
        <div><h1>{t('timelineTitle', 'Timeline')}</h1><p className="muted">{t('timelineIntro', 'Who is where, day by day. Click a name for their details.')}</p></div>
      </header>

      <div className="filters">
        <label>{t('from', 'From')} <input type="date" value={from} onChange={e => e.target.value && setFrom(e.target.value)} /></label>
        <select value={span} onChange={e => setSpan(+e.target.value)} aria-label="Range">
          {[14, 28, 56, 90].map(n => <option key={n} value={n}>{n} {t('days', 'days')}</option>)}
        </select>
        <select value={baseId} onChange={e => setBaseId(e.target.value)} aria-label="Base">
          <option value="">{t('allBases', 'All bases')}</option>{bases.data?.map(b => <option key={b.id} value={b.id}>{b.code}</option>)}
        </select>
        <select value={positionId} onChange={e => setPositionId(e.target.value)} aria-label="Position">
          <option value="">{t('allPositions', 'All positions')}</option>{positions.data?.filter(p => p.category !== 'MANAGEMENT').map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select value={groupBy} onChange={e => setGroupBy(e.target.value)} aria-label="Group by">
          <option value="base">{t('groupBase', 'Group by base')}</option><option value="position">{t('groupPosition', 'Group by position')}</option><option value="unit">{t('groupUnit', 'Group by unit')}</option>
        </select>
        <input className="plain" value={search} onChange={e => setSearch(e.target.value)} placeholder={t('searchPerson', 'Name or employee number')} aria-label="Search" />
      </div>

      {data.error && <div className="banner error" role="alert">{data.error}</div>}
      {!data.loading && (data.data?.rows.length ?? 0) === 0 && <p className="empty-note">{t('noPeople', 'Nobody matches these filters.')}</p>}

      <ul className="legend top" aria-label="Legend">
        {used.map(s => <li key={s}><i style={{ background: STATUS_META[s]?.color ?? 'var(--border)' }} />{STATUS_META[s]?.label ?? s}</li>)}
      </ul>

      {groups.length > 0 && (
        <div className="tl" style={style} role="table" aria-label="Team timeline">
          <div className="tl-row tl-head" role="row">
            <span className="tl-name" />
            {days.map((d, i) => {
              const dt = new Date(d)
              const weekend = [5, 6].includes(dt.getUTCDay())
              return <span key={d} className={`tl-day${weekend ? ' we' : ''}${i === todayIdx ? ' today' : ''}`} title={fmtDate(d, i18n.language)}>{dt.getUTCDate() === 1 || i === 0 ? <b>{dt.toLocaleDateString(i18n.language, { month: 'short', timeZone: 'UTC' })}</b> : null}{dt.getUTCDate()}</span>
            })}
          </div>
          {groups.map(([group, rows]) => (
            <div key={group} role="rowgroup">
              <div className="tl-group">{group} <span className="muted">· {rows.length}</span></div>
              {rows.map(r => (
                <div className="tl-row" role="row" key={r.employeeId}>
                  <button type="button" className="tl-name" onClick={() => setOpen(r.employeeId)}>{r.name}<small>{r.position} · {r.base}</small></button>
                  {r.blocks.map((b, i) => {
                    const s = Math.max(0, dayIndex(from, b.from)), e = Math.min(span - 1, dayIndex(from, b.to))
                    const label = `${fmtDate(b.from, i18n.language)} → ${fmtDate(b.to, i18n.language)} · ${STATUS_META[b.status]?.label ?? b.status}${b.label ? ` · ${b.label}` : ''}${b.restrictions?.length ? ` · restricted: ${b.restrictions.join(', ')}` : ''}`
                    return (
                      <i key={i} className={`tl-block${b.restrictions?.length ? ' restricted' : ''}`} style={{ gridColumn: `${s + 2} / ${e + 3}`, background: STATUS_META[b.status]?.color ?? 'var(--border)' }} title={label} aria-label={label}>
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
      {open && <PersonDrawer id={open} date={from} onClose={() => setOpen(null)} />}
    </main>
  )
}
