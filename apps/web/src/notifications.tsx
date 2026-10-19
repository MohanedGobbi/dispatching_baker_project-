import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Bell, BellRing, Check } from 'lucide-react'
import { api } from './api'
import { useAuth } from './auth'
import { errMsg, useApi, useLive } from './hooks'
import { Pill, useToast } from './ui'

export interface Notice {
  id: string; type: string; title: string; body: string; payload: Record<string, unknown>
  requiresAck: boolean; acknowledgedAt: string | null; readAt: string | null; createdAt: string
}
interface NoticePage { total: number; unread: number; pendingAck: number; items: Notice[] }
interface PrefType { type: string; label: string; ack: boolean; inApp: boolean; email: boolean; locked: boolean }
interface Prefs { lang: string; types: PrefType[] }

/** Unread and "please confirm" counters for the bell, refreshed on every change and once a minute. */
export function useUnread() {
  const counts = useApi<{ unread: number; pendingAck: number }>('/notifications/unread-count')
  useLive(counts.reload)
  useEffect(() => { const h = setInterval(() => void counts.reload(), 60_000); return () => clearInterval(h) }, [counts.reload])
  return { unread: counts.data?.unread ?? 0, pendingAck: counts.data?.pendingAck ?? 0, reload: counts.reload }
}

export function Bell_({ count, urgent }: { count: number; urgent: boolean }) {
  const Icon = urgent ? BellRing : Bell
  return <span className="bell"><Icon size={17} aria-hidden />{count > 0 && <b className={urgent ? 'urgent' : ''}>{count > 99 ? '99+' : count}</b>}</span>
}

const ago = (iso: string, lang: string) => {
  const s = Math.max(1, Math.round((Date.now() - Date.parse(iso)) / 1000))
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' })
  if (s < 3600) return rtf.format(-Math.round(s / 60), 'minute')
  if (s < 86400) return rtf.format(-Math.round(s / 3600), 'hour')
  return rtf.format(-Math.round(s / 86400), 'day')
}

