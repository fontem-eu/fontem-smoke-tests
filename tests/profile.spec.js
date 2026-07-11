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


// --- helpers for the leak-coverage test -------------------------------------
const OWNER_ONLY_FIELDS = ['account_email', 'show_email', 'use_custom_email', 'custom_email']

function assertNoOwnerFields(body) {
  for (const k of OWNER_ONLY_FIELDS) {
    expect(body, `owner-only field "${k}" leaked to an anonymous viewer`).not.toHaveProperty(k)
  }
}

// Fetch the same profile twice from inside the page: once WITH the bootstrap
// bearer (the owner) and once with no Authorization and credentials omitted
// (a true anonymous request — the refresh cookie can't authenticate an API
// call anyway, but omitting it makes the anonymity unambiguous).
async function fetchOwnerAndAnon(page, userId) {
  return page.evaluate(async (id) => {
    const token = globalThis.__FONTEM_BOOTSTRAP_TOKEN__
    const owner = await (await fetch(`/capi/users/${id}/profile`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })).json()
    const anon = await (await fetch(`/capi/users/${id}/profile`, { credentials: 'omit' })).json()
    return { owner, anon }
  }, userId)
}

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

    // 4. the top-right header ball shows the uploaded photo, not initials —
    // and the image actually LOADS (a broken/404 <img> is still 'visible', so
    // assert naturalWidth > 0; this guards the presign→nginx→MinIO chain).
    const ballImg = page.locator('[data-testid="profile-trigger"] [data-testid="user-avatar-img"]')
    await expect(ballImg).toBeVisible({ timeout: 10_000 })
    await expect
      .poll(() => ballImg.evaluate((el) => el.naturalWidth), { timeout: 10_000 })
      .toBeGreaterThan(0)
  })

  test('email + owner-only fields never leak to an anonymous viewer', async ({ page }) => {
    await page.goto('/')
    await page.click('[data-testid="profile-trigger"]')
    await page.click('[data-testid="profile-my-profile"]')
    await page.waitForURL(/\/users\/[^/]+$/, { timeout: 20_000 })
    const userId = page.url().match(/\/users\/([^/]+)$/)[1]

    // --- Phase A: "display email" UNCHECKED → public email must be empty ------
    await page.click('[data-testid="profile-edit-btn"]')
    const show = page.locator('[data-testid="profile-show-email"]')
    if (await show.isChecked()) await show.uncheck()
    await page.click('[data-testid="profile-save-btn"]')
    await expect(page.locator('[data-testid="profile-email"]')).toHaveCount(0, { timeout: 10_000 })

    let seen = await fetchOwnerAndAnon(page, userId)
    expect(seen.anon.email).toBe('')
    assertNoOwnerFields(seen.anon)

    // --- Phase B: display a DIFFERENT email → only the custom one is public,
    //     the ACCOUNT email must never appear in the anonymous payload --------
    const custom = `public-${Date.now()}@example.com`
    await page.click('[data-testid="profile-edit-btn"]')
    await page.locator('[data-testid="profile-show-email"]').check()
    await page.locator('[data-testid="profile-use-custom-email"]').check()
    await page.locator('[data-testid="profile-custom-email"]').fill(custom)
    await page.click('[data-testid="profile-save-btn"]')
    await expect(page.locator('[data-testid="profile-email"]')).toContainText(custom, { timeout: 10_000 })

    seen = await fetchOwnerAndAnon(page, userId)
    // the owner legitimately sees their own settings + real account email
    expect(seen.owner).toHaveProperty('account_email')
    const accountEmail = seen.owner.account_email
    expect(accountEmail).toBeTruthy()
    // anonymous: the custom address only; account email absent everywhere; no
    // owner-only settings fields at all.
    expect(seen.anon.email).toBe(custom)
    assertNoOwnerFields(seen.anon)
    expect(JSON.stringify(seen.anon)).not.toContain(accountEmail)
  })
})
