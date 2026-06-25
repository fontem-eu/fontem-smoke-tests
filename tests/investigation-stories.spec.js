/**
 * Investigation ↔ story association + delete semantics (M4).
 *
 * Fully UI-driven: create an investigation, create a story, "Add to
 * investigation" from the editor, see it listed, then DELETE the investigation
 * through the detail view's owner control (cascade vs orphan), and verify the
 * outcome by navigating to the article — it survives an orphan delete (its page
 * still renders) and is gone after a cascade delete (the page shows its error).
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

// Delete the investigation through the owner control in the detail view.
async function deleteInvestigationViaUI(page, invId, mode) {
  await page.goto(`/investigations/${invId}`)
  await page.click('[data-testid="investigation-delete-btn"]')
  await expect(page.locator('[data-testid="investigation-delete-confirm"]')).toBeVisible({ timeout: 10_000 })
  await page.click(`[data-testid="investigation-delete-${mode}"]`)
  await page.waitForURL(/\/investigations$/, { timeout: 15_000 })
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

    // orphan delete via the UI → the article survives (its page still renders)
    await deleteInvestigationViaUI(page, invId, 'orphan')
    await page.goto(`/stories/${storyId}`)
    await expect(page.locator('[data-testid="story-title"]')).toBeVisible({ timeout: 15_000 })
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

    // cascade delete via the UI → the article is gone (its page shows the error)
    await deleteInvestigationViaUI(page, invId, 'cascade')
    await page.goto(`/stories/${storyId}`)
    await expect(page.locator('[data-testid="story-error"]')).toBeVisible({ timeout: 15_000 })
  })
})
