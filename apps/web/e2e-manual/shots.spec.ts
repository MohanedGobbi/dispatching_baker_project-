import { test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { openApp } from '../e2e/helpers'

const OUT = '../../docs/manual/img'
const ALL = ['board', 'units', 'replacements', 'crew-changes', 'timeline', 'extensions', 'analytics', 'settings', 'data', 'audit']
const GUIDE_IDS = [...ALL, 'changes', 'workorders']

async function snap(page: Page, name: string, fullPage = false) {
  await page.waitForTimeout(900)
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage })
}
async function step(name: string, fn: () => Promise<void>) {
  try { await fn() } catch (e) { console.log(`SKIPPED ${name}: ${String(e).split('\n')[0]}`) }
}
const open = async (page: Page, hash: string) => { await page.goto(`/#/${hash}`); await page.waitForTimeout(1400) }
/** Show page guides expanded (the first-visit look). */
const guidesOpen = (page: Page) => page.evaluate(ids => { for (const id of ids) localStorage.removeItem(`crewboard.guide.${id}`) }, GUIDE_IDS)
const foldAll = (page: Page) => page.evaluate(ids => { for (const id of ids) localStorage.setItem(`crewboard.guide.${id}`, 'closed') }, GUIDE_IDS)

test('staff screens', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.setItem('crewboard.theme', 'light'))
  await page.reload()
  await openApp(page)

  await guidesOpen(page)
  for (const s of ALL) { await open(page, s); await snap(page, `10-${s}`, s === 'board') }
  // the top of the board with its guide open, for the manual's tour of the screen
  await step('board-top', async () => {
    await open(page, 'board')
    await page.waitForTimeout(900)
    await page.screenshot({ path: `${OUT}/10-board-top.png`, fullPage: true, clip: { x: 0, y: 0, width: 1366, height: 1250 } })
  })

  await foldAll(page)
  // what the manager sees when CrewBoard opens: one window of the board (used at the top of the README)
  await step('board-hero', async () => {
    await open(page, 'board')
    await page.waitForTimeout(900)
    await page.screenshot({ path: `${OUT}/10-board-hero.png` })
  })
  // unit cards under their base banner (guide folded, so the units sit higher)
  await step('board-units', async () => {
    await open(page, 'board')
    await page.waitForTimeout(900)
    const y = Math.max(0, Math.round(await page.locator('.base-sec .base-banner').first().evaluate(el => el.getBoundingClientRect().top + window.scrollY)) - 10)
    await page.screenshot({ path: `${OUT}/10-board-units.png`, fullPage: true, clip: { x: 240, y, width: 1126, height: 520 } })
  })
  await step('board-assign', async () => {
    await open(page, 'board')
    await page.getByRole('button', { name: /Assign someone/ }).first().click()
    await snap(page, '11-board-assign')
    await page.keyboard.press('Escape')
  })
  await step('board-seat-actions', async () => {
    await open(page, 'board')
    await page.locator('.seat-act').first().click()
    await snap(page, '11-seat-actions')
    await page.getByRole('button', { name: /Replace…/ }).click()
    await page.waitForTimeout(1500)
    await snap(page, '11-seat-replace-picker')
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
  })
  await step('board-unit-panel', async () => {
    await open(page, 'board')
    await page.locator('.ucard-head.clickable').first().click()
    await snap(page, '11-board-unit-panel')
    await page.keyboard.press('Escape')
  })
  await step('board-new-job', async () => {
    await open(page, 'board')
    await page.getByRole('button', { name: /New job/ }).first().click()
    await snap(page, '12-new-job')
    await page.keyboard.press('Escape')
  })
  await step('add-unit', async () => {
    await open(page, 'units')
    await page.getByRole('button', { name: 'Add a unit' }).first().click()
    await snap(page, '12-add-unit')
    await page.keyboard.press('Escape')
  })
  await step('unit-profile-panel', async () => {
    await open(page, 'units')
    await page.locator('table button, table a').filter({ hasText: /^HL-\d+/ }).first().click()
    await snap(page, '13-unit-profile-panel')
    await page.keyboard.press('Escape')
  })
  await step('unit-page', async () => {
    await open(page, 'units')
    const href = await page.locator('a[href*="#/units/"]').first().getAttribute('href')
    if (href) { await page.goto(href); await page.waitForTimeout(1500); await snap(page, '13-unit-page', true) }
  })
  await step('replacement-detail', async () => {
    await open(page, 'replacements')
    await page.locator('.tcard').first().click()
    await snap(page, '14-replacement-detail', true)
  })
  await step('replacement-fixed', async () => {
    await open(page, 'replacements')
    const cards = page.locator('.tcard')
    const n = await cards.count()
    for (let i = 0; i < n; i++) {
      await cards.nth(i).click()
      const put = page.getByRole('button', { name: 'Put on this seat' }).first()
      if (await put.waitFor({ state: 'visible', timeout: 4000 }).then(() => true, () => false)) {
        await snap(page, '14-replacement-candidates', true)
        await put.click()
        await page.waitForTimeout(1500)
        await page.evaluate(() => window.scrollTo(0, 0))
        await snap(page, '14-replacement-fixed', true)
        return
      }
    }
  })
  await step('timeline-person', async () => {
    await open(page, 'timeline')
    await page.locator('button.tl-name').first().click()
    await snap(page, '15-timeline-person', true)
  })
  await step('person-panel', async () => {
    await open(page, 'timeline')
    await page.reload()
    await page.waitForTimeout(1200)
    await page.locator('button.tl-name').first().click()
    await page.getByRole('button', { name: /Full profile/ }).click()
    await snap(page, '15-person-profile-panel')
    await page.keyboard.press('Escape')
  })
  await step('tv', async () => {
    await open(page, 'board')
    await page.getByRole('button', { name: /TV/ }).first().click()
    await snap(page, '18-tv-mode')
    await page.keyboard.press('Escape')
  })
  await step('dark', async () => {
    await page.evaluate(() => localStorage.setItem('crewboard.theme', 'dark'))
    await page.reload()
    await open(page, 'board')
    await snap(page, '20-board-dark')
  })
})

