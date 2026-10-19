import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useDialogFocus } from './a11y'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowLeft, Award, Briefcase, CalendarDays, CheckCircle2, Clock, History, Mail, MapPin, Phone, Plus, ShieldAlert, Truck, User, Wrench, X,
} from 'lucide-react'
import { api } from './api'
import { useAuth } from './auth'
import { errMsg, useApi } from './hooks'
import { fmtDate } from './labels'
import type { PersonalCalendar } from './types'
import { Ring } from './guide'
import { initials, SENIORITY_LABEL, STATUS_META, useToast } from './ui'
import { NewJobDialog } from './unitforms'

// ------------------------------------------------------------------ context: open a person or a unit from anywhere

type Target = { kind: 'person'; id: string } | { kind: 'unit'; id: string }
interface Ctx { openPerson: (id: string) => void; openUnit: (id: string) => void; openUnitByCode: (code: string) => void }
const ProfileCtx = createContext<Ctx>({ openPerson: () => {}, openUnit: () => {}, openUnitByCode: () => {} })
export const useProfiles = () => useContext(ProfileCtx)

/** Mounted once in the shell: any name or unit code anywhere can open its profile panel. */
export function ProfileProvider({ children }: { children: ReactNode }) {
  const [stack, setStack] = useState<Target[]>([])
  const [codes, setCodes] = useState<Map<string, string> | null>(null)
  const push = useCallback((t: Target) => setStack(s => (s.length && s[s.length - 1].id === t.id ? s : [...s, t])), [])
  const openUnitByCode = useCallback(async (code: string) => {
    let m = codes
    if (!m) {
      try { m = new Map((await api<{ items: { id: string; code: string }[] }>('/units?limit=500')).items.map(u => [u.code, u.id])); setCodes(m) } catch { return }
    }
    const id = m.get(code)
    if (id) push({ kind: 'unit', id })
  }, [codes, push])
  const value = useMemo<Ctx>(() => ({ openPerson: id => push({ kind: 'person', id }), openUnit: id => push({ kind: 'unit', id }), openUnitByCode: c => void openUnitByCode(c) }), [push, openUnitByCode])
  const top = stack[stack.length - 1]
  // Following a link out of the panel (e.g. to a unit's full page) closes it.
  useEffect(() => {
    const onNav = () => setStack([])
    window.addEventListener('hashchange', onNav)
    return () => window.removeEventListener('hashchange', onNav)
  }, [])
  useEffect(() => {
    if (!top) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setStack([]) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [top])
  return (
    <ProfileCtx.Provider value={value}>
      {children}
      {top && (
        <Panel top={top} depth={stack.length} onBack={() => setStack(s => s.slice(0, -1))} onClose={() => setStack([])} />
      )}
    </ProfileCtx.Provider>
  )
}

/** The side panel itself: takes keyboard focus while open and hands it back on close. */
function Panel({ top, depth, onBack, onClose }: { top: Target; depth: number; onBack: () => void; onClose: () => void }) {
  const box = useRef<HTMLElement>(null)
  useDialogFocus(box)
  // moving between profiles (a person's unit, then back) puts focus at the top of the new one
  useEffect(() => { if (box.current?.contains(document.activeElement)) box.current.querySelector<HTMLElement>('.pp-nav button')?.focus({ preventScroll: true }) }, [top])
  return (
    <div className="pp-back" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <aside ref={box} className="pp" role="dialog" aria-modal="true" aria-label={top.kind === 'person' ? 'Person profile' : 'Unit profile'}>
        <div className="pp-nav">
          {depth > 1 && <button type="button" onClick={onBack}><ArrowLeft size={16} aria-hidden /> Back</button>}
          <span className="spacer" />
          <button type="button" aria-label="Close" onClick={onClose}><X size={18} /></button>
        </div>
        {top.kind === 'person' ? <PersonProfile key={top.id} id={top.id} /> : <UnitProfile key={top.id} id={top.id} />}
      </aside>
    </div>
  )
}

/** A clickable person name. */
export function PersonLink({ id, children, className }: { id: string | null | undefined; children: ReactNode; className?: string }) {
  const { openPerson } = useProfiles()
  if (!id) return <>{children}</>
  return <button type="button" className={`name-link${className ? ' ' + className : ''}`} onClick={e => { e.stopPropagation(); openPerson(id) }} onPointerDown={e => e.stopPropagation()}>{children}</button>
}

/** A clickable unit code: by id, or by code when only the code is known (e.g. inside a seat label). */
export function UnitLink({ id, code, children }: { id?: string; code: string; children?: ReactNode }) {
  const { openUnit, openUnitByCode } = useProfiles()
  return <button type="button" className="name-link unit" onClick={e => { e.stopPropagation(); if (id) openUnit(id); else openUnitByCode(code) }} onPointerDown={e => e.stopPropagation()}>{children ?? code}</button>
}

/** A seat label like "HL-6707 · Field Operator #3": the unit code part becomes clickable. */
export function SeatLabel({ label }: { label: string }) {
  const m = /^(HL-[\w-]+)(.*)$/.exec(label)
  if (!m) return <>{label}</>
  return <><UnitLink code={m[1]} />{m[2]}</>
}

// ------------------------------------------------------------------ shared bits

const DAY = 86_400_000
const isoD = (d: Date) => d.toISOString().slice(0, 10)
const addDays = (s: string, n: number) => isoD(new Date(Date.parse(s) + n * DAY))
const color = (s: string) => STATUS_META[s]?.color ?? 'var(--muted)'
const SEN_COLOR: Record<string, string> = { NEW_RECRUIT: '#f59e0b', JUNIOR: '#38bdf8', EXPERIENCED: '#16a34a', SENIOR: '#8b5cf6' }

function Tabs<T extends string>({ tabs, tab, setTab }: { tabs: [T, string, typeof User][]; tab: T; setTab: (t: T) => void }) {
  return <div className="pp-tabs" role="tablist">{tabs.map(([k, l, I]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}><I size={14} aria-hidden /> {l}</button>)}</div>
}
const Fact = ({ label, children }: { label: string; children: ReactNode }) => <div className="fact"><span>{label}</span><b>{children || '–'}</b></div>

function Strip({ days, from, n }: { days: { date: string; status: string; label?: string }[]; from: string; n: number }) {
  const { i18n } = useTranslation()
  const runs: { from: string; to: string; status: string; label?: string; len: number }[] = []
  for (const d of days) {
    const last = runs[runs.length - 1]
    if (last && last.status === d.status && last.label === d.label) { last.to = d.date; last.len++ } else runs.push({ from: d.date, to: d.date, status: d.status, label: d.label, len: 1 })
  }
  const idx = (d: string) => Math.round((Date.parse(d) - Date.parse(from)) / DAY)
  const today = isoD(new Date())
  return (
    <>
      <div className="big-strip" style={{ ['--n' as string]: n, height: 52 }}>
        {runs.map((r, i) => (
          <div key={i} className="bs-block" style={{ gridColumn: `${idx(r.from) + 1} / ${idx(r.to) + 2}`, background: color(r.status) }} title={`${fmtDate(r.from, i18n.language)} → ${fmtDate(r.to, i18n.language)} · ${STATUS_META[r.status]?.label ?? r.status}${r.label ? ' · ' + r.label : ''}`}>
            {r.len >= 6 && <><span>{STATUS_META[r.status]?.label ?? r.status}</span><small>{r.label?.split(' · ')[0] ?? `${r.len} d`}</small></>}
          </div>
        ))}
        {idx(today) >= 0 && idx(today) < n && <span style={{ position: 'absolute', insetInlineStart: `${(idx(today) + 0.5) / n * 100}%`, top: 0, bottom: 0, width: 2, background: 'var(--text)' }} aria-hidden />}
      </div>
      <div className="strip-axis" style={{ ['--n' as string]: n }}>{Array.from({ length: n }, (_, i) => addDays(from, i)).map((d, i) => <span key={d} className={d === today ? 'today' : ''}>{d === today ? 'today' : i % 7 === 0 ? new Date(d).toLocaleDateString(i18n.language, { day: 'numeric', month: 'short', timeZone: 'UTC' }) : ''}</span>)}</div>
    </>
  )
}

// ------------------------------------------------------------------ person

interface Emp {
  id: string; employeeNo: string; firstName: string; lastName: string; phone: string | null; email: string | null; emergencyContact: string | null; homeCity: string | null
  hireDate: string; contractType: string; workMode: string; active: boolean; tags: string[]; managerNotes?: string | null
  position: { name: string }; homeBase: { code: string; name: string }; rotationPattern: { name: string } | null
  qualifications: { qualification: { name: string }; obtainedAt: string }[]
  certifications: { id: string; type: { name: string }; issuedAt: string }[]
  restrictions: { id: string; kind: string; start: string; end: string | null }[]
  leaves: { id: string; start: string; end: string; status: string; type: { name: string; category: string } }[]
  assignments: { id: string; start: string; plannedEnd: string; actualEnd: string | null; status: string; type: string; seat: { holderType: string; index: number; unit: { code: string } | null; base: { code: string } | null; position: { name: string } } }[]
  seniority: string; fieldDays: number; fieldDaysYear: number; yearsOfService: number; status: string; extensionDays: number; daysOffBalance: number
}

function PersonProfile({ id }: { id: string }) {
  const { t, i18n } = useTranslation()
  const [tab, setTab] = useState<'about' | 'schedule' | 'history'>('about')
  const e = useApi<Emp>(`/employees/${id}`)
  const from = addDays(isoD(new Date()), -14), n = 70
  const cal = useApi<PersonalCalendar>(`/calendar/employees/${id}?from=${from}&to=${addDays(from, n - 1)}`)
  const p = e.data
  if (e.error) return <div className="pp-body"><div className="banner error">{e.error}</div></div>
  if (!p) return <div className="pp-body muted">…</div>
  const st = STATUS_META[p.status] ?? STATUS_META.STANDBY
  const counts = new Map<string, number>()
  for (const d of cal.data?.days ?? []) counts.set(d.status, (counts.get(d.status) ?? 0) + 1)
  return (
    <>
      <header className="pp-head" style={{ ['--c' as string]: st.color }}>
        <span className="pp-av">{initials(`${p.firstName} ${p.lastName}`)}</span>
        <div className="pp-title">
          <h2>{p.firstName} {p.lastName}</h2>
          <p>{p.position.name} · {p.employeeNo} · <MapPin size={12} aria-hidden /> {p.homeBase.code}</p>
          <div className="pp-pills">
            <span><st.Icon size={12} aria-hidden /> {st.label}</span>
            <span style={{ background: SEN_COLOR[p.seniority] }}>{SENIORITY_LABEL[p.seniority]}</span>
            {!p.active && <span style={{ background: '#475569' }}>{t('archived', 'Left the company')}</span>}
          </div>
        </div>
        <div className="pp-quick">
          {p.phone && <a href={`tel:${p.phone}`} title={p.phone}><Phone size={16} aria-hidden /></a>}
          {p.email && <a href={`mailto:${p.email}`} title={p.email}><Mail size={16} aria-hidden /></a>}
        </div>
      </header>
      <Tabs tabs={[['about', t('ppAbout', 'About'), User], ['schedule', t('ppSchedule', 'Schedule'), CalendarDays], ['history', t('ppHistory', 'History'), History]]} tab={tab} setTab={setTab} />
      <div className="pp-body">
        {tab === 'about' && <>
          <div className="pp-stats">
            <div><b>{p.yearsOfService.toFixed(1)}</b><span>{t('yearsService', 'years of service')}</span></div>
            <div><b>{p.fieldDays}</b><span>{t('fieldDaysCareer', 'days in the field')}</span></div>
            <div><b>{p.fieldDaysYear}</b><span>{t('fieldDaysYear', 'field days, last 12 months')}</span></div>
            <div className={p.daysOffBalance >= 5 ? 'warn' : ''}><b>{p.daysOffBalance}</b><span>{t('restOwed', 'rest days owed')}</span></div>
          </div>
          <section className="pp-card">
            <h3><Phone size={14} aria-hidden /> {t('contact', 'Contact')}</h3>
            <div className="facts2">
              <Fact label={t('phone', 'Phone')}>{p.phone && <a href={`tel:${p.phone}`}>{p.phone}</a>}</Fact>
              <Fact label={t('email', 'Email')}>{p.email && <a href={`mailto:${p.email}`}>{p.email}</a>}</Fact>
              <Fact label={t('emergency', 'Emergency contact')}>{p.emergencyContact}</Fact>
              <Fact label={t('homeCity', 'Home city')}>{p.homeCity}</Fact>
            </div>
          </section>
          <section className="pp-card">
            <h3><Briefcase size={14} aria-hidden /> {t('work', 'Work')}</h3>
            <div className="facts2">
              <Fact label={t('position', 'Position')}>{p.position.name}</Fact>
              <Fact label={t('homeBase', 'Home base')}>{p.homeBase.code} · {p.homeBase.name}</Fact>
              <Fact label={t('rotation', 'Rotation')}>{p.rotationPattern?.name}</Fact>
              <Fact label={t('workMode', 'Works')}>{{ FIELD: 'In the field', BASE: 'At the base', FLEXIBLE: 'Field or base' }[p.workMode] ?? p.workMode}</Fact>
              <Fact label={t('hired', 'Hired')}>{fmtDate(p.hireDate, i18n.language)}</Fact>
              <Fact label={t('contract', 'Contract')}>{p.contractType}</Fact>
            </div>
          </section>
          <section className="pp-card">
            <h3><Award size={14} aria-hidden /> {t('qualsCerts', 'Qualifications and certificates')}</h3>
            <div className="chips">
              {p.qualifications.map(q => <span key={q.qualification.name} className="tag2" style={{ ['--c' as string]: q.qualification.name === 'Cased Hole' ? 'var(--ch)' : q.qualification.name === 'Open Hole' ? 'var(--oh)' : '#2563eb' }}>{q.qualification.name}</span>)}
              {p.certifications.map(c => <span key={c.id} className="tag2" style={{ ['--c' as string]: '#0d9488' }}><CheckCircle2 size={11} aria-hidden /> {c.type.name}</span>)}
              {!p.qualifications.length && !p.certifications.length && <span className="muted">–</span>}
            </div>
            {p.restrictions.length > 0 && <div className="chips">{p.restrictions.map(r => <span key={r.id} className="tag2" style={{ ['--c' as string]: 'var(--st-clearance)' }}><ShieldAlert size={11} aria-hidden /> {r.kind.replace(/_/g, ' ')}{r.end ? ` · ${t('until', 'until')} ${fmtDate(r.end, i18n.language)}` : ''}</span>)}</div>}
          </section>
          {p.managerNotes && <section className="pp-card"><h3>{t('managerNotes', 'Manager notes')}</h3><p style={{ margin: 0 }}>{p.managerNotes}</p></section>}
        </>}

        {tab === 'schedule' && <>
          <section className="pp-card">
            <h3><CalendarDays size={14} aria-hidden /> {t('tenWeeks', 'Two weeks back, eight ahead')}</h3>
            {cal.data ? <Strip days={cal.data.days} from={from} n={n} /> : <p className="muted">…</p>}
            <div className="chips">{[...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => <span key={k} className="tag2" style={{ ['--c' as string]: color(k) }}>{STATUS_META[k]?.label ?? k} · {v} {t('d', 'd')}</span>)}</div>
          </section>
          {cal.data && <section className="pp-card">
            <h3>{t('nextUp', 'Coming up')}</h3>
            <div className="facts2">
              <Fact label={t('today', 'Today')}>{STATUS_META[cal.data.summary.today?.status ?? '']?.label}{cal.data.summary.today?.label ? ` · ${cal.data.summary.today.label}` : ''}</Fact>
              <Fact label={t('nextOff', 'Next days off')}>{cal.data.summary.nextDaysOff && fmtDate(cal.data.summary.nextDaysOff, i18n.language)}</Fact>
              <Fact label={t('backOn', 'Back on duty')}>{cal.data.summary.nextBackOn && fmtDate(cal.data.summary.nextBackOn, i18n.language)}</Fact>
              <Fact label={t('extDays', 'Extension days (all time)')}>{p.extensionDays}</Fact>
            </div>
          </section>}
        </>}

        {tab === 'history' && <>
          <section className="pp-card">
            <h3><Truck size={14} aria-hidden /> {t('assignHistory', 'Assignments')} <small className="muted">· {p.assignments.length}</small></h3>
            <ul className="hist">
              {p.assignments.map(a => {
                const where = a.seat.unit?.code ?? `${a.seat.base?.code} base`
                const col = a.status === 'ACTIVE' ? 'var(--st-unit)' : a.status === 'CONFIRMED' ? '#7c3aed' : a.status === 'DRAFT' ? '#94a3b8' : a.status === 'CANCELLED' ? '#dc2626' : '#64748b'
                return (
                  <li key={a.id} style={{ ['--c' as string]: col }}>
                    <span><b>{a.seat.unit ? <UnitLink code={a.seat.unit.code} /> : where}</b> · {a.seat.position.name} #{a.seat.index}<br /><small>{fmtDate(a.start, i18n.language)} → {fmtDate(a.actualEnd ?? a.plannedEnd, i18n.language)}{a.type === 'REPLACEMENT' ? ' · replacement' : ''}</small></span>
                    <span className="tag2" style={{ ['--c' as string]: col }}>{a.status.toLowerCase()}</span>
                  </li>
                )
              })}
              {!p.assignments.length && <li className="muted">–</li>}
            </ul>
          </section>
          <section className="pp-card">
            <h3><CalendarDays size={14} aria-hidden /> {t('leaveHistory', 'Leave and absence')} <small className="muted">· {p.leaves.length}</small></h3>
            <ul className="hist">
              {p.leaves.map(l => {
                const col = l.type.category === 'medical' ? 'var(--st-medical)' : l.type.category === 'unavailable' ? 'var(--st-medical)' : 'var(--st-leave)'
                return <li key={l.id} style={{ ['--c' as string]: col }}><span><b>{l.type.name}</b><br /><small>{fmtDate(l.start, i18n.language)} → {fmtDate(l.end, i18n.language)}</small></span><span className="tag2" style={{ ['--c' as string]: col }}>{l.status.toLowerCase()}</span></li>
              })}
              {!p.leaves.length && <li className="muted">–</li>}
            </ul>
          </section>
        </>}
      </div>
    </>
  )
}

// ------------------------------------------------------------------ unit

interface UnitD {
  id: string; code: string; status: string; plate: string | null; model: string | null; year: number | null; notes: string | null
  unitType: { name: string; colorKey: string }; homeBase: { code: string; name: string }
  seats: { id: string; position: string; index: number; required: boolean; holder: { id: string; employeeNo: string; firstName: string; lastName: string } | null }[]
  deployments: { id: string; start: string; end: string; job: { id: string; ref: string; wellName: string; rigName: string | null; client: string | null; status: string } }[]
  workOrders: { id: string; type: string; priority: string; description: string | null; plannedStart: string; expectedReturn: string; status: string }[]
  crewHistory: { id: string; start: string; plannedEnd: string; actualEnd: string | null; status: string; employee: { id: string; firstName: string; lastName: string }; seat: { index: number; position: { name: string } } }[]
  utilization: { deployedDays: number; downtimeDays: number; rate: number }
}
const UNIT_STATUS: Record<string, [string, string]> = {
  DEPLOYED: ['On a job', '#2563eb'], AVAILABLE: ['At base, available', '#16a34a'], UNDER_MAINTENANCE: ['In the workshop', '#b45309'],
  OUT_OF_SERVICE: ['Out of service', '#dc2626'], IN_TRANSIT: ['In transit', '#7c3aed'],
}
const OPEN_WO = ['OPEN', 'IN_PROGRESS', 'WAITING_PARTS']

function UnitProfile({ id }: { id: string }) {
  const { t, i18n } = useTranslation()
  const { can } = useAuth()
  const toast = useToast()
  const [tab, setTab] = useState<'about' | 'jobs' | 'maintenance' | 'crew'>('about')
  const u = useApi<UnitD>(`/units/${id}`)
  const [jobOpen, setJobOpen] = useState(false)
  const [wo, setWo] = useState({ open: false, back: addDays(isoD(new Date()), 3), what: '' })
  const [notes, setNotes] = useState<string | null>(null)
  const editor = can('SUPER_ADMIN', 'OPS_MANAGER', 'DISPATCHER', 'BASE_MANAGER')
  const x = u.data
  if (u.error) return <div className="pp-body"><div className="banner error">{u.error}</div></div>
  if (!x) return <div className="pp-body muted">…</div>
  const [stLabel, stColor] = UNIT_STATUS[x.status] ?? [x.status, '#64748b']
  const typeCol = x.unitType.colorKey === 'amber' ? 'var(--ch)' : 'var(--oh)'
  const today = isoD(new Date())
  const current = x.deployments.find(d => d.start.slice(0, 10) <= today && d.end.slice(0, 10) >= today)
  const upcoming = x.deployments.filter(d => d.start.slice(0, 10) > today)
  const past = x.deployments.filter(d => d.end.slice(0, 10) < today)
  const openWos = x.workOrders.filter(w => OPEN_WO.includes(w.status))
  const filled = x.seats.filter(s => s.required && s.holder).length, req = x.seats.filter(s => s.required).length

  const act = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); toast(ok); await u.reload() } catch (e) { toast(errMsg(e), 'error') } }
  const sendToWorkshop = () => act(async () => {
    await api(`/units/${id}/status`, { method: 'PUT', body: { status: 'UNDER_MAINTENANCE', expectedReturn: wo.back, description: wo.what.trim() || undefined } })
    setWo({ ...wo, open: false, what: '' })
  }, `${x.code} ${t('sentWorkshop', 'is in the workshop')}`)

  return (
    <>
      <header className="pp-head" style={{ ['--c' as string]: typeCol }}>
        <span className="pp-av"><Truck size={26} aria-hidden /></span>
        <div className="pp-title">
          <h2>{x.code}</h2>
          <p>{x.unitType.name} · <MapPin size={12} aria-hidden /> {x.homeBase.code} · {x.homeBase.name} · <a className="pp-full" href={`#/units/${x.id}`}>{t('fullPage', 'Full page')}</a></p>
          <div className="pp-pills"><span style={{ background: stColor }}>{stLabel}</span>{current && <span>{current.job.wellName}{current.job.rigName ? ` · ${current.job.rigName}` : ''}</span>}</div>
        </div>
        <Ring value={filled} max={req} color="#fff" size={52} />
      </header>
      <Tabs tabs={[['about', t('ppAbout', 'About'), Truck], ['jobs', t('ppJobs', 'Jobs'), Briefcase], ['maintenance', t('ppMaint', 'Maintenance'), Wrench], ['crew', t('ppCrew', 'Crew history'), History]]} tab={tab} setTab={setTab} />
      <div className="pp-body">
        {editor && (
          <div className="pp-actions">
            {x.status !== 'UNDER_MAINTENANCE' && <button type="button" onClick={() => { setTab('maintenance'); setWo({ ...wo, open: true }) }}><Wrench size={14} aria-hidden /> {t('toWorkshop', 'Send to the workshop')}</button>}
            {!current && !['OUT_OF_SERVICE', 'UNDER_MAINTENANCE'].includes(x.status) && <button type="button" onClick={() => setJobOpen(true)}><Plus size={14} aria-hidden /> {t('giveJob', 'Give it a job')}</button>}
            {x.status === 'OUT_OF_SERVICE'
              ? <button type="button" onClick={() => act(() => api(`/units/${id}/status`, { method: 'PUT', body: { status: 'AVAILABLE' } }), t('backService', 'Back in service'))}>{t('backService', 'Back in service')}</button>
              : <button type="button" className="danger" onClick={() => act(() => api(`/units/${id}/status`, { method: 'PUT', body: { status: 'OUT_OF_SERVICE' } }), t('outService', 'Out of service'))}>{t('outService', 'Out of service')}</button>}
          </div>
        )}

        {tab === 'about' && <>
          <div className="pp-stats">
            <div><b>{x.utilization.rate}%</b><span>{t('utilYear', 'working, last 12 months')}</span></div>
            <div><b>{x.utilization.deployedDays}</b><span>{t('daysOnJobs', 'days on jobs')}</span></div>
            <div className={x.utilization.downtimeDays > 20 ? 'warn' : ''}><b>{x.utilization.downtimeDays}</b><span>{t('daysWorkshop', 'days in the workshop')}</span></div>
            <div><b>{filled}/{req}</b><span>{t('crewToday', 'crew seats filled today')}</span></div>
          </div>
          <section className="pp-card">
            <h3><Truck size={14} aria-hidden /> {t('vehicle', 'Vehicle')}</h3>
            <div className="facts2">
              <Fact label={t('unitType', 'Type')}>{x.unitType.name}</Fact>
              <Fact label={t('homeBase', 'Home base')}>{x.homeBase.code}</Fact>
              <Fact label={t('plate', 'Plate')}>{x.plate}</Fact>
              <Fact label={t('model', 'Model')}>{x.model}{x.year ? ` · ${x.year}` : ''}</Fact>
            </div>
          </section>
          <section className="pp-card">
            <h3><Briefcase size={14} aria-hidden /> {t('nowDoing', 'Current job')}</h3>
            {current ? <div className="facts2">
              <Fact label={t('wellName', 'Well')}>{current.job.wellName}</Fact><Fact label={t('rig', 'Rig')}>{current.job.rigName}</Fact>
              <Fact label={t('client', 'Client')}>{current.job.client}</Fact><Fact label={t('dates', 'Dates')}>{fmtDate(current.start, i18n.language)} → {fmtDate(current.end, i18n.language)}</Fact>
            </div> : <p className="muted" style={{ margin: 0 }}>{t('noJobNow', 'No job today.')}</p>}
          </section>
          <section className="pp-card">
            <h3><User size={14} aria-hidden /> {t('crewNow', 'Crew today')}</h3>
            <ul className="hist">{x.seats.map(s => (
              <li key={s.id} style={{ ['--c' as string]: s.holder ? 'var(--st-unit)' : s.required ? 'var(--bad)' : '#94a3b8' }}>
                <span><b>{s.position} #{s.index}</b>{!s.required && <small> · {t('optional', 'optional')}</small>}<br /><small>{s.holder ? <PersonLink id={s.holder.id}>{s.holder.firstName} {s.holder.lastName}</PersonLink> : t('emptySeat', 'Nobody')}</small></span>
              </li>
            ))}</ul>
          </section>
          <section className="pp-card">
            <h3>{t('notes', 'Notes')}</h3>
            {notes === null ? <>
              <p style={{ margin: 0, whiteSpace: 'pre-wrap' }} className={x.notes ? '' : 'muted'}>{x.notes || t('noNotes', 'No notes yet.')}</p>
              {editor && <button type="button" className="ghost" onClick={() => setNotes(x.notes ?? '')}>{t('editNotes', 'Edit notes')}</button>}
            </> : <>
              <textarea rows={3} value={notes} onChange={e => setNotes(e.target.value)} placeholder={t('notesPh', 'e.g. winch makes noise, tyres due next month')} />
              <div className="pp-actions"><button type="button" onClick={() => setNotes(null)}>{t('cancel', 'Cancel')}</button><button type="button" className="primary" onClick={() => act(async () => { await api(`/units/${id}`, { method: 'PUT', body: { notes } }); setNotes(null) }, t('saved', 'Saved'))}>{t('save', 'Save')}</button></div>
            </>}
          </section>
        </>}

        {tab === 'jobs' && <>
          {[[t('jobNow', 'Now'), current ? [current] : []], [t('jobNext', 'Coming up'), upcoming], [t('jobPast', 'Past'), past]].map(([title, list]) => (
            <section key={title as string} className="pp-card">
              <h3>{title as string} <small className="muted">· {(list as UnitD['deployments']).length}</small></h3>
              <ul className="hist">{(list as UnitD['deployments']).map(d => (
                <li key={d.id} style={{ ['--c' as string]: d === current ? '#2563eb' : d.end.slice(0, 10) < today ? '#94a3b8' : '#7c3aed' }}>
                  <span><b>{d.job.wellName}</b>{d.job.rigName ? ` · ${d.job.rigName}` : ''} <small className="muted">{d.job.ref}</small><br /><small>{fmtDate(d.start, i18n.language)} → {fmtDate(d.end, i18n.language)}{d.job.client ? ` · ${d.job.client}` : ''}</small></span>
                  {editor && d === current && <button type="button" className="ghost" onClick={() => act(() => api(`/jobs/${d.job.id}/end`, { method: 'POST', body: {} }), t('jobEnded', 'Job ended, unit back at base'))}>{t('endJob', 'End job today')}</button>}
                </li>
              ))}{!(list as UnitD['deployments']).length && <li className="muted">–</li>}</ul>
            </section>
          ))}
        </>}

        {tab === 'maintenance' && <>
          {editor && wo.open && (
            <section className="pp-card accent">
              <h3><Wrench size={14} aria-hidden /> {t('toWorkshop', 'Send to the workshop')}</h3>
              <label className="fld">{t('whatWrong', 'What is the problem?')}<textarea rows={3} value={wo.what} onChange={e => setWo({ ...wo, what: e.target.value })} placeholder={t('whatWrongPh', 'e.g. hydraulic leak on the winch, brakes to check')} autoFocus /></label>
              <label className="fld">{t('expectedBack', 'Expected back on')}<input type="date" value={wo.back} min={today} onChange={e => setWo({ ...wo, back: e.target.value })} /></label>
              <p className="muted" style={{ margin: 0 }}>{t('workshopHint', 'While it is in the workshop its crew seats are not needed, and the forecast and the board show it.')}</p>
              <div className="pp-actions"><button type="button" onClick={() => setWo({ ...wo, open: false })}>{t('cancel', 'Cancel')}</button><button type="button" className="primary" disabled={!wo.what.trim()} onClick={sendToWorkshop}>{t('send', 'Send to the workshop')}</button></div>
            </section>
          )}
          <section className="pp-card">
            <h3>{t('openWo', 'Open work orders')} <small className="muted">· {openWos.length}</small></h3>
            <ul className="hist">{openWos.map(w => (
              <li key={w.id} style={{ ['--c' as string]: w.priority === 'urgent' || w.priority === 'high' ? '#dc2626' : '#b45309' }}>
                <span><b>{w.description || w.type}</b><br /><small>{w.type} · {w.status.toLowerCase().replace('_', ' ')} · {t('backBy', 'back by')} {fmtDate(w.expectedReturn, i18n.language)}</small></span>
                {editor && <button type="button" className="ghost" onClick={() => act(() => api(`/work-orders/${w.id}/status`, { method: 'POST', body: { status: 'DONE' } }), t('woDone', 'Repaired: unit available again'))}><CheckCircle2 size={14} aria-hidden /> {t('repaired', 'Repaired')}</button>}
              </li>
            ))}{!openWos.length && <li className="muted">{t('noOpenWo', 'Nothing in the workshop.')}</li>}</ul>
          </section>
          <section className="pp-card">
            <h3><Clock size={14} aria-hidden /> {t('woHistory', 'Maintenance history')}</h3>
            <ul className="hist">{x.workOrders.filter(w => !OPEN_WO.includes(w.status)).map(w => (
              <li key={w.id} style={{ ['--c' as string]: '#94a3b8' }}><span><b>{w.description || w.type}</b><br /><small>{fmtDate(w.plannedStart, i18n.language)} → {fmtDate(w.expectedReturn, i18n.language)} · {w.status.toLowerCase()}</small></span></li>
            ))}{!x.workOrders.some(w => !OPEN_WO.includes(w.status)) && <li className="muted">–</li>}</ul>
          </section>
        </>}

        {tab === 'crew' && (
          <section className="pp-card">
            <h3><History size={14} aria-hidden /> {t('whoWorked', 'Who worked on this unit')}</h3>
            <ul className="hist">{x.crewHistory.map(a => (
              <li key={a.id} style={{ ['--c' as string]: a.status === 'ACTIVE' ? 'var(--st-unit)' : a.status === 'CONFIRMED' ? '#7c3aed' : '#94a3b8' }}>
                <span><PersonLink id={a.employee.id}>{a.employee.firstName} {a.employee.lastName}</PersonLink> · {a.seat.position.name} #{a.seat.index}<br /><small>{fmtDate(a.start, i18n.language)} → {fmtDate(a.actualEnd ?? a.plannedEnd, i18n.language)}</small></span>
                <span className="tag2">{a.status.toLowerCase()}</span>
              </li>
            ))}</ul>
          </section>
        )}
      </div>
      {jobOpen && <NewJobDialog unitId={id} onClose={() => setJobOpen(false)} onDone={() => void u.reload()} />}
    </>
  )
}
