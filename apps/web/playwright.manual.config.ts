import { defineConfig, devices } from '@playwright/test'

// Regenerates the screenshots of the user manual (docs/manual). Needs the API and the web app running on a freshly
// seeded database with the demo story (npm run seed && npm run demo in apps/api).
// Set PW_CHANNEL=chrome to use an installed Chrome instead of Playwright's own browser.
const channel = process.env.PW_CHANNEL
export default defineConfig({
  testDir: './e2e-manual',
  workers: 1,
  timeout: 300_000,
  reporter: [['list']],
  use: { actionTimeout: 8000, baseURL: process.env.E2E_URL ?? 'http://localhost:5173', reducedMotion: 'reduce' },
  projects: [{ name: 'manual', use: { ...devices['Desktop Chrome'], ...(channel ? { channel } : {}), viewport: { width: 1366, height: 860 } } }],
})
