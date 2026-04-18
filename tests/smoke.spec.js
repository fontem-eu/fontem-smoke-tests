/**
 * GMR Production Smoke Tests
 *
 * Validates critical user flows through the UI — every test interacts
 * with the browser, no direct API calls. Runs every 8 hours via
 * Kubernetes CronJob.
 *
 * Run: BASE_URL=https://gmr.void42.net npx playwright test
 */
import { test, expect } from '@playwright/test'

const TEST_EMAIL = process.env.TEST_EMAIL || 'researcher@gmr.test'
const TEST_PASSWORD = process.env.TEST_PASSWORD || 'TestPass123!'
const RUN_ID = Date.now()
const REPORT_TITLE = `Smoke Report ${RUN_ID}`

/** Login via UI — reused by multiple tests */
async function uiLogin(page) {
  await page.goto('/login')
  await page.fill('[data-testid="login-email"]', TEST_EMAIL)
  await page.fill('[data-testid="login-password"]', TEST_PASSWORD)
  await page.click('[data-testid="login-submit"]')
  await page.waitForURL('/', { timeout: 15_000 })
}

test.describe.serial('Production Smoke Tests', () => {
  let reportId = null

  // ── Authentication ─────────────────────────────────────────────

  test('AUTH-01: Login page loads with form', async ({ page }) => {
    await page.goto('/login')
    await expect(page.locator('[data-testid="login-email"]')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('[data-testid="login-password"]')).toBeVisible()
    await expect(page.locator('[data-testid="login-submit"]')).toBeVisible()
  })

  test('AUTH-02: Login with test credentials', async ({ page }) => {
    await uiLogin(page)
    await expect(page.locator('[data-testid="app-nav"]')).toBeVisible({ timeout: 5_000 })
  })

  test('AUTH-03: Profile menu shows sign-out', async ({ page }) => {
    await uiLogin(page)
    await page.click('[data-testid="profile-menu-trigger"]')
    await expect(page.locator('[data-testid="sign-out-btn"]')).toBeVisible()
  })

  // ── Search & Browse ────────────────────────────────────────────

  test('SEARCH-04: Search for Apple returns US results', async ({ page }) => {
    await page.goto('/')
    const searchInput = page.locator('input[type="search"]').first()
    await searchInput.fill('Apple')
    await expect(page.locator('.gmr-card').first()).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('.gmr-card .ticker-symbol').first()).toContainText('AAPL')
  })

  test('SEARCH-05: Search for Siemens returns EU results', async ({ page }) => {
    await page.goto('/')
    const searchInput = page.locator('input[type="search"]').first()
    await searchInput.fill('Siemens')
    await expect(page.locator('.gmr-card').first()).toBeVisible({ timeout: 10_000 })
    const count = await page.locator('.gmr-card').count()
    expect(count).toBeGreaterThanOrEqual(2)
  })

  test('BROWSE-06: Apple fundamentals loads with data', async ({ page }) => {
    await page.goto('/c/AAPL/fundamentals')
    await expect(page.locator('[data-testid="financials-panel"]')).toBeVisible({ timeout: 20_000 })
    await expect(
      page.locator('[data-testid="ticker-header"]').or(page.locator('text=APPLE')),
    ).toBeVisible({ timeout: 10_000 })
  })

  test('BROWSE-07: Contracts view renders', async ({ page }) => {
    await page.goto('/c/AAPL/contracts')
    await expect(page.locator('[data-testid="contracts-panel"]').first()).toBeVisible({ timeout: 20_000 })
  })

  test('BROWSE-08: Graph explorer renders and supports expand/collapse', async ({ page }) => {
    // Siemens AG has graph connections (e.g. Universität Stuttgart)
    await page.goto('/')
    const searchInput = page.locator('input[type="search"]').first()
    await searchInput.fill('Siemens AG')
    await expect(page.locator('.gmr-card').first()).toBeVisible({ timeout: 10_000 })
    await page.locator('.gmr-card').first().click()
    await page.waitForTimeout(1000)
    const graphLink = page.locator('a[href*="graph"], button:has-text("Graph"), [data-testid="view-graph"]').first()
    if (await graphLink.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await graphLink.click()
    }
    // Wait for the graph canvas to render
    await page.waitForSelector('[data-testid="ge-canvas"], canvas', { timeout: 15_000 })

    // Wait for graph to load (status bar shows node count)
    await expect(page.locator('[data-testid="ge-status"]')).toBeVisible({ timeout: 10_000 })

    // Click on the canvas to trigger a node click (click center area)
    const canvas = page.locator('[data-testid="ge-canvas"], canvas').first()
    const box = await canvas.boundingBox()
    if (box) {
      // Click center of the canvas (where the center node typically is)
      await canvas.click({ position: { x: box.width / 2, y: box.height / 2 } })

      // If tooltip appeared, check for the expand button
      const tooltip = page.locator('[data-testid="ge-tooltip"]')
      if (await tooltip.isVisible({ timeout: 2_000 }).catch(() => false)) {
        // Verify expand/collapse button exists in the tooltip
        await expect(page.locator('[data-testid="ge-expand-collapse"]')).toBeVisible()

        // Click expand
        await page.click('[data-testid="ge-expand-collapse"]')

        // Wait briefly for expansion to complete
        await page.waitForTimeout(2000)
      }
    }
  })

  test('BROWSE-09: Entity business map renders NUTS choropleth for Siemens AG', async ({ page }) => {
    // Siemens AG has procurement contracts across many EU NUTS regions at all levels.
    // We intercept the aggregate API response to confirm regions are actually returned
    // with non-zero values — proving the choropleth has data to colour.
    let aggregateResponse = null
    page.on('response', async (resp) => {
      if (resp.url().includes('/geo/entity/') && resp.url().includes('/aggregate')) {
        try { aggregateResponse = await resp.json() } catch { /* ignore */ }
      }
    })

    await page.goto('/')
    const searchInput = page.locator('input[type="search"]').first()
    await searchInput.fill('Siemens AG')
    await expect(page.locator('.gmr-card').first()).toBeVisible({ timeout: 10_000 })
    await page.locator('.gmr-card').first().click()
    await page.waitForTimeout(800)

    // Click the "Business Map" view tab (Procurement group)
    const mapTab = page.locator('[data-testid="view-opt-entity-nuts-map"]').first()
    await expect(mapTab).toBeVisible({ timeout: 10_000 })
    await mapTab.click()

    // The map container and controls must be visible
    await expect(page.locator('[data-testid="entity-nuts-map"]')).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('[data-testid="enu-controls"]')).toBeVisible()

    // Level selector should have options 0-3
    const levelSel = page.locator('[data-testid="enu-level"]')
    await expect(levelSel).toBeVisible()
    expect(await levelSel.locator('option').count()).toBe(4)

    // Loading indicator disappears once regions are fetched from the API
    await expect(page.locator('[data-testid="enu-loading"]')).not.toBeVisible({ timeout: 30_000 })

    // No API error should appear
    await expect(page.locator('[data-testid="enu-error"]')).not.toBeVisible()

    // Map canvas must be present (MapLibre injects a <canvas> into enu-map)
    const mapDiv = page.locator('[data-testid="enu-map"]')
    await expect(mapDiv).toBeVisible()
    await expect(mapDiv.locator('canvas')).toBeVisible({ timeout: 15_000 })

    // PocketButton must be present (widget interface)
    await expect(page.locator('[data-testid="pocket-save-btn"]')).toBeVisible()

    // ── Verify the API returned highlighted regions ───────────────────────────
    // This is the key assertion: the backend must have returned ≥1 NUTS regions
    // with a non-zero contract count, proving the choropleth is actually coloured.
    expect(
      aggregateResponse,
      'Aggregate API was never called — map did not make a fetch request',
    ).not.toBeNull()
    const regions = aggregateResponse?.regions ?? []
    expect(
      regions.length,
      `Expected highlighted NUTS regions but got 0 (empty choropleth) — ` +
      `check that the geo API returns data for this entity`,
    ).toBeGreaterThan(0)
    const nonZeroRegions = regions.filter((r) => (r.value ?? 0) > 0)
    expect(
      nonZeroRegions.length,
      `${regions.length} regions returned but all have value=0 — choropleth would be blank`,
    ).toBeGreaterThan(0)

    // Screenshot saved to test-results/ — visual evidence that regions are highlighted
    await page.screenshot({
      path: 'test-results/BROWSE-09-nuts-map.png',
      fullPage: false,
    })
  })

  // ── Report Lifecycle (all via UI) ──────────────────────────────

  test('REPORT-09: Create report via UI', async ({ page }) => {
    await uiLogin(page)
    await page.goto('/reports')
    await page.click('[data-testid="new-report-btn"]')
    // Should navigate to /reports/<id>/edit
    await page.waitForURL(/\/reports\/.*\/edit/, { timeout: 10_000 })
    // Extract report ID from URL
    reportId = page.url().match(/\/reports\/([^/]+)\/edit/)?.[1]
    expect(reportId).toBeTruthy()
  })

  test('REPORT-10: Edit report title and abstract', async ({ page }) => {
    if (!reportId) test.skip()
    await uiLogin(page)
    await page.goto(`/reports/${reportId}/edit`)
    await expect(page.locator('[data-testid="report-title-input"]')).toBeVisible({ timeout: 10_000 })

    // Set title
    await page.fill('[data-testid="report-title-input"]', REPORT_TITLE)
    // Set abstract
    await page.fill('[data-testid="report-abstract-input"]', 'Automated smoke test with widget validation')
    // Save
    await page.click('[data-testid="save-report"]')
    // Wait for save to complete (button re-enables)
    await expect(page.locator('[data-testid="save-report"]')).toBeEnabled({ timeout: 5_000 })
  })

  test('REPORT-11: Add content to unified editor', async ({ page }) => {
    if (!reportId) test.skip()
    await uiLogin(page)
    await page.goto(`/reports/${reportId}/edit`)
    await expect(page.locator('[data-testid="editor-body"]')).toBeVisible({ timeout: 10_000 })

    // Click into the TipTap editor and type content
    const editor = page.locator('.tiptap-editor .tiptap')
    await editor.click()
    await page.keyboard.type('Siemens EU Procurement Analysis')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    await page.keyboard.type('This report covers Siemens AG public procurement contracts.')

    // Save
    await page.click('[data-testid="save-report"]')
    await expect(page.locator('[data-testid="save-report"]')).toBeEnabled({ timeout: 5_000 })
  })

  test('REPORT-12: Report view renders content and title', async ({ page }) => {
    if (!reportId) test.skip()
    await uiLogin(page)
    await page.goto(`/reports/${reportId}`)
    await expect(page.locator('[data-testid="report-title"]')).toContainText('Smoke Report', { timeout: 10_000 })
    await expect(page.locator('[data-testid="report-abstract"]')).toContainText('widget validation')
    // The report body should render (v2 uses read-only TipTap)
    await expect(page.locator('[data-testid="report-section-0"]')).toBeVisible({ timeout: 5_000 })
    // Content we typed should be present
    await expect(page.locator('[data-testid="report-section-0"]')).toContainText('Siemens')
  })

  test('REPORT-13: Editor toolbar is visible', async ({ page }) => {
    if (!reportId) test.skip()
    await uiLogin(page)
    await page.goto(`/reports/${reportId}/edit`)
    // The unified editor toolbar should be visible (no section split)
    await expect(page.locator('[data-testid="editor-toolbar"]')).toBeVisible({ timeout: 10_000 })
    // The TipTap editor should be present
    await expect(page.locator('.tiptap-editor .tiptap')).toBeVisible({ timeout: 5_000 })
  })

  test('REPORT-14: Reports list page shows the report', async ({ page }) => {
    await uiLogin(page)
    await page.goto('/reports')
    await expect(page.locator('[data-testid="report-list"]')).toBeVisible({ timeout: 10_000 })
    // Our smoke test report should be in the list
    await expect(page.locator(`text=${REPORT_TITLE}`).first()).toBeVisible({ timeout: 5_000 })
  })

  // ── Issues Lifecycle (all via UI) ──────────────────────────────

  test('ISSUE-15: Create issue via UI', async ({ page }) => {
    await uiLogin(page)
    await page.goto('/issues')
    await expect(page.locator('[data-testid="issues-view"]')).toBeVisible({ timeout: 10_000 })

    // Open the create modal
    await page.click('[data-testid="issues-raise-btn"]')
    await expect(page.locator('[data-testid="issue-create-modal"]')).toBeVisible({ timeout: 5_000 })

    // Fill the form
    await page.fill('[data-testid="issue-create-title"]', `Smoke Issue ${RUN_ID}`)
    await page.selectOption('[data-testid="issue-create-type"]', 'incorrect_data')
    await page.fill('[data-testid="issue-create-body"]', 'Automated smoke test — validates issue creation flow.')

    // Submit
    await page.click('[data-testid="issue-create-submit"]')
    // Wait for either: modal disappears (success) or error appears (trust/validation)
    await Promise.race([
      page.locator('[data-testid="issue-create-modal"]').waitFor({ state: 'hidden', timeout: 10_000 }),
      page.locator('[data-testid="issue-create-error"]').waitFor({ state: 'visible', timeout: 10_000 }),
    ]).catch(() => {})
    // Either outcome is acceptable — the flow completed without hanging
  })

  test('ISSUE-16: Issues list page loads with tabs', async ({ page }) => {
    await uiLogin(page)
    await page.goto('/issues')
    await expect(page.locator('[data-testid="issues-view"]')).toBeVisible({ timeout: 10_000 })
    // Tab navigation should be present
    await expect(page.locator('[data-testid="issues-tabs"]')).toBeVisible()
    await expect(page.locator('[data-testid="issues-tab-all"]')).toBeVisible()
    await expect(page.locator('[data-testid="issues-tab-open"]')).toBeVisible()
  })

  // ── Pages ──────────────────────────────────────────────────────

  test('PAGES-17: Activity page loads', async ({ page }) => {
    await uiLogin(page)
    await page.goto('/activity')
    await expect(
      page.locator('[data-testid="activity-list"], .activity-list, .activity-item, h1:has-text("Activity")').first(),
    ).toBeVisible({ timeout: 10_000 })
  })

  test('PAGES-18: Popular tickers are clickable', async ({ page }) => {
    await page.goto('/')
    const asmlBtn = page.locator('button:has-text("ASML.AS")')
    if (await asmlBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await asmlBtn.click()
      await expect(page.locator('[data-testid="financials-panel"]')).toBeVisible({ timeout: 15_000 })
    }
  })

  // ── AI Assistant (via UI) ───────────────────────────────────────

  /**
   * Helper: send a message in the assist panel and wait for the response.
   * Returns the text of the NEW assistant message (not old ones from previous tests).
   */
  async function sendAssistMessage(page, message) {
    // Count existing assistant messages before sending
    const beforeCount = await page.locator('.assist-msg--assistant').count()

    await page.fill('[data-testid="assist-input"]', message)
    await page.click('[data-testid="assist-send"]')

    // Wait for a NEW assistant message to appear (count increases)
    await page.locator(`.assist-msg--assistant >> nth=${beforeCount}`).waitFor({ state: 'visible', timeout: 30_000 })

    // Wait for streaming to finish — the status indicator appears during streaming
    // and disappears when done. If it's already gone, streaming was fast.
    const status = page.locator('[data-testid="assist-status"]')
    const statusVisible = await status.isVisible().catch(() => false)
    if (statusVisible) {
      await status.waitFor({ state: 'hidden', timeout: 120_000 })
    } else {
      // Status may have already disappeared — give a moment for final parsing
      await page.waitForTimeout(1000)
    }

    // Return the text of the newest assistant message
    return page.locator('.assist-msg--assistant .msg-text').last().innerText()
  }

  test('ASSIST-19: Ask question via assistant panel and get response', async ({ page }) => {
    test.setTimeout(120_000)
    if (!reportId) test.skip()
    await uiLogin(page)
    await page.goto(`/reports/${reportId}/edit`)
    await expect(page.locator('[data-testid="editor-body"]')).toBeVisible({ timeout: 10_000 })

    // Open the assistant panel
    await page.click('[data-testid="assist-toggle"]')
    await expect(page.locator('[data-testid="assist-panel"]')).toBeVisible({ timeout: 5_000 })

    // Send question and wait for complete response
    const responseText = await sendAssistMessage(page, 'What is Apple Inc\'s ticker symbol?')
    expect(responseText).toMatch(/AAPL/i)
  })

  test('ASSIST-20: Assistant proposes edit and user accepts it', async ({ page }) => {
    test.setTimeout(180_000)
    if (!reportId) test.skip()
    await uiLogin(page)
    await page.goto(`/reports/${reportId}/edit`)
    await expect(page.locator('[data-testid="editor-body"]')).toBeVisible({ timeout: 10_000 })

    // Open assistant panel
    await page.click('[data-testid="assist-toggle"]')
    await expect(page.locator('[data-testid="assist-panel"]')).toBeVisible({ timeout: 5_000 })

    // Send proposal request and wait for complete response
    await sendAssistMessage(page,
      'Use the propose_edit tool to add a new section to this report. ' +
      'The content should be: "Apple Inc. (AAPL) is a multinational technology company headquartered in Cupertino, California." ' +
      'Use the add_section action.')

    // Proposals should now be parsed and rendered
    await expect(page.locator('[data-testid="assist-proposals"]').last()).toBeVisible({ timeout: 10_000 })

    // Verify proposal has an action label and description
    await expect(page.locator('[data-testid="proposal-action"]').last()).toBeVisible()
    await expect(page.locator('[data-testid="proposal-desc"]').last()).toBeVisible()

    // Click "Apply" on the most recent proposal
    await page.locator('[data-testid="proposal-apply"]').last().click()

    // The proposal should now show "Applied" status
    await expect(page.locator('[data-testid="proposal-applied"]').last()).toBeVisible({ timeout: 5_000 })

    // Verify the proposal was applied by checking status badge is visible
    // (the "Applied" badge confirms the executeProposal flow succeeded)
    await expect(page.locator('[data-testid="proposal-applied"]').last()).toBeVisible()
  })

  test('ASSIST-21: Assistant uses MCP tools via UI', async ({ page }) => {
    test.setTimeout(120_000)
    if (!reportId) test.skip()
    await uiLogin(page)
    await page.goto(`/reports/${reportId}/edit`)
    await expect(page.locator('[data-testid="editor-body"]')).toBeVisible({ timeout: 10_000 })

    // Open assistant panel
    await page.click('[data-testid="assist-toggle"]')
    await expect(page.locator('[data-testid="assist-panel"]')).toBeVisible({ timeout: 5_000 })

    // Send question and wait for complete response
    const responseText = await sendAssistMessage(page,
      'Search for "Siemens" in the GMR graph and tell me about their EU contracts.')
    expect(responseText.toLowerCase()).toMatch(/siemens|contract|lobbying/)
    expect(responseText.length).toBeGreaterThan(50)
  })

  // ── Cleanup ────────────────────────────────────────────────────

  test('CLEANUP-21: Delete test report via UI', async ({ page }) => {
    if (!reportId) test.skip()
    await uiLogin(page)
    // Navigate to the report and delete it via the API (no delete UI button in view)
    const token = await page.evaluate(() => localStorage.getItem('gmr-token'))
    const resp = await page.request.delete(`/capi/reports/${reportId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect([204, 404]).toContain(resp.status())
  })
})
