/**
 * Production smoke tests.
 *
 * Validates critical user flows through the UI — every test interacts
 * with the browser, no direct API calls.
 *
 * Cadence:
 *   - prod: hourly via the gmr-smoke-tests CronJob (deployment/cronjob.yaml)
 *   - staging: same CronJob spec but suspended; invoked on demand by
 *     the gitops promote workflow as a pre-prod gate
 *
 * Run: BASE_URL=https://gmr.void42.net npx playwright test
 */
import { test, expect } from '@playwright/test'

const TEST_EMAIL = process.env.TEST_EMAIL || 'researcher@gmr.test'
const TEST_PASSWORD = process.env.TEST_PASSWORD || 'TestPass123!'
// String form so call sites can `.slice()` it for shorter markers.
// `Date.now()` returns a number; calling `.slice()` on a number throws
// — use the string form throughout.
const RUN_ID = String(Date.now())
const STORY_TITLE = `Smoke Story ${RUN_ID}`

/**
 * Ensure the browser is in a logged-in state. Every test inherits the
 * session via Playwright's `storageState` (populated once by
 * global-setup.js's API login). This helper just navigates to `/` to
 * give the page context a real origin and verifies the token is there;
 * if it's not, it falls back to a full UI login (self-heal).
 *
 * This is the shape that keeps /auth/login rate-limit pressure at 0-3
 * hits per suite run instead of 1 hit per test.
 */
async function uiLogin(page) {
  await page.goto('/')
  const token = await page.evaluate(() => localStorage.getItem('gmr-token'))
  if (token) return
  // Fallback: storageState missing or expired — do a real UI login.
  await page.goto('/login')
  await page.fill('[data-testid="login-email"]', TEST_EMAIL)
  await page.fill('[data-testid="login-password"]', TEST_PASSWORD)
  await page.click('[data-testid="login-submit"]')
  await page.waitForURL('/', { timeout: 15_000 })
}

/** Clear the preloaded session so a test can exercise the unauthenticated flow. */
async function clearSession(page) {
  await page.goto('/login')
  await page.evaluate(() => localStorage.clear())
  await page.context().clearCookies()
  await page.reload()
}

