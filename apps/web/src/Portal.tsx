import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowLeft, Bell, CalendarDays, Camera, ChevronLeft, ChevronRight, Home, Inbox, KeyRound, LogOut, MapPin, Moon, Repeat, Sun, User, Users, WifiOff, Wrench,
} from 'lucide-react'
import { api } from './api'
import { useAuth } from './auth'
import { Modal, ViolationList } from './dialogs'
import { ChangePasswordDialog } from './account'
import { errMsg, useApi, useLive, useRoute } from './hooks'
import { fmtDate, plural } from './labels'
import { NoticeList, PreferencesPanel, useUnread } from './notifications'
import type { Violation } from './types'
import { Pill, STATUS_META, useToast } from './ui'

interface Today {
  date: string
  employee: { id: string; name: string; employeeNo: string; position: string; base: string }
  status: { status: string; label?: string } | null; restrictions: string[]
  seat: { label: string; position: string; kind: 'unit' | 'base'; from: string; to: string; upcoming: boolean; unit: { code: string; type: string } | null; base: { code: string; name: string } | null; job: { well: string; rig: string | null; site: string; travelHours: number | null } | null } | null
  team: { id: string; name: string; position: string }[]
  supervisor: { id: string; name: string; role: string } | null
  replacement: { replacedBy: { name: string; from: string } | null; replacing: { name: string; until: string } | null }
  nextCrewChange: { date: string; seat: string } | null
  nextDaysOff: string | null; nextBackOn: string | null; unread: number; pendingAck: number
}
interface Stats { year: number; seniority: string; yearsOfService: number; fieldDaysYear: number; fieldDaysTotal: number; baseDaysYear: number; extensionDaysYear: number; daysOffBalance: number; annualLeave: { entitled: number; taken: number; pending: number; remaining: number } }
interface Profile { id: string; employeeNo: string; name: string; position: string; base: string; hireDate: string; phone: string | null; email: string | null; emergencyContact: string | null; homeCity: string | null; rotation: string | null; restrictions: { kind: string; until: string | null }[]; qualifications: { name: string; obtained: string }[]; certifications: { id: string; name: string; expires: string; validity: 'valid' | 'expiring' | 'expired' }[] }
interface CalDay { date: string; status: string; label?: string }
interface Cal { days: CalDay[] }
interface LeaveRow { id: string; start: string; end: string; status: string; type: { name: string; category: string }; decisionNote?: string | null }
interface LeaveType { id: string; name: string; category: string; needsDocument: boolean }
interface MyAssignment { id: string; start: string; plannedEnd: string; status: string; seat: { position: { name: string }; unit: { code: string } | null; base: { code: string } | null; index: number } }
interface SwapCandidate { assignmentId: string; employee: { name: string }; seat: string; from: string; to: string }
interface SwapRow { id: string; status: string; note: string | null; requester: { name: string }; colleague: { name: string }; a: { seat: string; from: string; to: string }; b: { seat: string; from: string; to: string }; canRespond: boolean; canCancel: boolean }
interface WorkOrder { id: string; unit: { code: string }; type: string; priority: string; description: string | null; status: string; expectedReturn: string }

const TABS = [
  { path: 'today', key: 'tab_today', label: 'Today', Icon: Home },
  { path: 'calendar', key: 'tab_calendar', label: 'Calendar', Icon: CalendarDays },
  { path: 'requests', key: 'tab_requests', label: 'Requests', Icon: Inbox },
  { path: 'alerts', key: 'tab_alerts', label: 'Alerts', Icon: Bell },
  { path: 'me', key: 'tab_me', label: 'Me', Icon: User },
] as const

const today = () => new Date().toISOString().slice(0, 10)

function useOnline() {
  const [on, setOn] = useState(navigator.onLine)
  useEffect(() => {
    const a = () => setOn(true), b = () => setOn(false)
    window.addEventListener('online', a); window.addEventListener('offline', b)
    return () => { window.removeEventListener('online', a); window.removeEventListener('offline', b) }
  }, [])
  return on
}

