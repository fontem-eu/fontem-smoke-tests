/**
 * Investigations (M2) — full workspace flow through the UI.
 *
 * create → listed with role Owner → invite a member by email → set a
 * capability → promote to owner → the owner-invariant ("can't change another
 * owner") is enforced server-side and surfaced inline.
 *
 * A throwaway invitee is registered via the public API (independent `request`
 * context so it doesn't touch the page's researcher session). Feature-detects
 * the Investigations page and skips where it isn't deployed yet.
 */
import { test, expect } from './baseTest.js'

const RUN = String(Date.now())

test.describe('Investigations', () => {
  test.setTimeout(150_000)

  test('INV-1: create, invite, promote, owner-invariant', async ({ page, request }) => {
    await page.goto('/investigations')
    let present = true
    try {
      await page.locator('[data-testid="investigations-view"]').waitFor({ state: 'visible', timeout: 15_000 })
    } catch {
      present = false
    }
    test.skip(!present, 'Investigations not deployed in this environment yet')

    // ── create ──
    await page.click('[data-testid="new-investigation-btn"]')
    const name = `Smoke Inv ${RUN}`
    await page.fill('[data-testid="investigation-name-input"]', name)
    await page.click('[data-testid="create-investigation-confirm"]')
    await page.waitForURL(/\/investigations\/[^/]+$/, { timeout: 30_000 })

    await expect(page.locator('[data-testid="investigation-title"]')).toHaveText(name)
    // creator is an owner -> the manage/invite surface is present
    await expect(page.locator('[data-testid="investigation-invite"]')).toBeVisible()

    // ── register a throwaway invitee (independent request ctx) ──
    const email = `inv-${RUN}@example.com`
    const reg = await request.post('/capi/auth/register', {
      data: { email, password: 'TestPass123!', name: 'Smoke Invitee' },
    })
    expect(reg.ok(), `register invitee: HTTP ${reg.status()}`).toBeTruthy()

    // ── invite by email with a capability ──
    await page.fill('[data-testid="invite-email-input"]', email)
    await page.check('[data-testid="invite-write"]')
    await page.click('[data-testid="invite-add-btn"]')
    const row = page.locator('[data-testid="investigation-members"] li', { hasText: email })
    await expect(row).toBeVisible({ timeout: 10_000 })
    await expect(row).toContainText('Contributor')

    // ── promote to owner ──
    await row.locator('input[data-testid^="cap-is_owner-"]').check()
    await expect(row).toContainText('Owner', { timeout: 10_000 })

    // ── owner invariant: changing another owner is rejected (409) inline ──
    await row.locator('input[data-testid^="cap-can_add_viz-"]').click()
    await expect(page.locator('[data-testid="investigation-detail-error"]')).toBeVisible({ timeout: 10_000 })
  })
})
