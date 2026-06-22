/**
 * Pocketable charts → data story (Phase 1 of "investigations").
 *
 * Exercises the full new path end-to-end through the UI:
 *   1. open a data-quality dashboard (charts now wrapped in PocketableChart)
 *   2. save a couple of visualizations to the pocket  (widget_type: chart_snapshot)
 *   3. create a data story and insert those saved widgets from the pocket
 *   4. save, reload the editor, and confirm the widgets persisted + re-render
 *
 * Runs in the desktop (chromium) project — the save button is a hover-reveal
 * affordance, so it is intentionally not part of the mobile suite.
 *
 * Run: BASE_URL=https://fontem.staging.void42.internal npx playwright test pocket-story.spec.js
 */
import { test, expect } from './baseTest.js'

const RUN_ID = String(Date.now())

test.describe('Pocketable charts → data story', () => {
  // The flow is long (2 saves + story create + 2 inserts + save + reload);
  // give it room beyond the 60s default, especially on a cold staging route.
  test.setTimeout(150_000)

  test('POCKET-STORY: save DQ chart snapshots to pocket, insert into a story, persist', async ({ page }) => {
    // ── 1. A data-quality dashboard now renders every chart via PocketableChart ──
    await page.goto('/data-quality/contracts')
    const charts = page.locator('[data-testid="pocketable-chart"]')
    // Feature-detect: the pocketable-chart wrapper ships with the
    // chart-snapshot work. Environments still on an older image (e.g.
    // prod before this rolls out) won't have it — skip cleanly there
    // rather than failing the hourly prod smoke run.
    let present = true
    try {
      await charts.first().waitFor({ state: 'visible', timeout: 15_000 })
    } catch {
      present = false
    }
    test.skip(!present, 'PocketableChart not deployed in this environment yet')
    expect(
      await charts.count(),
      'expected the contracts DQ dashboard to render pocketable charts',
    ).toBeGreaterThan(1)

    // ── 2. Save a couple of visualizations to the pocket ──
    async function saveChart(idx, name) {
      const chart = charts.nth(idx)
      await chart.scrollIntoViewIfNeeded()
      await chart.locator('[data-testid="pocket-menu-btn"]').click() // open the ⋮ actions menu
      await chart.locator('[data-testid="pocket-save-btn"]').click() // "Save to pocket"
      const input = page.locator('[data-testid="pocket-name-input"]')
      await input.waitFor({ state: 'visible', timeout: 10_000 })
      await input.fill(name)
      await page.click('[data-testid="pocket-confirm"]')
      // prompt overlay closes once saved
      await expect(page.locator('[data-testid="pocket-name-input"]')).toHaveCount(0, { timeout: 10_000 })
    }
    const nameA = `Smoke DQ chart A ${RUN_ID}`
    const nameB = `Smoke DQ chart B ${RUN_ID}`
    await saveChart(0, nameA)
    await saveChart(1, nameB)

    // Both must land in the (localStorage) pocket as chart_snapshot items
    // carrying a serialised chart + props.
    const snaps = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('gmr-pocket') || '[]').filter((p) => p.widget_type === 'chart_snapshot'),
    )
    expect(snaps.length, 'two chart_snapshot items should be in the pocket').toBeGreaterThanOrEqual(2)
    expect(snaps[0].config.chart, 'snapshot config carries a chart type').toBeTruthy()

    // ── 3. Create a fresh data story ──
    await page.goto('/my-stories')
    await page.click('[data-testid="new-story-btn"]')
    await page.waitForURL(/\/stories\/.*\/edit/, { timeout: 30_000 })
    const storyId = page.url().match(/\/stories\/([^/]+)\/edit/)?.[1]
    expect(storyId, 'new story id parsed from edit URL').toBeTruthy()
    await expect(page.locator('[data-testid="editor-body"]')).toBeVisible({ timeout: 15_000 })

    // ── 4. Insert both saved widgets from the pocket ──
    async function insertFromPocket(name) {
      await page.click('[data-testid="tb-widget"]')
      await expect(page.locator('[data-testid="pocket-modal"]')).toBeVisible({ timeout: 10_000 })
      const item = page
        .locator('[data-testid="pocket-list"] .pocket-item', { hasText: name })
        .locator('.pocket-item-info')
      await item.first().click()
      await expect(page.locator('[data-testid="pocket-modal"]')).toHaveCount(0, { timeout: 10_000 })
      // A freshly-inserted block atom stays selected; move the cursor off it
      // (as a real author would by clicking on) so the NEXT insert appends
      // after it instead of replacing the current selection.
      await page.locator('.tiptap-editor .tiptap').press('ArrowDown')
    }
    await insertFromPocket(nameA)
    await insertFromPocket(nameB)

    // Both widget nodes render in the editor, as chart_snapshot embeds.
    await expect(page.locator('[data-testid="widget-node"]')).toHaveCount(2, { timeout: 10_000 })
    await expect(page.locator('[data-testid="widget-chart-snapshot"]')).toHaveCount(2)

    // ── 5. Save, reload the editor, confirm the widgets persisted ──
    await page.click('[data-testid="save-story"]')
    await expect(page.locator('[data-testid="save-story"]')).toBeEnabled({ timeout: 10_000 })

    await page.goto(`/stories/${storyId}/edit`)
    await expect(page.locator('[data-testid="editor-body"]')).toBeVisible({ timeout: 15_000 })
    await expect(
      page.locator('[data-testid="widget-chart-snapshot"]'),
      'saved chart_snapshot widgets re-render after a reload (round-trip persisted)',
    ).toHaveCount(2, { timeout: 20_000 })
  })

  test('POCKET-DOWNLOAD: the chart actions menu downloads the chart as an image', async ({ page }) => {
    await page.goto('/data-quality/contracts')
    const charts = page.locator('[data-testid="pocketable-chart"]')
    let present = true
    try {
      await charts.first().waitFor({ state: 'visible', timeout: 15_000 })
    } catch {
      present = false
    }
    test.skip(!present, 'PocketableChart not deployed in this environment yet')

    const chart = charts.first()
    await chart.locator('[data-testid="pocket-menu-btn"]').click()
    await expect(chart.locator('[data-testid="pocket-download-btn"]')).toBeVisible()
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      chart.locator('[data-testid="pocket-download-btn"]').click(),
    ])
    expect(download.suggestedFilename()).toMatch(/\.(svg|png)$/)
  })
})
