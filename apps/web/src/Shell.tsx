import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BarChart3, CalendarDays, CalendarRange, ClipboardList, LayoutGrid, LogOut, Moon, Repeat, Settings as SettingsIcon, Smartphone, Sun, Timer, Wand2, Wrench } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { api } from './api'
import { useAuth } from './auth'
import { isRtl } from './i18n'
import { useRoute } from './hooks'
import Board from './Board'
import Replacements from './Replacements'
import Plans from './Plans'
import Leave from './Leave'
import Timeline from './Timeline'
import CrewChanges from './CrewChanges'
import WorkOrders from './WorkOrders'
import Analytics from './Analytics'
import Extensions from './Extensions'
import Settings from './Settings'
import Portal from './Portal'
import NotificationsPage, { Bell_, useUnread } from './notifications'

interface Page { path: string; label: string; key: string; Icon: LucideIcon; roles?: string[] }

// Who sees which screen. The API enforces access too; this only avoids showing buttons that would be refused.
const PLANNERS = ['SUPER_ADMIN', 'OPS_MANAGER', 'DISPATCHER', 'BASE_MANAGER']
const PAGES: Page[] = [
  { path: 'board', key: 'nav_board', label: 'Board', Icon: LayoutGrid },
  { path: 'replacements', key: 'nav_replacements', label: 'Replacements', Icon: Repeat, roles: PLANNERS },
  { path: 'plans', key: 'nav_plans', label: 'Plans', Icon: Wand2, roles: PLANNERS },
  { path: 'leave', key: 'nav_leave', label: 'Leave', Icon: CalendarDays, roles: [...PLANNERS, 'HR'] },
  { path: 'work-orders', key: 'nav_workorders', label: 'Work orders', Icon: Wrench, roles: [...PLANNERS, 'CHIEF_OF_UNIT'] },
  { path: 'timeline', key: 'nav_timeline', label: 'Timeline', Icon: CalendarRange },
  { path: 'crew-changes', key: 'nav_changes', label: 'Crew changes', Icon: ClipboardList },
  { path: 'extensions', key: 'nav_extensions', label: 'Extensions', Icon: Timer, roles: [...PLANNERS, 'CHIEF_OF_UNIT'] },
  { path: 'analytics', key: 'nav_analytics', label: 'Analytics', Icon: BarChart3, roles: [...PLANNERS, 'HR'] },
  { path: 'settings', key: 'nav_settings', label: 'Settings', Icon: SettingsIcon, roles: ['SUPER_ADMIN', 'OPS_MANAGER'] },
]

export default function Shell() {
  const { t, i18n } = useTranslation()
  const { me, logout, can } = useAuth()
  const { parts } = useRoute()
  const [dark, setDark] = useState(false)
  const unread = useUnread()
  const employeeOnly = !!me && me.roles.every(r => r.role === 'EMPLOYEE')

  useEffect(() => {
    document.documentElement.dir = isRtl(i18n.language) ? 'rtl' : 'ltr'
    document.documentElement.lang = i18n.language
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  }, [i18n.language, dark])

  // The notification language is the person's language: take it at sign-in, and save it when they change it here.
  useEffect(() => {
    api<{ lang: string }>('/notifications/preferences').then(p => { if (p.lang && p.lang !== i18n.language) void i18n.changeLanguage(p.lang) }).catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const setLang = (l: string) => { void i18n.changeLanguage(l); api('/notifications/preferences', { method: 'PUT', body: { lang: l } }).catch(() => undefined) }

  // Employees get the phone-first portal and nothing else.
  if (employeeOnly) return <Portal />
  if (parts[0] === 'portal' && me?.employeeId) return <Portal onExit={() => undefined} />

  const visible = PAGES.filter(p => !p.roles || can(...p.roles))
  const onAlerts = parts[0] === 'notifications'
  const current = visible.find(p => p.path === parts[0]) ?? (onAlerts ? undefined : visible[0])

  return (
    <div className="shell">
      <header className="nav">
        <strong className="brand">{t('app')}</strong>
        <nav aria-label="Screens">
          {visible.map(p => (
            <a key={p.path} href={`#/${p.path}`} className={p === current ? 'on' : ''} aria-current={p === current ? 'page' : undefined}>
              <p.Icon size={15} aria-hidden /> {t(p.key, p.label)}
            </a>
          ))}
        </nav>
        <span className="spacer" />
        {me?.employeeId && <a className="navlink" href="#/portal/today" title={t('myPortal', 'My portal')}><Smartphone size={16} aria-hidden /> <span className="hide-sm">{t('myPortal', 'My portal')}</span></a>}
        <a className={`navlink bellink${onAlerts ? ' on' : ''}`} href="#/notifications" aria-label={t('alertsTitle', 'Notifications')} title={t('alertsTitle', 'Notifications')}><Bell_ count={unread.unread} urgent={unread.pendingAck > 0} /></a>
        {['en', 'fr', 'ar'].map(l => <button key={l} type="button" className={i18n.language === l ? 'on' : ''} onClick={() => setLang(l)}>{l.toUpperCase()}</button>)}
        <button type="button" aria-label="Theme" onClick={() => setDark(!dark)}>{dark ? <Sun size={16} /> : <Moon size={16} />}</button>
        <button type="button" aria-label="Sign out" title={me?.roles.map(r => r.role).join(', ')} onClick={logout}><LogOut size={16} /></button>
      </header>
      {onAlerts && <NotificationsPage />}
      {current?.path === 'board' && <Board />}
      {current?.path === 'replacements' && <Replacements />}
      {current?.path === 'plans' && <Plans />}
      {current?.path === 'leave' && <Leave />}
      {current?.path === 'work-orders' && <WorkOrders />}
      {current?.path === 'timeline' && <Timeline />}
      {current?.path === 'crew-changes' && <CrewChanges />}
      {current?.path === 'analytics' && <Analytics />}
      {current?.path === 'extensions' && <Extensions />}
      {current?.path === 'settings' && <Settings />}
    </div>
  )
}
