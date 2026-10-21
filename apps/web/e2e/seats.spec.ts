import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { foldGuides, signInManager } from './helpers'

// Replace or unassign the person on a seat, from the board, the unit panel, the unit page and the person panel.

async function openActions(page: Page, n = 0) {
  const btn = page.locator('.seat-act').nth(n)
  const label = await btn.getAttribute('aria-label')
  await btn.click()
  const name = (label ?? '').split(': ').pop() ?? ''
  await expect(page.getByRole('dialog', { name: new RegExp(`Replace or unassign: ${name}`) })).toBeVisible()
  return name
}

test('replace someone on a board seat with a ranked candidate', async ({ page }) => {
  await signInManager(page)
  await foldGuides(page)
  await page.goto('/#/board')
  const name = await openActions(page)
  const from = page.getByLabel('From')
  await expect(from).toHaveValue(new Date().toISOString().slice(0, 10))
  await page.getByLabel(/Reason \(optional/).fill('e2e: sent home')
  await page.getByRole('button', { name: /Replace…/ }).click()
  const picker = page.getByRole('dialog', { name: new RegExp(`Who replaces ${name}`) })
  await expect(picker).toBeVisible()
  await expect(picker.getByText(/Checking the rules/)).toHaveCount(0, { timeout: 15_000 })
  if (await picker.getByRole('button', { name: 'Choose', exact: true }).count() === 0) await picker.getByRole('tab', { name: /Everyone free/ }).click()
  await picker.getByRole('button', { name: 'Choose', exact: true }).first().click()
  const confirm = page.getByRole('dialog', { name: 'Replace on this seat?' })
  await expect(confirm.getByText(/What would happen/)).toBeVisible({ timeout: 15_000 })
  await expect(confirm.getByLabel(/Reason \(optional/)).toHaveValue('e2e: sent home')
  const override = confirm.getByLabel('Reason to override the rules')
  if (await override.count()) await override.fill('e2e override')
  await confirm.getByRole('button', { name: /^Replace/ }).click()
  await expect(page.getByText(new RegExp(`replaces ${name}`))).toBeVisible()
})

test('unassign someone from a seat, with an optional reason', async ({ page }) => {
  await signInManager(page)
  await foldGuides(page)
  await page.goto('/#/board')
  // Clicking the person's chip (not the name, which opens the profile) opens the same dialog.
  const chip = page.locator('.seat2 .chip.actable').nth(1)
  const name = (await chip.locator('button.name').textContent()) ?? ''
  await chip.locator('.avatar').click()
  await expect(page.getByRole('dialog', { name: `Replace or unassign: ${name}` })).toBeVisible()
  await page.getByLabel(/Reason \(optional/).fill('e2e: needed elsewhere')
  await page.getByRole('dialog').getByRole('button', { name: 'Unassign', exact: true }).click()
  await expect(page.getByText(new RegExp(`${name} is off`))).toBeVisible()
})

test('the same actions are on the unit panel, the unit page and the person panel', async ({ page }) => {
  await signInManager(page)
  await foldGuides(page)
  await page.goto('/#/board')
  await page.locator('.ucard-head.clickable').first().click()
  await expect(page.locator('.pp-body .seat-act').first()).toBeVisible()
  await page.keyboard.press('Escape')

  await page.goto('/#/units')
  const href = await page.locator('a[href*="#/units/"]').first().getAttribute('href')
  await page.goto(href!)
  await expect(page.locator('.unit-page .seat-act').first()).toBeVisible()
  await page.locator('.unit-page .seat-act').first().click()
  await expect(page.getByRole('dialog', { name: /Replace or unassign/ })).toBeVisible()
  await page.keyboard.press('Escape')

  await page.locator('.unit-page table a, .unit-page table button').filter({ hasText: /\w+ \w+/ }).first().click()
  await expect(page.locator('.pp-body').getByText('Seats now and coming up')).toBeVisible()
  await expect(page.locator('.pp-body .seat-act').first()).toBeVisible()
})