/** Mobile-first employee portal (plan 18): big touch targets, one card per piece of information, bottom navigation. */
export default function Portal({ onExit }: { onExit?: () => void }) {
  const { t } = useTranslation()
  const { parts } = useRoute()
  const online = useOnline()
  const unread = useUnread()
  const tab = TABS.find(x => x.path === parts[1]) ?? TABS[0]

  return (
    <div className="portal">
      {!online && <div className="offline" role="status"><WifiOff size={15} aria-hidden /> {t('offline', 'You are offline: showing what was last saved.')}</div>}
      {onExit && <a className="exit" href="#/board"><ArrowLeft size={15} aria-hidden /> {t('staffApp', 'Staff app')}</a>}
      <main className="portal-main">
        {tab.path === 'today' && <TodayTab />}
        {tab.path === 'calendar' && <CalendarTab />}
        {tab.path === 'requests' && <RequestsTab />}
        {tab.path === 'alerts' && <AlertsTab onChanged={unread.reload} />}
        {tab.path === 'me' && <MeTab />}
      </main>
      <nav className="bottom-nav" aria-label="Portal">
        {TABS.map(x => (
          <a key={x.path} href={`#/portal/${x.path}`} className={x === tab ? 'on' : ''} aria-current={x === tab ? 'page' : undefined}>
            <span className="ico"><x.Icon size={22} aria-hidden />{x.path === 'alerts' && unread.unread > 0 && <b className={unread.pendingAck ? 'urgent' : ''}>{unread.unread}</b>}</span>
            <span>{t(x.key, x.label)}</span>
          </a>
        ))}
      </nav>
    </div>
  )
}

// ---------------------------------------------------------------- Today

function Card({ title, icon, children, tone }: { title?: string; icon?: ReactNode; children: ReactNode; tone?: 'warn' | 'bad' }) {
  return <section className={`pcard${tone ? ` ${tone}` : ''}`}>{title && <h2>{icon}{title}</h2>}{children}</section>
}