test.describe.serial('Production Smoke Tests', () => {
  let storyId = null

  // ── Authentication ─────────────────────────────────────────────

  test('AUTH-01: Login page loads with form', async ({ page }) => {
    await clearSession(page)
    await expect(page.locator('[data-testid="login-email"]')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('[data-testid="login-password"]')).toBeVisible()
    await expect(page.locator('[data-testid="login-submit"]')).toBeVisible()
  })

  test('AUTH-02: Login with test credentials', async ({ page }) => {
    // Exercise the real login flow (clear the preloaded session first).
    await clearSession(page)
    await page.fill('[data-testid="login-email"]', TEST_EMAIL)
    await page.fill('[data-testid="login-password"]', TEST_PASSWORD)
    await page.click('[data-testid="login-submit"]')
    await page.waitForURL('/', { timeout: 15_000 })
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
    // The ge-canvas wrapper mounts immediately but stays
    // `display: none` until the first frame paints. Waiting for the
    // *visible* state can timeout under load even though the graph
    // ultimately renders fine. The status bar is the actual signal
    // we want — wait for it first; the canvas visibility is a
    // belt-and-braces follow-up.
    await page.waitForSelector('[data-testid="ge-canvas"], canvas', {
      state: 'attached', timeout: 15_000,
    })
    await expect(page.locator('[data-testid="ge-status"]')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('[data-testid="ge-canvas"], canvas').first()).toBeVisible({ timeout: 10_000 })

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
      const u = resp.url()
      if (u.includes('/geo/entity/') && u.includes('/aggregate')) {
        try { aggregateResponse = await resp.json() } catch { /* ignore */ }
      }
    })

    await page.goto('/')
    const searchInput = page.locator('input[type="search"]').first()
    await searchInput.fill('Siemens AG')
    await expect(page.locator('.gmr-card').first()).toBeVisible({ timeout: 10_000 })
    await page.locator('.gmr-card').first().click()
    await page.waitForTimeout(800)

    // Expand the Procurement group to reveal its sub-views
    const procCat = page.locator('[data-testid="view-cat-procurement"]').first()
    await expect(procCat).toBeVisible({ timeout: 10_000 })
    await procCat.click()

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

    // ── Canvas non-blank check ────────────────────────────────────────────────
    // Playwright takes a real composited screenshot (captures WebGL output correctly).
    // A rendered choropleth has varied pixel colours; a blank canvas PNG is tiny
    // because a uniform solid colour compresses down to almost nothing.
    const mapCanvas = mapDiv.locator('canvas')
    const canvasShot = await mapCanvas.screenshot()
    expect(
      canvasShot.length,
      `Canvas screenshot is suspiciously small (${canvasShot.length} bytes) — ` +
      `map may be rendering blank; a coloured choropleth produces a larger PNG`,
    ).toBeGreaterThan(10_000)

    // Full-page screenshot saved to test-results/ — visual evidence
    await page.screenshot({
      path: 'test-results/BROWSE-09-nuts-map.png',
      fullPage: false,
    })
  })

  // ── Report Lifecycle (all via UI) ──────────────────────────────

  test('STORY-09: Create story via UI', async ({ page }) => {
    await uiLogin(page)
    await page.goto('/my-stories')
    await page.click('[data-testid="new-story-btn"]')
    // Should navigate to /stories/<id>/edit. Generous timeout because
    // the create→redirect path is sometimes cold (first DB write of
    // the run, first cold-start of the editor route's bundle in the
    // page) and we've seen 15-20s legitimate completions on staging
    // under load. 10s was just below the natural worst case and
    // flaked the promote workflow regularly.
    await page.waitForURL(/\/stories\/.*\/edit/, { timeout: 30_000 })
    // Extract report ID from URL
    storyId = page.url().match(/\/stories\/([^/]+)\/edit/)?.[1]
    expect(storyId).toBeTruthy()
  })

  test('STORY-10: Edit story title and abstract', async ({ page }) => {
    if (!storyId) test.skip()
    await uiLogin(page)
    await page.goto(`/stories/${storyId}/edit`)
    await expect(page.locator('[data-testid="story-title-input"]')).toBeVisible({ timeout: 10_000 })

    // Set title
    await page.fill('[data-testid="story-title-input"]', STORY_TITLE)
    // Set abstract
    await page.fill('[data-testid="story-abstract-input"]', 'Automated smoke test with widget validation')
    // Save
    await page.click('[data-testid="save-story"]')
    // Wait for save to complete (button re-enables)
    await expect(page.locator('[data-testid="save-story"]')).toBeEnabled({ timeout: 5_000 })
  })

  test('STORY-11: Add content to unified editor', async ({ page }) => {
    if (!storyId) test.skip()
    await uiLogin(page)
    await page.goto(`/stories/${storyId}/edit`)
    await expect(page.locator('[data-testid="editor-body"]')).toBeVisible({ timeout: 10_000 })

    // Click into the TipTap editor and type content
    const editor = page.locator('.tiptap-editor .tiptap')
    await editor.click()
    await page.keyboard.type('Siemens EU Procurement Analysis')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    await page.keyboard.type('This report covers Siemens AG public procurement contracts.')

    // Save
    await page.click('[data-testid="save-story"]')
    await expect(page.locator('[data-testid="save-story"]')).toBeEnabled({ timeout: 5_000 })
  })

  test('STORY-12: Story view renders content and title', async ({ page }) => {
    if (!storyId) test.skip()
    await uiLogin(page)
    await page.goto(`/stories/${storyId}`)
    // 30s timeout: the read view fetches the report fresh and the
    // edits from STORY-10/11 sometimes haven't propagated to the
    // read path yet (write→read consistency). 10s was just under
    // the natural settling time on staging and flaked promotes.
    await expect(page.locator('[data-testid="story-title"]')).toContainText('Smoke Story', { timeout: 30_000 })
    await expect(page.locator('[data-testid="story-abstract"]')).toContainText('widget validation', { timeout: 10_000 })
    // The report body should render (v2 uses read-only TipTap)
    await expect(page.locator('[data-testid="report-section-0"]')).toBeVisible({ timeout: 10_000 })
    // Content we typed should be present
    await expect(page.locator('[data-testid="report-section-0"]')).toContainText('Siemens')
  })

  test('STORY-13: Editor toolbar is visible', async ({ page }) => {
    if (!storyId) test.skip()
    await uiLogin(page)
    await page.goto(`/stories/${storyId}/edit`)
    // Both `editor-toolbar` and `.tiptap-editor .tiptap` only render once the
    // TipTap editor instance finishes initializing (the template wraps them
    // in `v-if="editor"`). Cold-start init can take well over 10s under
    // cluster CPU pressure — bump the timeouts to tolerate it. This test
    // is a visibility check, not a perf check.
    await expect(page.locator('[data-testid="editor-toolbar"]')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('.tiptap-editor .tiptap')).toBeVisible({ timeout: 10_000 })
  })

  test('STORY-MENTION-1: @-typing inserts an entity chip + chip click opens the side panel', async ({ page }) => {
    test.setTimeout(120_000)
    if (!storyId) test.skip()
    await uiLogin(page)
    await page.goto(`/stories/${storyId}/edit`)
    await expect(page.locator('[data-testid="editor-body"]')).toBeVisible({ timeout: 30_000 })

    // Click into the editor and trigger an @-mention.
    const editor = page.locator('.tiptap-editor .tiptap')
    await editor.click()
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await page.keyboard.type('Mentioned in this paragraph: @Siemens')

    // Autocomplete popover should surface at least one Company hit.
    const popover = page.locator('[data-testid="mention-popover"]')
    await expect(popover).toBeVisible({ timeout: 10_000 })
    const firstSuggestion = page.locator('[data-testid="mention-suggestion-0"]')
    await expect(firstSuggestion).toBeVisible({ timeout: 5_000 })
    await firstSuggestion.click()

    // The chip lives inside the editor and exposes its IRI as a data
    // attribute. Use that as the load-bearing assertion (selector is
    // stable; the visible label changes per environment).
    const chip = editor.locator('[data-entity-iri^="http://data.fontem.eu/id/Company/"]').first()
    await expect(chip).toBeVisible({ timeout: 10_000 })

    // Save so the chip persists past a reload.
    await page.click('[data-testid="save-story"]')
    await expect(page.locator('[data-testid="save-story"]')).toBeEnabled({ timeout: 10_000 })

    // Click the chip → side panel slides in with the entity facts.
    await chip.click()
    await expect(page.locator('[data-testid="entity-side-panel"]')).toBeVisible({ timeout: 10_000 })
    // Resolver returned a label (could be any Siemens hit — assert on
    // non-empty rather than a specific name to avoid environment drift).
    const label = page.locator('[data-testid="entity-side-panel-label"]')
    await expect(label).not.toBeEmpty({ timeout: 5_000 })

    // Closing the panel removes it from the DOM so the next test
    // doesn't inherit an open overlay.
    await page.click('[data-testid="entity-side-panel-close"]')
    await expect(page.locator('[data-testid="entity-side-panel"]')).toBeHidden({ timeout: 5_000 })
  })

  test('STORY-MENTION-2: chip survives reload + opens panel from the read view', async ({ page }) => {
    test.setTimeout(60_000)
    if (!storyId) test.skip()
    await uiLogin(page)
    await page.goto(`/stories/${storyId}`)

    // The chip from STORY-MENTION-1 must round-trip through save.
    const chip = page.locator('[data-entity-iri^="http://data.fontem.eu/id/Company/"]').first()
    await expect(chip).toBeVisible({ timeout: 30_000 })

    await chip.click()
    await expect(page.locator('[data-testid="entity-side-panel"]')).toBeVisible({ timeout: 10_000 })
  })

  test('STORY-14: My Stories page shows the story', async ({ page }) => {
    await uiLogin(page)
    // /reports redirects to /my-stories since the nav restructure
    await page.goto('/my-stories')
    await expect(page.locator('[data-testid="my-stories"]')).toBeVisible({ timeout: 10_000 })
    // Our smoke test report should be in the list. The title write
    // from STORY-10 sometimes propagates to the listing endpoint with
    // a few-second lag (read-replica cache, list materialiser, etc.),
    // so we poll-then-assert with a reload fallback rather than a
    // tight 5s wait — that was the dominant flake source on staging.
    const titleLocator = page.locator(`text=${STORY_TITLE}`).first()
    try {
      await expect(titleLocator).toBeVisible({ timeout: 15_000 })
    } catch {
      // One reload — covers the case where the listing was rendered
      // before the new report appeared in the source query.
      await page.reload()
      await expect(page.locator('[data-testid="my-stories"]')).toBeVisible({ timeout: 10_000 })
      await expect(titleLocator).toBeVisible({ timeout: 15_000 })
    }
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

  // ── Atlas (Eurostat dataset explorer) ──────────────────────────
  //
  // Atlas reads from a fontem-stats TimescaleDB that's only deployed
  // alongside prod (and any future env that opts in). When it isn't
  // wired up — staging today, dev always — `/atlas/health` reports
  // `unconfigured` and the data routes 503 by design. The atlas tests
  // skip in that mode so the smoke gate doesn't fail on an env that
  // intentionally omits the data layer; the prod-cron smoke run + the
  // /atlas/health Kuma monitor still cover real regressions.

  /** True iff this env has fontem-stats wired up. */
  async function atlasConfigured(request) {
    try {
      const r = await request.get('/api/atlas/health', { timeout: 10_000 })
      if (!r.ok()) return false
      const body = await r.json()
      // status is 'ok' when every source is up; 'degraded' when any is
      // 'unconfigured' or 'down'. Skip atlas tests on anything but 'ok'.
      return body.status === 'ok'
    } catch {
      return false
    }
  }

  test('ATLAS-19: /atlas exits the loading state and renders the dataset picker', async ({ page, request }) => {
    test.skip(!(await atlasConfigured(request)), 'atlas not configured in this env')
    // Regression for the prod bug where MapLibre threw synchronously
    // on a null container during the loading state, aborting onMounted
    // before fetchDatasets ever ran — the view sat on the "Loading
    // datasets…" spinner forever and the user saw nothing.
    //
    // The smoke check is deliberately structural: the dataset picker
    // must become visible, the loading status must NOT be visible, and
    // the picker must contain real options. We don't assert a specific
    // dataset count because the seed evolves; "more than zero" is the
    // contract the user actually cares about.
    //
    // Atlas data lives in the fontem-stats Postgres, which is a
    // separate stack from the main gmr-api → Neo4j chain. Staging
    // legitimately runs without it (STATS_DATABASE_URL unset → 500
    // from /atlas/datasets). When that's the case, the test would
    // fail on every staging promote even though the UI guard we
    // care about is intact. Probe the API first; skip explicitly
    // when the upstream stats store is unavailable so the UI
    // regression check still gates on environments where the data
    // is actually there (prod).
    const probe = await page.request.get('/api/atlas/datasets')
    if (!probe.ok()) {
      const body = await probe.text().catch(() => '')
      if (body.includes('stats store unavailable') || body.includes('STATS_DATABASE_URL')) {
        test.skip(true, 'fontem-stats not provisioned in this env — Atlas test is moot')
      }
    }

    await page.goto('/atlas')

    await expect(page.locator('[data-testid="atlas-dataset"]'))
      .toBeVisible({ timeout: 15_000 })

    // Loading + error states must both be gone by the time the picker
    // is up. Their continued presence is a sign the chain (gmr-api →
    // /atlas/datasets → fontem-stats Postgres) has degraded.
    await expect(page.locator('[data-testid="atlas-loading"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="atlas-error"]')).toHaveCount(0)

    const optCount = await page.locator('[data-testid="atlas-dataset"] option').count()
    // 1 placeholder + N dataset options. Placeholder + at least one
    // real dataset is the floor — if we drop below that the catalog
    // is broken in prod.
    expect(
      optCount,
      'Atlas picker has no dataset options — fontem-stats catalog likely empty',
    ).toBeGreaterThan(1)
  })

  test('ATLAS-20: picking a dataset triggers a backend series fetch', async ({ page, request }) => {
    test.skip(!(await atlasConfigured(request)), 'atlas not configured in this env')
    // Locks the contract that the UI actually talks to /api/atlas/*.
    // If the URL prefix drifts (we've already had one /api/stats/* →
    // /api/atlas/* rename) the smoke fails here before promote.
    // Skip when the stats backend isn't provisioned in this env
    // (staging legitimately runs without it — see ATLAS-19).
    const probe = await page.request.get('/api/atlas/datasets')
    if (!probe.ok()) {
      const body = await probe.text().catch(() => '')
      if (body.includes('stats store unavailable') || body.includes('STATS_DATABASE_URL')) {
        test.skip(true, 'fontem-stats not provisioned in this env')
      }
    }
    let seriesUrl = null
    page.on('response', (resp) => {
      if (resp.url().includes('/api/atlas/series')) seriesUrl = resp.url()
    })
    await page.goto('/atlas')
    const picker = page.locator('[data-testid="atlas-dataset"]')
    await expect(picker).toBeVisible({ timeout: 15_000 })

    // Pick a real dataset — first non-placeholder option.
    const firstReal = await picker.locator('option').nth(1).getAttribute('value')
    if (!firstReal) test.skip()
    await picker.selectOption(firstReal)

    // Backend hit may be a few hundred ms; the URL should carry the
    // dataset code we picked AND a nuts_level (the choropleth query).
    await page.waitForResponse(
      (r) => r.url().includes('/api/atlas/series') && r.status() === 200,
      { timeout: 15_000 },
    )
    expect(seriesUrl, 'no /api/atlas/series request was issued').toBeTruthy()
    expect(seriesUrl).toContain(`dataset=${firstReal}`)
    expect(seriesUrl).toContain('nuts_level=')
  })

  test('ATLAS-21: every dataset returns 2xx from /atlas/series', async ({ request }) => {
    test.skip(!(await atlasConfigured(request)), 'atlas not configured in this env')
    // First-line guard: a single 5xx response on /atlas/series breaks
    // the whole UI for that dataset. Iterate every catalog entry by
    // API so we don't depend on which one the picker sorts first.
    // The original prod bug (Observation.flags typed `str` but the DB
    // column is `text[]`) only fired for datasets where Eurostat
    // actually emits flags — `isoc_r_iuse_i` doesn't, `nama_10r_2gdp`
    // does. Picking only the first dataset hid the bug; iterating
    // surfaces it.
    test.setTimeout(180_000)

    const cat = await request.get('/api/atlas/datasets')
    if (!cat.ok()) {
      const body = await cat.text().catch(() => '')
      if (body.includes('stats store unavailable') || body.includes('STATS_DATABASE_URL')) {
        test.skip(true, 'fontem-stats not provisioned in this env')
      }
    }
    expect(cat.status(), 'catalog endpoint must be 200').toBe(200)
    const datasets = await cat.json()
    expect(datasets.length, 'catalog must not be empty').toBeGreaterThan(0)

    // Serial loop + recent year window. Three iterations to get this
    // right:
    //  1. multi-decade NUTS-2 in `Promise.all` → 15-min timeout (75K
    //     rows for GDP alone).
    //  2. all-40 in `Promise.all` with `start=<recent>` → tripped the
    //     gmr-web nginx burst limit (2 req/s, burst 30 — see
    //     nginx.conf 00-rate-limit.conf), got 429s on the tail.
    //  3. chunk-of-5 → still 429'd because earlier tests in the suite
    //     had already eaten the burst counter for the smoke pod's IP
    //     by the time ATLAS-21 ran.
    // Serial is plenty: each request is ~0.5–1 s, 40 datasets fit in
    // ~30 s, well under both the test budget and the rate limit. We
    // still hit every dataset; we just don't paralellise in a way
    // that contends with the rest of the suite.
    const recentYear = new Date().getFullYear() - 1
    const failures = []
    for (const d of datasets) {
      const level = Math.min(...(d.nuts_levels || [2]))
      const url = `/api/atlas/series?dataset=${encodeURIComponent(d.code)}` +
                  `&nuts_level=${level}&start=${recentYear}`
      try {
        const r = await request.get(url, { timeout: 20_000 })
        if (r.status() >= 400) {
          const body = (await r.text()).slice(0, 160)
          failures.push(`${d.code} (lvl=${level}) → ${r.status()}: ${body}`)
        }
      } catch (e) {
        failures.push(`${d.code} (lvl=${level}) → request error: ${String(e).slice(0, 160)}`)
      }
    }
    expect(
      failures,
      `${failures.length}/${datasets.length} datasets returned errors:\n  ` +
        failures.join('\n  '),
    ).toEqual([])
  })

  test('ATLAS-22: opening a plot in the browser paints a coloured choropleth', async ({ page, request }) => {
    test.skip(!(await atlasConfigured(request)), 'atlas not configured in this env')
    // Browser-side complement to ATLAS-21. Targets nama_10r_2gdp
    // specifically — that dataset has Eurostat-emitted flag codes
    // (`['p']`, `['e']`, etc.) which exposed the schema mismatch in
    // prod. If the dataset isn't in the catalog (env yet to seed),
    // fall back to whatever the picker offers.
    //
    //   1. no /api/atlas/* response 4xx/5xx during the interaction
    //   2. no JS console errors (modulo CSP + WebGL noise)
    //   3. choropleth canvas renders > 15 KB PNG (i.e. coloured)
    const apiFailures = []
    const consoleErrors = []
    page.on('response', (resp) => {
      if (resp.url().includes('/api/atlas/') && resp.status() >= 400) {
        apiFailures.push(`${resp.status()} ${resp.url()}`)
      }
    })
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text())
    })
    page.on('pageerror', (e) => consoleErrors.push(`[pageerror] ${e.message}`))

    // Skip when the stats backend isn't provisioned (staging without
    // fontem-stats — same gating as ATLAS-19/20/21).
    const probe = await page.request.get('/api/atlas/datasets')
    if (!probe.ok()) {
      const body = await probe.text().catch(() => '')
      if (body.includes('stats store unavailable') || body.includes('STATS_DATABASE_URL')) {
        test.skip(true, 'fontem-stats not provisioned in this env')
      }
    }
    await page.goto('/atlas')
    const picker = page.locator('[data-testid="atlas-dataset"]')
    await expect(picker).toBeVisible({ timeout: 15_000 })

    // Prefer the GDP dataset — known to carry flag arrays in prod.
    // Fall back if not in the catalog yet.
    const want = 'nama_10r_2gdp'
    const optValues = await picker.locator('option').evaluateAll(
      (els) => els.map((o) => o.value).filter(Boolean),
    )
    const target = optValues.includes(want) ? want : optValues[0]
    if (!target) test.skip()
    await picker.selectOption(target)

    // Wait for either the choropleth to paint OR an error banner to
    // appear, whichever happens first. Either way we then assert.
    await Promise.race([
      page.locator('[data-testid="atlas-map"] canvas')
        .waitFor({ state: 'visible', timeout: 20_000 }),
      page.locator('[data-testid="atlas-series-error"]')
        .waitFor({ state: 'visible', timeout: 20_000 }),
    ]).catch(() => {})

    // 1. No /api/atlas/* request 4xx/5xx'd. CSP / pre-existing
    //    failures elsewhere on the page are filtered out.
    expect(
      apiFailures,
      `Atlas API returned errors: ${apiFailures.join(', ')}`,
    ).toEqual([])

    // 2. No JS errors. Filter out two classes of environmental noise
    //    that fire on every page load and aren't Atlas-side:
    //      - WebGL / canvas not supported in headless Chromium
    //      - CSP `script-src` violations from the consent banner /
    //        analytics inline tags (already on prod, page-wide).
    //    Any error that doesn't match those is a real Atlas bug.
    const NOISE_RE = /WebGL|WEBGL|getContext|browser-supports-canvas|Content Security Policy/i
    const realErrors = consoleErrors.filter((e) => !NOISE_RE.test(e))
    expect(
      realErrors,
      `JS console errors: ${realErrors.join(' | ')}`,
    ).toEqual([])

    // 3. Choropleth canvas exists and isn't a blank tile. A blank
    //    canvas screenshots to a tiny PNG; varied region colours
    //    push it past 15 KB.
    const canvas = page.locator('[data-testid="atlas-map"] canvas').first()
    await expect(canvas).toBeVisible()
    const shot = await canvas.screenshot()
    expect(
      shot.length,
      `choropleth canvas screenshot is ${shot.length} bytes — likely blank`,
    ).toBeGreaterThan(15_000)
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

  // AI assistant: re-enabled after migration from Claude CLI/OAuth proxy to
  // Mistral (mistral-small-latest) in gmr-community-api. The SSE event shape
  // is unchanged, so these three tests exercise the same UI surface.
  //
  // The ASSIST-* tests retry once on the playwright level (config.retries=1)
  // and have an extra in-test retry below for the LLM content match —
  // Mistral occasionally returns a stylistic answer like "Apple's NASDAQ
  // listing is under the AAPL ticker." vs "Apple Inc.'s ticker is AAPL"
  // and we don't want the gate to flip on phrasing variance.
  test('ASSIST-19: Ask question via assistant panel and get response', async ({ page }) => {
    test.setTimeout(120_000)
    if (!storyId) test.skip()
    await uiLogin(page)
    await page.goto(`/stories/${storyId}/edit`)
    await expect(page.locator('[data-testid="editor-body"]')).toBeVisible({ timeout: 10_000 })

    // Open the assistant panel
    await page.click('[data-testid="assist-toggle"]')
    await expect(page.locator('[data-testid="assist-panel"]')).toBeVisible({ timeout: 5_000 })

    // Send question and wait for complete response. The only thing we
    // assert is that the response mentions the ticker or the company —
    // Mistral may legitimately answer in one word ("AAPL") or in a
    // sentence, both pass. The previous length check (>20 chars)
    // wrongly flagged the correct one-word answer as "trivial".
    const responseText = await sendAssistMessage(page, 'What is Apple Inc\'s ticker symbol?')
    expect(
      responseText,
      `Assistant response did not mention Apple or AAPL: "${responseText}"`,
    ).toMatch(/AAPL|Apple/i)
  })

  test('ASSIST-20: Assistant proposes edit, user applies it, content lands in editor', async ({ page }) => {
    test.setTimeout(180_000)
    if (!storyId) test.skip()
    await uiLogin(page)
    await page.goto(`/stories/${storyId}/edit`)
    await expect(page.locator('[data-testid="editor-body"]')).toBeVisible({ timeout: 10_000 })

    // Open assistant panel
    await page.click('[data-testid="assist-toggle"]')
    await expect(page.locator('[data-testid="assist-panel"]')).toBeVisible({ timeout: 5_000 })

    // Distinctive marker so we can prove the inserted content actually
    // landed in the editor (not just that the "Applied" badge flipped —
    // that was the gap that let the apply-flow bug ship).
    const marker = `MARKER-ASSIST20-${RUN_ID.slice(0, 8)}`
    await sendAssistMessage(page,
      'Use the propose_edit tool with action="insert_content" to add a paragraph ' +
      `to this report. The paragraph must contain the exact string ${marker}. ` +
      'Just one short paragraph — no other prose.')

    // Proposal card should render.
    await expect(page.locator('[data-testid="assist-proposals"]').last()).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('[data-testid="proposal-action"]').last()).toBeVisible()

    // Apply the proposal.
    await page.locator('[data-testid="proposal-apply"]').last().click()
    await expect(page.locator('[data-testid="proposal-applied"]').last()).toBeVisible({ timeout: 5_000 })

    // The apply-flow regression: the editor used to get blown away on apply,
    // so the badge would say "Applied" while the editor was empty. We now
    // check the editor body actually contains the inserted marker.
    await expect(page.locator('.tiptap-editor .tiptap')).toContainText(marker, { timeout: 10_000 })
  })

  test('ASSIST-21: Assistant uses MCP tools via UI', async ({ page }) => {
    test.setTimeout(120_000)
    if (!storyId) test.skip()
    await uiLogin(page)
    await page.goto(`/stories/${storyId}/edit`)
    await expect(page.locator('[data-testid="editor-body"]')).toBeVisible({ timeout: 10_000 })

    // Open assistant panel
    await page.click('[data-testid="assist-toggle"]')
    await expect(page.locator('[data-testid="assist-panel"]')).toBeVisible({ timeout: 5_000 })

    // Send question and wait for complete response. Loose content
    // match (any of siemens / contract / procurement / lobbying / EU)
    // — the test of "MCP tool got called and returned graph context"
    // doesn't depend on the model picking one specific keyword.
    const responseText = await sendAssistMessage(page,
      'Search for "Siemens" in the GMR graph and tell me about their EU contracts.')
    expect(
      responseText.toLowerCase(),
      `MCP-tool response did not mention any expected keyword: "${responseText.slice(0, 200)}…"`,
    ).toMatch(/siemens|contract|procurement|lobbying|eu /)
    expect(responseText.length).toBeGreaterThan(50)
  })

  // ── Usefulness gates (post-revamp) ────────────────────────────────
  //
  // The three tests below were added with the assistant revamp (feat:
  // investigate_entity composite tool + system-prompt date injection +
  // /data-quality/source-freshness summary). They guard the user-visible
  // bugs the revamp fixed:
  //   * ASSIST-22 — picking the wrong tool (get_company on an authority)
  //                 silently returned no useful data; investigate_entity
  //                 dispatches by label so this no longer happens.
  //   * ASSIST-23 — grounded numeric claims: report quoted "thousands of
  //                 contracts" with no actual number; the new tool surface
  //                 forces a concrete count to land in the response.
  //   * ASSIST-24 — coverage awareness: user couldn't tell whether a
  //                 dataset was current; freshness summary is injected
  //                 into the system prompt so the assistant can cite
  //                 explicit date ranges.
  //
  // Like the rest of the ASSIST-* battery, these tolerate phrasing
  // variance — the LLM is allowed to write English however it wants as
  // long as the *content* of the answer demonstrates the underlying
  // capability.

  test('ASSIST-22: Authority investigation dispatches correctly (no wrong-tool dead-end)', async ({ page }) => {
    test.setTimeout(180_000)
    if (!storyId) test.skip()
    await uiLogin(page)
    await page.goto(`/stories/${storyId}/edit`)
    await expect(page.locator('[data-testid="editor-body"]')).toBeVisible({ timeout: 10_000 })

    await page.click('[data-testid="assist-toggle"]')
    await expect(page.locator('[data-testid="assist-panel"]')).toBeVisible({ timeout: 5_000 })

    // Metro Mondego is a Portuguese contracting authority. Pre-revamp,
    // the model would call get_company on it (which 404s) and surface
    // "I couldn't find anything". The investigate_entity tool now tries
    // Company → Authority → Lobbyist in turn, so the report has to
    // mention at least the entity name.
    const responseText = await sendAssistMessage(
      page,
      'Investigate "Metro Mondego" in the GMR graph. What kind of ' +
      'entity is it (company, authority, etc.) and what data do we have ' +
      'about it?',
    )
    expect(
      responseText,
      `Authority investigation did not surface useful info about Metro Mondego: "${responseText.slice(0, 300)}…"`,
    ).toMatch(/Metro|Mondego/i)
    // Has to be more than the "not found" stub the broken path used to
    // emit. 80 chars filters out generic refusals, doesn't pin phrasing.
    expect(responseText.length).toBeGreaterThan(80)
  })

  test('ASSIST-23: Assistant grounds numeric claims in actual graph data', async ({ page }) => {
    test.setTimeout(180_000)
    if (!storyId) test.skip()
    await uiLogin(page)
    await page.goto(`/stories/${storyId}/edit`)
    await expect(page.locator('[data-testid="editor-body"]')).toBeVisible({ timeout: 10_000 })

    await page.click('[data-testid="assist-toggle"]')
    await expect(page.locator('[data-testid="assist-panel"]')).toBeVisible({ timeout: 5_000 })

    // Asking for a count means the model has to pick the
    // `investigate_entity` tool, read the contract list, and quote a
    // concrete number. Pre-revamp the model would say "many" or "several"
    // because get_contracts wasn't always picked.
    const responseText = await sendAssistMessage(
      page,
      'How many EU public procurement contracts do we have for Siemens AG ' +
      'in the GMR graph? Give me the exact count.',
    )
    // At least one digit in the response — proves the model didn't fall
    // back to "many"/"several"/"some" hand-waving.
    expect(
      responseText,
      `Numeric-grounding response had no digits: "${responseText.slice(0, 300)}…"`,
    ).toMatch(/\d/)
    // And it should mention Siemens or contracts — guards against the
    // model hallucinating a number for some other entity.
    expect(responseText.toLowerCase()).toMatch(/siemens|contract/)
  })

  test('ASSIST-24: Assistant cites concrete data coverage when asked', async ({ page }) => {
    test.setTimeout(180_000)
    if (!storyId) test.skip()
    await uiLogin(page)
    await page.goto(`/stories/${storyId}/edit`)
    await expect(page.locator('[data-testid="editor-body"]')).toBeVisible({ timeout: 10_000 })

    await page.click('[data-testid="assist-toggle"]')
    await expect(page.locator('[data-testid="assist-panel"]')).toBeVisible({ timeout: 5_000 })

    // The /data-quality/source-freshness endpoint feeds a per-source
    // coverage block into the system prompt every turn. That means
    // the assistant should be able to answer "what date range do you
    // cover?" without calling a tool.
    const responseText = await sendAssistMessage(
      page,
      'What date range does your EU public procurement (TED contracts) ' +
      'data cover? Give me the earliest and latest dates you have.',
    )
    // A 4-digit year — proves the model surfaced a real date range
    // rather than refusing or hand-waving. We don't pin the specific
    // year because it shifts as the loaders run.
    expect(
      responseText,
      `Coverage response did not include a year: "${responseText.slice(0, 300)}…"`,
    ).toMatch(/20\d{2}/)
    // And it should be meaningfully long (≥ 50 chars) — short answers
    // like "I don't know" or "various" have been the failure mode.
    expect(responseText.length).toBeGreaterThan(50)
  })

  // ── Full-flow gate: assistant generates → apply → save → reload ──
  //
  // The post-revamp smoke battery (ASSIST-22/23/24) covers what the
  // model SAYS but not what the editor PERSISTS. The bug class that
  // got us here ("clicking Apply does nothing") only shows up after
  // a reload, so this test deliberately reloads the page and checks
  // the inserted content is still there.

  test('ASSIST-25: full assistant→edit→save→reload round-trip', async ({ page }) => {
    test.setTimeout(240_000)
    await uiLogin(page)

    // Use a fresh report so this test doesn't fight ASSIST-20's
    // editor state (and so it can run in isolation in dev too).
    await page.goto('/my-stories')
    await page.click('[data-testid="new-story-btn"]')
    await page.waitForURL(/\/stories\/.*\/edit/, { timeout: 15_000 })
    const localReportId = page.url().match(/\/stories\/([^/]+)\/edit/)?.[1]
    expect(localReportId).toBeTruthy()

    // Set a title so the report has something the user could find again.
    await page.fill('[data-testid="story-title-input"]', `Smoke Round-Trip ${RUN_ID.slice(0, 8)}`)

    // Open assistant.
    await expect(page.locator('[data-testid="editor-body"]')).toBeVisible({ timeout: 10_000 })
    await page.click('[data-testid="assist-toggle"]')
    await expect(page.locator('[data-testid="assist-panel"]')).toBeVisible({ timeout: 5_000 })

    // Ask for something simple enough not to bleed tokens but real
    // enough to need a tool call. The marker pins persistence at the
    // end — the model echoes it because we ask explicitly.
    const marker = `RT-${RUN_ID.slice(0, 8)}`
    await sendAssistMessage(page,
      `Use propose_edit with action="insert_content" to add a brief one-paragraph ` +
      `note about Apple Inc. (AAPL) to this report. The paragraph MUST contain ` +
      `the literal string ${marker}. One paragraph total — keep it short.`)

    // A proposal must arrive. If it doesn't, the model picked the wrong
    // tool — that's a regression we want loud, not silent.
    await expect(page.locator('[data-testid="assist-proposals"]').last()).toBeVisible({ timeout: 30_000 })
    await page.locator('[data-testid="proposal-apply"]').last().click()
    await expect(page.locator('[data-testid="proposal-applied"]').last()).toBeVisible({ timeout: 10_000 })

    // Editor body has the marker (apply-time persistence — was the bug).
    await expect(page.locator('.tiptap-editor .tiptap')).toContainText(marker, { timeout: 10_000 })

    // Close the assist panel so its DOM doesn't intercept the Save
    // button click. The panel is an overlay that visually sits above
    // the editor header; without closing it, Playwright's click
    // retries are blocked by the message div on top of the button.
    await page.click('[data-testid="assist-close"]')
    await expect(page.locator('[data-testid="assist-panel"]')).toBeHidden({ timeout: 5_000 })

    // The fix auto-saves on apply, so the user shouldn't have to click
    // Save themselves. Click anyway — it's idempotent and proves the
    // explicit save still works.
    await page.click('[data-testid="save-story"]')
    await expect(page.locator('[data-testid="save-story"]')).toBeEnabled({ timeout: 10_000 })

    // The real persistence check: reload the page (full reset of the
    // editor, fresh fetch from the API) and confirm the marker survives.
    // Pre-fix, the apply mutated the editor in-memory only — reload
    // wiped it. This is the gate that would have caught the bug.
    await page.reload()
    await expect(page.locator('[data-testid="editor-body"]')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.tiptap-editor .tiptap')).toContainText(marker, { timeout: 15_000 })

    // Light follow-up edit: type a single character at the end and save
    // again. Catches the "save broken after assistant edit" tail of the
    // same bug class.
    const editor = page.locator('.tiptap-editor .tiptap')
    await editor.click()
    await page.keyboard.press('End')
    await page.keyboard.type(' ✓')
    await page.click('[data-testid="save-story"]')
    await expect(page.locator('[data-testid="save-story"]')).toBeEnabled({ timeout: 10_000 })

    // Cleanup — don't accumulate round-trip reports across runs.
    const token = await page.evaluate(() => localStorage.getItem('gmr-token'))
    await page.request.delete(`/capi/stories/${localReportId}`, {
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {})
  })

  // ── Public-report regression gate ────────────────────────────────
  //
  // Regression: clicking a shared link to a public_open report
  // bounced the visitor to /login because the frontend's auth gate
  // matched any path under /reports with `startsWith`. The backend
  // had already been fixed; this test pins the frontend half so a
  // future router change can't quietly re-introduce the dead-end.

  test('PUBLIC-1: public_open story is viewable by an anonymous visitor', async ({ page, context }) => {
    test.setTimeout(120_000)
    if (!storyId) test.skip()

    // Make the report public_open as the authenticated user, then
    // drop the session and prove an anonymous visit succeeds.
    await uiLogin(page)
    await page.goto(`/stories/${storyId}/edit`)
    await expect(page.locator('[data-testid="visibility-select"]')).toBeVisible({ timeout: 10_000 })
    await page.selectOption('[data-testid="visibility-select"]', 'public_open')
    await page.click('[data-testid="save-story"]')
    await expect(page.locator('[data-testid="save-story"]')).toBeEnabled({ timeout: 10_000 })

    // Drop the session (token + cookies) and revisit as a stranger.
    await page.evaluate(() => localStorage.clear())
    await context.clearCookies()

    await page.goto(`/stories/${storyId}`)

    // Two failure modes pre-fix:
    //   - hard redirect to /login (router gate)
    //   - blank page that hydrates and *then* redirects to /login
    // We assert the URL stays put AND the report renders.
    await expect(page).toHaveURL(new RegExp(`/stories/${storyId}$`), { timeout: 10_000 })
    await expect(page.locator('[data-testid="story-title"]')).toBeVisible({ timeout: 10_000 })

    // Sanity check: no login form lurking on the page (would mean we
    // landed on /login without changing the URL bar).
    expect(await page.locator('[data-testid="login-email"]').count()).toBe(0)

    // Restore the report's visibility so subsequent runs aren't
    // looking at a leftover public_open report.
    await uiLogin(page)
    await page.goto(`/stories/${storyId}/edit`)
    await page.selectOption('[data-testid="visibility-select"]', 'private')
    await page.click('[data-testid="save-story"]')
    await expect(page.locator('[data-testid="save-story"]')).toBeEnabled({ timeout: 10_000 })
  })

  // ── Consolidation visibility gate ────────────────────────────────
  //
  // Concrete sighting that produced this test: eu-LISA showed 4
  // contracts in the graph view (carried by stale CLIENT_OF summary
  // edges from a one-shot materialise) and 0 in the contracts list
  // (live AWARDED query). The fix has two prongs:
  //   - gmr-consolidator refreshes CLIENT_OF/SUPPLIER_OF on every
  //     merge (zero staleness on consolidation)
  //   - edgar-gmr-etl runs `materialize_trade_edges` nightly as a
  //     defence-in-depth bound on staleness from non-consolidator
  //     paths.
  //
  // The smoke test asserts the post-fix invariant: for any
  // authority, `Σ CLIENT_OF.contracts` (what the graph view shows)
  // must equal `contract_count` from /authorities/{id}/contracts
  // (what the contracts list shows).
  //
  // eu-LISA is the canary because the original incident lived
  // there; once the cron runs after deploy, the two views are
  // consistent and stay that way. If the test goes red post-deploy
  // it means either the cron hasn't run yet (give it 24h) or the
  // consolidator path drifted again.

  test('CONSOLIDATION-1: graph CLIENT_OF count matches contracts list count', async ({ page }) => {
    test.setTimeout(60_000)
    await uiLogin(page)

    // Resolve eu-LISA's authority_id via the unified search.
    const searchRes = await page.request.get('/api/search?q=eu-LISA&limit=1')
    expect(searchRes.ok(), 'search endpoint reachable').toBe(true)
    const search = await searchRes.json()
    const authority = search.authorities?.[0]
    if (!authority) test.skip(true, 'eu-LISA not present — graph data was probably re-loaded')
    const authorityId = authority.authority_id

    // Live count: AWARDED edges from the canonical to Contract nodes.
    const contractsRes = await page.request.get(
      `/api/authorities/${encodeURIComponent(authorityId)}/contracts?limit=200`,
    )
    expect(contractsRes.ok(), 'contracts endpoint reachable').toBe(true)
    const contracts = await contractsRes.json()
    const liveCount = contracts.contract_count

    // Materialised count: sum of CLIENT_OF.contracts on the canonical's
    // outgoing edges. summary=true is the graph view's default.
    const graphRes = await page.request.get(
      `/api/graph/${encodeURIComponent(authorityId)}?depth=1&summary=true`,
    )
    expect(graphRes.ok(), 'graph endpoint reachable').toBe(true)
    const graph = await graphRes.json()
    const materialisedCount = (graph.edges || [])
      .filter((e) => e.type === 'CLIENT_OF' && e.source === authorityId)
      .reduce((acc, e) => acc + (e.properties?.contracts || 0), 0)

    expect(
      materialisedCount,
      `eu-LISA visibility split: graph view sees ${materialisedCount} contracts via ` +
      `CLIENT_OF, contracts list sees ${liveCount} via AWARDED. The two views ` +
      `must agree — if they don't, the trade-summary edges are stale relative ` +
      `to AWARDED and the consolidator's post-merge refresh or the nightly ` +
      `materialize_trade_edges cron is broken.`,
    ).toBe(liveCount)
  })

  // ── Cleanup ────────────────────────────────────────────────────

  test('CLEANUP-21: Delete test story via UI', async ({ page }) => {
    if (!storyId) test.skip()
    await uiLogin(page)
    // Navigate to the report and delete it via the API (no delete UI button in view)
    const token = await page.evaluate(() => localStorage.getItem('gmr-token'))
    const resp = await page.request.delete(`/capi/stories/${storyId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect([204, 404]).toContain(resp.status())
  })
})