/** The list itself: unread first in bold, a button to confirm the ones that ask for it. Used by staff and by the portal. */
export function NoticeList({ onChanged }: { onChanged?: () => void }) {
  const { t, i18n } = useTranslation()
  const toast = useToast()
  const [unreadOnly, setUnreadOnly] = useState(false)
  const list = useApi<NoticePage>(`/notifications?limit=100${unreadOnly ? '&unread=true' : ''}`)
  useLive(list.reload)
  const refresh = useCallback(() => { void list.reload(); onChanged?.() }, [list.reload, onChanged])

  const act = async (path: string, ok?: string) => {
    try { await api(path, { method: 'POST' }); if (ok) toast(ok); refresh() } catch (e) { toast(errMsg(e), 'error') }
  }
  const items = list.data?.items ?? []

  return (
    <section className="notices" aria-label="Notifications">
      <div className="filters">
        {list.data && list.data.pendingAck > 0 && <Pill severity="warn">{list.data.pendingAck} {t('toConfirm', 'to confirm')}</Pill>}
        <span className="spacer" />
        <label className="check"><input type="checkbox" checked={unreadOnly} onChange={e => setUnreadOnly(e.target.checked)} /> {t('unreadOnly', 'Unread only')}</label>
        <button type="button" disabled={!list.data?.unread} onClick={() => void act('/notifications/read-all')}>{t('markAllRead', 'Mark all as read')}</button>
      </div>
      {list.error && <div className="banner error" role="alert">{list.error}</div>}
      {!list.loading && items.length === 0 && <p className="empty-note">{unreadOnly ? t('allRead', 'Everything is read.') : t('noAlerts', 'Nothing yet. You will see schedule changes, decisions and reminders here.')}</p>}
      <ul className="notice-list">
        {items.map(n => (
          <li key={n.id} className={`notice${n.readAt ? '' : ' unread'}${n.requiresAck && !n.acknowledgedAt ? ' needs' : ''}`}>
            <button type="button" className="notice-main" onClick={() => { if (!n.readAt) void act(`/notifications/${n.id}/read`) }}>
              <strong>{n.title}</strong>
              <span>{n.body}</span>
              <small className="muted">{ago(n.createdAt, i18n.language)}</small>
            </button>
            {n.requiresAck && (n.acknowledgedAt
              ? <span className="acked"><Check size={14} aria-hidden /> {t('confirmedLabel', 'Confirmed')}</span>
              : <button type="button" className="primary" onClick={() => void act(`/notifications/${n.id}/acknowledge`, t('thanksConfirmed', 'Thanks, confirmed'))}>{t('acknowledge', 'I have seen this')}</button>)}
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Which notices I want in the app or by email. Notices that need confirming cannot be switched off. */
export function PreferencesPanel() {
  const { t } = useTranslation()
  const toast = useToast()
  const prefs = useApi<Prefs>('/notifications/preferences')
  const save = async (body: unknown) => {
    try { await api('/notifications/preferences', { method: 'PUT', body }); await prefs.reload() } catch (e) { toast(errMsg(e), 'error') }
  }
  if (!prefs.data) return null
  return (
    <section className="panel" aria-label="Notification preferences">
      <h3>{t('prefsTitle', 'Notification preferences')}</h3>
      <table className="table compact">
        <thead><tr><th>{t('notice', 'Notice')}</th><th>{t('inApp', 'In the app')}</th><th>{t('byEmail', 'By email')}</th></tr></thead>
        <tbody>
          {prefs.data.types.map(p => (
            <tr key={p.type}>
              <td>{p.label}{p.locked && <small className="why">{t('cannotSwitchOff', 'Must be confirmed, so it cannot be switched off')}</small>}</td>
              <td><input type="checkbox" aria-label={`${p.label} in the app`} checked={p.inApp} disabled={p.locked} onChange={e => void save({ inApp: { [p.type]: e.target.checked } })} /></td>
              <td><input type="checkbox" aria-label={`${p.label} by email`} checked={p.email} onChange={e => void save({ email: { [p.type]: e.target.checked } })} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

/** Manager broadcast (plan 19): everyone, one base, or chosen roles. */
export function BroadcastPanel() {
  const { t } = useTranslation()
  const toast = useToast()
  const bases = useApi<{ id: string; code: string }[]>('/bases')
  const [title, setTitle] = useState('')
  const [message, setMessage] = useState('')
  const [audience, setAudience] = useState('all')
  const [ack, setAck] = useState(false)
  const [busy, setBusy] = useState(false)

  const send = async () => {
    setBusy(true)
    try {
      const body = { title, message, ack, ...(audience === 'all' ? { all: true } : { baseId: audience }) }
      const r = await api<{ sent: number }>('/notifications/broadcast', { method: 'POST', body })
      toast(`${t('broadcastSent', 'Sent to')} ${r.sent}`)
      setTitle(''); setMessage('')
    } catch (e) { toast(errMsg(e), 'error') } finally { setBusy(false) }
  }
  return (
    <section className="panel" aria-label="Broadcast">
      <h3>{t('broadcastTitle', 'Send a message')}</h3>
      <label className="reason">{t('title', 'Title')}<input value={title} onChange={e => setTitle(e.target.value)} /></label>
      <label className="reason">{t('message', 'Message')}<input value={message} onChange={e => setMessage(e.target.value)} /></label>
      <div className="filters">
        <select value={audience} onChange={e => setAudience(e.target.value)} aria-label="Audience">
          <option value="all">{t('everyone', 'Everyone')}</option>
          {bases.data?.map(b => <option key={b.id} value={b.id}>{t('baseOnly2', 'Base')} {b.code}</option>)}
        </select>
        <label className="check"><input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} /> {t('askConfirm', 'Ask people to confirm they read it')}</label>
        <span className="spacer" />
        <button type="button" className="primary" disabled={busy || !title.trim() || !message.trim()} onClick={() => void send()}>{t('send', 'Send')}</button>
      </div>
    </section>
  )
}

/** Staff screen (plan screen 20): the list, then preferences, then broadcast for managers. */
export default function NotificationsPage() {
  const { t } = useTranslation()
  const { can } = useAuth()
  return (
    <main className="page">
      <header className="page-head"><div><h1>{t('alertsTitle', 'Notifications')}</h1><p className="muted">{t('alertsIntro', 'Changes that concern you and things waiting for you.')}</p></div></header>
      <NoticeList />
      {can('SUPER_ADMIN', 'OPS_MANAGER') && <BroadcastPanel />}
      <PreferencesPanel />
    </main>
  )
}
