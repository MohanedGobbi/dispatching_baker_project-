import Shell from './Shell'
import { ToastProvider } from './ui'
import './tokens.css'
import './look.css'

// CrewBoard has one user, the manager, on this computer: no sign-in, the screens open straight away.
export default function App() {
  return <ToastProvider><Shell /></ToastProvider>
}
