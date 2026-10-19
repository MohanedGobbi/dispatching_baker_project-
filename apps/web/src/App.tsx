import { AuthProvider, useAuth } from './auth'
import { ForcedPasswordChange, ResetPassword } from './account'
import { useRoute } from './hooks'
import Login from './Login'
import Shell from './Shell'
import { ToastProvider } from './ui'
import './tokens.css'
import './App.css'
import './pages.css'
import './portal.css'
import './look.css'

// The shell decides what each role sees: staff get the planner screens, employees get the phone-first portal.
// A reset link works whether or not someone is signed in on this browser; a temporary password must be replaced first.
function Gate() {
  const { me } = useAuth()
  const { parts, query } = useRoute()
  if (parts[0] === 'reset' && query.get('token')) return <ResetPassword token={query.get('token')!} />
  if (me?.mustChangePassword) return <ForcedPasswordChange />
  return me ? <Shell /> : <Login />
}

export default function App() {
  return <AuthProvider><ToastProvider><Gate /></ToastProvider></AuthProvider>
}
