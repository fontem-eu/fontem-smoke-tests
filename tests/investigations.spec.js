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

/**
 * Register the throwaway invitee. The /auth/register endpoint is per-IP rate
 * limited and the suite shares that budget, so tolerate 409 (already created by
 * a prior attempt) and retry 429 with a backoff rather than flaking.
 */
async function registerInvitee(request, email) {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const reg = await request.post('/capi/auth/register', {
      data: { email, password: 'TestPass123!', name: 'Smoke Invitee' },
    })
    if (reg.ok() || reg.status() === 409) return
    if (reg.status() !== 429) throw new Error(`register invitee: HTTP ${reg.status()}`)
    await new Promise((resolve) => { setTimeout(resolve, 3000 * attempt) })
  }
  throw new Error('register invitee: still rate-limited (429) after retries')
}

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
    await registerInvitee(request, email)

    // ── invite by email with a role ──
    await page.fill('[data-testid="invite-email-input"]', email)
    await page.selectOption('[data-testid="invite-role"]', 'contributor')
    await page.click('[data-testid="invite-add-btn"]')
    const row = page.locator('[data-testid="investigation-members"] li', { hasText: email })
    await expect(row).toBeVisible({ timeout: 10_000 })
    // The role chip (a span) — not the role <select>, which also contains the
    // word "Contributor" as an option — confirms the committed role.
    await expect(row.locator('.invd-member-role')).toHaveText('Contributor', { timeout: 10_000 })

    // ── promote to owner via the role select ──
    await row.locator('[data-testid^="member-role-select-"]').selectOption('owner')
    await expect(row.locator('.invd-member-role')).toHaveText('Owner', { timeout: 10_000 })

    // ── owner invariant: changing another owner is rejected (409) inline ──
    // is_owner is committed above (chip reads Owner), so the PUT verdict is
    // deterministic. Assert the server's 409 directly + the inline banner.
    const rejected = page.waitForResponse(
      (r) => /\/capi\/investigations\/[^/]+\/members\//.test(r.url())
        && r.request().method() === 'PUT',
      { timeout: 15_000 },
    )
    await row.locator('[data-testid^="member-role-select-"]').selectOption('admin')
    expect((await rejected).status(), 'changing another owner must 409').toBe(409)
    await expect(page.locator('[data-testid="investigation-detail-error"]')).toBeVisible({ timeout: 10_000 })
  })
})
