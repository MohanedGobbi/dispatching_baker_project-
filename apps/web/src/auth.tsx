import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { api, getToken, setToken, whenUnauthorized } from './api'

export interface Me { sub: string; roles: { role: string; baseScope?: string | null }[]; employeeId?: string | null; mustChangePassword?: boolean }
interface AuthState {
  me: Me | null
  login: (login: string, password: string) => Promise<void>
  /** Take a new token (after a password change) and reload who is signed in. */
  adoptToken: (token: string) => Promise<void>
  logout: () => void
  /** Signed in automatically (no sign-in page): sign-out and password screens are hidden. */
  auto: boolean
  can: (...roles: string[]) => boolean
}

const Ctx = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null)
  const [ready, setReady] = useState(false)
  const [auto, setAuto] = useState(false)

  const logout = useCallback(() => {
    setToken(null); setMe(null)
    // Saved offline data belongs to the person who just left.
    navigator.serviceWorker?.controller?.postMessage('clear')
    void caches?.delete('crewboard-api')
  }, [])

  // The manager is the only user: on this computer the API signs the browser in without a password.
  // Several requests can fail at once with an expired token; they share one sign-in.
  const pending = useRef<Promise<boolean> | null>(null)
  const autoLogin = useCallback(() => {
    pending.current ??= api<{ token: string; user: { id: string; roles: Me['roles']; employeeId: string | null } }>('/auth/auto', { method: 'POST' })
      .then(r => { setToken(r.token); setMe({ sub: r.user.id, roles: r.user.roles, employeeId: r.user.employeeId }); setAuto(true); return true }, () => false)
      .finally(() => { pending.current = null })
    return pending.current
  }, [])

  useEffect(() => {
    void (async () => {
      if (!(await autoLogin()) && getToken()) {
        try { setMe(await api<Me>('/auth/me')) } catch { setToken(null) }
      }
      setReady(true)
    })()
  }, [autoLogin])
  // An expired token signs in again by itself when that is allowed, otherwise shows the sign-in page.
  useEffect(() => whenUnauthorized(() => { void autoLogin().then(ok => { if (!ok) logout() }) }), [logout, autoLogin])

  const login = useCallback(async (loginName: string, password: string) => {
    const r = await api<{ token: string; user: { id: string; roles: Me['roles']; employeeId: string | null; mustChangePassword: boolean } }>('/auth/login', { method: 'POST', body: { login: loginName, password } })
    setToken(r.token)
    setMe({ sub: r.user.id, roles: r.user.roles, employeeId: r.user.employeeId, mustChangePassword: r.user.mustChangePassword })
  }, [])

  const adoptToken = useCallback(async (token: string) => {
    setToken(token)
    setMe(await api<Me>('/auth/me'))
  }, [])

  const value = useMemo<AuthState>(() => ({
    me, login, adoptToken, logout, auto, can: (...roles) => !!me?.roles.some(r => roles.includes(r.role)),
  }), [me, login, adoptToken, logout, auto])

  if (!ready) return null
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAuth() {
  const v = useContext(Ctx)
  if (!v) throw new Error('useAuth outside AuthProvider')
  return v
}
