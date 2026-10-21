import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'

/**
 * Ticking rows in a list to change them together. The selection follows what is on screen: filtering a row away
 * drops it, so "select all" and the count always mean the rows the manager can see.
 */
export function useSelection(visibleIds: string[]) {
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const ids = useMemo(() => visibleIds.filter(id => picked.has(id)), [visibleIds, picked])
  const toggle = useCallback((id: string, on: boolean) => setPicked(p => { const n = new Set(p); if (on) n.add(id); else n.delete(id); return n }), [])
  const clear = useCallback(() => setPicked(new Set()), [])
  const all = visibleIds.length > 0 && ids.length === visibleIds.length
  const toggleAll = useCallback((on: boolean) => setPicked(p => {
    const n = new Set(p)
    for (const id of visibleIds) { if (on) n.add(id); else n.delete(id) }
    return n
  }), [visibleIds])
  return { ids, count: ids.length, has: (id: string) => picked.has(id), toggle, toggleAll, clear, all, some: ids.length > 0 && !all }
}

/** The header tick box: all / none, showing a dash while only some rows are ticked. */
export function SelectAllBox({ all, some, onChange, label }: { all: boolean; some: boolean; onChange: (on: boolean) => void; label: string }) {
  return (
    <input type="checkbox" className="pick-all" checked={all} ref={el => { if (el) el.indeterminate = some }} onChange={e => onChange(e.target.checked)} aria-label={label} />
  )
}

export function RowBox({ on, onChange, label }: { on: boolean; onChange: (on: boolean) => void; label: string }) {
  return <input type="checkbox" checked={on} onChange={e => onChange(e.target.checked)} aria-label={label} onClick={e => e.stopPropagation()} />
}

export interface BulkField {
  key: string
  label: string
  /** A picker of values, or a date (applied as soon as a whole date is entered). */
  options?: { value: string; label: string }[]
  type?: 'select' | 'date'
  /** Extra one-click actions that send a value worked out at the moment of the click. */
  buttons?: { label: string; value: () => string; title?: string }[]
}

/**
 * The bar that appears while rows are ticked. Choosing a value applies it to every ticked row at once;
 * the screen says what happened and keeps the selection so several fields can be set in a row.
 */
export function BulkBar({ count, fields, busy, onApply, onClear, children }: {
  count: number
  fields: BulkField[]
  busy?: boolean
  onApply: (key: string, value: string) => void | Promise<void>
  onClear: () => void
  children?: React.ReactNode
}) {
  const { t } = useTranslation()
  if (count === 0) return null
  return (
    <div className="bulk-bar" role="region" aria-label={t('bulkEdit', 'Change the ticked rows')}>
      <strong>{count} {t('selected', 'selected')}</strong>
      {fields.map(f => (
        <label key={f.key} className="bulk-field">
          <span>{f.label}</span>
          {f.type === 'date'
            ? <input type="date" disabled={busy} onChange={e => { if (e.target.value) void onApply(f.key, e.target.value) }} aria-label={f.label} />
            : <select disabled={busy} value="" onChange={e => { if (e.target.value) { void onApply(f.key, e.target.value); e.target.value = '' } }} aria-label={f.label}>
                <option value="">–</option>
                {f.options?.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>}
          {f.buttons?.map(b => <button key={b.label} type="button" disabled={busy} title={b.title} onClick={() => void onApply(f.key, b.value())}>{b.label}</button>)}
        </label>
      ))}
      {children}
      <span className="spacer" />
      <button type="button" className="bulk-clear" onClick={onClear}><X size={14} aria-hidden /> {t('clearSelection', 'Clear')}</button>
    </div>
  )
}
