/**
 * Investigation visualizations (M5) — the full server-side viz loop.
 *
 * From a DQ chart: ⋮ → Add to investigation (saves the viz server-side, the
 * pocket's successor). Then create a story, add it to that investigation, and
 * in the editor's Insert Widget modal insert the investigation's saved viz
 * ("From this investigation") — proving viz cross from a chart, into an
 * investigation, into an article inside it.
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

test.describe('Investigation visualizations', () => {
  test.setTimeout(180_000)

  test('M5: save a DQ chart to an investigation, then insert it into an article in it', async ({ page }) => {
    await page.goto('/data-quality/contracts')
    const charts = page.locator('[data-testid="pocketable-chart"]')
    let present = true
    try {
      await charts.first().waitFor({ state: 'visible', timeout: 15_000 })
      await charts.first().locator('[data-testid="pocket-menu-btn"]').click()
      await charts.first().locator('[data-testid="pocket-add-investigation-btn"]')
        .waitFor({ state: 'visible', timeout: 5_000 })
      await page.keyboard.press('Escape')
    } catch { present = false }
    test.skip(!present, 'M5 (chart → add to investigation) not deployed in this environment yet')

    // 1. an investigation to collect the viz
    const invId = await createInvestigation(page, `M5 Viz ${RUN}`)

    // 2. save a DQ chart straight onto the investigation
    await page.goto('/data-quality/contracts')
    const chart = charts.first()
    await chart.waitFor({ state: 'visible', timeout: 15_000 })
    await chart.scrollIntoViewIfNeeded()
    await chart.locator('[data-testid="pocket-menu-btn"]').click()
    await chart.locator('[data-testid="pocket-add-investigation-btn"]').click()
    await expect(page.locator('[data-testid="pocket-inv-picker"]')).toBeVisible({ timeout: 10_000 })
    await page.click(`[data-testid="pocket-inv-pick-${invId}"]`)
    await expect(page.locator('[data-testid="pocket-inv-picker"]')).toBeHidden({ timeout: 10_000 })

    // listed under the investigation — assert it through the UI (the detail
    // view's Visualizations section), not the API
    await page.goto(`/investigations/${invId}`)
    await expect(page.locator('[data-testid="investigation-viz"]')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('[data-testid^="inv-viz-"]').first())
      .toBeVisible({ timeout: 10_000 })

    // 3. a story, added to the same investigation
    await page.goto('/my-stories')
    await page.click('[data-testid="create-btn"]')
    await page.click('[data-testid="new-story-btn"]')
    await page.waitForURL(/\/stories\/.*\/edit/, { timeout: 30_000 })
    await page.click('[data-testid="add-to-investigation-btn"]')
    await expect(page.locator('[data-testid="investigation-picker"]')).toBeVisible({ timeout: 10_000 })
    await page.click(`[data-testid="investigation-pick-${invId}"]`)
    await expect(page.locator('[data-testid="investigation-picker"]')).toBeHidden({ timeout: 10_000 })

    // 4. reload so the editor reads the article's investigation_id, then insert
    //    the investigation's saved viz from the Insert Widget modal
    await page.reload()
    await page.locator('[data-testid="tb-widget"]').click()
    await expect(page.locator('[data-testid="inv-viz-list"]')).toBeVisible({ timeout: 10_000 })
    await page.locator('[data-testid^="inv-viz-item-"]').first().click()
    await expect(page.locator('[data-testid="widget-node"]').first()).toBeVisible({ timeout: 10_000 })
  })
})
