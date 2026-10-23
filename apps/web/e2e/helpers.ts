import { expect } from '@playwright/test'
import type { Page } from '@playwright/test'

/** Open CrewBoard: there is no sign-in, it starts on the board. */
export async function openApp(page: Page) {
  await page.goto('/')
  await expect(page.locator('.side-brand')).toBeVisible()
}

/** Fold every page guide so screens look the same on every run. */
export async function foldGuides(page: Page) {
  await page.evaluate(() => {
    for (const id of ['board', 'units', 'replacements', 'crew-changes', 'plans', 'timeline', 'extensions', 'analytics', 'settings', 'data', 'audit']) localStorage.setItem(`crewboard.guide.${id}`, 'closed')
  })
}

export const unique = (prefix: string) => `${prefix}${Date.now() % 100000}`
