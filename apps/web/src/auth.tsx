import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { api, getToken, setToken, whenUnauthorized } from './api'

export interface Me { sub: string; roles: { role: string; baseScope?: string | null }[]; employeeId?: string | null }
interface AuthState {
  me: Me | null
  login: (login: string, password: string) => Promise<void>
  logout: () => void
  can: (...roles: string[]) => boolean
}

const Ctx = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null)
  const [ready, setReady] = useState(false)

  const logout = useCallback(() => {
    setToken(null); setMe(null)
    // Saved offline data belongs to the person who just left.
    navigator.serviceWorker?.controller?.postMessage('clear')
    void caches?.delete('crewboard-api')
  }, [])

  useEffect(() => {
    if (!getToken()) { setReady(true); return }
    api<Me>('/auth/me').then(setMe).catch(() => setToken(null)).finally(() => setReady(true))
  }, [])
  useEffect(() => whenUnauthorized(logout), [logout])

  const login = useCallback(async (loginName: string, password: string) => {
    const r = await api<{ token: string; user: { id: string; roles: Me['roles']; employeeId: string | null } }>('/auth/login', { method: 'POST', body: { login: loginName, password } })
    setToken(r.token)
    setMe({ sub: r.user.id, roles: r.user.roles, employeeId: r.user.employeeId })
  }, [])

  const value = useMemo<AuthState>(() => ({
    me, login, logout, can: (...roles) => !!me?.roles.some(r => roles.includes(r.role)),
  }), [me, login, logout])

  if (!ready) return null
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAuth() {
  const v = useContext(Ctx)
  if (!v) throw new Error('useAuth outside AuthProvider')
  return v
}