function TodayTab() {
  const { t, i18n } = useTranslation()
  const d = useApi<Today>('/portal/today')
  useLive(d.reload)
  if (d.error) return <Card tone="bad"><p>{d.error}</p></Card>
  if (!d.data) return <p className="loading">{t('loading', 'Loading…')}</p>
  const x = d.data
  const meta = x.status ? STATUS_META[x.status.status] : undefined
  const L = (s: string) => fmtDate(s, i18n.language)

  return (
    <>
      <header className="hello">
        <p className="muted">{new Date(x.date).toLocaleDateString(i18n.language, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })}</p>
        <h1>{t('hello', 'Hello')}, {x.employee.name.split(' ')[0]}</h1>
      </header>

      {x.pendingAck > 0 && <a className="pcard warn link" href="#/portal/alerts"><strong>{plural(x.pendingAck, t('noticeWord', 'notice'))} {t('waitingConfirm', 'waiting for you to confirm')}</strong><span>{t('tapToOpen', 'Tap to open')}</span></a>}

      <Card>
        {meta && x.status ? <p className="big-status" style={{ color: meta.color }}><meta.Icon size={26} aria-hidden /> {t(`status_${x.status.status}`, meta.label)}</p> : <p className="muted">—</p>}
        {x.status?.label && <p className="muted">{x.status.label}</p>}
        {x.restrictions.length > 0 && <Pill severity="warn">{t('restricted', 'Restricted')}: {x.restrictions.join(', ')}</Pill>}
      </Card>

      <Card title={x.seat?.upcoming ? t('nextSeat', 'Your next seat') : t('mySeat', 'My seat')} icon={<MapPin size={17} aria-hidden />}>
        {x.seat ? (
          <>
            <p className="strong">{x.seat.label}</p>
            <p className="muted">{L(x.seat.from)} → {L(x.seat.to)}{x.seat.upcoming ? ` · ${t('startsLater', 'starts later')}` : ''}</p>
            {x.seat.job && <p>{x.seat.job.well}{x.seat.job.rig ? ` / ${x.seat.job.rig}` : ''} · {x.seat.job.site}{x.seat.job.travelHours ? ` · ${x.seat.job.travelHours} h` : ''}</p>}
            {x.seat.base && <p>{x.seat.base.name}</p>}
          </>
        ) : <p className="muted">{t('noSeat', 'You are not on a seat today.')}</p>}
      </Card>

      {x.seat && (
        <Card title={x.seat.kind === 'unit' ? t('myCrew', 'My crew') : t('myTeam', 'My team')} icon={<Users size={17} aria-hidden />}>
          {x.supervisor && <p><strong>{x.supervisor.role}:</strong> {x.supervisor.name}</p>}
          <ul className="plain">{x.team.filter(m => m.id !== x.supervisor?.id).map(m => <li key={m.id}>{m.name} <span className="muted">· {m.position}</span></li>)}</ul>
          {x.team.length === 0 && <p className="muted">—</p>}
        </Card>
      )}

      <Card title={t('myReplacement', 'My replacement')} icon={<Repeat size={17} aria-hidden />}>
        {x.replacement.replacedBy ? <p>{t('replacedBy', 'Takes over from you')}: <strong>{x.replacement.replacedBy.name}</strong> · {L(x.replacement.replacedBy.from)}</p> : <p className="muted">{t('noReplacement', 'Nobody is planned to take over yet.')}</p>}
        {x.replacement.replacing && <p>{t('replacing', 'You take over from')}: <strong>{x.replacement.replacing.name}</strong></p>}
      </Card>

      <Card title={t('whatsNext', 'What is next')} icon={<CalendarDays size={17} aria-hidden />}>
        <dl className="facts">
          {x.nextCrewChange && <><dt>{t('crewChange', 'Crew change')}</dt><dd>{L(x.nextCrewChange.date)}</dd></>}
          <dt>{t('nextDaysOff', 'Next days off')}</dt><dd>{x.nextDaysOff ? L(x.nextDaysOff) : '—'}</dd>
          <dt>{t('backOn', 'Back on')}</dt><dd>{x.nextBackOn ? L(x.nextBackOn) : '—'}</dd>
        </dl>
      </Card>
    </>
  )
}

// ---------------------------------------------------------------- Calendar

function CalendarTab() {
  const { t, i18n } = useTranslation()
  const { me } = useAuth()
  const [month, setMonth] = useState(today().slice(0, 7))
  const [picked, setPicked] = useState<CalDay | null>(null)
  const cal = useApi<Cal>(me?.employeeId ? `/calendar/employees/${me.employeeId}?month=${month}` : null)
  useLive(cal.reload)

  const shift = (n: number) => { const [y, m] = month.split('-').map(Number); setMonth(new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7)); setPicked(null) }
  const days = cal.data?.days ?? []
  const lead = days.length ? new Date(days[0].date).getUTCDay() : 0
  const weekdays = useMemo(() => Array.from({ length: 7 }, (_, i) => new Date(Date.UTC(2023, 0, 1 + i)).toLocaleDateString(i18n.language, { weekday: 'narrow', timeZone: 'UTC' })), [i18n.language])
  const used = [...new Set(days.map(d => d.status))]

  return (
    <>
      <header className="cal-head">
        <button type="button" aria-label="Previous month" onClick={() => shift(-1)}><ChevronLeft size={22} /></button>
        <h1>{new Date(`${month}-01`).toLocaleDateString(i18n.language, { month: 'long', year: 'numeric', timeZone: 'UTC' })}</h1>
        <button type="button" aria-label="Next month" onClick={() => shift(1)}><ChevronRight size={22} /></button>
      </header>
      {cal.error && <Card tone="bad"><p>{cal.error}</p></Card>}
      <div className="month" role="grid" aria-label="Month">
        {weekdays.map((w, i) => <span key={i} className="wd" role="columnheader">{w}</span>)}
        {Array.from({ length: lead }, (_, i) => <span key={`b${i}`} />)}
        {days.map(d => {
          const m = STATUS_META[d.status]
          return (
            <button type="button" key={d.date} role="gridcell" className={`day${d.date === today() ? ' today' : ''}${picked?.date === d.date ? ' picked' : ''}`} onClick={() => setPicked(d)} aria-label={`${fmtDate(d.date, i18n.language)}: ${m?.label ?? d.status}${d.label ? `, ${d.label}` : ''}`}>
              <span>{Number(d.date.slice(8))}</span>
              <i style={{ background: m?.color ?? 'var(--border)' }} />
            </button>
          )
        })}
      </div>
      {picked && <Card><p className="strong">{fmtDate(picked.date, i18n.language)}</p><p style={{ color: STATUS_META[picked.status]?.color }}>{STATUS_META[picked.status]?.label ?? picked.status}{picked.label ? ` · ${picked.label}` : ''}</p></Card>}
      <ul className="legend">{used.map(s => <li key={s}><i style={{ background: STATUS_META[s]?.color }} />{t(`status_${s}`, STATUS_META[s]?.label ?? s)}</li>)}</ul>
      <p className="muted small">{t('calHint', 'Tap a day for details.')}</p>
    </>
  )
}

