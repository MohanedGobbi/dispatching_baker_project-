import { expect, test } from '@playwright/test'
import { signIn, signInManager, unique } from './helpers'

test('sign-in shows the CrewBoard logo and only the manager account', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveTitle('CrewBoard')
  await expect(page.locator('.login-brand img[src="/icon.svg"]')).toBeVisible()
  await expect(page.getByLabel('Login')).toHaveValue('admin')
  await expect(page.getByRole('button', { name: 'Dispatcher' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'FR' })).toHaveCount(0)
})

test('a new manager signs in with a temporary password and must choose their own', async ({ page }) => {
  await signInManager(page)
  await page.goto('/#/users')
  await page.getByRole('button', { name: 'New user' }).click()
  const dialog = page.getByRole('dialog')
  const login = unique('e2e')
  await dialog.getByLabel('Login').fill(login)
  await dialog.getByLabel('Manager', { exact: true }).check()
  await dialog.getByRole('button', { name: 'Save' }).click()
  const temp = await page.locator('.temp-pw code').innerText()
  await page.getByRole('button', { name: 'Done' }).click()
  await page.getByRole('button', { name: 'Sign out' }).first().click()

  await signIn(page, login, temp)
  await expect(page.getByRole('heading', { name: 'Choose your password' })).toBeVisible()
  await page.getByLabel('Current password').fill(temp)
  await page.getByLabel('New password', { exact: true }).fill('e2e-password-1')
  await page.getByLabel('New password again').fill('e2e-password-1')
  await page.getByRole('button', { name: 'Change password' }).click()
  await expect(page.getByRole('link', { name: /Users/ })).toBeVisible()
})

test('forgot password answers the same whether or not the login exists', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Forgot your password?' }).click()
  await page.getByLabel('Login').fill('nobody-at-all')
  await page.getByRole('button', { name: 'Send reset link' }).click()
  await expect(page.getByText(/reset link is on its way/)).toBeVisible()
})
