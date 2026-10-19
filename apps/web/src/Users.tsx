import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, KeyRound, Plus } from 'lucide-react'
import { api } from './api'
import { useAuth } from './auth'
import { Modal } from './dialogs'
import { errMsg, useApi, useDebounced } from './hooks'
import { fmtDate } from './labels'
import { Pill, useToast } from './ui'

interface Account {
  id: string; login: string; email: string | null; active: boolean; mustChangePassword: boolean; lastLoginAt: string | null; createdAt: string
  roles: { role: string; baseScope: string | null }[]
  employee: { id: string; employeeNo: string; name: string; email: string | null } | null
}

const ROLE_LABEL: Record<string, string> = {
  SUPER_ADMIN: 'Manager', OPS_MANAGER: 'Ops manager', DISPATCHER: 'Dispatcher', HR: 'HR', BASE_MANAGER: 'Base manager',
  CHIEF_OF_UNIT: 'Chief of unit', EMPLOYEE: 'Employee',
}
const ROLES = Object.keys(ROLE_LABEL)
// For now the platform has two kinds of user. Other roles stay in the API and show only on accounts that already have them.
const IN_USE = ['SUPER_ADMIN', 'EMPLOYEE']

/** Accounts (plan section 3): managers and employees. Passwords are never shown, except a temporary one once. */
export default function Users() {
  const { t, i18n } = useTranslation()
  const { can, me } = useAuth()
  const toast = useToast()
  const admin = can('SUPER_ADMIN')
  const [text, setText] = useState('')
  const q = useDebounced(text.trim())
  const [role, setRole] = useState('')
  const [status, setStatus] = useState('true')
  const params = new URLSearchParams({ ...(q ? { q } : {}), ...(role ? { role } : {}), ...(status ? { active: status } : {}) })
  const list = useApi<Account[]>(`/users?${params}`)
  const [editing, setEditing] = useState<Account | 'new' | null>(null)
  const [temp, setTemp] = useState<{ login: string; password: string } | null>(null)

  const reset = async (u: Account) => {
    try {
      const r = await api<{ tempPassword: string }>(`/users/${u.id}/reset-password`, { method: 'POST' })
      setTemp({ login: u.login, password: r.tempPassword }); await list.reload()
    } catch (e) { toast(errMsg(e), 'error') }
  }

  return (
    <main className="page wide">
      <header className="page-head">
        <div><h1>{t('usersTitle', 'Users')}</h1><p className="muted">{t('usersIntro', 'Who can sign in, with which roles. Every change is in the audit log.')}</p></div>
        {admin && <div className="actions"><button type="button" className="primary" onClick={() => setEditing('new')}><Plus size={15} aria-hidden /> {t('newUser', 'New user')}</button></div>}
      </header>
      <div className="filters">
        <input value={text} onChange={e => setText(e.target.value)} placeholder={t('userSearch', 'Login, name, email or employee number')} aria-label={t('search', 'Search')} />
        <select value={role} onChange={e => setRole(e.target.value)} aria-label={t('role', 'Role')}>
          <option value="">{t('allRoles', 'All roles')}</option>{IN_USE.map(r => <option key={r} value={r}>{t(`role_${r}`, ROLE_LABEL[r])}</option>)}
        </select>
        <select value={status} onChange={e => setStatus(e.target.value)} aria-label={t('status', 'Status')}>
          <option value="true">{t('active', 'Active')}</option><option value="false">{t('disabled', 'Disabled')}</option><option value="">{t('all', 'All')}</option>
        </select>
        <span className="spacer" /><span className="muted">{list.data ? list.data.length : '…'}</span>
      </div>
      {list.error && <div className="banner error" role="alert">{list.error}</div>}
      <table className="table compact">
        <thead><tr><th>{t('login', 'Login')}</th><th>{t('person', 'Person')}</th><th>{t('roles', 'Roles')}</th><th>{t('email', 'Email')}</th><th>{t('lastSignIn', 'Last sign-in')}</th><th>{t('status', 'Status')}</th>{admin && <th />}</tr></thead>
        <tbody>
          {list.data?.map(u => (
            <tr key={u.id}>
              <td><strong>{u.login}</strong>{u.id === me?.sub && <small className="muted"> ({t('you', 'you')})</small>}</td>
              <td>{u.employee ? <>{u.employee.name} <small className="muted">{u.employee.employeeNo}</small></> : <span className="muted">—</span>}</td>
              <td><div className="badges">{u.roles.map(r => <span key={r.role} className="badge sev-info">{t(`role_${r.role}`, ROLE_LABEL[r.role] ?? r.role)}{r.baseScope ? ` · ${r.baseScope}` : ''}</span>)}</div></td>
              <td>{u.email ?? u.employee?.email ?? <span className="muted">—</span>}</td>
              <td>{u.lastLoginAt ? fmtDate(u.lastLoginAt, i18n.language) : <span className="muted">{t('never', 'never')}</span>}</td>
              <td>{!u.active ? <Pill severity="bad">{t('disabled', 'Disabled')}</Pill> : u.mustChangePassword ? <Pill severity="warn">{t('tempPw', 'Temporary password')}</Pill> : <Pill severity="ok">{t('active', 'Active')}</Pill>}</td>
              {admin && <td className="row-actions"><button type="button" onClick={() => setEditing(u)}>{t('edit', 'Edit')}</button><button type="button" onClick={() => void reset(u)} title={t('resetPwHint', 'Give a temporary password; other sessions end')}><KeyRound size={14} aria-hidden /> {t('resetPw', 'Reset password')}</button></td>}
            </tr>
          ))}
          {list.data?.length === 0 && <tr><td colSpan={7} className="muted">{t('noUsers', 'No account matches.')}</td></tr>}
        </tbody>
      </table>
      {editing && <UserDialog user={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={async created => { setEditing(null); if (created) setTemp(created); await list.reload() }} />}
      {temp && <TempPassword {...temp} onClose={() => setTemp(null)} />}
    </main>
  )
}

function TempPassword({ login, password, onClose }: { login: string; password: string; onClose: () => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const copy = () => { navigator.clipboard?.writeText(password).then(() => toast(t('copied', 'Copied')), () => undefined) }
  return (
    <Modal title={t('tempPwTitle', 'Temporary password')} onClose={onClose}>
      <p>{t('tempPwFor', 'For')} <strong>{login}</strong>. {t('tempPwOnce', 'It is shown only now. Give it to the person; they choose their own at the next sign-in.')}</p>
      <p className="temp-pw"><code>{password}</code> <button type="button" onClick={copy} aria-label={t('copy', 'Copy')}><Copy size={14} aria-hidden /></button></p>
      <footer><button type="button" className="primary" onClick={onClose}>{t('done', 'Done')}</button></footer>
    </Modal>
  )
}

function UserDialog({ user, onClose, onSaved }: { user: Account | null; onClose: () => void; onSaved: (created?: { login: string; password: string }) => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const { me } = useAuth()
  const bases = useApi<{ id: string; code: string }[]>('/bases')
  const [login, setLogin] = useState(user?.login ?? '')
  const [email, setEmail] = useState(user?.email ?? '')
  const [password, setPassword] = useState('')
  const [active, setActive] = useState(user?.active ?? true)
  const [roles, setRoles] = useState<Record<string, string | null>>(Object.fromEntries((user?.roles ?? []).map(r => [r.role, r.baseScope])))
  const [employee, setEmployee] = useState<{ id: string; name: string } | null>(user?.employee ? { id: user.employee.id, name: `${user.employee.name} · ${user.employee.employeeNo}` } : null)
  const [text, setText] = useState('')
  const q = useDebounced(text.trim())
  const hits = useApi<{ items: { id: string; firstName: string; lastName: string; employeeNo: string; position: { name: string } }[] }>(q.length >= 2 ? `/employees?q=${encodeURIComponent(q)}&limit=6` : null)
  const [busy, setBusy] = useState(false)
  const self = user?.id === me?.sub

  const toggle = (r: string) => setRoles(({ [r]: had, ...rest }) => (had !== undefined ? rest : { ...rest, [r]: r === 'BASE_MANAGER' ? (bases.data?.[0]?.code ?? null) : null }))
  const save = async () => {
    setBusy(true)
    const body = { email: email.trim() || null, employeeId: employee?.id ?? null, roles: Object.entries(roles).map(([role, baseScope]) => ({ role, baseScope })) }
    try {
      if (user) {
        await api(`/users/${user.id}`, { method: 'PUT', body: { ...body, active } })
        toast(t('saved', 'Saved')); onSaved()
      } else {
        const r = await api<{ tempPassword: string | null }>('/users', { method: 'POST', body: { ...body, login: login.trim(), password: password || undefined } })
        toast(t('userCreated', 'Account created')); onSaved(r.tempPassword ? { login: login.trim(), password: r.tempPassword } : undefined)
      }
    } catch (e) { toast(errMsg(e), 'error'); setBusy(false) }
  }

  return (
    <Modal title={user ? `${t('editUser', 'Edit account')} · ${user.login}` : t('newUser', 'New user')} onClose={onClose}>
      {!user && <label className="reason">{t('login', 'Login')}<input value={login} onChange={e => setLogin(e.target.value)} autoComplete="off" autoFocus /></label>}
      <label className="reason">{t('email', 'Email')} <small>{t('emailHint', '(for password reset links; the employee record\'s address is used when empty)')}</small><input type="email" value={email} onChange={e => setEmail(e.target.value)} /></label>
      <h3>{t('roles', 'Roles')}</h3>
      <div className="role-grid">
        {ROLES.filter(r => IN_USE.includes(r) || r in roles).map(r => (
          <label key={r} className="check">
            <input type="checkbox" checked={r in roles} disabled={self && r === 'SUPER_ADMIN'} onChange={() => toggle(r)} />
            {t(`role_${r}`, ROLE_LABEL[r])}
            {r === 'BASE_MANAGER' && r in roles && (
              <select value={roles[r] ?? ''} onChange={e => setRoles({ ...roles, [r]: e.target.value })} aria-label={t('base', 'Base')}>
                {bases.data?.map(b => <option key={b.id} value={b.code}>{b.code}</option>)}
              </select>
            )}
          </label>
        ))}
      </div>
      <h3>{t('linkedEmployee', 'Employee record')}</h3>
      {employee ? (
        <p>{employee.name} <button type="button" className="link" onClick={() => setEmployee(null)}>{t('unlink', 'Unlink')}</button></p>
      ) : (
        <>
          <label className="reason">{t('linkEmployee', 'Link to an employee (gives access to their portal)')}<input value={text} onChange={e => setText(e.target.value)} placeholder={t('searchPerson', 'Name or employee number')} /></label>
          {hits.data && <ul className="cand-list">{hits.data.items.map(h => <li key={h.id}><div><strong>{h.firstName} {h.lastName}</strong><small className="why">{h.employeeNo} · {h.position.name}</small></div><button type="button" onClick={() => { setEmployee({ id: h.id, name: `${h.firstName} ${h.lastName} · ${h.employeeNo}` }); setText('') }}>{t('choose', 'Choose')}</button></li>)}</ul>}
        </>
      )}
      {!user && <label className="reason">{t('password', 'Password')} <small>{t('pwEmptyHint', '(leave empty to get a temporary one)')}</small><input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" /></label>}
      {user && <label className="check"><input type="checkbox" checked={active} disabled={self} onChange={e => setActive(e.target.checked)} /> {t('accountActive', 'Account active (unchecked: cannot sign in, sessions end)')}</label>}
      <footer>
        <button type="button" onClick={onClose}>{t('cancel', 'Cancel')}</button>
        <button type="button" className="primary" disabled={busy || (!user && !login.trim()) || Object.keys(roles).length === 0} onClick={() => void save()}>{t('save', 'Save')}</button>
      </footer>
    </Modal>
  )
}
