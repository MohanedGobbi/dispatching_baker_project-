import { lazy, Suspense, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BarChart3, CalendarDays, CalendarRange, ClipboardList, FileSpreadsheet, History, KeyRound, LayoutGrid, LogOut, MapPin, Menu, Moon, PanelLeftClose, PanelLeftOpen, Repeat, Settings as SettingsIcon, Sun, Timer, Truck, Users, Wand2, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useAuth } from './auth'
import { useRoute } from './hooks'
import { currentTheme, setTheme } from './theme'
import Board from './Board'
import { ChangePasswordDialog } from './account'
import { ProfileProvider } from './profiles'
import { QuickProvider } from './quick'
import NotificationsPage, { Bell_, useUnread } from './notifications'

// The board is the landing screen; every other screen is loaded the first time it is opened.
const Units = lazy(() => import('./Units'))
const People = lazy(() => import('./People'))
const Rotations = lazy(() => import('./Rotations'))
const Locations = lazy(() => import('./Locations'))
const Replacements = lazy(() => import('./Replacements'))
const Plans = lazy(() => import('./Plans'))
const Timeline = lazy(() => import('./Timeline'))
const CrewChanges = lazy(() => import('./CrewChanges'))
const Analytics = lazy(() => import('./Analytics'))
const Extensions = lazy(() => import('./Extensions'))
const Settings = lazy(() => import('./Settings'))
const Audit = lazy(() => import('./Audit'))
const DataTransfer = lazy(() => import('./DataTransfer'))

interface Page { path: string; label: string; key: string; Icon: LucideIcon; color: string; hint: string; group: string; roles?: string[] }

// Who sees which screen. The API enforces access too; this only avoids showing buttons that would be refused.
const PLANNERS = ['SUPER_ADMIN', 'OPS_MANAGER', 'DISPATCHER', 'BASE_MANAGER']
const GROUPS: [string, string][] = [['today', 'Today'], ['planning', 'Planning'], ['insights', 'Insights'], ['admin', 'Administration']]
const PAGES: Page[] = [
  { group: 'today', path: 'board', key: 'nav_board', label: 'Board', Icon: LayoutGrid, color: 'var(--pal-blue-600)', hint: 'Who is on which unit today' },
  { group: 'today', path: 'units', key: 'nav_units', label: 'Units', Icon: Truck, color: 'var(--pal-sky-700)', hint: 'The fleet: status, jobs, details', roles: ['SUPER_ADMIN', 'OPS_MANAGER', 'DISPATCHER', 'BASE_MANAGER'] },
  { group: 'today', path: 'people', key: 'nav_people', label: 'People', Icon: Users, color: 'var(--pal-indigo-600)', hint: 'Everyone, their rank and partner', roles: ['SUPER_ADMIN', 'OPS_MANAGER', 'HR'] },
  { group: 'admin', path: 'locations', key: 'nav_locations', label: 'Locations', Icon: MapPin, color: 'var(--pal-teal-700)', hint: 'Bases and sites', roles: ['SUPER_ADMIN', 'OPS_MANAGER'] },
  { group: 'today', path: 'replacements', key: 'nav_replacements', label: 'Replacements', Icon: Repeat, color: 'var(--pal-red-600)', hint: 'Seats that need someone', roles: PLANNERS },
  { group: 'today', path: 'crew-changes', key: 'nav_changes', label: 'Crew changes', Icon: ClipboardList, color: 'var(--pal-teal-600)', hint: 'Who goes out and comes back' },
  { group: 'planning', path: 'plans', key: 'nav_plans', label: 'Plans', Icon: Wand2, color: 'var(--pal-violet-600)', hint: 'Let the planner fill the coming weeks', roles: PLANNERS },
  { group: 'planning', path: 'rotations', key: 'nav_rotations', label: 'Work & days off', Icon: CalendarDays, color: 'var(--pal-cyan-700)', hint: 'Rotations and first day of work', roles: ['SUPER_ADMIN', 'OPS_MANAGER', 'HR'] },
  { group: 'planning', path: 'timeline', key: 'nav_timeline', label: 'Timeline', Icon: CalendarRange, color: 'var(--pal-cyan-600)', hint: 'Everyone day by day' },
  { group: 'planning', path: 'extensions', key: 'nav_extensions', label: 'Extensions', Icon: Timer, color: 'var(--pal-orange-600)', hint: 'Keeping someone longer on a unit', roles: [...PLANNERS, 'CHIEF_OF_UNIT'] },
  { group: 'insights', path: 'analytics', key: 'nav_analytics', label: 'Analytics', Icon: BarChart3, color: 'var(--pal-green-600)', hint: 'Numbers and coverage ahead', roles: [...PLANNERS, 'HR'] },
  { group: 'admin', path: 'settings', key: 'nav_settings', label: 'Settings', Icon: SettingsIcon, color: 'var(--pal-slate-600)', hint: 'Rules and numbers', roles: ['SUPER_ADMIN', 'OPS_MANAGER'] },
  { group: 'admin', path: 'data', key: 'nav_data', label: 'Import / export', Icon: FileSpreadsheet, color: 'var(--pal-slate-600)', hint: 'Excel in and out', roles: ['SUPER_ADMIN', 'OPS_MANAGER', 'DISPATCHER', 'HR', 'BASE_MANAGER'] },
  { group: 'admin', path: 'audit', key: 'nav_audit', label: 'Audit', Icon: History, color: 'var(--pal-slate-600)', hint: 'Who changed what', roles: ['SUPER_ADMIN', 'OPS_MANAGER', 'HR'] },
]
const ROLE_NAME: Record<string, string> = { SUPER_ADMIN: 'Manager', OPS_MANAGER: 'Operations manager', DISPATCHER: 'Dispatcher', BASE_MANAGER: 'Base manager', HR: 'HR', CHIEF_OF_UNIT: 'Chief of unit', EMPLOYEE: 'Employee' }

