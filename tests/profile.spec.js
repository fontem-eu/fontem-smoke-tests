/**
 * Profile editing flow (own profile):
 *  1. Reach the profile via the top-right menu ("My profile") — covers the
 *     menu → /users/:id linkage.
 *  2. Save a summary + a SCHEMELESS link. This is the regression guard for the
 *     bug where a link without an https:// scheme was silently dropped; it must
 *     now persist, normalised to https, and survive a reload.
 *  3. Upload an avatar and confirm it renders in the round frame with the
 *     reposition affordance.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from './baseTest.js'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'uploads')
const PHOTO = path.join(FIXTURES, 'good-photo.jpg')

test.describe('Profile editing', () => {
  test('menu → profile, summary + schemeless link persist, avatar upload', async ({ page }) => {
    // 1. reach own profile through the profile menu
    await page.goto('/')
    await page.click('[data-testid="profile-trigger"]')
    await page.click('[data-testid="profile-my-profile"]')
    await page.waitForURL(/\/users\/[^/]+$/, { timeout: 20_000 })
    await expect(page.locator('[data-testid="user-profile"]')).toBeVisible()

    // 2. edit: summary + a schemeless link
    const summary = `Smoke bio ${Date.now()}`
    await page.click('[data-testid="profile-edit-btn"]')
    await page.fill('[data-testid="profile-edit-summary"]', summary)
    await page.click('[data-testid="profile-add-link"]')
    await page.locator('[data-testid="profile-link-name"]').last().fill('LinkedIn')
    await page.locator('[data-testid="profile-link-url"]').last().fill('linkedin.com/in/smoke')
    await page.click('[data-testid="profile-save-btn"]')

    // the link renders, normalised to https (not dropped)
    const link = page.locator('[data-testid="profile-links"] a', { hasText: 'LinkedIn' }).last()
    await expect(link).toBeVisible({ timeout: 10_000 })
    await expect(link).toHaveAttribute('href', 'https://linkedin.com/in/smoke')

    // survives a reload (persisted server-side)
    await page.reload()
    await expect(page.locator('[data-testid="profile-summary"]')).toHaveText(summary)
    await expect(
      page.locator('[data-testid="profile-links"] a', { hasText: 'LinkedIn' }).last(),
    ).toHaveAttribute('href', 'https://linkedin.com/in/smoke')

    // 3. avatar upload → round image + reposition affordance
    await page.setInputFiles('[data-testid="profile-avatar-input"]', PHOTO)
    await expect(page.locator('[data-testid="user-avatar-img"]').first()).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('[data-testid="profile-reposition"]')).toBeVisible({ timeout: 10_000 })

    // 4. the top-right header ball now shows the uploaded photo, not initials
    await expect(
      page.locator('[data-testid="profile-trigger"] [data-testid="user-avatar-img"]'),
    ).toBeVisible({ timeout: 10_000 })
  })
})
