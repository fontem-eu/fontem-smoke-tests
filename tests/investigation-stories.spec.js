/**
 * Investigation ↔ story association + delete semantics (M4).
 *
 * UI-drives the user-facing surface: create an investigation, create a story,
 * "Add to investigation" from the editor, and see it listed under the
 * investigation. The delete semantics (cascade vs orphan) have no UI in this
 * slice, so they're exercised via the authenticated API (the same content=
 * contract the backend exposes), verifying the story survives an orphan delete
 * and is removed by a cascade delete.
 */
import { test, expect } from './baseTest.js'

const RUN = String(Date.now())

async function createInvestigation(page, name) {
  await page.goto('/investigations')
  await page.click('[data-testid="new-investigation-btn"]')
  await page.fill('[data-testid="investigation-name-input"]', name)
  await page.click('[data-testid="create-investigation-confirm"]')
  await page.waitForURL(/\/investigations\/[^/]+$/, { timeout: 30_000 })
  return page.url().match(/investigations\/([^/]+)/)[1]
}

async function createStoryAndAddToInvestigation(page, invId) {
  await page.goto('/my-stories')
  await page.click('[data-testid="create-btn"]')
  await page.click('[data-testid="new-story-btn"]')
  await page.waitForURL(/\/stories\/.*\/edit/, { timeout: 30_000 })
  const storyId = page.url().match(/stories\/([^/]+)\/edit/)[1]
  await page.click('[data-testid="add-to-investigation-btn"]')
  await expect(page.locator('[data-testid="investigation-picker"]')).toBeVisible({ timeout: 10_000 })
  await page.click(`[data-testid="investigation-pick-${invId}"]`)
  await expect(page.locator('[data-testid="investigation-picker"]')).toBeHidden({ timeout: 10_000 })
  return storyId
}

// Authenticated DELETE / GET via the in-page session token (no delete UI yet).
function apiStatus(page, method, path) {
  return page.evaluate(async ({ m, p }) => {
    const r = await fetch(`/capi${p}`, {
      method: m,
      credentials: 'include',
      headers: { Authorization: `Bearer ${window.__FONTEM_BOOTSTRAP_TOKEN__ || ''}` },
    })
    return r.status
  }, { m: method, p: path })
}

test.describe('Investigation stories', () => {
  test.setTimeout(150_000)

  test('M4-ORPHAN: add story → listed → delete orphan keeps the story', async ({ page }) => {
    await page.goto('/investigations')
    let present = true
    try {
      await page.locator('[data-testid="investigations-view"]').waitFor({ state: 'visible', timeout: 15_000 })
      await page.locator('[data-testid="new-investigation-btn"]').waitFor({ state: 'visible', timeout: 5_000 })
    } catch { present = false }
    test.skip(!present, 'Investigations not deployed in this environment yet')

    const invId = await createInvestigation(page, `M4 Orphan ${RUN}`)
    const storyId = await createStoryAndAddToInvestigation(page, invId)

    // listed under the investigation
    await page.goto(`/investigations/${invId}`)
    await expect(page.locator(`[data-testid="inv-story-${storyId}"]`)).toBeVisible({ timeout: 10_000 })

    // orphan delete → story survives
    expect(await apiStatus(page, 'DELETE', `/investigations/${invId}?content=orphan`)).toBe(204)
    expect(await apiStatus(page, 'GET', `/data-stories/${storyId}`)).toBe(200)
  })

  test('M4-CASCADE: add story → delete cascade removes the story', async ({ page }) => {
    await page.goto('/investigations')
    let present = true
    try {
      await page.locator('[data-testid="new-investigation-btn"]').waitFor({ state: 'visible', timeout: 15_000 })
    } catch { present = false }
    test.skip(!present, 'Investigations not deployed in this environment yet')

    const invId = await createInvestigation(page, `M4 Cascade ${RUN}`)
    const storyId = await createStoryAndAddToInvestigation(page, invId)

    expect(await apiStatus(page, 'DELETE', `/investigations/${invId}?content=cascade`)).toBe(204)
    expect(await apiStatus(page, 'GET', `/data-stories/${storyId}`)).toBe(404)
  })
})
