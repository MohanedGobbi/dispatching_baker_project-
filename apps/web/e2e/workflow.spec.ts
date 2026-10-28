import { expect, test } from '@playwright/test'
import { foldGuides, openApp } from './helpers'

test('the solo manager sees no leave, tasks, work orders, users or portal', async ({ page }) => {
  await openApp(page)
  for (const name of ['Leave', 'Tasks', 'Work orders', 'Users']) await expect(page.locator('.side-nav').getByRole('link', { name: new RegExp(`^${name}`) })).toHaveCount(0)
  await expect(page.getByRole('link', { name: /My portal/ })).toHaveCount(0)
})
