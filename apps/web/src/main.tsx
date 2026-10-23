import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './i18n'
import '@fontsource-variable/inter'
import './index.css'
import App from './App.tsx'
import { initTheme } from './theme'

initTheme()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
// The employee portal's offline service worker is gone: remove it, and its cache, from browsers that installed it.
navigator.serviceWorker?.getRegistrations().then(rs => rs.forEach(r => { void r.unregister() })).catch(() => {})
if ('caches' in window) void caches.delete('crewboard-api').catch(() => {})
