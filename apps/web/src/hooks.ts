import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError, subscribeChanges } from './api'

export const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e))

/** Load a path and keep it in state. Pass null to skip. `reload` fetches again without clearing what is shown. */
export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(!!path)
  const latest = useRef(0)

  const reload = useCallback(async () => {
    if (!path) { setData(null); setLoading(false); return }
    const n = ++latest.current
    try {
      const r = await api<T>(path)
      if (n === latest.current) { setData(r); setError('') }
    } catch (e) {
      if (n === latest.current) setError(errMsg(e))
    } finally {
      if (n === latest.current) setLoading(false)
    }
  }, [path])

  useEffect(() => { setLoading(!!path); void reload() }, [path, reload])
  return { data, error, loading, reload }
}

/** Refresh a screen whenever anyone changes something (the board's live-update stream, plan 29 "Realtime"). */
export function useLive(reload: () => void) {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const stop = subscribeChanges(() => { clearTimeout(timer); timer = setTimeout(reload, 300) })
    return () => { stop(); clearTimeout(timer) }
  }, [reload])
}

const parse = () => {
  const h = window.location.hash.replace(/^#\/?/, '')
  const [path, query = ''] = h.split('?')
  return { parts: path.split('/').filter(Boolean), query: new URLSearchParams(query) }
}

export function useRoute() {
  const [route, setRoute] = useState(parse)
  useEffect(() => {
    const on = () => setRoute(parse())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return route
}

export const go = (path: string) => { window.location.hash = `#/${path}` }

export function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = useState(value)
  useEffect(() => { const h = setTimeout(() => setV(value), ms); return () => clearTimeout(h) }, [value, ms])
  return v
}

/** Whether plans go through review and approval (setting workflow.requireApproval). Off by default: the manager publishes directly. */
export function useRequireApproval() {
  const s = useApi<Record<string, unknown>>('/settings')
  return s.data?.['workflow.requireApproval'] === true
}
