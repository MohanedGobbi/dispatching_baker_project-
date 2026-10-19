import { expect } from '@playwright/test'
import type { Page } from '@playwright/test'

export const PASSWORD = 'demo1234'

/** Sign in from the sign-in page; the manager by default. */
export async function signIn(page: Page, login = 'admin', password = PASSWORD) {
  await page.goto('/')
  await page.getByLabel('Login').fill(login)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: /sign in/i }).click()
}

export async function signInManager(page: Page) {
  await signIn(page)
  await expect(page.locator('.side-brand')).toBeVisible()
}

/** Fold every page guide so screens look the same on every run. */
export async function foldGuides(page: Page) {
  await page.evaluate(() => {
    for (const id of ['board', 'units', 'tasks', 'replacements', 'crew-changes', 'plans', 'timeline', 'leave', 'extensions', 'work-orders', 'analytics', 'users', 'settings', 'data', 'audit']) localStorage.setItem(`crewboard.guide.${id}`, 'closed')
  })
}

export const unique = (prefix: string) => `${prefix}${Date.now() % 100000}`
