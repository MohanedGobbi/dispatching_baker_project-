// Records the short demo video (docs/media/crewboard-demo.webm) by driving the app on the demo data, with captions and a
// visible cursor. Not part of the screenshots run: it only runs when DEMO_VIDEO=1.
//   DEMO_VIDEO=1 npx playwright test -c playwright.manual.config.ts demo-video
// Needs the built app on a throwaway DATA_DIR seeded with `npm run seed && npm run demo` (see docs/manual/README.md).
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'

test.skip(!process.env.DEMO_VIDEO, 'set DEMO_VIDEO=1 to record the demo video')
test.use({ viewport: { width: 1280, height: 720 }, video: { mode: 'on', size: { width: 1280, height: 720 } }, actionTimeout: 15_000 })
test.setTimeout(240_000)

const OUT = process.env.DEMO_VIDEO_OUT ?? '../../docs/media/crewboard-demo.webm'

/** A bar at the bottom of the screen that says what is being shown. */
const say = (page: Page, text: string) => page.evaluate(t => {
  let el = document.getElementById('demo-caption')
  if (!el) {
    el = document.createElement('div')
    el.id = 'demo-caption'
    el.style.cssText = 'position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:2147483647;max-width:80%;padding:12px 22px;border-radius:12px;background:rgba(15,23,42,.92);color:#fff;font:600 20px/1.3 Inter,system-ui,sans-serif;text-align:center;box-shadow:0 8px 30px rgba(0,0,0,.35);pointer-events:none'
    document.body.append(el)
  }
  el.textContent = t
}, text)

/** A dot that follows the mouse, so the viewer sees where the clicks go. */
const cursorScript = () => {
  addEventListener('DOMContentLoaded', () => {
    const dot = document.createElement('div')
    dot.style.cssText = 'position:fixed;left:-50px;top:-50px;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:rgba(239,68,68,.55);border:2px solid #fff;box-shadow:0 0 0 2px rgba(239,68,68,.6);z-index:2147483647;pointer-events:none;transition:transform .12s'
    document.body.append(dot)
    addEventListener('mousemove', e => { dot.style.left = e.clientX + 'px'; dot.style.top = e.clientY + 'px' }, true)
    addEventListener('mousedown', () => { dot.style.transform = 'scale(.7)' }, true)
    addEventListener('mouseup', () => { dot.style.transform = 'scale(1)' }, true)
  })
}

const pause = (page: Page, ms: number) => page.waitForTimeout(ms)
/** Move the mouse to the element in a smooth line, then click it. */
async function tap(page: Page, target: Locator) {
  await target.scrollIntoViewIfNeeded()
  const box = await target.boundingBox()
  if (!box) throw new Error('not visible')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 22 })
  await pause(page, 250)
  await target.click()
}
const nav = (page: Page, screen: string) => tap(page, page.locator(`.side-nav a[href="#/${screen}"]`))

test('the demo video', async ({ page }) => {
  await page.addInitScript(cursorScript)
  await page.goto('/')
  await page.evaluate(() => {
    localStorage.setItem('crewboard.theme', 'light')
    for (const id of ['board', 'units', 'crew-changes', 'timeline', 'extensions', 'analytics', 'settings', 'data', 'audit']) localStorage.setItem(`crewboard.guide.${id}`, 'closed')
  })
  await page.reload()
  await expect(page.locator('.side-brand')).toBeVisible()
  await pause(page, 800)

  // 1. the board
  await say(page, 'CrewBoard: crew rotation and dispatch, for one manager, on one PC, offline')
  await pause(page, 4000)
  await say(page, 'The board: every unit with its crew, every base, and who is free today')
  await page.mouse.move(700, 400, { steps: 10 })
  await page.mouse.wheel(0, 520); await pause(page, 1800)
  await page.mouse.wheel(0, 520); await pause(page, 1800)
  await page.mouse.wheel(0, -1040); await pause(page, 1200)
  await say(page, 'A red card means a rule is broken or a seat is empty')
  await pause(page, 2600)

  // 2. a unit and its crew
  await say(page, 'Click a unit: its crew, jobs, maintenance and history')
  await tap(page, page.locator('.ucard-head.clickable').first())
  await expect(page.locator('.pp-body')).toBeVisible()
  await pause(page, 3500)
  await page.keyboard.press('Escape')
  await pause(page, 600)

  // 5. timeline and forecast
  await say(page, 'Timeline: everyone, day by day')
  await nav(page, 'timeline')
  await pause(page, 3500)
  await say(page, 'Analytics: a 90-day forecast shows shortages before they happen')
  await nav(page, 'analytics')
  await pause(page, 4500)

  // 6. data stays on this PC
  await say(page, 'Excel in and out; every change is audited')
  await nav(page, 'data')
  await pause(page, 2600)
  await nav(page, 'audit')
  await pause(page, 2600)
  await say(page, 'Daily backups on this PC, and a Back up now button')
  await nav(page, 'settings')
  await pause(page, 2000)
  await tap(page, page.getByRole('button', { name: 'Back up now' }))
  await pause(page, 2500)

  // 7. dark mode and the signature
  await say(page, 'Light or dark, your choice')
  await tap(page, page.getByRole('button', { name: 'Theme' }))
  await nav(page, 'board')
  await pause(page, 3000)
  await say(page, 'CrewBoard · made by Mohaned Gobbi')
  await pause(page, 4000)

  await page.close()
  await page.video()!.saveAs(OUT)
})
