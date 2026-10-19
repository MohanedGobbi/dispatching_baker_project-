import { AuthProvider, useAuth } from './auth'
import Login from './Login'
import Shell from './Shell'
import { ToastProvider } from './ui'
import './tokens.css'
import './App.css'
import './pages.css'
import './portal.css'

// The shell decides what each role sees: staff get the planner screens, employees get the phone-first portal.
function Gate() {
  const { me } = useAuth()
  return me ? <Shell /> : <Login />
}

export default function App() {
  return <AuthProvider><ToastProvider><Gate /></ToastProvider></AuthProvider>
}
