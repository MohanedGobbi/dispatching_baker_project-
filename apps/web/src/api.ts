const TOKEN_KEY = 'crewboard.token'

export class ApiError extends Error {
  status: number
  body: unknown
  constructor(status: number, message: string, body: unknown) {
    super(message)
    this.status = status
    this.body = body
  }
}

export const getToken = () => {
  try { return localStorage.getItem(TOKEN_KEY) } catch { return null }
}
export const setToken = (t: string | null) => {
  try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY) } catch { /* private mode */ }
}

type Listener = () => void
const onUnauthorized = new Set<Listener>()
export const whenUnauthorized = (fn: Listener) => { onUnauthorized.add(fn); return () => { onUnauthorized.delete(fn) } }

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = getToken()
  const res = await fetch(`/api${path}`, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  const text = await res.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  if (res.status === 401 && path !== '/auth/login' && path !== '/auth/auto') onUnauthorized.forEach(fn => fn())
  if (!res.ok) {
    const msg = (json as { message?: string } | null)?.message
    throw new ApiError(res.status, typeof msg === 'string' ? msg : res.statusText, json)
  }
  return json as T
}

/**
 * Live updates: the API pushes "something changed" over server-sent events. EventSource cannot send an
 * Authorization header, so this reads the stream with fetch and reconnects with a growing pause.
 *
 * All screens share ONE stream. Browsers allow only about six connections per site, so a connection per component
 * would starve ordinary requests on a busy screen.
 */
const listeners = new Set<() => void>()
let stopStream: (() => void) | null = null

function openStream() {
  let stopped = false
  let ctl: AbortController | null = null
  let delay = 1000
  const run = async () => {
    while (!stopped) {
      ctl = new AbortController()
      try {
        const res = await fetch('/api/board/events', { headers: { authorization: `Bearer ${getToken() ?? ''}` }, signal: ctl.signal })
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`)
        delay = 1000
        const reader = res.body.getReader()
        const dec = new TextDecoder()
        let buf = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          const parts = buf.split('\n\n')
          buf = parts.pop() ?? ''
          if (parts.some(p => p.includes('"type":"changed"'))) listeners.forEach(fn => fn())
        }
      } catch { /* dropped or aborted: retry below */ }
      if (stopped) return
      await new Promise(r => setTimeout(r, delay))
      delay = Math.min(delay * 2, 15000)
    }
  }
  void run()
  return () => { stopped = true; ctl?.abort() }
}

export function subscribeChanges(onChange: () => void): () => void {
  listeners.add(onChange)
  if (listeners.size === 1) stopStream = openStream()
  return () => {
    listeners.delete(onChange)
    // Keep the stream for a moment: moving between screens unsubscribes and resubscribes right away.
    setTimeout(() => { if (listeners.size === 0) { stopStream?.(); stopStream = null } }, 1500)
  }
}

/** Download a file from the API (the Authorization header rules out a plain link). */
export async function download(path: string, fallbackName: string) {
  const token = getToken()
  const res = await fetch(`/api${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} })
  if (!res.ok) {
    let msg = res.statusText
    try { msg = ((await res.json()) as { message?: string }).message ?? msg } catch { /* not json */ }
    throw new ApiError(res.status, msg, null)
  }
  const name = res.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1] ?? fallbackName
  const url = URL.createObjectURL(await res.blob())
  const a = Object.assign(document.createElement('a'), { href: url, download: name })
  document.body.append(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
