import { useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, HelpCircle } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

const key = (id: string) => `crewboard.guide.${id}`
// The steps open on the first visit to a screen (not on phones, where they would fill the screen), then stay
// folded unless the person opens them again; their choice is remembered per screen.
const read = (id: string) => {
  try {
    const v = localStorage.getItem(key(id))
    if (v) return v === 'open'
    localStorage.setItem(key(id), 'closed')
    return window.innerWidth >= 760
  } catch { return false }
}
const write = (id: string, open: boolean) => { try { localStorage.setItem(key(id), open ? 'open' : 'closed') } catch { /* private mode */ } }

/**
 * The header every screen starts with: a coloured icon, what the screen is for in one sentence, and a short
 * "how it works" that can be folded away (remembered per screen). Actions sit on the right.
 */
export function PageGuide({ id, Icon, color, title, purpose, steps, children }: {
  id: string; Icon: LucideIcon; color: string; title: string; purpose: string; steps?: ReactNode[]; children?: ReactNode
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(() => read(id))
  const toggle = () => { setOpen(!open); write(id, !open) }
  return (
    <header className="guide" style={{ ['--g' as string]: color }}>
      <div className="guide-top">
        <span className="guide-icon" aria-hidden><Icon size={22} /></span>
        <div className="guide-text">
          <h1>{title}</h1>
          <p>{purpose}</p>
        </div>
        <div className="guide-actions">
          {children}
          {steps && steps.length > 0 && (
            <button type="button" className="guide-help" onClick={toggle} aria-expanded={open}>
              <HelpCircle size={15} aria-hidden /> {t('howItWorks', 'How it works')} <ChevronDown size={14} aria-hidden className={open ? 'flip' : ''} />
            </button>
          )}
        </div>
      </div>
      {open && steps && steps.length > 0 && (
        <ol className="guide-steps">{steps.map((s, i) => <li key={i}><b>{i + 1}</b><span>{s}</span></li>)}</ol>
      )}
    </header>
  )
}

/** A row of coloured keys explaining what a colour means. */
export function Legend({ items }: { items: { color: string; label: string; shape?: 'dot' | 'bar' | 'ring' }[] }) {
  return (
    <ul className="legend2" aria-label="Legend">
      {items.map(i => <li key={i.label}><i className={i.shape ?? 'dot'} style={{ ['--c' as string]: i.color }} />{i.label}</li>)}
    </ul>
  )
}

/** Donut chart from slices; the centre shows a number and a caption. Slices are clickable when onPick is given. */
export function Donut({ slices, size = 150, center, caption, onPick, active }: {
  slices: { key: string; value: number; color: string; label: string }[]; size?: number
  center?: ReactNode; caption?: string; onPick?: (key: string) => void; active?: string
}) {
  const total = slices.reduce((a, s) => a + s.value, 0) || 1
  const r = 42, c = 2 * Math.PI * r
  let acc = 0
  return (
    <div className="donut" style={{ width: size, height: size }}>
      <svg viewBox="0 0 100 100" role="img" aria-label={slices.map(s => `${s.label} ${s.value}`).join(', ')}>
        <circle style={{ stroke: 'var(--border)' }} cx="50" cy="50" r={r} fill="none" strokeWidth="12" />
        {slices.filter(s => s.value > 0).map(s => {
          const len = (s.value / total) * c
          const el = (
            <circle key={s.key} cx="50" cy="50" r={r} fill="none" strokeWidth={active === s.key ? 16 : 12}
              strokeDasharray={`${Math.max(0, len - 1)} ${c}`} strokeDashoffset={-acc} transform="rotate(-90 50 50)"
              style={{ stroke: s.color, cursor: onPick ? 'pointer' : undefined, opacity: active && active !== s.key ? 0.35 : 1, transition: 'opacity .2s' }}
              onClick={() => onPick?.(s.key)}><title>{`${s.label}: ${s.value}`}</title></circle>
          )
          acc += len
          return el
        })}
      </svg>
      <div className="donut-center"><strong>{center ?? total}</strong>{caption && <small>{caption}</small>}</div>
    </div>
  )
}

/** Ring showing filled / required (crew completeness). */
export function Ring({ value, max, size = 40, color }: { value: number; max: number; size?: number; color: string }) {
  const r = 15, c = 2 * Math.PI * r, p = max ? Math.min(1, value / max) : 0
  return (
    <svg width={size} height={size} viewBox="0 0 36 36" className="ring" role="img" aria-label={`${value} of ${max}`}>
      <circle cx="18" cy="18" r={r} fill="none" stroke="rgba(255,255,255,.35)" strokeWidth="4" />
      <circle style={{ stroke: color }} cx="18" cy="18" r={r} fill="none" strokeWidth="4" strokeDasharray={`${p * c} ${c}`} transform="rotate(-90 18 18)" strokeLinecap="round" />
      <text x="18" y="21.5" textAnchor="middle" fontSize="10" fontWeight="700" fill="currentColor">{value}/{max}</text>
    </svg>
  )
}

/** Distinct colours for bases, used everywhere a base appears (board, map, charts). */
export const BASE_COLORS = ['var(--pal-blue-700)', 'var(--pal-purple-700)', 'var(--pal-teal-700)', 'var(--pal-pink-700)', 'var(--pal-orange-700)', 'var(--pal-indigo-700)']
export const baseColor = (codes: string[], code: string) => BASE_COLORS[Math.max(0, codes.indexOf(code)) % BASE_COLORS.length]
