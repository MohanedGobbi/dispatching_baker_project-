import { useState } from 'react'
import type { FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from './api'
import { useAuth } from './auth'
import { Modal } from './dialogs'
import { errMsg, go } from './hooks'
import { useToast } from './ui'

/** Current password, new password twice. On success the API signs out other sessions and returns a new token. */
function ChangePasswordForm({ onDone, onCancel }: { onDone: () => void; onCancel?: () => void }) {
  const { t } = useTranslation()
  const { adoptToken } = useAuth()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (next !== again) { setError(t('pwMismatch', 'The two new passwords are different')); return }
    setBusy(true); setError('')
    try {
      const r = await api<{ token: string }>('/auth/change-password', { method: 'POST', body: { current, next } })
      await adoptToken(r.token)
      onDone()
    } catch (err) { setError(errMsg(err)); setBusy(false) }
  }
  return (
    <form onSubmit={submit} className="pw-form">
      <label>{t('pwCurrent', 'Current password')}<input type="password" value={current} onChange={e => setCurrent(e.target.value)} autoComplete="current-password" autoFocus required /></label>
      <label>{t('pwNew', 'New password')}<input type="password" value={next} onChange={e => setNext(e.target.value)} autoComplete="new-password" required /></label>
      <label>{t('pwAgain', 'New password again')}<input type="password" value={again} onChange={e => setAgain(e.target.value)} autoComplete="new-password" required /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <footer>
        {onCancel && <button type="button" onClick={onCancel}>{t('cancel', 'Cancel')}</button>}
        <button className="primary" disabled={busy || !current || !next}>{busy ? '…' : t('pwChange', 'Change password')}</button>
      </footer>
    </form>
  )
}

export function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  return (
    <Modal title={t('pwChange', 'Change password')} onClose={onClose}>
      <p className="muted">{t('pwOtherSessions', 'You stay signed in here; other devices are signed out.')}</p>
      <ChangePasswordForm onCancel={onClose} onDone={() => { toast(t('pwChanged', 'Password changed')); onClose() }} />
    </Modal>
  )
}

/** Shown instead of everything else while the account still has a temporary password. */
export function ForcedPasswordChange() {
  const { t } = useTranslation()
  const { logout } = useAuth()
  return (
    <main className="login">
      <div className="login-card">
        <h1>{t('pwChooseTitle', 'Choose your password')}</h1>
        <p className="muted">{t('pwChooseIntro', 'You signed in with a temporary password. Choose your own to continue.')}</p>
        <ChangePasswordForm onDone={() => undefined} />
        <button type="button" className="link" onClick={logout}>{t('signOut', 'Sign out')}</button>
      </div>
    </main>
  )
}

/** "Forgot password": always the same answer, whether or not the login exists. */
export function ForgotPassword({ initial, onBack }: { initial: string; onBack: () => void }) {
  const { t } = useTranslation()
  const [login, setLogin] = useState(initial)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true); setError('')
    try { await api('/auth/forgot', { method: 'POST', body: { login } }); setSent(true) } catch (err) { setError(errMsg(err)) } finally { setBusy(false) }
  }
  return (
    <form onSubmit={submit} className="login-card">
      <h1>{t('pwForgotTitle', 'Reset your password')}</h1>
      {sent ? (
        <p role="status">{t('pwForgotSent', 'If this account has an email address, a reset link is on its way. It works once and expires within the hour.')}</p>
      ) : (
        <>
          <p className="muted">{t('pwForgotIntro', 'Enter your login. We will email a link to the address on your account. No email address? Ask an administrator for a temporary password.')}</p>
          <label>{t('login', 'Login')}<input value={login} onChange={e => setLogin(e.target.value)} autoComplete="username" autoFocus required /></label>
          {error && <p className="error" role="alert">{error}</p>}
          <button className="primary" disabled={busy || !login.trim()}>{busy ? '…' : t('pwSendLink', 'Send reset link')}</button>
        </>
      )}
      <button type="button" className="link" onClick={onBack}>{t('pwBack', 'Back to sign in')}</button>
    </form>
  )
}

/** Opened from the emailed link: #/reset?token=… */
export function ResetPassword({ token }: { token: string }) {
  const { t } = useTranslation()
  const [password, setPassword] = useState('')
  const [again, setAgain] = useState('')
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (password !== again) { setError(t('pwMismatch', 'The two new passwords are different')); return }
    setBusy(true); setError('')
    try { await api('/auth/reset', { method: 'POST', body: { token, password } }); setDone(true) } catch (err) { setError(errMsg(err)) } finally { setBusy(false) }
  }
  return (
    <main className="login">
      <form onSubmit={submit} className="login-card">
        <h1>{t('pwForgotTitle', 'Reset your password')}</h1>
        {done ? (
          <p role="status">{t('pwResetDone', 'Your password is changed. Sign in with it now.')}</p>
        ) : (
          <>
            <label>{t('pwNew', 'New password')}<input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" autoFocus required /></label>
            <label>{t('pwAgain', 'New password again')}<input type="password" value={again} onChange={e => setAgain(e.target.value)} autoComplete="new-password" required /></label>
            {error && <p className="error" role="alert">{error}</p>}
            <button className="primary" disabled={busy || !password}>{busy ? '…' : t('pwSet', 'Set password')}</button>
          </>
        )}
        <button type="button" className="link" onClick={() => go('')}>{t('pwBack', 'Back to sign in')}</button>
      </form>
    </main>
  )
}
