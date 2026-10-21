import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeftRight, CalendarRange } from 'lucide-react'
import { api } from './api'
import { BulkBar, RowBox, SelectAllBox, useSelection } from './bulk'
import { PageGuide } from './guide'
import { errMsg, useApi, useLive } from './hooks'
import { rankOf, rankOrder, useRanks } from './personform'
import { PersonLink } from './profiles'
import { RotationStrip, rotationNow } from './quick'
import type { Pattern } from './quick'
import { useToast } from './ui'

interface Row {
  id: string; firstName: string; lastName: string; tags: string[]; backToBackId: string | null
  rotationPatternId: string | null; rotationAnchorDate: string | null; position: { name: string }
}
const DAY = 86_400_000
const plus = (iso: string, n: number) => new Date(Date.parse(iso) + n * DAY).toISOString().slice(0, 10)
const today = () => new Date().toISOString().slice(0, 10)

/**
 * Work and days off for everyone on one page: each person's rotation and the first day of one of their work
 * stretches. Partners sit next to each other and can be set to work the opposite stretches in one click.
 */
export default function Rotations() {
  const { t, i18n } = useTranslation()
  const toast = useToast()
  const { ranks } = useRanks()
  const list = useApi<{ items: Row[] }>('/employees?limit=200')
  const patterns = useApi<Pattern[]>('/catalogs/rotation-patterns')
  useLive(list.reload)
  const [text, setText] = useState('')
  const [onlyMissing, setOnlyMissing] = useState(false)
  const [busy, setBusy] = useState('')
  const [bulkBusy, setBulkBusy] = useState(false)

  const all = useMemo(() => list.data?.items ?? [], [list.data])
  const byId = useMemo(() => new Map(all.map(p => [p.id, p])), [all])
  const patternOf = (r: Row) => patterns.data?.find(p => p.id === r.rotationPatternId)
  // partners next to each other, the higher rank first
  const ordered = useMemo(() => {
    const sorted = [...all].sort((a, b) => rankOrder(ranks, a.tags) - rankOrder(ranks, b.tags) || a.lastName.localeCompare(b.lastName))
    const seen = new Set<string>(); const out: { row: Row; paired: boolean }[] = []
    for (const r of sorted) {
      if (seen.has(r.id)) continue
      seen.add(r.id); out.push({ row: r, paired: false })
      const mate = r.backToBackId ? byId.get(r.backToBackId) : undefined
      if (mate && !seen.has(mate.id)) { seen.add(mate.id); out.push({ row: mate, paired: true }) }
    }
    return out
  }, [all, byId, ranks])
  const q = text.trim().toLowerCase()
  const rows = ordered.filter(({ row: r }) => (!onlyMissing || !r.rotationAnchorDate) && (!q || `${r.firstName} ${r.lastName} ${r.lastName} ${r.firstName}`.toLowerCase().includes(q)))
  const missing = all.filter(r => !r.rotationAnchorDate).length
  const pick = useSelection(rows.map(({ row: r }) => r.id))
  const applyBulk = async (action: string, value: string) => {
    setBulkBusy(true)
    try {
      const r = await api<{ updated: number }>('/employees/bulk', { method: 'POST', body: { ids: pick.ids, action, value } })
      toast(`${r.updated} ${t('peopleUpdated', 'people updated')}`); await list.reload()
    } catch (e) { toast(errMsg(e), 'error') }
    setBulkBusy(false)
  }
  // "Off today" needs each person's own pattern, so it is worked out per row rather than sent as one date.
  const bulkOffToday = async () => {
    setBulkBusy(true)
    try {
      const groups = new Map<string, string[]>()
      for (const id of pick.ids) {
        const r = byId.get(id); const p = r && patternOf(r)
        if (!p || p.type !== 'cycle') continue
        const date = plus(today(), -(p.daysOn ?? 28))
        groups.set(date, [...(groups.get(date) ?? []), id])
      }
      for (const [date, ids] of groups) await api('/employees/bulk', { method: 'POST', body: { ids, action: 'rotationAnchor', value: date } })
      const n = [...groups.values()].reduce((a, b) => a + b.length, 0)
      toast(n ? `${n} ${t('peopleUpdated', 'people updated')}` : t('needPattern', 'Give them a rotation first'), n ? 'ok' : 'error'); await list.reload()
    } catch (e) { toast(errMsg(e), 'error') }
    setBulkBusy(false)
  }

  const save = async (r: Row, body: { rotationPatternId?: string | null; rotationAnchorDate?: string | null }, quiet = false) => {
    setBusy(r.id)
    try { await api(`/employees/${r.id}`, { method: 'PUT', body }); if (!quiet) toast(`${r.firstName} ${r.lastName}: ${t('saved', 'saved')}`); await list.reload() } catch (e) { toast(errMsg(e), 'error') }
    setBusy('')
  }
  const opposite = async (r: Row) => {
    const mate = r.backToBackId ? byId.get(r.backToBackId) : undefined
    const p = patternOf(r)
    if (!mate || !p || p.type !== 'cycle' || !r.rotationAnchorDate) return
    await save(mate, { rotationPatternId: p.id, rotationAnchorDate: plus(r.rotationAnchorDate.slice(0, 10), p.daysOn ?? 28) }, true)
    toast(`${mate.firstName} ${mate.lastName} ${t('worksOpposite', 'works the opposite stretches of')} ${r.firstName} ${r.lastName}`)
  }
  const fmt = (iso: string) => new Date(iso).toLocaleDateString(i18n.language, { day: 'numeric', month: 'short', timeZone: 'UTC' })

  return (
    <main className="page wide">
      <PageGuide id="rotations" Icon={CalendarRange} color="var(--pal-cyan-600)" title={t('rotationsTitle', 'Work and days off')}
        purpose={t('rotationsPurpose', 'When each person works and when they are off. Set the rotation and the first day of one work stretch; the system works out every stretch after it.')}
        steps={[
          t('roStep1', 'Pick the first day of any work stretch (past or future) in "First day on". "Today" means a stretch starts today; "Off today" means they just finished one.'),
          t('roStep2', 'Back-to-back partners are listed together. The ⇄ button makes the partner work exactly the stretches this person is off.'),
          t('roStep3', 'The strip shows the next 8 weeks: dark squares are work days. Right-click any name elsewhere in the app for the same setting.'),
        ]} />

      <div className="filters">
        <input value={text} onChange={e => setText(e.target.value)} placeholder={t('personSearch', 'Name')} aria-label={t('search', 'Search')} />
        <label className="check"><input type="checkbox" checked={onlyMissing} onChange={e => setOnlyMissing(e.target.checked)} /> {t('onlyMissing', 'Only people not set up yet')} ({missing})</label>
        <span className="spacer" /><span className="muted">{all.length - missing} / {all.length} {t('setUp', 'set up')}</span>
      </div>
      {list.error && <div className="banner error" role="alert">{list.error}</div>}

      <BulkBar count={pick.count} busy={bulkBusy} onApply={applyBulk} onClear={pick.clear}
        fields={[
          { key: 'rotation', label: t('rotation', 'Rotation'), options: (patterns.data ?? []).map(x => ({ value: x.id, label: x.name })) },
          { key: 'rotationAnchor', label: t('firstDayOn', 'First day on'), type: 'date', buttons: [{ label: t('today', 'Today'), value: () => today(), title: t('startsToday', 'A work stretch starts today') }, { label: t('noDate', 'None'), value: () => '', title: t('clearAnchor', 'Forget the first day again') }] },
        ]}>
        <button type="button" disabled={bulkBusy} onClick={() => void bulkOffToday()} title={t('offTodayHint', 'Today is their first day off: the stretch before it has just ended')}>{t('offToday', 'Off today')}</button>
      </BulkBar>

      <div className="table-scroll">
        <table className="table compact rot-table">
          <thead><tr><th className="pick-col"><SelectAllBox all={pick.all} some={pick.some} onChange={pick.toggleAll} label={t('selectAll', 'Select everyone shown')} /></th><th>{t('name', 'Name')}</th><th>{t('rank', 'Rank')}</th><th>{t('rotation', 'Rotation')}</th><th>{t('firstDayOn', 'First day on')}</th><th>{t('today', 'Today')}</th><th>{t('next8', 'Next 8 weeks')}</th><th /></tr></thead>
          <tbody>
            {rows.map(({ row: r, paired }) => {
              const p = patternOf(r)
              const anchor = r.rotationAnchorDate?.slice(0, 10) ?? ''
              const now = rotationNow(p, anchor || null)
              const mate = r.backToBackId ? byId.get(r.backToBackId) : undefined
              return (
                <tr key={r.id} className={`${paired ? 'paired' : mate ? 'pair-top' : ''}${pick.has(r.id) ? ' picked' : ''}`}>
                  <td className="pick-col"><RowBox on={pick.has(r.id)} onChange={on => pick.toggle(r.id, on)} label={`${r.firstName} ${r.lastName}`} /></td>
                  <td><strong><PersonLink id={r.id}>{r.firstName} {r.lastName}</PersonLink></strong>{paired && <small className="muted unit-note">{t('partnerOf', 'partner')}</small>}</td>
                  <td>{rankOf(ranks, r.tags)?.label ?? <span className="muted">{r.position.name}</span>}</td>
                  <td>
                    <select value={r.rotationPatternId ?? ''} disabled={busy === r.id} onChange={e => void save(r, { rotationPatternId: e.target.value || null })} aria-label={`${t('rotation', 'Rotation')} ${r.firstName} ${r.lastName}`}>
                      <option value="">—</option>{patterns.data?.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
                    </select>
                  </td>
                  <td className="rot-anchor">
                    <input type="date" value={anchor} disabled={busy === r.id} onChange={e => void save(r, { rotationAnchorDate: e.target.value || null, ...(r.rotationPatternId ? {} : { rotationPatternId: patterns.data?.find(x => x.name === '28/28')?.id ?? null }) })} aria-label={`${t('firstDayOn', 'First day on')} ${r.firstName} ${r.lastName}`} />
                    <button type="button" disabled={busy === r.id} onClick={() => void save(r, { rotationAnchorDate: today() })}>{t('today', 'Today')}</button>
                    {p?.type === 'cycle' && <button type="button" disabled={busy === r.id} onClick={() => void save(r, { rotationAnchorDate: plus(today(), -(p.daysOn ?? 28)) })}>{t('offToday', 'Off today')}</button>}
                  </td>
                  <td>{now ? <span className={`rot-now ${now.on ? 'on' : 'off'}`}>{now.on ? t('workingUntil', 'Working until') : t('offUntil', 'Off until')} {fmt(now.until)}</span> : <span className="muted">{anchor ? '' : t('notSet', 'not set')}</span>}</td>
                  <td><RotationStrip pattern={p} anchor={anchor} /></td>
                  <td className="row-actions">
                    {mate && <button type="button" disabled={!anchor || p?.type !== 'cycle' || busy !== ''} onClick={() => void opposite(r)} title={`${mate.firstName} ${mate.lastName} ${t('worksOppositeShort', 'works the opposite stretches')}`} aria-label={`${mate.firstName} ${mate.lastName} ${t('worksOppositeShort', 'works the opposite stretches')}`}><ArrowLeftRight size={14} aria-hidden /></button>}
                  </td>
                </tr>
              )
            })}
            {list.data && rows.length === 0 && <tr><td colSpan={8} className="muted">{t('noPeopleMatch', 'Nobody matches.')}</td></tr>}
          </tbody>
        </table>
      </div>
    </main>
  )
}
