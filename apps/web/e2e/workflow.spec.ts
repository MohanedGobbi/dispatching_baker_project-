import { expect, test } from '@playwright/test'
import { foldGuides, openApp } from './helpers'

test('the manager publishes a draft plan directly, without a review step', async ({ page }) => {
  await openApp(page)
  await page.goto('/#/plans')
  await page.getByRole('button', { name: 'New plan' }).click()
  await page.getByRole('button', { name: 'Suggest a plan' }).click()
  await expect(page.getByRole('button', { name: 'Publish' })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('button', { name: 'Send for review' })).toHaveCount(0)
})

test('putting someone on an empty seat shows the problem as fixed', async ({ page }) => {
  await openApp(page)
  await foldGuides(page)
  await page.goto('/#/replacements')
  const cards = page.locator('.tcard')
  await expect(cards.first()).toBeVisible()
  const open = await page.locator('.rc-list .tcard').filter({ hasNot: page.getByText('fixed', { exact: true }) }).count()
  expect(open).toBeGreaterThan(0)
  // Find an open task somebody can take.
  let placed = false
  for (let i = 0; i < open && !placed; i++) {
    await cards.nth(i).click()
    const put = page.getByRole('button', { name: 'Put on this seat' }).first()
    const ready = await put.waitFor({ state: 'visible', timeout: 4000 }).then(() => true, () => false)
    if (ready) { await put.click(); placed = true }
  }
  expect(placed).toBe(true)
  await expect(page.getByText(/^Fixed: /).first()).toBeVisible()
  await expect(page.locator('.rc-fixed')).toBeVisible()
  await expect(page.locator('.rc-body').getByText('Fixed this week').first()).toBeVisible()
})

test('the solo manager sees no leave, tasks, work orders, users or portal', async ({ page }) => {
  await openApp(page)
  for (const name of ['Leave', 'Tasks', 'Work orders', 'Users']) await expect(page.locator('.side-nav').getByRole('link', { name: new RegExp(`^${name}`) })).toHaveCount(0)
  await expect(page.getByRole('link', { name: /My portal/ })).toHaveCount(0)
})
