import { useState } from 'react'
import type { FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from './auth'

const DEMO = [
  ['dispatcher', 'Dispatcher'], ['ops', 'Ops manager'], ['hr', 'HR'], ['basemanager', 'Base manager'], ['admin', 'Super admin'],
] as const

export default function Login() {
  const { t } = useTranslation()
  const { login } = useAuth()
  const [name, setName] = useState('dispatcher')
  const [password, setPassword] = useState('demo1234')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true); setError('')
    try { await login(name, password) } catch { setError(t('badLogin', 'Wrong login or password')) } finally { setBusy(false) }
  }

  return (
    <main className="login">
      <form onSubmit={submit} className="login-card">
        <h1>{t('app')}</h1>
        <p className="muted">{t('loginIntro', 'Crew rotation, dispatch and base staffing')}</p>
        <label>{t('login', 'Login')}<input value={name} onChange={e => setName(e.target.value)} autoComplete="username" autoFocus /></label>
        <label>{t('password', 'Password')}<input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" /></label>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary" disabled={busy}>{busy ? '…' : t('signIn', 'Sign in')}</button>
        <div className="demo-users">
          <span className="muted">{t('demoAccounts', 'Demo accounts')} ({t('demo')})</span>
          <div>{DEMO.map(([l, label]) => <button type="button" key={l} onClick={() => { setName(l); setPassword('demo1234') }}>{label}</button>)}</div>
        </div>
      </form>
    </main>
  )
}
