// Light or dark: the person's choice is remembered on this device; until they choose, the system setting decides.
const KEY = 'crewboard.theme'
type Theme = 'light' | 'dark'

const saved = (): Theme | null => {
  try { const v = localStorage.getItem(KEY); return v === 'dark' || v === 'light' ? v : null } catch { return null }
}
const system = (): Theme => (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')

export const currentTheme = (): Theme => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light')

/** Apply at start-up, and follow the system while nothing is saved. */
export function initTheme() {
  document.documentElement.dataset.theme = saved() ?? system()
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
    if (!saved()) document.documentElement.dataset.theme = system()
  })
}

export function setTheme(t: Theme) {
  document.documentElement.dataset.theme = t
  try { localStorage.setItem(KEY, t) } catch { /* private mode: applies to this visit only */ }
}