export default function Shell() {
  const { t } = useTranslation()
  const { me, logout, can, auto } = useAuth()
  const { parts } = useRoute()
  const [dark, setDark] = useState(() => currentTheme() === 'dark')
  const [pwOpen, setPwOpen] = useState(false)
  const [slim, setSlim] = useState(() => { try { return localStorage.getItem('crewboard.slim') === '1' } catch { return false } })
  useEffect(() => { try { localStorage.setItem('crewboard.slim', slim ? '1' : '0') } catch { /* private mode */ } }, [slim])
  // phones: the menu slides in over the page and closes again once a screen is picked
  const [menuOpen, setMenuOpen] = useState(false)
  useEffect(() => { setMenuOpen(false) }, [parts[0]])
  const unread = useUnread()

  const visible = PAGES.filter(p => !p.roles || can(...p.roles))
  const onAlerts = parts[0] === 'notifications'
  const current = visible.find(p => p.path === parts[0]) ?? (onAlerts ? undefined : visible[0])

  const role = me?.roles[0]?.role ?? ''
  return (
    <ProfileProvider>
    <QuickProvider>
    <div className={`shell2${slim ? ' slim' : ''}${menuOpen ? ' menu-open' : ''}`}>
      {menuOpen && <div className="menu-scrim" aria-hidden onClick={() => setMenuOpen(false)} />}
      <aside className="side-nav" id="side-nav" aria-label="Screens">
        <div className="side-brand">
          <img className="logo" src="/icon.svg" alt="" aria-hidden />
          <span className="side-label"><strong>{t('app')}</strong><small>{t('tagline', 'Crew rotation & dispatch')}</small></span>
          <button type="button" className="slim-toggle" aria-label={slim ? 'Expand menu' : 'Collapse menu'} onClick={() => setSlim(!slim)}>{slim ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}</button>
        </div>
        <nav>
          {GROUPS.map(([g, gl]) => {
            const items = visible.filter(p => p.group === g)
            if (!items.length) return null
            return (
              <div key={g} className="side-group">
                <span className="side-group-title side-label">{t(`grp_${g}`, gl)}</span>
                {items.map(p => (
                  <a key={p.path} href={`#/${p.path}`} className={p === current ? 'on' : ''} aria-current={p === current ? 'page' : undefined} style={{ ['--c' as string]: p.color }} title={slim ? `${t(p.key, p.label)} · ${p.hint}` : p.hint}>
                    <span className="side-icon"><p.Icon size={16} aria-hidden /></span>
                    <span className="side-label"><b>{t(p.key, p.label)}</b><small>{t(`hint_${p.path}`, p.hint)}</small></span>
                  </a>
                ))}
              </div>
            )
          })}
        </nav>
        <div className="side-me side-label">
          <span className="avatar-sm" aria-hidden>{(ROLE_NAME[role] ?? role).split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()}</span>
          <span><b>{t('signedInAs', 'Signed in as')}</b><small>{ROLE_NAME[role] ?? role}{me?.roles[0]?.baseScope ? ` · ${me.roles[0].baseScope}` : ''}</small></span>
        </div>
        <div className="side-account">
          {!auto && <button type="button" onClick={() => setPwOpen(true)}><KeyRound size={16} aria-hidden /> {t('pwChange', 'Change password')}</button>}
          {!auto && <button type="button" onClick={logout}><LogOut size={16} aria-hidden /> {t('signOut', 'Sign out')}</button>}
        </div>
      </aside>
      <div className="main-col">
      <header className="nav">
        <button type="button" className="menu-btn" aria-label={t('menu', 'Menu')} aria-controls="side-nav" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>{menuOpen ? <X size={20} /> : <Menu size={20} />}</button>
        <strong className="crumb" style={{ ['--c' as string]: current?.color ?? 'var(--accent)' }}>{current && <current.Icon size={16} aria-hidden />} {current ? t(current.key, current.label) : t('alertsTitle', 'Notifications')}</strong>
        <span className="spacer" />
        <a className={`navlink bellink${onAlerts ? ' on' : ''}`} href="#/notifications" aria-label={t('alertsTitle', 'Notifications')} title={t('alertsTitle', 'Notifications')}><Bell_ count={unread.unread} urgent={unread.pendingAck > 0} /></a>
        <button type="button" aria-label="Theme" onClick={() => { setTheme(dark ? 'light' : 'dark'); setDark(!dark) }}>{dark ? <Sun size={16} /> : <Moon size={16} />}</button>
        {!auto && <button type="button" className="acct" aria-label={t('pwChange', 'Change password')} title={t('pwChange', 'Change password')} onClick={() => setPwOpen(true)}><KeyRound size={16} /></button>}
        {!auto && <button type="button" className="acct" aria-label={t('signOut', 'Sign out')} title={me?.roles.map(r => r.role).join(', ')} onClick={logout}><LogOut size={16} /></button>}
      </header>
      <Suspense fallback={<main className="page"><p className="muted" role="status">Loading…</p></main>}>
        {onAlerts && <NotificationsPage />}
        {current?.path === 'board' && <Board />}
        {current?.path === 'units' && <Units />}
        {current?.path === 'people' && <People />}
        {current?.path === 'rotations' && <Rotations />}
        {current?.path === 'locations' && <Locations />}
        {current?.path === 'replacements' && <Replacements />}
        {current?.path === 'plans' && <Plans />}
        {current?.path === 'timeline' && <Timeline />}
        {current?.path === 'crew-changes' && <CrewChanges />}
        {current?.path === 'analytics' && <Analytics />}
        {current?.path === 'extensions' && <Extensions />}
        {current?.path === 'settings' && <Settings />}
        {current?.path === 'audit' && <Audit />}
        {current?.path === 'data' && <DataTransfer />}
      </Suspense>
      {pwOpen && <ChangePasswordDialog onClose={() => setPwOpen(false)} />}
      </div>
    </div>
    </QuickProvider>
    </ProfileProvider>
  )
}
