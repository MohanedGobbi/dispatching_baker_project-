import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2 } from 'lucide-react'
import { api } from './api'
import { errMsg, useApi } from './hooks'
import { fmtDate } from './labels'
import { Pill, useToast } from './ui'

interface Options { idleUnits: { id: string; code: string; type: string; base: string }[]; bases: { id: string; code: string }[]; positions: string[]; qualifications: string[] }
interface Rule { baseId: string; position: string; qualification: string; experienced: boolean; count: number; days: number; startDay: number }
interface Result {
  period: { from: string; to: string; days: number }; applied: string[]; verdict: 'ok' | 'worse'; deltaRequiredGapDays: number
  baseline: { stats: { gaps: number; gapDays: number; requiredGapDays: number; placements: number } }
  scenario: { stats: { gaps: number; gapDays: number; requiredGapDays: number; placements: number } }
  byBase: { base: string; before: number; after: number }[]
  newGaps: { seatId: string; seat: string; from: string; to: string; days: number; options: string[] }[]
}
const blank = (): Rule => ({ baseId: '', position: 'Field Operator', qualification: '', experienced: false, count: 3, days: 14, startDay: 0 })

/** "What if…" (plan 18): try a change on a copy of the plan and see which days would go uncovered. Nothing is saved. */
export default function WhatIf() {
  const { t, i18n } = useTranslation()
  const toast = useToast()
  const opts = useApi<Options>('/planning/what-if/options')
  const [days, setDays] = useState(28)
  const [deploy, setDeploy] = useState<string[]>([])
  const [lose, setLose] = useState<Rule[]>([])
  const [absent, setAbsent] = useState<Rule[]>([])
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState<Result | null>(null)
  const o = opts.data

  const filt = (r: Rule) => ({ baseId: r.baseId || undefined, position: r.position || undefined, qualification: r.qualification || undefined, experienced: r.experienced || undefined })
  const run = async () => {
    setBusy(true)
    try {
      setRes(await api<Result>('/planning/what-if', { method: 'POST', body: { days, deployUnitIds: deploy, lose: lose.map(r => ({ ...filt(r), count: r.count })), absent: absent.map(r => ({ ...filt(r), count: r.count, days: r.days, startDay: r.startDay })) } }))
    } catch (e) { toast(errMsg(e), 'error') } finally { setBusy(false) }
  }
  const upd = (list: Rule[], set: (r: Rule[]) => void, i: number, patch: Partial<Rule>) => set(list.map((r, j) => (j === i ? { ...r, ...patch } : r)))

  const Who = ({ r, i, list, set, leave }: { r: Rule; i: number; list: Rule[]; set: (r: Rule[]) => void; leave?: boolean }) => (
    <div className="wi-rule" key={i}>
      <input type="number" min={1} max={50} value={r.count} aria-label="How many" onChange={e => upd(list, set, i, { count: +e.target.value })} />
      <label className="check-row"><input type="checkbox" checked={r.experienced} onChange={e => upd(list, set, i, { experienced: e.target.checked })} /> {t('wiExp', 'experienced')}</label>
      <select value={r.qualification} onChange={e => upd(list, set, i, { qualification: e.target.value })} aria-label="Qualification"><option value="">{t('wiAnyQual', 'any qualification')}</option>{o?.qualifications.map(q => <option key={q}>{q}</option>)}</select>
      <select value={r.position} onChange={e => upd(list, set, i, { position: e.target.value })} aria-label="Position"><option value="">{t('wiAnyPos', 'any position')}</option>{o?.positions.map(p => <option key={p}>{p}</option>)}</select>
      <select value={r.baseId} onChange={e => upd(list, set, i, { baseId: e.target.value })} aria-label="Base"><option value="">{t('allBases', 'All bases')}</option>{o?.bases.map(b => <option key={b.id} value={b.id}>{b.code}</option>)}</select>
      {leave && <><label>{t('wiFrom', 'from day')} <input type="number" min={0} value={r.startDay} onChange={e => upd(list, set, i, { startDay: +e.target.value })} /></label><label>{t('wiFor', 'for')} <input type="number" min={1} value={r.days} onChange={e => upd(list, set, i, { days: +e.target.value })} /> {t('days', 'days')}</label></>}
      <button type="button" aria-label="Remove" onClick={() => set(list.filter((_, j) => j !== i))}><Trash2 size={14} /></button>
    </div>
  )

  const nothing = !deploy.length && !lose.length && !absent.length
  const max = res ? Math.max(1, ...res.byBase.flatMap(b => [b.before, b.after])) : 1
  return (
    <>
      <section className="panel">
        <h2>{t('wiTitle', 'Try a change')}</h2>
        <p className="muted">{t('wiIntro', 'The planner runs again on a copy of the data. Nothing is saved or sent to anyone.')}</p>
        <label>{t('wiHorizon', 'Look ahead')} <select value={days} onChange={e => setDays(+e.target.value)}>{[14, 28, 42, 60, 90].map(d => <option key={d} value={d}>{d} {t('days', 'days')}</option>)}</select></label>

        <fieldset><legend>{t('wiDeploy', 'Put idle units to work')}</legend>
          {o?.idleUnits.length === 0 && <p className="muted">{t('wiNoIdle', 'Every unit already has a job.')}</p>}
          {o?.idleUnits.map(u => <label key={u.id} className="check-row"><input type="checkbox" checked={deploy.includes(u.id)} onChange={e => setDeploy(e.target.checked ? [...deploy, u.id] : deploy.filter(x => x !== u.id))} /> {u.code} <span className="muted">{u.type} · {u.base}</span></label>)}
        </fieldset>
        <fieldset><legend>{t('wiLose', 'Lose people (resign, transfer, retire)')}</legend>
          {lose.map((r, i) => Who({ r, i, list: lose, set: setLose }))}
          <button type="button" onClick={() => setLose([...lose, blank()])}><Plus size={14} aria-hidden /> {t('wiAdd', 'Add')}</button>
        </fieldset>
        <fieldset><legend>{t('wiAbsent', 'Absent for a while (leave, training, sickness)')}</legend>
          {absent.map((r, i) => Who({ r, i, list: absent, set: setAbsent, leave: true }))}
          <button type="button" onClick={() => setAbsent([...absent, blank()])}><Plus size={14} aria-hidden /> {t('wiAdd', 'Add')}</button>
        </fieldset>
        <div className="actions"><button type="button" className="primary" disabled={busy || nothing} onClick={run}>{busy ? '…' : t('wiRun', 'Run simulation')}</button></div>
      </section>

      {res && (
        <section className="panel" aria-label="Simulation result">
          <h2>{t('wiResult', 'Result')} <span className="muted">· {fmtDate(res.period.from, i18n.language)} – {fmtDate(res.period.to, i18n.language)}</span></h2>
          <ul className="an-list">{res.applied.map(a => <li key={a}>• {a}</li>)}</ul>
          <div className="an-kpis">
            <div className="an-card"><span className="an-label">{t('wiBefore', 'Uncovered days today')}</span><strong>{res.baseline.stats.requiredGapDays}</strong></div>
            <div className={`an-card ${res.verdict === 'worse' ? 'bad' : 'ok'}`}><span className="an-label">{t('wiAfter', 'Uncovered days after the change')}</span><strong>{res.scenario.stats.requiredGapDays}</strong><small className="muted">{res.deltaRequiredGapDays > 0 ? '+' : ''}{res.deltaRequiredGapDays} {t('days', 'days')}</small></div>
            <div className="an-card"><span className="an-label">{t('wiGaps', 'Gaps before / after')}</span><strong>{res.baseline.stats.gaps} → {res.scenario.stats.gaps}</strong></div>
          </div>
          <h3>{t('wiByBase', 'Uncovered days by base')}</h3>
          <div className="an-bars">{res.byBase.map(b => (
            <div key={b.base} className="an-bar"><span>{b.base}</span>
              <div><i style={{ width: `${(b.before / max) * 100}%`, background: 'var(--st-off)' }} /></div><b>{b.before}</b>
              <span />
              <div><i style={{ width: `${(b.after / max) * 100}%`, background: b.after > b.before ? 'var(--bad)' : 'var(--ok)' }} /></div><b>{b.after}</b>
            </div>
          ))}</div>
          <p className="an-key"><i style={{ background: 'var(--st-off)' }} /> {t('wiNow', 'today')} <i style={{ background: 'var(--bad)' }} /> {t('wiScenario', 'with the change')}</p>
          {res.newGaps.length > 0 && <>
            <h3>{t('wiNew', 'Biggest new gaps')}</h3>
            <table className="table"><thead><tr><th>{t('seat', 'Seat')}</th><th>{t('anFrom', 'From')}</th><th>{t('anTo', 'To')}</th><th>{t('days', 'days')}</th><th>{t('wiWhy', 'Why it is hard')}</th></tr></thead>
              <tbody>{res.newGaps.map(g => <tr key={g.seatId + g.from}><th scope="row">{g.seat}</th><td>{fmtDate(g.from, i18n.language)}</td><td>{fmtDate(g.to, i18n.language)}</td><td><Pill severity={g.days > 14 ? 'bad' : 'warn'}>{g.days}</Pill></td><td className="muted">{g.options[0]}</td></tr>)}</tbody></table>
          </>}
          {res.newGaps.length === 0 && <p>{t('wiNoNew', 'No new gaps: the rest of the organisation absorbs this change.')}</p>}
        </section>
      )}
    </>
  )
}
