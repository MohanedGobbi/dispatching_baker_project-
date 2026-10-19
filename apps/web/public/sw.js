// CrewBoard service worker: the app shell loads offline, and the portal shows the last schedule it fetched
// when the phone has no signal (plan 18 "works offline for viewing", 27.6). Writes are never cached or queued.
const SHELL = 'crewboard-shell-v1'
const API = 'crewboard-api'

// Only read endpoints that describe "me" are kept for offline viewing.
const READABLE = [/^\/api\/portal\//, /^\/api\/calendar\/employees\//, /^\/api\/notifications/, /^\/api\/leaves/, /^\/api\/swaps/, /^\/api\/assignments/, /^\/api\/work-orders/, /^\/api\/catalogs\/leave-types/, /^\/api\/auth\/me/]

self.addEventListener('install', e => { e.waitUntil(caches.open(SHELL).then(c => c.addAll(['/', '/icon.svg', '/manifest.webmanifest'])).then(() => self.skipWaiting())) })
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== SHELL && k !== API).map(k => caches.delete(k)))).then(() => self.clients.claim()))
})

// Signing out wipes what was saved, so the next person on a shared phone never sees someone else's schedule.
self.addEventListener('message', e => { if (e.data === 'clear') e.waitUntil(caches.delete(API)) })

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName)
  try {
    const res = await fetch(req)
    if (res.ok) cache.put(req, res.clone())
    return res
  } catch (err) {
    const hit = await cache.match(req)
    if (hit) return hit
    throw err
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(SHELL)
  const hit = await cache.match(req)
  if (hit) return hit
  const res = await fetch(req)
  if (res.ok) cache.put(req, res.clone())
  return res
}

self.addEventListener('fetch', e => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname === '/api/board/events') return // the live stream is never cached
  if (url.pathname.startsWith('/api/')) {
    if (READABLE.some(r => r.test(url.pathname))) e.respondWith(networkFirst(req, API))
    return
  }
  if (req.mode === 'navigate') { e.respondWith(networkFirst(req, SHELL).catch(() => caches.match('/'))); return }
  if (url.pathname.startsWith('/assets/') || url.pathname === '/icon.svg') e.respondWith(cacheFirst(req))
})
