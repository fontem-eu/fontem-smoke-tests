/**
 * Dossiers (M3) — create a dossier and build its article tree through the UI.
 *
 * My Stories → Create → Dossier → DossierView → add a root article → it shows
 * in the TreeNav and as the selected article → add a sub-article under it.
 * Feature-detects the Create split and skips where M3 isn't deployed.
 */
import { test, expect } from './baseTest.js'

test.describe('Dossiers', () => {
  test.setTimeout(150_000)

  test('DOSSIER-1: create a dossier and build its article tree', async ({ page }) => {
    await page.goto('/my-stories')
    let present = true
    try {
      await page.locator('[data-testid="create-btn"]').waitFor({ state: 'visible', timeout: 15_000 })
    } catch {
      present = false
    }
    test.skip(!present, 'Create split (M3) not deployed in this environment yet')

    // create a dossier
    await page.click('[data-testid="create-btn"]')
    await page.click('[data-testid="new-dossier-btn"]')
    await page.waitForURL(/\/dossiers\/[^/]+$/, { timeout: 30_000 })
    await expect(page.locator('[data-testid="dossier-view"]')).toBeVisible()
    await expect(page.locator('[data-testid="tree-empty"]')).toBeVisible()

    // add a root article -> appears in the tree + becomes the selected article
    const nodes = page.locator('[data-testid="tree-nav"] [data-testid^="tree-node-"]')
    await page.click('[data-testid="dossier-new-article"]')
    await expect(nodes).toHaveCount(1, { timeout: 15_000 })
    await expect(page.locator('[data-testid="dossier-selected-title"]')).toBeVisible()
    await expect(page.locator('[data-testid="dossier-edit-article"]')).toBeVisible()

    // add a sub-article under the root node -> two nodes in the tree
    const rootTestId = await nodes.first().getAttribute('data-testid')
    const rootId = rootTestId.replace('tree-node-', '')
    await page.locator(`[data-testid="tree-add-${rootId}"]`).click()
    await expect(nodes).toHaveCount(2, { timeout: 15_000 })
  })
})
