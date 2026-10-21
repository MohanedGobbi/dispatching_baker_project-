import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { foldGuides, signInManager } from './helpers'

// WCAG 2.1 AA checks with axe-core on every screen, in light and dark (plan E28/E30 accessibility audit).
const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8')
const SCREENS = ['board', 'units', 'replacements', 'crew-changes', 'plans', 'timeline', 'extensions', 'analytics', 'settings', 'data', 'audit', 'notifications']

async function violations(page: Page) {
  await page.addScriptTag({ content: AXE })
  return page.evaluate(async () => {
    const r = await (window as unknown as { axe: { run: (d: Document, o: object) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> } })
      .axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })
    return r.violations.map(v => `${v.id}: ${v.nodes.slice(0, 3).map(n => n.target.join(' ')).join(' | ')}`)
  })
}

for (const theme of ['light', 'dark'] as const) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme: theme })

    test('staff screens have no WCAG 2.1 AA violations', async ({ page }) => {
      await page.goto('/')
      await page.evaluate(t => localStorage.setItem('crewboard.theme', t), theme)
      await page.reload()
      expect(await violations(page), 'sign-in').toEqual([])
      await signInManager(page)
      await foldGuides(page)
      for (const s of SCREENS) {
        await page.goto(`/#/${s}`)
        await page.waitForTimeout(1500)
        expect(await violations(page), s).toEqual([])
      }
      await page.goto('/#/units')
      await page.getByRole('button', { name: 'Add a unit' }).first().click()
      expect(await violations(page), 'dialog').toEqual([])
    })

  })
}