// ---------------------------------------------------------------- Requests

function RequestsTab() {
  return (
    <>
      <header className="hello"><h1>{useTranslation().t('tab_requests', 'Requests')}</h1></header>
      <LeaveSection />
      <SwapSection />
      <WorkOrderSection />
    </>
  )
}

const toBase64 = async (file: File) => {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

const LEAVE_TEXT: Record<string, [string, 'ok' | 'warn' | 'bad' | 'info']> = {
  SUBMITTED: ['Waiting for a decision', 'warn'], APPROVED: ['Approved', 'ok'], RECORDED: ['Recorded', 'ok'], REJECTED: ['Rejected', 'bad'], CANCELLED: ['Cancelled', 'info'],
}

function LeaveSection() {
  const { t, i18n } = useTranslation()
  const toast = useToast()
  const { me } = useAuth()
  const list = useApi<{ items: LeaveRow[] }>('/leaves?limit=30')
  const types = useApi<LeaveType[]>('/catalogs/leave-types')
  const balance = useApi<{ daysOffBalance: number; annualLeave: { remaining: number } }>(me?.employeeId ? `/leaves/balance/${me.employeeId}` : null)
  useLive(list.reload)
  const [open, setOpen] = useState(false)
  const [typeId, setTypeId] = useState('')
  const [start, setStart] = useState(today())
  const [end, setEnd] = useState(today())
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const type = types.data?.find(x => x.id === typeId)
  const mine = (types.data ?? []).filter(x => x.category !== 'absence')

  const submit = async () => {
    setBusy(true)
    try {
      let documentUrl: string | undefined
      if (file) {
        const up = await api<{ url: string }>('/files', { method: 'POST', body: { name: file.name, mime: file.type, kind: type?.category === 'medical' ? 'medical' : 'general', dataBase64: await toBase64(file) } })
        documentUrl = up.url
      }
      const r = await api<{ warnings: string[] }>('/leaves', { method: 'POST', body: { typeId, start, end, documentUrl } })
      toast(t('requestSent', 'Request sent')); r.warnings.forEach(w => toast(w))
      setOpen(false); setFile(null); await list.reload()
    } catch (e) { toast(errMsg(e), 'error') } finally { setBusy(false) }
  }
  const cancel = async (id: string) => { try { await api(`/leaves/${id}/cancel`, { method: 'POST', body: {} }); toast(t('cancelled', 'Cancelled')); await list.reload() } catch (e) { toast(errMsg(e), 'error') } }

  return (
    <Card title={t('myLeave', 'My leave')} icon={<CalendarDays size={17} aria-hidden />}>
      {balance.data && <p className="muted">{t('annualLeft', 'Annual leave left')}: <strong>{balance.data.annualLeave.remaining}</strong> · {t('restDays', 'Rest days owed')}: <strong>{balance.data.daysOffBalance}</strong></p>}
      <button type="button" className="pbtn primary" onClick={() => setOpen(true)}>{t('newRequest', 'New leave request')}</button>
      <ul className="rows">
        {(list.data?.items ?? []).map(l => {
          const [text, sev] = LEAVE_TEXT[l.status] ?? [l.status, 'info' as const]
          return (
            <li key={l.id}>
              <div><strong>{l.type.name}</strong><small className="muted">{fmtDate(l.start, i18n.language)} → {fmtDate(l.end, i18n.language)}</small>{l.decisionNote && <small className="why">{l.decisionNote}</small>}</div>
              <span className="row-right"><Pill severity={sev}>{text}</Pill>{l.status === 'SUBMITTED' && <button type="button" className="link" onClick={() => void cancel(l.id)}>{t('withdraw', 'Withdraw')}</button>}</span>
            </li>
          )
        })}
      </ul>
      {list.data && list.data.items.length === 0 && <p className="muted">{t('noLeaveYet', 'No leave requests yet.')}</p>}

      {open && (
        <Modal title={t('newRequest', 'New leave request')} onClose={() => setOpen(false)}>
          <label className="reason">{t('type', 'Type')}
            <select value={typeId} onChange={e => setTypeId(e.target.value)}><option value="">—</option>{mine.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
          </label>
          <div className="dates">
            <label>{t('from', 'From')}<input type="date" value={start} onChange={e => { setStart(e.target.value); if (end < e.target.value) setEnd(e.target.value) }} /></label>
            <label>{t('until', 'Until')}<input type="date" value={end} min={start} onChange={e => setEnd(e.target.value)} /></label>
          </div>
          {type?.needsDocument && (
            <label className="reason">{type.category === 'medical' ? t('certificatePhoto', 'Medical certificate (photo or PDF)') : t('document', 'Document')}
              <span className="file-pick"><Camera size={18} aria-hidden /><input type="file" accept="image/*,application/pdf" capture="environment" onChange={e => setFile(e.target.files?.[0] ?? null)} /></span>
              {file && <small className="muted">{file.name} · {Math.round(file.size / 1024)} KB</small>}
            </label>
          )}
          {type?.category === 'medical' && <p className="note">{t('medicalPrivacy', 'Only HR and the operations manager can see your certificate. Your dispatcher only sees that you are unavailable.')}</p>}
          <footer>
            <button type="button" onClick={() => setOpen(false)}>{t('cancel', 'Cancel')}</button>
            <button type="button" className="primary" disabled={busy || !typeId || end < start || (!!type?.needsDocument && !file)} onClick={() => void submit()}>{busy ? '…' : t('send', 'Send')}</button>
          </footer>
        </Modal>
      )}
    </Card>
  )
}

function SwapSection() {
  const { t, i18n } = useTranslation()
  const { me } = useAuth()
  const toast = useToast()
  const swaps = useApi<SwapRow[]>('/swaps')
  const mine = useApi<{ items: MyAssignment[] }>(me?.employeeId ? `/assignments?employeeId=${me.employeeId}&from=${today()}&limit=50` : null)
  useLive(swaps.reload)
  const [pick, setPick] = useState<MyAssignment | null>(null)
  const [cands, setCands] = useState<SwapCandidate[] | null>(null)
  const [problems, setProblems] = useState<Violation[] | null>(null)
  const [note, setNote] = useState('')
  const upcoming = (mine.data?.items ?? []).filter(a => a.start.slice(0, 10) > today() && ['CONFIRMED', 'ACTIVE'].includes(a.status))
  const label = (a: MyAssignment) => `${a.seat.unit?.code ?? `${a.seat.base?.code} base`} · ${a.seat.position.name} #${a.seat.index}`

  const open = async (a: MyAssignment) => {
    setPick(a); setCands(null); setProblems(null)
    try { setCands(await api<SwapCandidate[]>(`/swaps/candidates?assignmentId=${a.id}`)) } catch (e) { toast(errMsg(e), 'error'); setPick(null) }
  }
  const request = async (c: SwapCandidate) => {
    try {
      await api('/swaps', { method: 'POST', body: { requesterAssignmentId: pick!.id, colleagueAssignmentId: c.assignmentId, note } })
      toast(t('swapSent', 'Swap request sent to your colleague')); setPick(null); setNote(''); await swaps.reload()
    } catch (e) {
      const body = (e as { body?: { violations?: Violation[] } }).body
      if (body?.violations) setProblems(body.violations); else toast(errMsg(e), 'error')
    }
  }
  const act = async (id: string, path: 'respond' | 'cancel', body: unknown, ok: string) => {
    try { await api(`/swaps/${id}/${path}`, { method: 'POST', body }); toast(ok); await swaps.reload() } catch (e) { toast(errMsg(e), 'error') }
  }
  const SW: Record<string, [string, 'ok' | 'warn' | 'bad' | 'info']> = { PENDING: ['Waiting for your colleague', 'warn'], ACCEPTED: ['Waiting for a manager', 'warn'], DECLINED: ['Declined', 'bad'], APPROVED: ['Approved', 'ok'], REJECTED: ['Rejected', 'bad'], CANCELLED: ['Cancelled', 'info'] }

  return (
    <Card title={t('swapTitle2', 'Swap with a colleague')} icon={<Repeat size={17} aria-hidden />}>
      <p className="muted small">{t('swapHint', 'Only upcoming stretches can be swapped. Your colleague accepts, then a manager approves.')}</p>
      <ul className="rows">
        {swaps.data?.map(s => {
          const [text, sev] = SW[s.status] ?? [s.status, 'info' as const]
          return (
            <li key={s.id}>
              <div><strong>{s.requester.name} ⇄ {s.colleague.name}</strong><small className="muted">{s.a.seat} ({fmtDate(s.a.from, i18n.language)}) ⇄ {s.b.seat}</small>{s.note && <small className="why">{s.note}</small>}</div>
              <span className="row-right"><Pill severity={sev}>{text}</Pill>
                {s.canRespond && <><button type="button" className="pbtn primary slim" onClick={() => void act(s.id, 'respond', { accept: true }, t('accepted', 'Accepted'))}>{t('accept', 'Accept')}</button><button type="button" className="pbtn slim" onClick={() => void act(s.id, 'respond', { accept: false }, t('declined', 'Declined'))}>{t('decline', 'Decline')}</button></>}
                {s.canCancel && <button type="button" className="link" onClick={() => void act(s.id, 'cancel', {}, t('cancelled', 'Cancelled'))}>{t('withdraw', 'Withdraw')}</button>}
              </span>
            </li>
          )
        })}
      </ul>
      <h3>{t('chooseStretch', 'Choose one of your upcoming stretches')}</h3>
      {upcoming.length === 0 && <p className="muted">{t('noUpcoming', 'You have no upcoming stretch to swap yet.')}</p>}
      <ul className="rows">{upcoming.map(a => <li key={a.id}><div><strong>{label(a)}</strong><small className="muted">{fmtDate(a.start, i18n.language)} → {fmtDate(a.plannedEnd, i18n.language)}</small></div><button type="button" className="pbtn slim" onClick={() => void open(a)}>{t('swap', 'Swap')}</button></li>)}</ul>

      {pick && (
        <Modal title={`${t('swapWith', 'Swap')} ${label(pick)}`} onClose={() => setPick(null)}>
          {!cands && <p className="muted">{t('loading', 'Loading…')}</p>}
          {cands && cands.length === 0 && <p className="empty-note">{t('noSwapCands', 'Nobody has a matching stretch you could swap with.')}</p>}
          <label className="reason">{t('note', 'Note (optional)')}<input value={note} onChange={e => setNote(e.target.value)} /></label>
          {problems && <><p className="error">{t('swapRefused', 'That swap is not possible:')}</p><ViolationList violations={problems} /></>}
          <ul className="cand-list">{cands?.map(c => <li key={c.assignmentId}><div><strong>{c.employee.name}</strong><small className="why">{c.seat} · {fmtDate(c.from, i18n.language)} → {fmtDate(c.to, i18n.language)}</small></div><button type="button" onClick={() => void request(c)}>{t('ask', 'Ask')}</button></li>)}</ul>
        </Modal>
      )}
    </Card>
  )
}

const NEXT: Record<string, string[]> = { OPEN: ['IN_PROGRESS', 'WAITING_PARTS', 'DONE'], IN_PROGRESS: ['WAITING_PARTS', 'DONE'], WAITING_PARTS: ['IN_PROGRESS', 'DONE'] }
const WO_TEXT: Record<string, string> = { IN_PROGRESS: 'Start work', WAITING_PARTS: 'Waiting for parts', DONE: 'Mark done' }

function WorkOrderSection() {
  const { t, i18n } = useTranslation()
  const toast = useToast()
  const list = useApi<{ items: WorkOrder[] }>('/work-orders?mine=true&open=true')
  useLive(list.reload)
  const items = list.data?.items ?? []
  if (items.length === 0) return null
  const move = async (id: string, status: string) => { try { await api(`/work-orders/${id}/status`, { method: 'POST', body: { status } }); toast(t('updated', 'Updated')); await list.reload() } catch (e) { toast(errMsg(e), 'error') } }
  return (
    <Card title={t('myWorkOrders', 'My work orders')} icon={<Wrench size={17} aria-hidden />}>
      <ul className="rows">
        {items.map(w => (
          <li key={w.id} className="stack">
            <div><strong>{w.unit.code} · {w.type.replace('_', ' ')}</strong><small className="muted">{w.description ?? ''} · {t('backBy', 'back by')} {fmtDate(w.expectedReturn, i18n.language)}</small></div>
            <div className="btn-row">{(NEXT[w.status] ?? []).map(n => <button type="button" key={n} className={`pbtn slim${n === 'DONE' ? ' primary' : ''}`} onClick={() => void move(w.id, n)}>{t(`wo_${n}`, WO_TEXT[n])}</button>)}<Pill severity={w.status === 'WAITING_PARTS' ? 'warn' : 'info'}>{w.status.replace('_', ' ').toLowerCase()}</Pill></div>
          </li>
        ))}
      </ul>
    </Card>
  )
}

// ---------------------------------------------------------------- Alerts and Me

function AlertsTab({ onChanged }: { onChanged: () => void }) {
  const { t } = useTranslation()
  return <><header className="hello"><h1>{t('tab_alerts', 'Alerts')}</h1></header><NoticeList onChanged={onChanged} /></>
}

function MeTab() {
  const { t, i18n } = useTranslation()
  const { logout } = useAuth()
  const toast = useToast()
  const stats = useApi<Stats>('/portal/stats')
  const profile = useApi<Profile>('/portal/profile')
  const [edit, setEdit] = useState(false)
  const [form, setForm] = useState({ phone: '', email: '', emergencyContact: '', homeCity: '' })
  const [dark, setDark] = useState(document.documentElement.dataset.theme === 'dark')
  const [pwOpen, setPwOpen] = useState(false)
  const p = profile.data, s = stats.data

  const startEdit = () => { if (p) { setForm({ phone: p.phone ?? '', email: p.email ?? '', emergencyContact: p.emergencyContact ?? '', homeCity: p.homeCity ?? '' }); setEdit(true) } }
  const save = async () => {
    try { await api('/portal/profile', { method: 'PUT', body: form }); toast(t('saved', 'Saved')); setEdit(false); await profile.reload() } catch (e) { toast(errMsg(e), 'error') }
  }
  const theme = () => { const n = !dark; setDark(n); document.documentElement.dataset.theme = n ? 'dark' : 'light' }
  const CERT: Record<string, ['ok' | 'warn' | 'bad', string]> = { valid: ['ok', 'Valid'], expiring: ['warn', 'Expiring soon'], expired: ['bad', 'Expired'] }

  return (
    <>
      <header className="hello"><h1>{p?.name ?? t('tab_me', 'Me')}</h1>{p && <p className="muted">{p.employeeNo} · {p.position} · {p.base}</p>}</header>
      {s && (
        <Card title={`${t('myStats', 'My numbers')} ${s.year}`}>
          <div className="stat-grid">
            <div><strong>{s.fieldDaysYear}</strong><span>{t('fieldDays', 'Field days')}</span></div>
            <div><strong>{s.baseDaysYear}</strong><span>{t('baseDays', 'Base days')}</span></div>
            <div><strong>{s.extensionDaysYear}</strong><span>{t('extDays', 'Extension days')}</span></div>
            <div><strong>{s.daysOffBalance}</strong><span>{t('restOwed', 'Rest days owed')}</span></div>
            <div><strong>{s.annualLeave.remaining}</strong><span>{t('annualLeft', 'Annual leave left')}</span></div>
            <div><strong>{s.yearsOfService}</strong><span>{t('years', 'Years of service')}</span></div>
          </div>
        </Card>
      )}
      {p && (
        <Card title={t('contact', 'My contact details')}>
          {!edit ? (
            <>
              <dl className="facts"><dt>{t('phone', 'Phone')}</dt><dd>{p.phone ?? '—'}</dd><dt>{t('email', 'Email')}</dt><dd>{p.email ?? '—'}</dd><dt>{t('emergency', 'Emergency contact')}</dt><dd>{p.emergencyContact ?? '—'}</dd><dt>{t('city', 'City')}</dt><dd>{p.homeCity ?? '—'}</dd></dl>
              <button type="button" className="pbtn" onClick={startEdit}>{t('edit', 'Edit')}</button>
            </>
          ) : (
            <>
              {(['phone', 'email', 'emergencyContact', 'homeCity'] as const).map(k => <label className="reason" key={k}>{t(`f_${k}`, k)}<input value={form[k]} onChange={e => setForm({ ...form, [k]: e.target.value })} /></label>)}
              <div className="btn-row"><button type="button" className="pbtn" onClick={() => setEdit(false)}>{t('cancel', 'Cancel')}</button><button type="button" className="pbtn primary" onClick={() => void save()}>{t('save', 'Save')}</button></div>
            </>
          )}
        </Card>
      )}
      {p && (
        <Card title={t('qualsCerts', 'Qualifications and certificates')}>
          <ul className="rows">
            {p.qualifications.map(q => <li key={q.name}><strong>{q.name}</strong><small className="muted">{t('since', 'since')} {fmtDate(q.obtained, i18n.language)}</small></li>)}
            {p.certifications.map(c => { const [sev, text] = CERT[c.validity]; return <li key={c.id}><div><strong>{c.name}</strong><small className="muted">{t('expires', 'expires')} {fmtDate(c.expires, i18n.language)}</small></div><Pill severity={sev}>{text}</Pill></li> })}
          </ul>
        </Card>
      )}
      <PreferencesPanel />
      <div className="btn-row stretch">
        <button type="button" className="pbtn" onClick={theme}>{dark ? <Sun size={18} /> : <Moon size={18} />} {dark ? t('light', 'Light') : t('dark', 'Dark')}</button>
        <button type="button" className="pbtn" onClick={() => setPwOpen(true)}><KeyRound size={18} /> {t('pwChange', 'Change password')}</button>
        <button type="button" className="pbtn" onClick={logout}><LogOut size={18} /> {t('signOut', 'Sign out')}</button>
      </div>
      {pwOpen && <ChangePasswordDialog onClose={() => setPwOpen(false)} />}
    </>
  )
}
