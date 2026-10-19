import { useMemo } from 'react'
import type { UnitCardData } from './types'

export interface MapData {
  bases: { id: string; code: string; name: string; lat: number; lng: number; people: number; standby: number; onUnit: number; units: number }[]
  sites: { id: string; name: string; lat: number; lng: number; well: string | null; rig: string | null }[]
}

// Rough outline of Algeria (lng, lat) so the bases sit in a recognisable place; drawn from coordinates, no tiles needed.
const ALGERIA: [number, number][] = [
  [-1.8, 35.1], [0, 35.9], [2, 36.6], [3.2, 36.8], [5, 36.8], [6.5, 37.1], [8.6, 36.9], [8.4, 35.2], [8.2, 34.1], [7.5, 33.2],
  [9.5, 30.2], [9.9, 27.0], [11.5, 24.3], [12, 23.5], [5.8, 19.4], [4.2, 19.1], [3.2, 19.0], [1.2, 20.7], [-4.8, 25.0],
  [-8.67, 27.3], [-8.67, 28.7], [-3.6, 30.9], [-1.2, 32.1], [-1.7, 33.3],
]
const STATE_COLOR: Record<string, string> = { ok: 'var(--pal-green-600)', info: 'var(--pal-green-600)', warn: 'var(--pal-amber-600)', bad: 'var(--pal-red-600)' }

/**
 * Bases as rings (on a unit / standby / everyone else), active well sites as diamonds, and a dashed line from each
 * base to the sites its units are working at, coloured by the crew's state. Click a base to filter the board.
 */
export function FleetMap({ map, units, colorOf, selected, onBase }: {
  map: MapData; units: UnitCardData[]; colorOf: (code: string) => string; selected: string; onBase: (baseId: string) => void
}) {
  const W = 620, H = 330, P = 34
  const proj = useMemo(() => {
    const pts = [...map.bases, ...map.sites]
    const lats = pts.map(p => p.lat), lngs = pts.map(p => p.lng)
    const pad = 1.2
    const minLat = Math.min(...lats) - pad, maxLat = Math.max(...lats) + pad, minLng = Math.min(...lngs) - pad, maxLng = Math.max(...lngs) + pad
    const k = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180)
    const sx = (W - 2 * P) / ((maxLng - minLng) * k), sy = (H - 2 * P) / (maxLat - minLat)
    const s = Math.min(sx, sy)
    const ox = (W - (maxLng - minLng) * k * s) / 2, oy = (H - (maxLat - minLat) * s) / 2
    return (lng: number, lat: number): [number, number] => [ox + (lng - minLng) * k * s, oy + (maxLat - lat) * s]
  }, [map])

  const siteByName = useMemo(() => new Map(map.sites.map(s => [s.name, s])), [map])
  const routes = units.filter(u => u.job && siteByName.has(u.job.site)).map(u => ({ u, base: map.bases.find(b => b.id === u.baseId), site: siteByName.get(u.job!.site)! }))
  const usedSites = new Map<string, { site: MapData['sites'][number]; units: UnitCardData[] }>()
  for (const r of routes) { const e = usedSites.get(r.site.id) ?? { site: r.site, units: [] }; e.units.push(r.u); usedSites.set(r.site.id, e) }
  const outline = ALGERIA.map(([lng, lat]) => proj(lng, lat).map(n => n.toFixed(1)).join(',')).join(' ')

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="fleet-map" role="group" aria-label="Map of bases, well sites and deployed units">
      <defs><clipPath id="mapclip"><rect width={W} height={H} rx="14" /></clipPath></defs>
      <g clipPath="url(#mapclip)">
        <polygon className="country" points={outline} />
        {routes.map(({ u, base, site }) => {
          if (!base) return null
          const [x1, y1] = proj(base.lng, base.lat), [x2, y2] = proj(site.lng, site.lat)
          return <line style={{ stroke: STATE_COLOR[u.state] ?? 'var(--pal-slate-500)' }} key={u.id} className="route" x1={x1} y1={y1} x2={x2} y2={y2} />
        })}
        {[...usedSites.values()].map(({ site, units: us }) => {
          const [x, y] = proj(site.lng, site.lat)
          const worst = us.some(u => u.state === 'bad') ? 'bad' : us.some(u => u.state === 'warn') ? 'warn' : 'ok'
          return (
            <g key={site.id}>
              <rect style={{ fill: STATE_COLOR[worst] }} x={x - 6} y={y - 6} width="12" height="12" rx="2" transform={`rotate(45 ${x} ${y})`} stroke="#fff" strokeWidth="2">
                <title>{`${site.name}${site.well ? ' · ' + site.well : ''}: ${us.map(u => u.code).join(', ')}`}</title>
              </rect>
              <text className="site-label" x={x + 10} y={y + 4}>{us.map(u => u.code.replace('HL-', '')).join(' ')}</text>
            </g>
          )
        })}
        {map.bases.map(b => {
          const [x, y] = proj(b.lng, b.lat)
          const other = Math.max(0, b.people - b.onUnit - b.standby)
          const total = Math.max(1, b.people)
          const R = 22, c = 2 * Math.PI * R
          const segs = [[b.onUnit, 'var(--pal-blue-600)'], [b.standby, 'var(--pal-teal-600)'], [other, 'var(--pal-slate-400)']] as const
          let acc = 0
          return (
            <g key={b.id} className={`base-g${selected === b.id ? ' on' : ''}`} tabIndex={0} role="button" aria-label={`${b.code}: ${b.onUnit} on units, ${b.standby} on standby, ${b.people} people`}
              onClick={() => onBase(selected === b.id ? '' : b.id)} onKeyDown={e => { if (e.key === 'Enter') onBase(selected === b.id ? '' : b.id) }}>
              <circle className="halo" cx={x} cy={y} r={R + 6} fill="rgba(255,255,255,.75)" />
              {segs.map(([v, col], i) => {
                const len = (v / total) * c
                const el = <circle style={{ stroke: col }} key={i} cx={x} cy={y} r={R} fill="none" strokeWidth="7" strokeDasharray={`${len} ${c}`} strokeDashoffset={-acc} transform={`rotate(-90 ${x} ${y})`} />
                acc += len
                return el
              })}
              <circle style={{ fill: colorOf(b.code) }} cx={x} cy={y} r={R - 6} />
              <text x={x} y={y + 4} textAnchor="middle" fontSize="13" fontWeight="800" fill="#fff">{b.code}</text>
              <text x={x} y={y + R + 18} textAnchor="middle" className="site-label">{b.onUnit} on units · {b.standby} standby</text>
              <title>{`${b.name}: ${b.people} people, ${b.onUnit} on units, ${b.standby} on standby, ${b.units} units`}</title>
            </g>
          )
        })}
      </g>
    </svg>
  )
}
