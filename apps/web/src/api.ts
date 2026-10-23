export class ApiError extends Error {
  status: number
  body: unknown
  constructor(status: number, message: string, body: unknown) {
    super(message)
    this.status = status
    this.body = body
  }
}

/**
 * Screens refresh when something changes. The manager is the only user, so every change goes through this page:
 * a successful request that is not a read tells the screens that subscribed.
 */
const listeners = new Set<() => void>()
export function subscribeChanges(onChange: () => void): () => void {
  listeners.add(onChange)
  return () => { listeners.delete(onChange) }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? 'GET'
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  const text = await res.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  if (!res.ok) {
    const msg = (json as { message?: string } | null)?.message
    throw new ApiError(res.status, typeof msg === 'string' ? msg : res.statusText, json)
  }
  if (method !== 'GET') listeners.forEach(fn => fn())
  return json as T
}

/** Download a file from the API (an Excel export, an uploaded document). */
export async function download(path: string, fallbackName: string) {
  const res = await fetch(`/api${path}`)
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
