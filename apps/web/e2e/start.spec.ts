import { expect, test } from '@playwright/test'
import { openApp } from './helpers'

test('CrewBoard opens straight on the board, with no sign-in', async ({ page }) => {
  await openApp(page)
  await expect(page).toHaveTitle('CrewBoard')
  await expect(page.getByRole('heading', { name: 'Dispatch board' })).toBeVisible()
  await expect(page.getByLabel('Login')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Notifications' })).toHaveCount(0)
})

test('the author signs the app: sidebar and Settings > About', async ({ page }) => {
  await openApp(page)
  await expect(page.locator('.side-sign')).toHaveText('Made by Mohaned Gobbi')
  await page.goto('/#/settings')
  const about = page.locator('section.panel').filter({ has: page.getByRole('heading', { name: 'About' }) })
  await expect(about).toContainText(/CrewBoard \d+\.\d+\.\d+/)
  await expect(about).toContainText('Made by Mohaned Gobbi')
})

test('Settings offers a backup on demand', async ({ page }) => {
  await page.goto('/#/settings')
  await expect(page.getByRole('heading', { name: 'Backups' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Back up now' })).toBeVisible()
})
