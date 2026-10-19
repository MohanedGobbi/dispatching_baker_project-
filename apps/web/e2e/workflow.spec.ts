import { expect, test } from '@playwright/test'
import { signIn, signInManager, unique } from './helpers'

test('the manager publishes a draft plan directly, without a review step', async ({ page }) => {
  await signInManager(page)
  await page.goto('/#/plans')
  await page.getByRole('button', { name: 'New plan' }).click()
  await page.getByRole('button', { name: 'Suggest a plan' }).click()
  await expect(page.getByRole('button', { name: 'Publish' })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('button', { name: 'Send for review' })).toHaveCount(0)
})

test('a task goes from the manager to the employee and back', async ({ page, browser }) => {
  await signInManager(page)
  const title = unique('Sign the PPE register ')
  await page.goto('/#/tasks')
  await page.getByRole('button', { name: 'New task' }).click()
  const d = page.getByRole('dialog')
  await d.getByLabel('Who *').fill('e1001')
  await d.locator('.cand-list li').first().getByRole('button', { name: 'Add' }).click()
  await d.getByLabel('What to do *').fill(title)
  await d.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('tr', { hasText: title })).toBeVisible()

  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage()
  await signIn(phone, 'e1001')
  await phone.getByRole('link', { name: /To do/ }).click()
  await phone.getByRole('button', { name: `Done: ${title}` }).click()
  await phone.getByRole('dialog').getByLabel('A note for the manager (optional)').fill('Signed at the gate')
  await phone.getByRole('dialog').getByRole('button', { name: 'Done' }).click()
  await expect(phone.locator('.todo-list li.done', { hasText: title })).toBeVisible()

  await page.getByLabel('Status').selectOption('DONE')
  await expect(page.locator('tr', { hasText: title })).toContainText('Signed at the gate')
})
