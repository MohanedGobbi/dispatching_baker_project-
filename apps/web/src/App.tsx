import { LogOut } from 'lucide-react'
import { AuthProvider, useAuth } from './auth'
import { ForcedPasswordChange, ResetPassword } from './account'
import { useRoute } from './hooks'
import Login from './Login'
import Shell from './Shell'
import { ToastProvider } from './ui'
import './tokens.css'
import './look.css'

// CrewBoard is for one person, the manager. Any other kind of account is told so instead of being shown screens it was never meant for.
// A reset link works whether or not someone is signed in on this browser; a temporary password must be replaced first.
function ManagerOnly() {
  const { logout } = useAuth()
  return (
    <main className="login">
      <div className="login-card">
        <div className="login-brand"><img src="/icon.svg" alt="" aria-hidden width={48} height={48} /><h1>CrewBoard</h1></div>
        <p>This platform is for the manager only. Sign in with the manager account.</p>
        <button type="button" className="primary" onClick={logout}><LogOut size={16} aria-hidden /> Sign out</button>
      </div>
    </main>
  )
}

function Gate() {
  const { me } = useAuth()
  const { parts, query } = useRoute()
  if (parts[0] === 'reset' && query.get('token')) return <ResetPassword token={query.get('token')!} />
  if (me?.mustChangePassword) return <ForcedPasswordChange />
  if (me && !me.roles.some(r => r.role === 'SUPER_ADMIN')) return <ManagerOnly />
  return me ? <Shell /> : <Login />
}

export default function App() {
  return <AuthProvider><ToastProvider><Gate /></ToastProvider></AuthProvider>
}
