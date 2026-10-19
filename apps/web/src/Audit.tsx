import { Fragment, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useApi, useDebounced } from './hooks'

interface Entry {
  id: string; at: string; entity: string; entityId: string; action: string; reason: string | null; redacted: boolean
  user: { id: string; login: string } | null; before: unknown; after: unknown
}
interface Facets { entities: { name: string; count: number }[]; actions: { name: string; count: number }[] }

const PAGE = 50
const fmtTime = (iso: string, lang: string) => new Date(iso).toLocaleString(lang, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
const show = (v: unknown) => (v === undefined ? '—' : typeof v === 'string' ? v : JSON.stringify(v))

/** Field-by-field difference of two records. Values that are not plain objects are compared whole. */
function changes(before: unknown, after: unknown): { key: string; from: unknown; to: unknown }[] {
  const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null)
  const b = obj(before), a = obj(after)
  if (!b && !a) return before === undefined && after === undefined ? [] : [{ key: '', from: before ?? undefined, to: after ?? undefined }]
  const keys = [...new Set([...Object.keys(b ?? {}), ...Object.keys(a ?? {})])]
  return keys.filter(k => JSON.stringify(b?.[k]) !== JSON.stringify(a?.[k])).map(k => ({ key: k, from: b?.[k], to: a?.[k] }))
}

/** The audit trail (plan section 23): every change with who, when, before/after and the reason given. */
export default function Audit() {
  const { t, i18n } = useTranslation()
  const facets = useApi<Facets>('/audit/facets')
  const [entity, setEntity] = useState('')
  const [action, setAction] = useState('')
  const [who, setWho] = useState('')
  const [entityId, setEntityId] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [offset, setOffset] = useState(0)
  const [open, setOpen] = useState<string | null>(null)
  const login = useDebounced(who.trim())
  const id = useDebounced(entityId.trim())
  const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset) })
  for (const [k, v] of Object.entries({ entity, action, login, entityId: id, from, to })) if (v) params.set(k, v)
  const list = useApi<{ total: number; items: Entry[] }>(`/audit?${params}`)
  const filter = (set: (v: string) => void) => (v: string) => { set(v); setOffset(0) }
  const total = list.data?.total ?? 0

  return (
    <main className="page wide">
      <header className="page-head">
        <div><h1>{t('auditTitle', 'Audit log')}</h1><p className="muted">{t('auditIntro', 'Every change, who made it and why. Read only.')}</p></div>
      </header>
      <div className="filters">
        <select value={entity} onChange={e => filter(setEntity)(e.target.value)} aria-label={t('auditEntity', 'Record type')}>
          <option value="">{t('auditAllEntities', 'All record types')}</option>{facets.data?.entities.map(f => <option key={f.name} value={f.name}>{f.name} ({f.count})</option>)}
        </select>
        <select value={action} onChange={e => filter(setAction)(e.target.value)} aria-label={t('auditAction', 'Action')}>
          <option value="">{t('auditAllActions', 'All actions')}</option>{facets.data?.actions.map(f => <option key={f.name} value={f.name}>{f.name.replace(/_/g, ' ')} ({f.count})</option>)}
        </select>
        <input value={who} onChange={e => filter(setWho)(e.target.value)} placeholder={t('auditWho', 'Who (login)')} aria-label={t('auditWho', 'Who (login)')} />
        <input value={entityId} onChange={e => filter(setEntityId)(e.target.value)} placeholder={t('auditId', 'Record id')} aria-label={t('auditId', 'Record id')} />
        <label className="muted">{t('from', 'From')} <input type="date" value={from} onChange={e => filter(setFrom)(e.target.value)} /></label>
        <label className="muted">{t('to', 'To')} <input type="date" value={to} onChange={e => filter(setTo)(e.target.value)} /></label>
        <span className="spacer" />
        <span className="muted">{total ? `${offset + 1}–${Math.min(offset + PAGE, total)} / ${total}` : '0'}</span>
        <button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>{t('prev', 'Previous')}</button>
        <button type="button" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>{t('next', 'Next')}</button>
      </div>
      {list.error && <div className="banner error" role="alert">{list.error}</div>}
      <table className="table compact">
        <thead><tr><th /><th>{t('when', 'When')}</th><th>{t('who', 'Who')}</th><th>{t('auditEntity', 'Record type')}</th><th>{t('auditAction', 'Action')}</th><th>{t('reason', 'Reason')}</th></tr></thead>
        <tbody>
          {list.data?.items.map(r => {
            const isOpen = open === r.id
            const diff = isOpen ? changes(r.before, r.after) : []
            return (
              <Fragment key={r.id}>
                <tr className="click" onClick={() => setOpen(isOpen ? null : r.id)}>
                  <td><button type="button" className="link" aria-expanded={isOpen} aria-label={t('auditDetails', 'Details')} onClick={e => { e.stopPropagation(); setOpen(isOpen ? null : r.id) }}>{isOpen ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}</button></td>
                  <td>{fmtTime(r.at, i18n.language)}</td>
                  <td>{r.user?.login ?? <span className="muted">{t('auditSystem', 'system / self-service')}</span>}</td>
                  <td>{r.entity} <small className="muted">{r.entityId.length > 14 ? `…${r.entityId.slice(-8)}` : r.entityId}</small></td>
                  <td>{r.action.replace(/_/g, ' ')}</td>
                  <td>{r.reason ?? <span className="muted">—</span>}</td>
                </tr>
                {isOpen && (
                  <tr><td /><td colSpan={5}>
                    <p className="muted">{r.entity} <code>{r.entityId}</code></p>
                    {r.redacted ? <p className="muted">{t('auditRedacted', 'Details hidden: medical information.')}</p>
                      : diff.length === 0 ? <p className="muted">{t('auditNoDetail', 'No field-level details recorded.')}</p>
                      : (
                        <table className="table compact audit-diff">
                          <thead><tr><th>{t('field', 'Field')}</th><th>{t('before', 'Before')}</th><th>{t('after', 'After')}</th></tr></thead>
                          <tbody>{diff.map(d => <tr key={d.key}><td><code>{d.key || '—'}</code></td><td className="del">{show(d.from)}</td><td className="add">{show(d.to)}</td></tr>)}</tbody>
                        </table>
                      )}
                  </td></tr>
                )}
              </Fragment>
            )
          })}
          {list.data?.items.length === 0 && <tr><td colSpan={6} className="muted">{t('auditEmpty', 'Nothing matches these filters.')}</td></tr>}
        </tbody>
      </table>
    </main>
  )
}
