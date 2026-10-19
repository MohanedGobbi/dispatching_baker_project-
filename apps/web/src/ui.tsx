import { createContext, useCallback, useContext, useState } from 'react'
import type { ReactNode } from 'react'
import { useDraggable } from '@dnd-kit/core'
import type { LucideIcon } from 'lucide-react'
import {
  AlertTriangle, Building2, CalendarDays, Check, Clock, GraduationCap, HeartPulse, Info, Moon, ShieldAlert, Truck, X,
} from 'lucide-react'
import type { Badge, Person, Severity } from './types'

// Status = icon + colour + text, never colour alone (plan 27.2 #4). Colours come from the design tokens.
export const STATUS_META: Record<string, { label: string; color: string; Icon: LucideIcon }> = {
  ON_UNIT: { label: 'On unit', color: 'var(--st-unit)', Icon: Truck },
  EXTENDED: { label: 'Extended', color: 'var(--st-extended)', Icon: AlertTriangle },
  ON_BASE_POST: { label: 'On base post', color: 'var(--st-base)', Icon: Building2 },
  STANDBY: { label: 'Standby', color: 'var(--st-standby)', Icon: Clock },
  DAYS_OFF: { label: 'Days off', color: 'var(--st-off)', Icon: Moon },
  LEAVE: { label: 'Leave', color: 'var(--st-leave)', Icon: CalendarDays },
  MEDICAL_LEAVE: { label: 'Medical leave', color: 'var(--st-medical)', Icon: HeartPulse },
  UNAVAILABLE: { label: 'Unavailable', color: 'var(--st-medical)', Icon: HeartPulse },
  AWAITING_CLEARANCE: { label: 'Awaiting clearance', color: 'var(--st-clearance)', Icon: ShieldAlert },
  TRAINING: { label: 'Training', color: 'var(--st-training)', Icon: GraduationCap },
  INACTIVE: { label: 'Inactive', color: 'var(--muted)', Icon: X },
}

const SEVERITY_ICON: Record<Severity, LucideIcon> = { ok: Check, info: Info, warn: AlertTriangle, bad: X }

export function SeverityBadge({ badge }: { badge: Badge }) {
  const Icon = SEVERITY_ICON[badge.severity]
  return (
    <span className={`badge sev-${badge.severity}`} title={badge.text}>
      <Icon size={12} aria-hidden /> {badge.text}
    </span>
  )
}

export const SENIORITY_LABEL: Record<string, string> = {
  NEW_RECRUIT: 'New recruit', JUNIOR: 'Junior', EXPERIENCED: 'Experienced', SENIOR: 'Senior',
}

export const initials = (name: string) => name.split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase()

interface DragData { person: Person; seatId?: string; assignmentId?: string; until?: string }

/** Person chip (plan 27.4): initials, name, seniority dot, qualification tags. Looks the same on board, lists and drawer. */
export function PersonChip({ person, drag, highlight, onOpen, compact, draft }: {
  person: Person
  drag?: { id: string; data: DragData }
  highlight?: boolean
  onOpen?: (id: string) => void
  compact?: boolean
  draft?: boolean
}) {
  const d = useDraggable({ id: drag?.id ?? `static:${person.id}`, data: drag?.data, disabled: !drag })
  return (
    <div
      ref={d.setNodeRef}
      {...(drag ? d.listeners : {})}
      {...(drag ? d.attributes : {})}
      className={`chip${highlight ? ' hit' : ''}${d.isDragging ? ' dragging' : ''}${compact ? ' compact' : ''}${draft ? ' draft' : ''}`}
      onDoubleClick={() => onOpen?.(person.id)}
      title={`${person.name} · ${SENIORITY_LABEL[person.seniority]}${draft ? ' · proposed in the draft plan' : ''}`}
    >
      <span className="avatar" aria-hidden>{initials(person.name)}<i className={`sen sen-${person.seniority}`} /></span>
      <span className="who">
        <button type="button" className="name" onClick={e => { e.stopPropagation(); onOpen?.(person.id) }} onPointerDown={e => e.stopPropagation()}>{person.name}</button>
        {!compact && <small>{person.position}{person.label ? ` · ${person.label}` : ''}</small>}
      </span>
      {person.tags.filter(t => t === 'OH' || t === 'CH').map(t => <span key={t} className={`tag tag-${t}`}>{t}</span>)}
      {person.restrictions.length > 0 && <span className="tag tag-restr" title={person.restrictions.join(', ')}><ShieldAlert size={11} aria-hidden /> restricted</span>}
    </div>
  )
}

export interface Toast { id: number; text: string; kind: 'ok' | 'error'; undo?: () => void }

export function ToastHost({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: number) => void }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map(t => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <span>{t.text}</span>
          {t.undo && <button type="button" onClick={() => { t.undo?.(); dismiss(t.id) }}>Undo</button>}
          <button type="button" aria-label="Dismiss" onClick={() => dismiss(t.id)}><X size={14} /></button>
        </div>
      ))}
    </div>
  )
}

type Notify = (text: string, kind?: Toast['kind'], undo?: () => Promise<void>) => void
const ToastCtx = createContext<Notify>(() => {})
export const useToast = () => useContext(ToastCtx)

/** One toast stack for every screen. A toast can carry an Undo (plan 27.2 #7: undo instead of 'Are you sure?'). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const dismiss = useCallback((id: number) => setToasts(x => x.filter(y => y.id !== id)), [])
  const notify = useCallback<Notify>((text, kind = 'ok', undo) => {
    const id = Date.now() + Math.random()
    const item: Toast = {
      id, text, kind,
      undo: undo ? () => { undo().then(() => notify('Undone')).catch(e => notify(String((e as Error).message ?? e), 'error')) } : undefined,
    }
    setToasts(x => [...x, item])
    setTimeout(() => dismiss(id), undo ? 9000 : 5000)
  }, [dismiss])
  return <ToastCtx.Provider value={notify}>{children}<ToastHost toasts={toasts} dismiss={dismiss} /></ToastCtx.Provider>
}

const URGENCY_SEVERITY = { CRITICAL: 'bad', HIGH: 'warn', NORMAL: 'info' } as const
export function UrgencyChip({ urgency }: { urgency: string }) {
  const sev = URGENCY_SEVERITY[urgency as keyof typeof URGENCY_SEVERITY] ?? 'info'
  const Icon = sev === 'bad' ? X : sev === 'warn' ? AlertTriangle : Info
  return <span className={`badge sev-${sev}`}><Icon size={12} aria-hidden /> {urgency === 'CRITICAL' ? 'Critical' : urgency === 'HIGH' ? 'High' : 'Normal'}</span>
}

export function Pill({ severity, children }: { severity: Severity; children: ReactNode }) {
  const Icon = SEVERITY_ICON[severity]
  return <span className={`badge sev-${severity}`}><Icon size={12} aria-hidden /> {children}</span>
}
