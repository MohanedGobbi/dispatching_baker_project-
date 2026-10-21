import { expect, test } from '@playwright/test'
import { signIn } from './helpers'

test('sign-in shows the CrewBoard logo and only the manager account', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveTitle('CrewBoard')
  await expect(page.locator('.login-brand img[src="/icon.svg"]')).toBeVisible()
  await expect(page.getByLabel('Login')).toHaveValue('admin')
  await expect(page.getByRole('button', { name: 'Dispatcher' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'FR' })).toHaveCount(0)
})

test('any account other than the manager is told the platform is for the manager only', async ({ page }) => {
  await signIn(page, 'e1001')
  await expect(page.getByText('This platform is for the manager only')).toBeVisible()
  await expect(page.locator('.side-nav')).toHaveCount(0)
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page.getByLabel('Login')).toBeVisible()
})

test('forgot password answers the same whether or not the login exists', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Forgot your password?' }).click()
  await page.getByLabel('Login').fill('nobody-at-all')
  await page.getByRole('button', { name: 'Send reset link' }).click()
  await expect(page.getByText(/reset link is on its way/)).toBeVisible()
})
