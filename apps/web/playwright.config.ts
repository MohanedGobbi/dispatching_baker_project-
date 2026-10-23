import { defineConfig, devices } from '@playwright/test'

// End-to-end tests of the main flows (plan E28). They need the built app (npm run build, then npm start) on a
// throwaway DATA_DIR seeded with the demo story (npm run seed && npm run demo in apps/api), never the real data:
// they change data. E2E_URL=http://localhost:5173 runs them against the Vite dev server instead.
// Set PW_CHANNEL=msedge (or chrome) to use an installed browser instead of Playwright's own.
const channel = process.env.PW_CHANNEL
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: [['list']],
  use: { baseURL: process.env.E2E_URL ?? 'http://127.0.0.1:3000', reducedMotion: 'reduce', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], ...(channel ? { channel } : {}), viewport: { width: 1366, height: 900 } } }],
})
