import { useState } from 'react'
import type { FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from './auth'
import { ForgotPassword } from './account'


export default function Login() {
  const { t } = useTranslation()
  const { login } = useAuth()
  const [name, setName] = useState('admin')
  const [password, setPassword] = useState('demo1234')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [forgot, setForgot] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true); setError('')
    try { await login(name, password) } catch { setError(t('badLogin', 'Wrong login or password')) } finally { setBusy(false) }
  }

  if (forgot) return <main className="login"><ForgotPassword initial={name} onBack={() => setForgot(false)} /></main>

  return (
    <main className="login">
      <form onSubmit={submit} className="login-card">
        <div className="login-brand"><img src="/icon.svg" alt="" aria-hidden width={48} height={48} /><h1>{t('app')}</h1></div>
        <p className="muted">{t('loginIntro', 'Crew rotation and dispatch')}</p>
        <label>{t('login', 'Login')}<input value={name} onChange={e => setName(e.target.value)} autoComplete="username" autoFocus /></label>
        <label>{t('password', 'Password')}<input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" /></label>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary" disabled={busy}>{busy ? '…' : t('signIn', 'Sign in')}</button>
        <button type="button" className="link" onClick={() => setForgot(true)}>{t('pwForgot', 'Forgot your password?')}</button>
        <p className="muted demo-note">{t('demo')} · {t('demoAdmin', 'manager account')} <code>admin</code> / <code>demo1234</code></p>
      </form>
    </main>
  )
}
