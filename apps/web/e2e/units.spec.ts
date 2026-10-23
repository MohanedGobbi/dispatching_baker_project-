import { expect, test } from '@playwright/test'
import { foldGuides, openApp, unique } from './helpers'

test.beforeEach(async ({ page }) => { await openApp(page); await foldGuides(page) })

test('the fleet: tiles filter, add, edit, move, retire and delete a unit', async ({ page }) => {
  await page.goto('/#/units')
  await page.locator('.kpi2', { hasText: 'On a job' }).click()
  for (const cell of await page.locator('.units-table tbody tr td:nth-child(5)').allInnerTexts()) expect(cell).toContain('On a job')
  await page.locator('.kpi2', { hasText: 'All units' }).click()

  const code = unique('HL-E')
  await page.getByRole('button', { name: 'Add a unit' }).first().click()
  const d = page.getByRole('dialog')
  await d.getByLabel('Unit code *').fill(code)
  await d.getByLabel('Type *').selectOption({ index: 1 })
  await d.getByLabel('Home base *').selectOption({ index: 1 })
  await d.getByRole('button', { name: 'Add a unit' }).click()
  await page.getByPlaceholder('Code, plate, model or note').fill(code)
  const row = page.locator('.units-table tbody tr', { hasText: code })
  await expect(row).toBeVisible()

  await page.getByRole('button', { name: `Edit ${code}` }).click()
  await page.getByRole('dialog').getByLabel('Model').fill('Kenworth C500')
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click()
  await expect(row).toContainText('Kenworth C500')

  await page.getByRole('button', { name: `Move to another base ${code}` }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Move' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)

  await page.getByRole('button', { name: `Out of service ${code}` }).click()
  await expect(row).toContainText('Out of service')
  await page.getByRole('button', { name: `Back in service ${code}` }).click()
  await expect(row).toContainText('Available')

  await page.getByRole('button', { name: `Delete ${code}` }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click()
  await expect(page.getByText('No unit matches.')).toBeVisible()
})

test('a unit with history cannot be deleted and is offered out of service instead', async ({ page }) => {
  await page.goto('/#/units')
  await page.locator('.kpi2', { hasText: 'On a job' }).click()
  await page.locator('.units-table tbody tr').first().getByRole('button', { name: /^Delete / }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click()
  await expect(page.getByRole('dialog')).toContainText('has history')
})

test('unit page: service plan, paper with a file, side panel link', async ({ page }) => {
  await page.goto('/#/units')
  await page.locator('.units-table tbody tr').first().locator('a.name-link').click()
  await expect(page.getByRole('heading', { name: 'The last 12 months' })).toBeVisible()

  const service = unique('Service ')
  await page.getByRole('button', { name: 'Add a service' }).click()
  await page.getByRole('dialog').getByLabel('Service *').fill(service)
  await page.getByRole('dialog').getByLabel('Every (days) *').fill('60')
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click()
  const plan = page.locator('tr', { hasText: service })
  await plan.getByRole('button', { name: 'Done' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click()
  await expect(plan).toContainText('Up to date')
  await page.getByRole('button', { name: `Delete ${service}` }).click()
  await expect(plan).toHaveCount(0)

  const paper = unique('Inspection ')
  await page.locator('.panel', { hasText: 'Papers' }).getByRole('button', { name: 'Add' }).click()
  const d = page.getByRole('dialog')
  await d.getByLabel('Kind').selectOption('inspection')
  await d.getByLabel('Title').fill(paper)
  await d.getByLabel('File (optional: PDF or photo)').setInputFiles({ name: 'inspection.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%e2e\n') })
  await d.getByRole('button', { name: 'Save' }).click()
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: `Download ${paper}` }).click()
  expect((await download).suggestedFilename()).toMatch(/\.pdf$/)

  await page.goto('/#/replacements')
  await page.locator('.name-link.unit').first().click()
  await page.getByRole('link', { name: 'Full page' }).click()
  await expect(page.getByRole('heading', { name: 'The last 12 months' })).toBeVisible()
  await expect(page.locator('.pp')).toHaveCount(0)
})
