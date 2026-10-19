import { defineConfig, devices } from '@playwright/test'

// End-to-end tests of the main flows (plan E28). They need the API and the web app running on a seeded database
// with the demo story: npm run seed && npm run demo (apps/api), npm run start:dev (apps/api), npm run dev (apps/web).
// They change data, like the API smoke suites: reseed afterwards.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: [['list']],
  use: { baseURL: process.env.E2E_URL ?? 'http://localhost:5173', reducedMotion: 'reduce', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 900 } } }],
})
