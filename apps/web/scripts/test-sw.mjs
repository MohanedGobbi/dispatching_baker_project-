// Exercises public/sw.js with a mock cache and network: node scripts/test-sw.mjs
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const handlers = {}
const stores = new Map()
const cacheApi = {
  async open(name) {
    if (!stores.has(name)) stores.set(name, new Map())
    const m = stores.get(name)
    return {
      async match(req) { const hit = m.get(typeof req === 'string' ? new URL(req, 'http://app').href : req.url); return hit?.clone() },
      async put(req, res) { m.set(req.url, res) },
      async addAll(urls) { for (const u of urls) m.set(new URL(u, 'http://app').href, new Response('shell')) },
      async keys() { return [...m.keys()].map(u => new Request(u)) },
    }
  },
  async match(req) { for (const m of stores.values()) { const hit = m.get(typeof req === 'string' ? new URL(req, 'http://app').href : req.url); if (hit) return hit.clone() } },
  async delete(name) { return stores.delete(name) },
  async keys() { return [...stores.keys()] },
}
let online = true
const net = async req => { if (!online) throw new TypeError('offline'); return new Response(JSON.stringify({ url: req.url }), { status: 200 }) }
const sandbox = {
  self: { addEventListener: (t, f) => { handlers[t] = f }, location: { origin: 'http://app' }, skipWaiting: async () => {}, clients: { claim: async () => {} } },
  caches: cacheApi, fetch: net, URL, Response, Request, Promise, console,
}
vm.runInNewContext(readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), sandbox)

let failed = 0
const check = (name, ok, extra) => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + JSON.stringify(extra)}`) }
const fire = async (path, init = {}, mode) => {
  const req = new Request('http://app' + path, init)
  Object.defineProperty(req, 'mode', { value: mode ?? 'cors' })
  const ev = { request: req, responded: null, respondWith(p) { this.responded = p } }
  handlers.fetch(ev)
  return ev.responded ? ev.responded.then(r => r, e => ({ error: String(e) })) : null
}

await handlers.install({ waitUntil: p => p })
check('install pre-caches the app shell', (await (await cacheApi.open('crewboard-shell-v1')).keys()).length === 3)

const first = await fire('/api/portal/today')
check('online: my schedule is fetched and returned', first && (await first.json()).url.endsWith('/api/portal/today'))
online = false
const offline = await fire('/api/portal/today')
check('offline: the last saved schedule is served', offline && offline.status === 200 && (await offline.json()).url.endsWith('/api/portal/today'), offline)
check('offline: something never fetched before fails honestly (no fake data)', (await fire('/api/portal/stats'))?.error !== undefined)
check('personal calendar is kept for offline too', await (async () => { online = true; await fire('/api/calendar/employees/abc?month=2026-10'); online = false; const r = await fire('/api/calendar/employees/abc?month=2026-10'); return r && r.status === 200 })())
check('notifications are kept for offline viewing', await (async () => { online = true; await fire('/api/notifications?limit=100'); online = false; const r = await fire('/api/notifications?limit=100'); return r && r.status === 200 })())
online = true
check('writes are never intercepted (POST)', (await fire('/api/leaves', { method: 'POST', body: '{}' })) === null)
check('the live event stream is never cached', (await fire('/api/board/events')) === null)
check('other staff data is not cached (employee list)', (await fire('/api/employees')) === null)
check('a medical file download is never cached', (await fire('/api/files/abc')) === null)
check('other origins are ignored', await (async () => { const req = new Request('http://other/api/portal/today'); const ev = { request: req, responded: null, respondWith(p) { this.responded = p } }; handlers.fetch(ev); return ev.responded === null })())

// the app shell: navigation falls back to the cached page when offline
await fire('/', {}, 'navigate')
online = false
const nav = await fire('/', {}, 'navigate')
check('offline: opening the app shows the cached shell', nav && (await nav.text()).length > 0 && !nav.error, nav)
online = true

// sign-out wipes saved data
check('before sign-out the saved data exists', stores.get('crewboard-api')?.size >= 3)
await handlers.message({ data: 'clear', waitUntil: p => p })
check('sign-out ("clear") removes every saved API response', !stores.has('crewboard-api'))
online = false
check('after sign-out nothing of the previous person is available offline', (await fire('/api/portal/today'))?.error !== undefined)

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed')
process.exit(failed ? 1 : 0)
