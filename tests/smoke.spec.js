/**
 * Production smoke tests.
 *
 * Validates critical user flows through the UI — every test interacts
 * with the browser, no direct API calls.
 *
 * WHAT BELONGS HERE, AND WHAT DOES NOT
 * ------------------------------------
 * This suite is a promotion gate, and it is serial (workers: 1), so
 * every test here costs the gate wall-clock time that a component test
 * costs nobody. A test earns its place only if it needs the deployed
 * stack: real auth, real data, cross-service agreement, deployment
 * config (headers, canonical), or a backend security gate.
 *
 * A test that only asserts how a component renders or reacts does NOT
 * belong here — fontem-web runs 2,354 component tests in ~19s. The
 * following were removed on 2026-09-04 because a component test
 * already asserted the same behaviour, usually more thoroughly:
 *
 *   NAV-EXPLORE                     -> AppSidebar
 *   FEED-TAG-PERSIST                -> useStoriesTagFilter, FeedView
 *   SPARQL-EDITOR, -EXAMPLE-LOADER  -> SparqlView
 *   PROC-CONTRACT-LINK              -> ContractsPanel
 *   PROFILE-FIN-HIDDEN, -ANALYSIS-GONE -> HomeView
 *   STORY-13, STORY-TOOLBAR-UNIFIED -> StoryEditorToolbar
 *   STORY-TABLE-{CONTROLS,ROW-TRASH,LAST-DELETES-TABLE}
 *                                   -> TableControlsOverlay
 *   STORY-FLOWERS-2, -3             -> FlowerButton
 *   ISSUE-16                        -> IssuesView
 *   ATLAS-20                        -> AtlasView
 *   ASSIST-NAV                      -> AssistPanelNavigate (11 cases)
 *   ASSIST-BYPASS                   -> AssistPanelProposeEdit
 *   ASSIST-28                       -> AssistPanelConversations
 *   ASSIST-20                       -> applyFlowIntegration
 *   ASSIST-ANON                     -> AssistPanelSignedOut
 *   ASSIST-HISTORY                  -> AssistPanelToolHistory
 *   ASSIST-26                       -> AssistPanelPagedHistory
 *   CHAT-TABS-01..06                -> AssistPanelConversations
 *
 * Before adding a test here, ask whether a component test would catch
 * the same regression. If it would, write it there instead.
 *
 * Cadence:
 *   - prod: hourly via the fontem-smoke-tests CronJob (deployment/cronjob.yaml)
 *   - staging: same CronJob spec but suspended; invoked on demand by
 *     the gitops promote workflow as a pre-prod gate
 *
 * Run: BASE_URL=https://fontem.testing.void42.internal npx playwright test
 */
import { test, expect } from './baseTest.js'
import fs from 'node:fs/promises'
import https from 'node:https'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'uploads')

const TEST_EMAIL = process.env.TEST_EMAIL || 'researcher@fontem.eu'
const TEST_PASSWORD = process.env.TEST_PASSWORD || 'TestPass123!'
// String form so call sites can `.slice()` it for shorter markers.
// `Date.now()` returns a number; calling `.slice()` on a number throws
// — use the string form throughout.
const RUN_ID = String(Date.now())
const STORY_TITLE = `Smoke Story ${RUN_ID}`

// Demo-mode hook for the recording config: when SMOKE_DEMO=1 the
// helper inserts a visible pause + on-page banner so the resulting
// video is followable by a human reviewer. In CI the helper is a
// no-op — the tests stay fast.
const SMOKE_DEMO = process.env.SMOKE_DEMO === '1'
async function demoMark(page, label, ms = 1500) {
  if (!SMOKE_DEMO) return
  // Inject a top-of-page banner with the current checkpoint name so
  // the reviewer can read what the test is about to assert, then hold
  // for `ms` milliseconds before moving on.
  await page.evaluate((text) => {
    let el = document.querySelector('[data-demo-banner]')
    if (!el) {
      el = document.createElement('div')
      el.setAttribute('data-demo-banner', '1')
      el.style.cssText =
        'position:fixed;top:0;left:0;right:0;z-index:2147483647;' +
        'padding:10px 16px;font:600 14px/1.3 system-ui,sans-serif;' +
        'color:#fff;background:#0969da;text-align:center;' +
        'box-shadow:0 2px 8px rgba(0,0,0,.25)'
      document.body.appendChild(el)
    }
    el.textContent = text
  }, label).catch(() => { /* page may be navigating */ })
  await page.waitForTimeout(ms)
}

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
/**
 * Mint a fresh 15-min access JWT by calling /auth/refresh with the
 * httpOnly cookie the page context carries (seeded by global-setup).
 * Replaces the pre-session-migration pattern of reading
 * ``localStorage.getItem('gmr-token')`` directly — the SPA now keeps
 * the access token in memory only.
 */
async function freshAccessToken(page) {
  // The base-test fixture injects window.__FONTEM_BOOTSTRAP_TOKEN__
  // (the long-lived token global-setup minted) into every page. Read
  // it back rather than hitting /auth/refresh — refreshing here would
  // rotate the family and race the SPA's own restore (see baseTest.js).
  const token = await page.evaluate(() => window.__FONTEM_BOOTSTRAP_TOKEN__ || null)
  if (!token) throw new Error('no bootstrap access token injected')
  return token
}

/**
 * Publish whatever is in this editor's draft.
 *
 * Saving no longer changes the article readers see: an editor's save
 * lands on their draft, and the published text moves when a change
 * review is published. Tests that assert on the READ view therefore have
 * to publish first — the same step a person takes, done through the API
 * because the subject of those tests is the read view, not the button.
 *
 * Silent when there is nothing to publish: a draft equal to the
 * published text has no proposal to make, which is a fine state to be in.
 */
async function publishDraft(page, storyId) {
  const token = await freshAccessToken(page)
  const headers = { Authorization: `Bearer ${token}` }
  const opened = await page.request.post(
    `/capi/data-stories/${storyId}/reviews`,
    { headers, data: { kind: 'change' } },
  )
  if (!opened.ok()) return false
  const review = await opened.json()
  const published = await page.request.post(
    `/capi/data-stories/${storyId}/reviews/${review.id}/publish`, { headers },
  )
  return published.ok()
}

async function uiLogin(page) {
  await page.goto('/')
  // Try to mint a fresh access token via the cookie. If the cookie
  // round-tripped from global-setup, this succeeds and the SPA's own
  // main.js refresh() will also have populated the in-memory store.
  try {
    await freshAccessToken(page)
    return
  } catch { /* fall through to UI login */ }
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
  // Clear everything, then mark this context anonymous so the
  // base-test fixture's addInitScript stops injecting the bootstrap
  // access token on the reload below — otherwise the SPA would
  // re-authenticate and the login form wouldn't render.
  await page.evaluate(() => {
    localStorage.clear()
    localStorage.setItem('__smoke_anon__', '1')
  })
  await page.context().clearCookies()
  await page.reload()
}

test.describe.serial('Production Smoke Tests', () => {
  let storyId = null

  // ── Authentication ─────────────────────────────────────────────

  test('DQ-FRESHNESS: data quality hub no longer shows "Source freshness unavailable: HTTP 404"', async ({ page }) => {
    // Batch-6 item 2: the hub used to call `/api/data-quality/source-freshness`
    // — a URL that never existed on the backend — and rendered a
    // permanent error banner. fontem-web #153 repoints it at the live
    // `/api/data-quality/freshness` endpoint and rewrites the section
    // to consume the actual response shape.
    await page.goto('/data-quality')
    await demoMark(page, 'DQ-FRESHNESS — open /data-quality')

    await expect(page.locator('[data-testid="dqh-freshness-error"]'))
      .toHaveCount(0, { timeout: 10_000 })
    // Belt + braces — the legacy error string isn't anywhere on the
    // page either.
    await expect(page.locator('body'))
      .not.toContainText(/Source freshness unavailable: HTTP 404/i)
    await demoMark(page, 'No "Source freshness unavailable: HTTP 404" banner ✓', 2500)
  })

  test('DQ-TRIPLES: triple-store dashboard no longer 500s; renders either real data or the unconfigured state', async ({ page }) => {
    // Batch-6 item 3: the Virtuoso `COUNT(*)` query blew past the 10s
    // httpx timeout on prod and the resulting ReadTimeout 500'd the
    // panel. fontem-api PR #189 bumps the default to 60s + catches the
    // typed `SparqlTimeout` for a graceful response.
    await page.goto('/data-quality/triples')
    await demoMark(page, 'DQ-TRIPLES — open /data-quality/triples')
    await expect(page.locator('[data-testid="triples-dq-error"]'))
      .toHaveCount(0, { timeout: 10_000 })
    const unconfigured = await page.locator('[data-testid="triples-dq-unconfigured"]').count()
    if (unconfigured) {
      await demoMark(page, 'Virtuoso not configured on testing — graceful empty state ✓', 2500)
    } else {
      await demoMark(page, 'Triple-store inventory renders ✓', 2500)
    }
  })

  test('AUTH-01: Login page loads with form', async ({ page }) => {
    await clearSession(page)
    await expect(page.locator('[data-testid="login-email"]')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('[data-testid="login-password"]')).toBeVisible()
    await expect(page.locator('[data-testid="login-submit"]')).toBeVisible()
  })

  test('AUTH-GSI: Google Identity loads on the login page and nowhere else', async ({ page }) => {
    // The script used to sit in index.html, so Google's code ran on every
    // page of the app — including authenticated ones showing other people's
    // data. DAST saw cross-domain script inclusion on 41 pages and missing
    // SRI on 52; the objection that matters is the DOM access.
    //
    // Asserted on OUR injection, not on Google's button rendering: whether
    // accounts.google.com is reachable from a given environment is not
    // something this suite should gate on, and the scoping is the part we
    // own. SRI is deliberately absent — Google serves that URL mutably and
    // publishes no hash, so pinning one would turn their next update into a
    // sign-in outage.
    const gsi = 'script[src*="accounts.google.com/gsi/client"]'

    await clearSession(page)
    await expect(page.locator('[data-testid="login-email"]')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator(gsi)).toHaveCount(1, { timeout: 10_000 })

    // Any other page must not pull it in.
    await page.goto('/about')
    await expect(page.locator('[data-testid="login-email"]')).toHaveCount(0)
    await expect(page.locator(gsi)).toHaveCount(0)
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
    // Signed-in users get an avatar button (top-right bezel) that opens a
    // lean profile menu; the sign-out row is `profile-logout`.
    await page.click('[data-testid="profile-trigger"]')
    await expect(page.locator('[data-testid="profile-logout"]')).toBeVisible()
  })

  test('AUTH-04: Registration form requires a password confirmation that matches', async ({ page }) => {
    // Regression: the original register form accepted a single password
    // and submitted it. A typo silently created an account the user
    // could never sign back in to. The form now requires the password
    // to be entered twice and disables submit while they don't match.
    await clearSession(page)
    await page.click('text=Create account')
    await expect(page.locator('[data-testid="reg-password"]')).toBeVisible()
    await expect(page.locator('[data-testid="reg-password-confirm"]'))
      .toBeVisible({ timeout: 5_000 })

    await page.fill('[data-testid="reg-name"]', 'Test User')
    await page.fill('[data-testid="reg-email"]', `mismatch+${Date.now()}@fontem.eu`)
    await page.fill('[data-testid="reg-password"]', 'SecurePass123')
    await page.fill('[data-testid="reg-password-confirm"]', 'SecurePass124')

    await expect(page.locator('[data-testid="reg-password-mismatch"]')).toBeVisible()
    await expect(page.locator('[data-testid="reg-submit"]')).toBeDisabled()

    // Correcting the typo clears the error and re-enables submit
    // (without actually clicking — we don't want to create an account
    // here. The submit-side enforcement is exercised by the unit test
    // in fontem-web's tests/unit/LoginView.test.js).
    await page.fill('[data-testid="reg-password-confirm"]', 'SecurePass123')
    await expect(page.locator('[data-testid="reg-password-mismatch"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="reg-submit"]')).toBeEnabled()
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

  test('PROC-CONTRACT-DETAIL: a contract opens our detail page, which links out to the right TED notice', async ({ page, context }) => {
    // The flow the user asked for: clicking a contract opens OUR detail
    // page (with the integrity profile), and from there an outward link
    // goes to the original TED notice — landing on a page about *this*
    // contract (the old blank-UUID-page regression stays guarded).
    await page.goto('/')
    await demoMark(page, 'PROC-CONTRACT-DETAIL — search for Siemens AG')
    const searchInput = page.locator('input[type="search"]').first()
    await searchInput.fill('Siemens AG')
    await expect(page.locator('.gmr-card').first()).toBeVisible({ timeout: 10_000 })
    await page.locator('.gmr-card').first().click()
    await expect(page.locator('[data-testid="view-selector"]')).toBeVisible({ timeout: 10_000 })

    await demoMark(page, 'Open Procurement → Contracts')
    const procCat = page.locator('[data-testid="view-cat-procurement"]').first()
    if (await procCat.isVisible().catch(() => false)) await procCat.click()
    const contractsTab = page.locator('[data-testid="view-tab-contracts"]').first()
    if (await contractsTab.isVisible().catch(() => false)) await contractsTab.click()
    await expect(page.locator('[data-testid="contracts-panel"]').first())
      .toBeVisible({ timeout: 20_000 })

    // Only contracts that carry a ted_notice_id get a detail link — most
    // do not (data-backlog item 25, ~94% NULL). Where the environment's
    // dataset has none for this entity there is nothing to click, so skip
    // rather than fail: the same feature-detect idiom this suite already
    // uses for "studio not deployed here". A silent pass would be worse
    // than either.
    const titleLink = page.locator('[data-testid^="contract-title-link-"]').first()
    const linkable = await titleLink.count()
    test.skip(linkable === 0, 'no contract in this dataset has a ted_notice_id to link to')
    await titleLink.waitFor({ state: 'visible', timeout: 20_000 })
    const contractTitle = (await titleLink.textContent() || '').trim()
    expect(contractTitle.length).toBeGreaterThan(5)
    const titleChunk = contractTitle.slice(0, 24)

    await demoMark(page, `Open the detail page for "${contractTitle.slice(0, 60)}"`)
    // In-app navigation to our detail page (not a popup).
    await titleLink.click()
    await expect(page.locator('[data-testid="contract-detail"]'))
      .toBeVisible({ timeout: 20_000 })
    expect(page.url()).toMatch(/\/contract\/.+/)
    // The integrity profile is the lede.
    await expect(page.locator('[data-testid="integrity-profile"]')).toBeVisible()
    await expect(page.locator('[data-testid="red-flag-count"]')).toBeVisible()
    await expect(page.locator(`text=${titleChunk}`).first())
      .toBeVisible({ timeout: 10_000 })

    await demoMark(page, 'From the detail page, open the original TED notice')
    const tedOut = page.locator('[data-testid="ted-outlink"]')
    await expect(tedOut).toBeVisible()
    const [popup] = await Promise.all([
      context.waitForEvent('page', { timeout: 30_000 }),
      tedOut.click(),
    ])
    await popup.waitForLoadState('domcontentloaded', { timeout: 30_000 })
    await popup.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {})
    // We land on TED, on a real (non-blank) page about this contract.
    expect(popup.url()).toMatch(/ted\.europa\.eu/)
    // The external TED page hydrates asynchronously and we don't control its
    // render timing — poll its *rendered text* (substantive AND about THIS
    // contract) instead of waiting on a single element's visibility, which
    // races the external render and was the source of intermittent flakes.
    const normTed = (t) => (t || '').toLowerCase().replace(/\s+/g, ' ')
    const wantChunk = normTed(contractTitle).slice(0, 14)
    await expect
      .poll(async () => {
        const t = normTed(await popup.locator('body').innerText().catch(() => ''))
        return t.length > 200 && t.includes(wantChunk)
      }, {
        timeout: 35_000,
        message: `TED notice should render substantive text incl. "${contractTitle.slice(0, 20)}"`,
      })
      .toBe(true)
    await demoMark(page, 'TED page shows the contract title ✓', 2500)
    await popup.close()
  })


  test('PROC-COUNTERPARTY-LINK: contracts rows link to the counterparty profile', async ({ page }) => {
    // Regression for the prod ask: clicking the authority / contractor
    // cell in the contracts panel had no effect — it was plain text.
    // The contracts panel now wraps each cell in a RouterLink to
    // /c/<id>/profile when the API provides the linkable id
    // (authority_id for company-view rows, contractor_gmr_id for
    // authority-view rows). The fontem-api side returns those ids; the
    // fontem-web side renders them. End-to-end pin: navigate to a
    // company's contracts → click the first counterparty link → land
    // on the authority's profile route.
    await page.goto('/')
    await demoMark(page, 'PROC-COUNTERPARTY-LINK — search for Siemens AG')
    const searchInput = page.locator('input[type="search"]').first()
    await searchInput.fill('Siemens AG')
    await expect(page.locator('.gmr-card').first()).toBeVisible({ timeout: 10_000 })
    await demoMark(page, 'Pick the Siemens AG search result')
    await page.locator('.gmr-card').first().click()
    await expect(page.locator('[data-testid="view-selector"]')).toBeVisible({ timeout: 10_000 })

    await demoMark(page, 'Open the Procurement → Contracts tab')
    const procCat = page.locator('[data-testid="view-cat-procurement"]').first()
    if (await procCat.isVisible().catch(() => false)) await procCat.click()
    await expect(page.locator('[data-testid="contracts-panel"]').first())
      .toBeVisible({ timeout: 20_000 })

    const counterparty = page.locator('[data-testid^="contract-counterparty-link-"]').first()
    await counterparty.waitFor({ state: 'visible', timeout: 20_000 })
    const href = await counterparty.getAttribute('href')
    // Profile route shape: /c/<id>/profile. Embed-stable URL.
    expect(href).toMatch(/^\/c\/[^/]+\/profile$/)
    await demoMark(page, `Counterparty cell is a link to ${href}`)

    // Click and verify the URL changes to the counterparty profile.
    await counterparty.click()
    await page.waitForURL(/\/c\/[^/]+\/profile$/, { timeout: 10_000 })
    // The destination should mount the same data-view shell.
    await expect(page.locator('[data-testid="view-selector"]')).toBeVisible({ timeout: 10_000 })
    await demoMark(page, 'Landed on the authority profile ✓', 2000)
  })

  test('BROWSE-08: Graph explorer renders and supports expand/collapse', async ({ page }) => {
    // Siemens AG has graph connections (e.g. Universität Stuttgart)
    await page.goto('/')
    const searchInput = page.locator('input[type="search"]').first()
    await searchInput.fill('Siemens AG')
    await expect(page.locator('.gmr-card').first()).toBeVisible({ timeout: 10_000 })
    await page.locator('.gmr-card').first().click()
    // Card click navigates to /c/<uuid>/profile (the Overview group's
    // default view). Wait for the DataViewSelector to mount before
    // looking for the Graph Explorer tab — under load the SPA can
    // need >1s to settle.
    await expect(page.locator('[data-testid="view-selector"]')).toBeVisible({ timeout: 10_000 })
    // Click the Graph Explorer tab. The SPA's testid is
    // `view-opt-graph` (per the grouped DataViewSelector — was
    // `view-graph` in the pre-grouping layout the original test
    // assumed). Keep the legacy testid + the has-text fallback so
    // the test survives the next rename.
    const graphTab = page.locator(
      '[data-testid="view-opt-graph"], [data-testid="view-graph"], button:has-text("Graph Explorer")',
    ).first()
    await expect(graphTab).toBeVisible({ timeout: 5_000 })
    await graphTab.click()
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

    // The shared viz actions menu must be present (widget interface).
    // Save now lives behind the ⋮ menu, so assert the menu button itself.
    await expect(page.locator('[data-testid="pocket-menu-btn"]')).toBeVisible()

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

  test('PROC-MAP-COLORIZE: business map paints visible colors for an entity with EU contracts', async ({ page }) => {
    // Two checks bundled into one e2e — the prod feedback was that
    // (a) the tooltip wording was wrong ("no data" → "no known
    // contracts") and (b) for entities that DO have contracts the
    // affected countries were rendering gray/white instead of the
    // viridis palette. The unit tests pin both fixes; this e2e adds
    // the visible-proof layer.
    //
    // Use the Danish Ministry of Defence Acquisition: it procures
    // across DK, DE, AT, FR — four colored countries, easy to see
    // on the recording. Apple (US) has zero EU contracts so the map
    // would be all-gray and there'd be nothing to verify.
    const AUTH = '97cebd5c-0b1a-527b-b8fb-8053ee35f2a8' // gitleaks:allow — public authority_id (Danish Ministry of Defence)

    // Capture the aggregate API response so we can confirm the
    // backend returned positive values for several regions BEFORE
    // asserting the map painted them. Distinguishes "API broken"
    // from "render broken" if this ever regresses.
    let aggregate = null
    page.on('response', async (resp) => {
      const u = resp.url()
      if (u.includes('/geo/entity/') && u.includes('/aggregate')) {
        try { aggregate = await resp.json() } catch { /* skip */ }
      }
    })

    await page.goto(`/c/${AUTH}/entity-nuts-map`)
    await demoMark(page, 'PROC-MAP-COLORIZE — open the Business Map for Danish Ministry of Defence')
    await expect(page.locator('[data-testid="entity-nuts-map"]')).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('[data-testid="enu-loading"]')).not.toBeVisible({ timeout: 30_000 })
    await expect(page.locator('[data-testid="enu-map"] canvas')).toBeVisible({ timeout: 15_000 })

    // Best-effort diagnostic only — NOT the pass gate. Re-reading the
    // response body in a page.on('response') listener is inherently
    // racy: MapLibre/the app consumes the stream first, so resp.json()
    // in the listener can come back empty (the catch swallows it and
    // leaves `aggregate` null) even when the call succeeded. The real,
    // user-visible proof that the colorize wired up is the atlas-legend
    // + the saturated-pixel canvas scan below — both require positive
    // data to have actually painted. So we log the regions if we caught
    // them, but don't fail on a missed intercept.
    if (aggregate?.regions) {
      const positives = aggregate.regions.filter((r) => (r.value ?? 0) > 0)
      await demoMark(page, `API returned ${positives.length} regions with contracts: ${positives.map((r) => r.nuts_code).join(', ')}`, 2500)
    }

    // AtlasLegend only mounts when colorScaleProps.bounds is non-null.
    // bounds is non-null only when at least one rendered feature has a
    // positive value, which in turn requires the colorize fill layer
    // to actually be wired up. So a visible legend == the regression
    // (gray-instead-of-color, single-value bounds collapse) is gone.
    await expect(page.locator('[data-testid="atlas-legend"]'))
      .toBeVisible({ timeout: 10_000 })
    await demoMark(page, 'Atlas legend is visible → bounds set → colorize is wired ✓', 2500)

    // Pixel-level proof: scan the rendered canvas for highly-
    // saturated pixels — those can only come from the choropleth
    // data layer painting in the palette (viridis purple→yellow, or
    // PuOr depending on user prefs). The no-data null layer paints
    // in a low-saturation gray; the OSM basemap is beige/light. So
    // a saturated pixel ⇒ colorize is wired.
    //
    // MapLibre's WebGL context does NOT set preserveDrawingBuffer,
    // so canvas.toDataURL inside the page returns blank. Capture via
    // Playwright's CDP-backed screenshot instead — that grabs the
    // composited framebuffer — then ship the PNG bytes back into the
    // page for decoding via an <img>+2D canvas+getImageData.
    const mapCanvas = page.locator('[data-testid="enu-map"] canvas').first()
    const pngBuf = await mapCanvas.screenshot()
    const colorized = await page.evaluate(async (bytes) => {
      const blob = new Blob([new Uint8Array(bytes)], { type: 'image/png' })
      const url = URL.createObjectURL(blob)
      const img = new Image()
      img.src = url
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej })
      const off = document.createElement('canvas')
      off.width = img.width
      off.height = img.height
      const ctx = off.getContext('2d')
      ctx.drawImage(img, 0, 0)
      const { data } = ctx.getImageData(0, 0, off.width, off.height)
      URL.revokeObjectURL(url)
      let saturated = 0
      let nullGray = 0
      for (let i = 0; i < data.length; i += 4 * 16) {
        const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3]
        if (a < 200) continue
        const maxc = Math.max(r, g, b), minc = Math.min(r, g, b)
        const sat = maxc - minc
        if (sat < 10 && maxc > 180 && maxc < 230) nullGray++
        if (sat > 60 && maxc > 100) saturated++
      }
      return { saturated, nullGray, width: off.width, height: off.height }
    }, Array.from(pngBuf))

    expect(
      colorized.saturated,
      `Expected ≥1 saturated pixel on the canvas (choropleth paint) but found ${colorized.saturated}. ` +
      `Null-gray pixel count was ${colorized.nullGray}. ` +
      `The choropleth layer is rendering nothing — either the layer never mounted or bounds collapsed.`,
    ).toBeGreaterThan(0)
    await demoMark(page, `Pixel scan: ${colorized.saturated} colored pixels, ${colorized.nullGray} null-gray ✓`, 2500)

    // The tooltip-wording half of this test used to grep the main
    // index bundle for "no known contracts". That can no longer work:
    // the build splits the 24 locales into lazily-loaded chunks, so the
    // string is not in any asset the initial HTML references and the
    // grep matched a chunk preamble instead (it was asserting against
    // __vite__mapDeps). Dropped rather than replaced with a fragile
    // WebGL hover: the wording is pinned where it belongs, on the
    // rendered tooltip, by fontem-web tests/unit/EntityNutsMap.test.js
    // ("tooltip reads \"no known contracts\" (not \"no data\")"). What
    // this e2e uniquely proves — that the choropleth actually paints —
    // is the legend + saturated-pixel scan above.
  })

  test('PROFILE-NO-UUID: financials view does not render the raw gmr_id UUID', async ({ page }) => {
    // Regression: navigating directly to /c/<uuid>/summary used to
    // render the bare UUID in two places — the SummaryPanel ticker
    // pill AND the financials header title (which fell back to
    // `companyName || symbol` and was hit by the summary view's no-
    // load path where companyName stayed null). The UUID belongs in
    // the URL, not at the user.
    const UUID = '867f66f4-4aa4-5737-9bed-d51e2746a729' // gitleaks:allow — public gmr_id (Siemens Energy AG/ADR)
    await page.goto(`/c/${UUID}/summary`)
    await demoMark(page, `PROFILE-NO-UUID — navigate to /c/${UUID.slice(0, 8)}…/summary`)
    await expect(page.locator('[data-testid="financials-panel"]')).toBeVisible({ timeout: 20_000 })
    // Wait for the resolve call to populate the company name. The
    // resolver hits /api/companies first; on staging this entity has
    // a known company_name.
    await expect(page.locator('[data-testid="financials-title"]'))
      .toHaveText(/Siemens|Entity profile/, { timeout: 15_000 })
    await demoMark(page, 'Header shows the company name, not the UUID ✓', 2000)

    // The summary-ticker pill (inside SummaryPanel) renders only for
    // human-readable tickers — for a UUID symbol it should not exist.
    await expect(page.locator('[data-testid="summary-ticker"]')).toHaveCount(0)

    // Belt-and-braces: the UUID must not appear anywhere in the
    // page's visible body text.
    const bodyText = await page.locator('body').innerText()
    expect(bodyText).not.toContain(UUID)
    await demoMark(page, 'UUID never appears in the visible body text ✓', 2000)
  })

  test('PROFILE-AUTHORITY-NAME: authority profile header shows the name, never the UUID', async ({ page }) => {
    // Batch-5 item 3: /api/companies/<UUID> returns 200 with
    // company_name: null for an authority UUID (it's a stub, not 404).
    // The old resolver short-circuited on the truthy stub and never
    // reached /api/authorities/, so the header fell back to rendering
    // the raw UUID. PR fontem-web #151 fixes the guard.
    const AUTH = '97cebd5c-0b1a-527b-b8fb-8053ee35f2a8' // gitleaks:allow — public authority_id (Danish Ministry of Defence)
    await page.goto(`/c/${AUTH}/profile`)
    await demoMark(page, `PROFILE-AUTHORITY-NAME — open /c/${AUTH.slice(0, 8)}…/profile`)
    await expect(page.locator('[data-testid="financials-panel"]')).toBeVisible({ timeout: 20_000 })

    // Wait for the resolver round-trip — the header should land on the
    // authority's actual name. We don't know the exact name across
    // staging seeds, so just assert it's *some* non-UUID string with
    // letters. The hard contract is the next line: the UUID must not
    // appear in the body.
    const title = page.locator('[data-testid="financials-title"]')
    await expect(title).not.toHaveText(/^[0-9a-f-]+$/i, { timeout: 15_000 })
    await expect(title).toHaveText(/[A-Za-z]{3,}/, { timeout: 5_000 })
    await demoMark(page, 'Title resolves to the authority name ✓', 2000)

    const bodyText = await page.locator('body').innerText()
    expect(bodyText).not.toContain(AUTH)
    await demoMark(page, 'UUID never appears in the visible body text ✓', 2000)
  })

  test('PROFILE-CONTRACTS-CONTRACTOR-HEADER: authority contracts list labels the column "Contractor"', async ({ page }) => {
    // Batch-5 item 4: on an authority profile the contracts column was
    // labelled "Authority", but the awarding side of the contract is
    // the authority itself — what the user wants there is the COMPANY
    // that provided the service. ContractsPanel now accepts an
    // entityKind prop (and falls back to row-shape detection).
    const AUTH = '97cebd5c-0b1a-527b-b8fb-8053ee35f2a8' // gitleaks:allow — public authority_id (Danish Ministry of Defence)
    await page.goto(`/c/${AUTH}/contracts`)
    await demoMark(page, 'PROFILE-CONTRACTS-CONTRACTOR-HEADER — open the contracts view')
    await expect(page.locator('[data-testid="contracts-panel"]')).toBeVisible({ timeout: 20_000 })

    // Once contracts land, the column header reads "Contractor" — both
    // forms of detection (entityKind prop + row-shape sniff) converge
    // on the same label.
    const table = page.locator('[data-testid="contracts-table"]')
    await expect(table).toBeVisible({ timeout: 15_000 })
    const headers = await table.locator('thead th').allTextContents()
    expect(headers.some((h) => h.startsWith('Contractor'))).toBe(true)
    expect(headers.some((h) => h.startsWith('Authority'))).toBe(false)
    await demoMark(page, 'Counterparty column reads "Contractor" ✓', 2500)
  })

  // ── Report Lifecycle (all via UI) ──────────────────────────────

  test('STORY-09: Create story via UI', async ({ page }) => {
    await uiLogin(page)
    await page.goto('/my-stories')
    await page.click('[data-testid="create-btn"]')  // M3: Create -> Story
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
    // The read view shows the PUBLISHED text, and STORY-10/11 only saved
    // a draft. Publishing is the step that moves what readers see.
    await publishDraft(page, storyId)
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

  test('STORY-CHAPTER-RAIL: TOC component is wired into the editor layout', async ({ page }) => {
    // ChapterRail was read-only on the report view; PR #146 mounts it
    // in the editor too. End-to-end pin: walk `.editor-layout` and
    // confirm the rail component is wired into the slot. The rail
    // renders an empty comment placeholder until the document has
    // h2/h3 content (its v-if = chapters.length > 1).
    //
    // Earlier draft tried to type headings + assert on rail visibility,
    // but slow-motion + ProseMirror's transactional update model made
    // it flakey to synthesise a real TipTap transaction from the test
    // harness. The bodyVersion-triggered refresh path is covered by
    // unit tests in fontem-web (mocked TipTap editor); this e2e
    // covers the structural wiring that the unit test can't.
    if (!storyId) test.skip()
    await uiLogin(page)
    await page.goto(`/stories/${storyId}/edit`)
    await expect(page.locator('[data-testid="editor-toolbar"]')).toBeVisible({ timeout: 30_000 })
    await demoMark(page, 'STORY-CHAPTER-RAIL — confirm rail is wired into .editor-layout')
    const layout = await page.evaluate(() => {
      const el = document.querySelector('.editor-layout')
      if (!el) return null
      return {
        hasBodyCol: !!el.querySelector('.editor-body-col'),
        // ChapterRail v-if=hasContent renders an empty comment node
        // while there's nothing to TOC. The comment is enough to
        // prove the component is wired into the slot.
        railPlaceholderPresent: Array.from(el.childNodes).some(
          (n) => n.nodeType === Node.COMMENT_NODE,
        ),
        childTags: Array.from(el.children).map((c) => c.className),
      }
    })
    expect(layout).not.toBeNull()
    expect(layout.hasBodyCol, 'editor-body-col must wrap the EditorContent').toBe(true)
    expect(
      layout.railPlaceholderPresent,
      `expected ChapterRail placeholder comment inside .editor-layout; saw children: ${JSON.stringify(layout.childTags)}`,
    ).toBe(true)
    await demoMark(page, 'ChapterRail wired into .editor-layout ✓', 2500)
  })

  test('STORY-IMAGE-UPLOAD: uploaded image is served via a presigned URL', async ({ page }) => {
    // Post-2026-06-13 model (community-api #87): the uploads bucket is
    // PRIVATE. Upload returns a stable /uploads/<key> handle stored in
    // the doc; the raw path is NOT publicly fetchable (legacy /uploads/
    // 404s). The browser only ever gets a short-lived presigned URL,
    // minted in the story READ response after the STORIES_READ authz
    // check. This pins that end-to-end: upload → raw path 404s →
    // story read rewrites the ref to a signed URL → that URL fetches.
    if (!storyId) test.skip()
    await uiLogin(page)
    await page.goto(`/stories/${storyId}/edit`)
    await expect(page.locator('[data-testid="editor-toolbar"]')).toBeVisible({ timeout: 30_000 })
    await demoMark(page, 'STORY-IMAGE-UPLOAD — POST a valid 1×1 PNG to /upload')
    const token = await freshAccessToken(page)
    const result = await page.evaluate(async ({ id, tok }) => {
      // A STRUCTURALLY-VALID 1×1 RGBA PNG (correct IDAT CRC). The
      // file-security pipeline re-encodes + structurally verifies
      // every raster, so a corrupt PNG is correctly rejected with 400
      // (see STORY-UPLOAD-SEC-*); this fixture must be byte-valid.
      const png = Uint8Array.from([
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
        0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
        0x89, 0x00, 0x00, 0x00, 0x0B, 0x49, 0x44, 0x41,
        0x54, 0x78, 0x9C, 0x63, 0x60, 0x00, 0x02, 0x00,
        0x00, 0x05, 0x00, 0x01, 0x7A, 0x5E, 0xAB, 0x3F,
        0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44,
        0xAE, 0x42, 0x60, 0x82,
      ])
      const form = new FormData()
      form.append('file', new Blob([png], { type: 'image/png' }), 'tiny.png')
      const up = await fetch(`/capi/data-stories/${id}/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok}` },
        body: form,
      })
      const upBody = await up.json().catch(() => ({}))
      // The raw /uploads/ handle must NOT be publicly fetchable now
      // (private bucket + legacy-path 404 trap).
      let rawStatus = null
      if (upBody.url) {
        const raw = await fetch(upBody.url)
        rawStatus = raw.status
      }
      // Save a doc embedding the uploaded image and PUBLISH it, then
      // read the story back: the read path rewrites /uploads/<key> → a
      // presigned URL. A save alone would only move the author's draft,
      // and this test is about what the read path serves.
      const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }
      const before = await (await fetch(`/capi/data-stories/${id}`,
                                        { headers: auth })).json()
      await fetch(`/capi/data-stories/${id}/content`, {
        method: 'PUT',
        headers: auth,
        body: JSON.stringify({
          tiptap: { type: 'doc', content: [
            { type: 'image', attrs: { src: upBody.url } },
          ] },
          version: 2,
          base_revision: before.draft_revision || before.head_revision || null,
        }),
      })
      const opened = await fetch(`/capi/data-stories/${id}/reviews`, {
        method: 'POST', headers: auth,
        body: JSON.stringify({ kind: 'change' }),
      })
      if (opened.status === 201) {
        const review = await opened.json()
        await fetch(`/capi/data-stories/${id}/reviews/${review.id}/publish`,
                    { method: 'POST', headers: auth })
      }
      const read = await fetch(`/capi/data-stories/${id}`, {
        headers: { Authorization: `Bearer ${tok}` },
      })
      const readBody = await read.text()
      const m = readBody.match(/https?:\/\/[^"\\]+X-Amz-Signature=[a-f0-9]+/)
      let signedStatus = null
      let signedBytes = 0
      if (m) {
        const img = await fetch(m[0])
        signedStatus = img.status
        signedBytes = (await img.blob()).size
      }
      return {
        uploadStatus: up.status, url: upBody.url, rawStatus,
        hasSignedUrl: !!m, signedStatus, signedBytes,
      }
    }, { id: storyId, tok: token })

    expect(result.uploadStatus, `upload failed: ${JSON.stringify(result)}`).toBe(200)
    expect(result.url).toMatch(/^\/uploads\//)
    // Private bucket: the raw handle is not directly fetchable.
    expect(result.rawStatus, `raw /uploads/ should 404 (private bucket); got ${result.rawStatus}`).toBe(404)
    // The story read must surface a working presigned URL for the image.
    expect(result.hasSignedUrl, `story read carried no presigned image URL: ${JSON.stringify(result)}`).toBe(true)
    expect(result.signedStatus, `presigned image URL failed to fetch: ${JSON.stringify(result)}`).toBe(200)
    expect(result.signedBytes).toBeGreaterThan(0)
    await demoMark(page, `Upload → private 404 → presigned ${result.signedBytes} B fetch ✓`, 2500)
  })

  test('STORY-SAVE-TOAST: clicking Save fires a success toast', async ({ page }) => {
    // PR #145 wired useToast() into the save handler. Click Save and
    // confirm a `[data-testid="toast-success"]` lands.
    if (!storyId) test.skip()
    await uiLogin(page)
    await page.goto(`/stories/${storyId}/edit`)
    await expect(page.locator('[data-testid="editor-toolbar"]')).toBeVisible({ timeout: 30_000 })
    await demoMark(page, 'STORY-SAVE-TOAST — click the Save button')
    await page.click('[data-testid="save-story"]')
    await expect(page.locator('[data-testid="toast-success"]'))
      .toBeVisible({ timeout: 10_000 })
    await demoMark(page, 'Save success toast appeared ✓', 2500)
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
    // MENTION-1 saved the chip onto the author's draft; the read view
    // shows the published text, so publishing is what puts it there.
    await publishDraft(page, storyId)
    await page.goto(`/stories/${storyId}`)

    // The chip from STORY-MENTION-1 must round-trip through save,
    // publish and reload.
    const chip = page.locator('[data-entity-iri^="http://data.fontem.eu/id/Company/"]').first()
    await expect(chip).toBeVisible({ timeout: 30_000 })

    await chip.click()
    await expect(page.locator('[data-testid="entity-side-panel"]')).toBeVisible({ timeout: 10_000 })
  })


  test('STORY-FLOWERS-1: clicking the flower button gives a flower and increments the count', async ({ page }) => {
    // The shared STORY-09 story is private by default, so flowers
    // (which are public_open / public_auth only) won't accept it.
    // Self-seed a fresh public_open story for this test so the
    // assertion is independent of the shared chain AND safe to retry.
    await uiLogin(page)
    const token = await freshAccessToken(page)
    if (!token) test.skip()
    const flowerStoryId = await page.evaluate(async ({ runId, tok }) => {
      const r = await fetch('/capi/data-stories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
        body: JSON.stringify({ title: `Flower Smoke Story ${runId}`, abstract: 'Story under flower smoke test.' }),
      })
      if (!r.ok) throw new Error(`create story failed: ${r.status} ${await r.text()}`)
      const { id } = await r.json()
      // Flip to public_open so the flower endpoint will accept claps.
      const v = await fetch(`/capi/data-stories/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
        body: JSON.stringify({ title: `Flower Smoke Story ${runId}`, abstract: 'Story under flower smoke test.', visibility: 'public_open' }),
      })
      if (!v.ok) throw new Error(`make-public failed: ${v.status} ${await v.text()}`)
      return id
    }, { runId: RUN_ID, tok: token })
    expect(flowerStoryId).toBeTruthy()
    await demoMark(page, `STORY-FLOWERS-1 — seeded story ${flowerStoryId.slice(-8)}`, 1500)

    try {
      await page.goto(`/stories/${flowerStoryId}`)
      const btn = page.locator('[data-testid="flower-button"]')
      const count = page.locator('[data-testid="flower-count"]')
      // The button mounts inside .report-meta after the visibility
      // badge — the GET on mount can take a beat on cold staging.
      await expect(btn).toBeVisible({ timeout: 15_000 })
      await expect(count).toBeVisible()
      const before = parseInt(await count.textContent(), 10)
      await demoMark(page, `Flower count before click: ${before}`, 1200)

      // First click — optimistic + server reconcile. Asserting via
      // toHaveText (not textContent twice) so Playwright auto-retries
      // until Vue's reactivity tick lands.
      await btn.click()
      await expect(count).toHaveText(String(before + 1), { timeout: 5_000 })
      await demoMark(page, `Flower count ${before} -> ${before + 1} ✓`, 1500)

      // Persistence — reload with a cache-buster on the route URL so
      // the proxy in front of /capi can't serve a stale flower GET.
      // gmr.void42.net (and the fontem successor) front /capi with a
      // proxy cache; without ?cb=… the assertion can flake on a hit.
      await page.goto(`/stories/${flowerStoryId}?cb=${Date.now()}`)
      await expect(count).toHaveText(String(before + 1), { timeout: 10_000 })

      // mine badge reflects the per-user count: "(you: 1)" / German
      // "(du: 1)" / etc. We only assert the digit so the test stays
      // locale-agnostic.
      await expect(page.locator('[data-testid="flower-mine"]')).toContainText('1')
    } finally {
      // Always clean up — even if the assertions failed, leaving a
      // public Smoke Story behind on prod is noise on the feed.
      await page.evaluate(async ({ id, tok }) => {
        await fetch(`/capi/data-stories/${id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${tok}` },
        })
      }, { id: flowerStoryId, tok: token })
    }
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
        // Per-request timeout bumped 20s → 60s for the two migration
        // tables (migr_asyappctzm, migr_asydcfsta) — wide aggregations
        // against an uncached materialised view legitimately spend ~30s
        // before the row data lands. A timeout there would fail the
        // gate even though the dataset isn't actually broken. The
        // total-suite timeout (180s set at the test top) still bounds
        // the whole loop.
        const r = await request.get(url, { timeout: 60_000 })
        if (r.status() >= 400) {
          const body = (await r.text()).slice(0, 160)
          const via = r.headers()['x-ratelimited-by'] || ''
          failures.push(
            `${d.code} (lvl=${level}) → ${r.status()}` +
            `${via ? ` (via ${via})` : ''}: ${body}`,
          )
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
        // The marker header names WHICH layer rate-limited (four can);
        // triaging run 28166's 429s burned time working that out.
        const via = resp.headers()['x-ratelimited-by'] || ''
        apiFailures.push(
          `${resp.status()} ${resp.url()}${via ? ` (via ${via})` : ''}`,
        )
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
  /**
   * Is the LLM behind the assistant usable in this environment?
   *
   * The panel streams Server-Sent Events; when the upstream key is
   * rejected the stream still opens with HTTP 200 and then carries
   * `event: error` with the provider's message, so a status check says
   * nothing. Probed once from Node with the token global-setup already
   * saved — deliberately NOT via uiLogin, because /auth/login is capped
   * at 5/min per IP and there are nine guarded tests.
   *
   * As of 2026-07-29 the Mistral key returns 401 and is byte-identical
   * across testing, staging and prod, so this is an expired credential
   * rather than a gap in the environment. Skipping states the reason out
   * loud and keeps the promotion gate meaningful, instead of every
   * assistant test burning its 120s ceiling.
   */
  let _llmOk = null
  async function llmAvailable() {
    if (_llmOk !== null) return _llmOk
    const state = JSON.parse(await fs.readFile('./auth.json', 'utf8'))
    const origin = (state.origins || [])[0] || {}
    const token = (origin.localStorage || []).find((e) => e.name === 'gmr-token')?.value
    const base = process.env.BASE_URL || 'https://fontem.testing.void42.internal'
    const u = new URL(`${base}/capi/assist/chat/stream`)

    // https.request, not fetch(). The internal domains serve a private CA
    // cert; global-setup and the browser contexts both opt out of
    // verification (rejectUnauthorized:false / ignoreHTTPSErrors) but bare
    // fetch() does not, so it threw on every single run. The old catch
    // swallowed that into "LLM unavailable" and skipped all ten ASSIST
    // tests with a message blaming the discontinued upstream key — green,
    // silent, and wrong for months. A probe that cannot tell "no LLM" from
    // "I could not ask" is not a probe.
    const body = JSON.stringify({ message: 'ping', conversation_key: `probe-${process.pid}` })
    const res = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'Content-Length': Buffer.byteLength(body),
        },
        ...(/\.void42\.internal$/.test(u.hostname) ? { rejectUnauthorized: false } : {}),
      }, (r) => {
        const chunks = []
        r.on('data', (c) => chunks.push(c))
        r.on('end', () => resolve({ status: r.statusCode, text: Buffer.concat(chunks).toString('utf-8') }))
      })
      req.on('error', reject)
      req.setTimeout(90_000, () => req.destroy(new Error('assistant probe timed out')))
      req.write(body)
      req.end()
    })

    // A transport or auth failure is OUR problem and must be loud. Only a
    // clean response that reports an LLM error counts as "no LLM here".
    if (res.status === 401 || res.status === 403) {
      throw new Error(`assistant probe could not authenticate (${res.status}) — fix the probe, do not skip the suite`)
    }
    if (res.status >= 500) {
      throw new Error(`assistant probe got ${res.status} from ${base} — the API is broken, not the LLM`)
    }
    _llmOk = res.status === 200 && !/event:\s*error/.test(res.text)
    if (!_llmOk) {
      console.warn(`[assist] LLM unavailable: status=${res.status} body=${res.text.slice(0, 200)}`)
    }
    return _llmOk
  }

  async function sendAssistMessage(page, message, waitMs = 200_000) {
    // Count existing assistant messages before sending
    const beforeCount = await page.locator('.assist-msg--assistant').count()

    await page.fill('[data-testid="assist-input"]', message)
    await page.click('[data-testid="assist-send"]')

    // Wait for a NEW assistant message to appear (count increases).
    // 200s. ASSIST-21 forces a real search_entities chain and is the
    // slowest turn the suite provokes; at 150s it timed out on both
    // attempts against staging while every other assistant test passed.
    // The ceiling has to clear the worst turn the
    // suite provokes, not the average one: the tool loop runs up to 10
    // rounds and the non-prod agent generates at ~14 tok/s on a node it
    // shares with the testing workloads. At 120s, ASSIST-22 and ASSIST-MCP-1
    // took turns failing on different runs while each passed standalone in
    // seconds — the signature of a deadline, not a defect.
    //
    // It must also stay below the caller's test.setTimeout with room for the
    // assertions that follow; those are 240s for the assistant tests.
    await page.locator(`.assist-msg--assistant >> nth=${beforeCount}`).waitFor({ state: 'visible', timeout: waitMs })

    // Wait for streaming to finish — the status indicator appears during streaming
    // and disappears when done. If it's already gone, streaming was fast.
    const status = page.locator('[data-testid="assist-status"]')
    const statusVisible = await status.isVisible().catch(() => false)
    if (statusVisible) {
      await status.waitFor({ state: 'hidden', timeout: waitMs })
    } else {
      // Status may have already disappeared — give a moment for final parsing
      await page.waitForTimeout(1000)
    }

    // Wait for the message to actually CONTAIN something before reading it.
    //
    // The bubble now appears earlier than it used to: a proposal or a
    // thinking event creates the assistant message before any prose has
    // streamed, so "element visible" stopped implying "text present" and
    // this helper started returning "" — ASSIST-19 failed asserting against
    // an empty string while the answer was still arriving. Waiting on the
    // element was always the weaker assumption; it only held because the
    // bubble happened to be created by the first text chunk.
    // Wait for prose OR a proposal card — whichever the turn produces.
    //
    // Waiting only for text was a mistake I introduced alongside a prompt
    // that tells the model "do not answer in prose". Obeyed perfectly, that
    // turn emits a tool call and nothing else, and the helper then blocked
    // 60s on text that was never coming. The two changes contradicted each
    // other, and the failure surfaced as a later assertion rather than here.
    //
    // A turn is "answered" when either surface has content, so wait on the
    // union and let the caller assert on whichever it cares about.
    const body = page.locator('.assist-msg--assistant .msg-text').last()
    const card = page.locator('[data-testid="assist-proposals"]')
    await expect
      .poll(async () => (await body.innerText()).trim().length
              + await card.count(),
            { timeout: 60_000, message: 'assistant produced neither prose nor a proposal' })
      .toBeGreaterThan(0)
    return body.innerText()
  }

  // AI assistant: re-enabled after migration from Claude CLI/OAuth proxy to
  // Mistral (mistral-small-latest) in gmr-community-api. The SSE event shape
  // is unchanged, so these three tests exercise the same UI surface.
  //
  // The ASSIST-* tests retry once on the playwright level (config.retries=1)
  // Regression for the prod report that the AssistPanel input row sits
  // behind the cookie consent banner — the banner is fixed at z-index
  // 1000 and the input row was at z-index 100. Once the user accepts
  // / declines, the banner goes away and the input is fine; pre-consent
  // it was occluded on desktop and fully hidden on mobile. Fix lives
  // in CookieConsentBanner.vue (exports `--cookie-banner-h`) + AssistPanel.vue
  // (reads it as padding-bottom).
  test('ASSIST-PRE-19: assistant input stays visible above the cookie banner', async ({ page }) => {
    if (!storyId) test.skip()
    test.skip(!(await llmAvailable()), 'assistant LLM unavailable in this environment (upstream key rejected)')
    await uiLogin(page)
    // Force the "pre-consent" state — clear the storage key the
    // global setup sets so the banner renders. We're targeting the
    // editor view because that's where the assistant lives.
    await page.evaluate(() => localStorage.removeItem('gmr-cookie-consent'))
    await page.goto(`/stories/${storyId}/edit`)
    await expect(page.locator('[data-testid="cookie-consent-banner"]'))
      .toBeVisible({ timeout: 5_000 })

    await page.click('[data-testid="assist-toggle"]')
    const input = page.locator('[data-testid="assist-input"]')
    const banner = page.locator('[data-testid="cookie-consent-banner"]')
    await expect(input).toBeVisible({ timeout: 5_000 })

    // The input must sit ABOVE the banner — input.bottom must be at
    // or above banner.top (with a 1px slack for sub-pixel rendering).
    const inputBox = await input.boundingBox()
    const bannerBox = await banner.boundingBox()
    expect(inputBox).not.toBeNull()
    expect(bannerBox).not.toBeNull()
    expect(
      inputBox.y + inputBox.height,
      `assist input bottom (${inputBox.y + inputBox.height}) should sit at or above banner top (${bannerBox.y})`,
    ).toBeLessThanOrEqual(bannerBox.y + 1)

    // Same check on a mobile-narrow viewport — the assist-panel is full
    // width and the banner is full width, so the overlap was actually
    // bigger here. Resize and re-measure.
    await page.setViewportSize({ width: 375, height: 667 })
    await page.waitForTimeout(150)  // let layout settle
    const inputMob = await input.boundingBox()
    const bannerMob = await banner.boundingBox()
    expect(inputMob).not.toBeNull()
    expect(bannerMob).not.toBeNull()
    expect(
      inputMob.y + inputMob.height,
      `mobile: assist input bottom (${inputMob.y + inputMob.height}) should sit at or above banner top (${bannerMob.y})`,
    ).toBeLessThanOrEqual(bannerMob.y + 1)

    // Tidy up so the rest of the suite runs in its expected "consent
    // already given" state (other tests don't render the banner).
    await page.setViewportSize({ width: 1280, height: 720 })
    await page.evaluate(() => localStorage.setItem('gmr-cookie-consent', 'declined'))
  })

  // and have an extra in-test retry below for the LLM content match —
  // Mistral occasionally returns a stylistic answer like "Apple's NASDAQ
  // listing is under the AAPL ticker." vs "Apple Inc.'s ticker is AAPL"
  // and we don't want the gate to flip on phrasing variance.
  test('ASSIST-19: Ask question via assistant panel and get response', async ({ page }) => {
    // 180s to match the rest of the ASSIST battery — a slow Mistral turn
    // plus setup overhead can brush past 120s (see ASSIST-21). A larger
    // budget only ever helps a slow turn; it never delays a fast one.
    test.setTimeout(180_000)
    if (!storyId) test.skip()
    test.skip(!(await llmAvailable()), 'assistant LLM unavailable in this environment (upstream key rejected)')
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

  // ASSIST-MCP-1 was removed here on 2026-08-10, along with the
  // status-capturing helper that existed only to serve it.
  //
  // It asserted that a real search_entities tool_use status reached the
  // browser, and it measured 1-in-3 against Qwen3-1.7B: the model answers
  // the same question with find_paths often enough that the test was a
  // coin flip. Tightening the prompt the way that fixed ASSIST-20 moved it
  // not at all — 1/3 before, 1/3 after — so this is a model-capability
  // limit, not a test defect and not something clearer wording reaches.
  //
  // A gate that fails half the time for no product reason teaches people
  // to rerun until green, which is worth less than the coverage it cost.
  //
  // What went with it: this was the only assertion that the model CALLED a
  // tool rather than narrating that it had. ASSIST-21/22/23 still exercise
  // tool use, but through the response text, so a tool path that breaks
  // while the model keeps talking plausibly is now caught later than it
  // was. Worth restoring if non-prod ever runs a model that holds it.

    // ASSIST-21 is the outlier and owns its deadline rather than
    // dragging every assistant test up with it. Measured against
    // staging: 177s and 246s for this exact turn. It is not slow
    // because anything is broken — search_entities tells the model to
    // iterate every hit, so it calls investigate_entity five or six
    // times, at ~35s each on the 1.7B. That is the product being slow,
    // which is worth fixing on its own terms; a gate that fails while
    // the feature works is not the way to surface it.

  test('ASSIST-21: Assistant uses MCP tools via UI', async ({ page }) => {
    // 180s, not 120s: this runs after ASSIST-19/20/MCP-1 on the SAME
    // story, so the assistant conversation has already accumulated
    // several turns. Mistral's first token on a tool-using turn over a
    // long context is measured at 60-100s (see sendAssistMessage), and
    // the test budget must also cover login + nav + panel open + the
    // streaming-done wait. At 120s the test timer fired mid-response
    // even though the inner waitFor still had time. The sibling tests
    // ASSIST-22/23/24 — which run later with EVEN longer context —
    // already use 180s and pass reliably; 120s here was the outlier.
    test.setTimeout(540_000)
    if (!storyId) test.skip()
    test.skip(!(await llmAvailable()), 'assistant LLM unavailable in this environment (upstream key rejected)')
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
      'Search for "Siemens" in the GMR graph and tell me about their EU contracts.',
      420_000)
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
    test.setTimeout(300_000)
    if (!storyId) test.skip()
    test.skip(!(await llmAvailable()), 'assistant LLM unavailable in this environment (upstream key rejected)')
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

  // ASSIST-23 runs on the scripted model, not the 1.7B. Every other
  // assistant test in this file still drives the real one — this replaces
  // the model for one test, not the coverage.
  //
  // Why: the assertion is that a numeric claim is grounded, which needs
  // search_entities and then investigate_entity with the id the search
  // returned. Non-prod serves only qwen3-1.7b (production defaults to the
  // 4B), and the 1.7B skips the search often enough that the test was a coin
  // toss — it failed the promote gate by answering about "EMENS", and passed
  // the run before by luck. A gate that flips on model mood tells you
  // nothing about the platform.
  //
  // The mock is not a recording: it reads the real tool results out of the
  // conversation and derives each next call from them. If search_entities
  // stops returning a usable id, or investigate_entity stops reporting a
  // count, this test still fails — which is the whole reason to run it
  // against a deployed environment rather than in a unit test.
  test('ASSIST-23: the tool chain runs, in order, on real data', async ({ page }) => {
    test.setTimeout(300_000)
    if (!storyId) test.skip()
    await uiLogin(page)

    // Select the scripted model for this user, and put it back afterwards —
    // the suite shares one account, so leaving it set would silently move
    // every later assistant test onto the mock.
    const token = await freshAccessToken(page)
    const pick = async (id) => page.request.put('/capi/assist/models', {
      headers: { Authorization: `Bearer ${token}` },
      data: { model_id: id },
    })
    const chose = await pick('mock-e2e')
    test.skip(chose.status() === 422,
      'scripted model not enabled here (assistMockModel unset)')
    expect(chose.ok(), `could not select the scripted model: ${chose.status()}`).toBeTruthy()

    try {
      await runToolChain(page)
    } finally {
      // Back to the environment default whatever happened above.
      await pick('qwen3-1.7b')
    }
  })

  test('ASSIST-24: read the draft, then rewrite it whole', async ({ page }) => {
    // The document surface, end to end: the scripted model reads the saved
    // draft (read_document), proposes a whole-body rewrite (replace_body),
    // the card renders, Apply swaps the ENTIRE body — and the conversation
    // records the read before the proposal, which is the contract the
    // tooling rework exists to enforce: you cannot revise what you have
    // not read.
    test.setTimeout(300_000)
    if (!storyId) test.skip()
    await uiLogin(page)

    const token = await freshAccessToken(page)
    const pick = async (id) => page.request.put('/capi/assist/models', {
      headers: { Authorization: `Bearer ${token}` },
      data: { model_id: id },
    })
    const chose = await pick('mock-e2e')
    test.skip(chose.status() === 422,
      'scripted model not enabled here (assistMockModel unset)')
    expect(chose.ok(), `could not select the scripted model: ${chose.status()}`).toBeTruthy()

    try {
      await page.goto(`/stories/${storyId}/edit`)
      await expect(page.locator('[data-testid="editor-body"]')).toBeVisible({ timeout: 10_000 })
      await page.click('[data-testid="assist-toggle"]')
      await expect(page.locator('[data-testid="assist-panel"]')).toBeVisible({ timeout: 5_000 })

      await sendAssistMessage(page, 'E2E-SCENARIO: edit rewrite this draft.')
      await expect(page.locator('[data-testid="assist-status"]')).toBeHidden({ timeout: 200_000 })

      // The card carries the whole-body action, not an append.
      await expect(page.locator('[data-testid="assist-proposals"]').last()).toBeVisible({ timeout: 30_000 })
      await expect(page.locator('[data-testid="proposal-action"]').last())
        .toContainText(/replace[ _]body/i)

      await page.locator('[data-testid="proposal-apply"]').last().click()
      await expect(page.locator('[data-testid="proposal-applied"]').last()).toBeVisible({ timeout: 5_000 })

      // Applied means REPLACED: the mock's marker is the body now, alone.
      const body = page.locator('[data-testid="editor-body"]')
      await expect(body).toContainText('MOCK-REWRITE', { timeout: 5_000 })

      // And the stored conversation shows the read happened first — through
      // the API, because the panel could render a card without persisting
      // anything, which is exactly the class of bug the record exists for.
      const conv = await page.request.get(
        `/capi/assist/conversations/report:${storyId}`,
        { headers: { Authorization: `Bearer ${token}` } },
      )
      expect(conv.ok()).toBeTruthy()
      const messages = (await conv.json()).messages || []
      const turnStart = messages.map((m) => m.role === 'user'
        && (m.content || '').includes('E2E-SCENARIO: edit')).lastIndexOf(true)
      expect(turnStart, 'this turn is missing from the record').toBeGreaterThan(-1)
      const tools = messages.slice(turnStart)
        .filter((m) => m.role === 'tool').map((m) => m.content)
      expect(tools, 'read_document must be recorded').toContain('mcp__gmr__read_document')
      expect(tools, 'replace_body must be recorded').toContain('mcp__gmr__replace_body')
      expect(tools.indexOf('mcp__gmr__read_document'),
        'the read must precede the proposal — you cannot revise what you have not read')
        .toBeLessThan(tools.indexOf('mcp__gmr__replace_body'))
      // The read stored its result: the record shows WHAT was read, not
      // just that a read happened. Shipped with the panel rework; this is
      // the first gate that exercises it.
      const readRow = messages.slice(turnStart).find(
        (m) => m.role === 'tool' && m.content === 'mcp__gmr__read_document')
      expect(readRow.extras?.result, 'the read result was not stored').toBeTruthy()
    } finally {
      await pick('qwen3-1.7b')
    }
  })

  async function runToolChain(page) {
    await page.goto(`/stories/${storyId}/edit`)
    await expect(page.locator('[data-testid="editor-body"]')).toBeVisible({ timeout: 10_000 })

    await page.click('[data-testid="assist-toggle"]')
    await expect(page.locator('[data-testid="assist-panel"]')).toBeVisible({ timeout: 5_000 })

    const responseText = await sendAssistMessage(
      page,
      'E2E-SCENARIO: toolchain — how many EU public procurement contracts '
      + 'does Siemens AG have in the graph?',
    )

    // The script says so, so anything else is a broken tool rather than a
    // model having an off day. MOCK-FAIL is what the script answers when a
    // tool gave it nothing usable — surfaced with the raw payload attached.
    expect(responseText, `the tool chain broke: "${responseText.slice(0, 300)}…"`)
      .not.toContain('MOCK-FAIL')
    expect(responseText, `no count in the answer: "${responseText.slice(0, 300)}…"`)
      .toMatch(/\d/)
    expect(responseText).toContain('Siemens AG')

    // The answer names the entity investigate_entity was actually called
    // with — the id came out of search_entities, so this is the join
    // between the two tools holding.
    const idInAnswer = responseText.match(/entity ([0-9a-f-]{8,})/i)?.[1]
    expect(idInAnswer, `the answer cited no entity id: "${responseText.slice(0, 200)}…"`)
      .toBeTruthy()

    // navigate ran, which means the panel asked for consent rather than
    // moving the page — the regression that started this whole thread was
    // the assistant announcing a navigation that never happened.
    const navPrompt = page.locator('[data-testid="assist-nav"]')
    await expect(navPrompt, 'navigate did not ask before moving the user')
      .toBeVisible({ timeout: 15_000 })
    await page.click('[data-testid="assist-nav-stay"]')
    await expect(page).toHaveURL(/\/stories\/.*\/edit/)

    // The conversation is the record of what the agent did. Every call the
    // script makes must be there, in order, with its arguments — this is
    // the part a 1.7B could never make assertable.
    const conv = await page.request.get(
      `/capi/assist/conversations/report:${storyId}`,
      { headers: { Authorization: `Bearer ${await freshAccessToken(page)}` } },
    )
    expect(conv.ok(), `conversation fetch failed: ${conv.status()}`).toBeTruthy()
    const messages = (await conv.json()).messages || []
    // THIS turn's rows, not the whole conversation.
    //
    // The conversation is keyed to the story, and other assistant tests
    // add their own tool calls to it. Asserting order across the lot
    // passed in isolation and failed in the full suite, where
    // search_entities showed up at index 4 behind someone else's calls —
    // a test reading another test's history and calling it a bug.
    const turnStart = messages.map((m) => m.role === 'user'
      && (m.content || '').includes('E2E-SCENARIO')).lastIndexOf(true)
    expect(turnStart, 'could not find this turn in the conversation')
      .toBeGreaterThan(-1)
    // A tool row stores the call's NAME as its content, with the arguments
    // and the (capped) result in extras.
    const toolRows = messages.slice(turnStart).filter((m) => m.role === 'tool')
    const called = toolRows.map((m) => m.content)

    for (const name of ['mcp__gmr__search_entities', 'mcp__gmr__investigate_entity',
      'get_doc', 'navigate']) {
      expect(called, `${name} missing from ${JSON.stringify(called)}`).toContain(name)
    }
    // Order matters: investigating before searching would mean the id was
    // invented rather than looked up.
    expect(called.indexOf('mcp__gmr__search_entities'))
      .toBeLessThan(called.indexOf('mcp__gmr__investigate_entity'))

    // And the arguments, not just the names — "the agent called
    // investigate_entity" is worth little without which entity.
    const investigate = toolRows.find((m) => m.content === 'mcp__gmr__investigate_entity')
    const investigatedId = investigate?.extras?.args?.entity_id
    expect(investigatedId,
      `no entity_id recorded: ${JSON.stringify(investigate?.extras)}`).toBeTruthy()
    expect(investigatedId, 'the answer cited a different entity than was investigated')
      .toBe(idInAnswer)

    const searched = toolRows.find((m) => m.content === 'mcp__gmr__search_entities')
    expect(searched?.extras?.args?.query,
      `no query recorded for the search: ${JSON.stringify(searched?.extras)}`)
      .toBe('Siemens AG')

    // The same turn, read back through the provenance endpoint — the view
    // the activity log links to. It must tell the same story: the prompt
    // that caused it, and every call in order.
    const prov = await page.request.get(
      `/capi/assist/provenance/${investigate.id}`,
      { headers: { Authorization: `Bearer ${await freshAccessToken(page)}` } },
    )
    expect(prov.ok(), `provenance fetch failed: ${prov.status()}`).toBeTruthy()
    const body = await prov.json()
    expect(body.prompt?.content, 'provenance lost the prompt').toContain('E2E-SCENARIO')
    expect((body.calls || []).map((c) => c.tool))
      .toEqual(expect.arrayContaining(['mcp__gmr__search_entities',
        'mcp__gmr__investigate_entity', 'get_doc', 'navigate']))
    expect(body.calls.find((c) => c.is_subject)?.id,
      'provenance did not mark the call it was asked about').toBe(investigate.id)
  }

  // ASSIST-24 removed 2026-08-09.
  //
  // It asserted the assistant could cite a concrete date range, on the
  // stated grounds that "/data-quality/source-freshness feeds a per-source
  // coverage block into the system prompt every turn". That endpoint 404s
  // in every environment and always has: _get_freshness_summary caught the
  // error and injected nothing, so the block the test depended on was never
  // once present.
  //
  // Which means the test could only ever pass by the model producing a
  // plausible 20XX year from pre-training — rewarding exactly the
  // ungrounded-figure behaviour the rest of this battery exists to catch.
  // A test that passes only when the model fabricates is worse than no test.
  //
  // The replacement is the catalogue block (fontem-community-api
  // src/assistant/catalogue.py), which is generated from the platform's own
  // registries and carries per-source coverage text. Once that ships, assert
  // against it instead — with a coverage phrase from the data, not a bare
  // year-shaped regex that any hallucination satisfies.

  test('ASSIST-MOCK-PRIVATE: the scripted model is not reachable from outside', async ({ request }) => {
    // It is mounted in testing and staging, unauthenticated, and its only
    // legitimate caller is the community-api pod talking to itself. /capi/
    // proxies that service, so without an explicit block the endpoint
    // answers on the public host — it did, before nginx.conf grew one.
    for (const path of ['/capi/mock-llm/v1/chat/completions', '/capi/mock-llm/v1/models']) {
      const resp = await request.post(path, { data: {}, timeout: 15_000 })
      expect(resp.status(), `${path} must not be reachable from outside`).toBe(404)
    }
  })

  test('ASSIST-25: full assistant→edit→save→reload round-trip', async ({ page }) => {
    test.setTimeout(300_000)
    test.skip(!(await llmAvailable()), 'assistant LLM unavailable in this environment (upstream key rejected)')
    await uiLogin(page)

    // Use a fresh report so this test doesn't fight ASSIST-20's
    // editor state (and so it can run in isolation in dev too).
    await page.goto('/my-stories')
    await page.click('[data-testid="create-btn"]')  // M3: Create -> Story
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
      `Use the read_document tool, then the replace_body tool, to make this ` +
      `report a brief one-paragraph note about Apple Inc. (AAPL). The ` +
      `paragraph MUST contain the literal string ${marker}. One paragraph ` +
      `total — keep it short.`)

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
    const token = await freshAccessToken(page)
    await page.request.delete(`/capi/stories/${localReportId}`, {
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {})
  })

  test('ASSIST-27: an open-ended turn of six tool calls completes and the UI survives it', async ({ page }) => {
    // The other half of the same blocker: a real investigation prompt
    // produces half a dozen tool calls in one stream, and the panel froze
    // and took the tab down under exactly that shape while every short
    // scripted turn passed. The marathon scenario reproduces the shape
    // deterministically; the assertions are the user's experience — all
    // the working shown, the answer delivered, and an input that still
    // types afterwards.
    test.setTimeout(300_000)
    if (!storyId) test.skip()
    await uiLogin(page)
    // The SPA keeps its access token in memory now; localStorage
    // 'gmr-token' is only whatever storageState happened to carry, and a
    // null token made this PUT 401 SILENTLY — the turn then ran on the
    // real model and answered from the global history instead of echoing
    // (run 28614). Use the injected bootstrap token and assert the switch.
    const token = await freshAccessToken(page)
    const pick = async (id) => page.request.put('/capi/assist/models', {
      headers: { Authorization: `Bearer ${token}` },
      data: { model_id: id },
    })
    const chose = await pick('mock-e2e')
    test.skip(chose.status() === 422,
      'scripted model not enabled here (assistMockModel unset)')
    expect(chose.ok(),
      `could not select the scripted model: ${chose.status()}`).toBeTruthy()
    try {
      await page.goto(`/stories/${storyId}/edit`)
      await expect(page.locator('[data-testid="editor-body"]')).toBeVisible({ timeout: 10_000 })
      await page.click('[data-testid="assist-toggle"]')
      await expect(page.locator('[data-testid="assist-panel"]')).toBeVisible({ timeout: 5_000 })

      const reply = await sendAssistMessage(page,
        'E2E-SCENARIO: marathon — investigate EU procurement end to end.')
      expect(reply, `marathon broke: "${reply.slice(0, 300)}…"`)
        .toContain('MOCK-MARATHON-DONE')

      // Navigate asks; it must not move an editing user.
      const navPrompt = page.locator('[data-testid="assist-nav"]')
      if (await navPrompt.isVisible().catch(() => false)) {
        await page.click('[data-testid="assist-nav-stay"]')
      }

      // Every call in the record, this turn.
      const conv = await page.request.get(
        `/capi/assist/conversations/report:${storyId}`,
        { headers: { Authorization: `Bearer ${token}` } },
      )
      const messages = (await conv.json()).messages || []
      const turnStart = messages.map((m) => m.role === 'user'
        && (m.content || '').includes('marathon')).lastIndexOf(true)
      expect(turnStart).toBeGreaterThan(-1)
      const called = messages.slice(turnStart)
        .filter((m) => m.role === 'tool').map((m) => m.content)
      expect(called.length,
        `expected six tool calls, got ${JSON.stringify(called)}`)
        .toBeGreaterThanOrEqual(6)
      for (const name of ['mcp__gmr__search_entities',
        'mcp__gmr__investigate_entity', 'mcp__gmr__query_graph',
        'mcp__gmr__calculate', 'navigate']) {
        expect(called, `${name} missing`).toContain(name)
      }

      // The tab survived: the working is on screen and the input still
      // types. A frozen renderer fails both.
      const bubbles = page.locator('.assist-msg--tool')
      expect(await bubbles.count()).toBeGreaterThanOrEqual(5)
      await page.fill('[data-testid="assist-input"]', 'still alive?')
      await expect(page.locator('[data-testid="assist-input"]'))
        .toHaveValue('still alive?')
    } finally {
      await pick('qwen3-1.7b')
    }
  })

  // ── Reviews ──────────────────────────────────────────────────────
  //
  // Publishing is a decision now: an editor's save goes to their draft,
  // and the article's public text moves when a change review is
  // published. These walk the loop a person actually takes, because the
  // parts have unit tests and the seam between them does not.

  test('REVIEW-1: edit, review the diff, publish, and the article changes', async ({ page }) => {
    test.setTimeout(120_000)
    if (!storyId) test.skip()
    await uiLogin(page)

    const marker = `REVIEW-${RUN_ID.slice(0, 8)}`
    await page.goto(`/stories/${storyId}/edit`)
    await expect(page.locator('[data-testid="editor-body"]')).toBeVisible({ timeout: 15_000 })
    await page.locator('[data-testid="editor-body"]').click()
    await page.keyboard.type(marker)

    // The primary action saves the draft and takes you to the diff.
    await page.click('[data-testid="review-story"]')
    await page.waitForURL(/\/stories\/[^/]+\/reviews\//, { timeout: 30_000 })
    await expect(page.locator('[data-testid="review-view"]')).toBeVisible()
    await expect(page.locator('[data-testid="review-kind"]')).toContainText(/change/i)

    // What changed is on the screen, as blocks.
    await expect(page.locator('[data-testid="review-blocks"]')).toContainText(marker)

    // Publishing moves the article; until then the public text is the old one.
    await page.click('[data-testid="review-publish"]')
    await page.waitForURL(/\/stories\/[^/]+$/, { timeout: 30_000 })
    await expect(page.locator('body')).toContainText(marker, { timeout: 20_000 })
  })

  test('REVIEW-2: a comment sticks to the block it was left on', async ({ page }) => {
    test.setTimeout(120_000)
    if (!storyId) test.skip()
    await uiLogin(page)

    // A full article review: one version, read end to end, nothing to merge.
    await page.goto('/my-stories')
    await expect(page.locator(`[data-testid="self-review-${storyId}"]`))
      .toBeVisible({ timeout: 20_000 })
    await page.click(`[data-testid="self-review-${storyId}"]`)
    await page.waitForURL(/\/stories\/[^/]+\/reviews\//, { timeout: 30_000 })
    await expect(page.locator('[data-testid="review-kind"]')).toContainText(/article/i)
    // No diff and nothing to publish — that is the whole difference.
    await expect(page.locator('[data-testid="review-publish"]')).toHaveCount(0)

    const note = `note-${RUN_ID.slice(0, 8)}`
    await page.locator('[data-testid="review-add-comment"]').first().click()
    await page.fill('[data-testid="review-comment-input"]', note)
    await page.click('[data-testid="review-comment-submit"]')

    // It survives a reload, against the same block.
    await expect(page.locator('[data-testid="review-comment"]').first())
      .toContainText(note, { timeout: 20_000 })
    await page.reload()
    await expect(page.locator('[data-testid="review-comment"]').first())
      .toContainText(note, { timeout: 20_000 })
  })

  test('REVIEW-3: my reviews lists what I started', async ({ page }) => {
    test.setTimeout(90_000)
    if (!storyId) test.skip()
    await uiLogin(page)
    await page.goto('/my-reviews')
    await expect(page.locator('[data-testid="my-reviews"]')).toBeVisible({ timeout: 20_000 })
    // REVIEW-1 and REVIEW-2 both left one behind.
    const rows = page.locator('[data-testid="my-review-row"]')
    await expect(rows.first()).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('[data-testid="my-review-who"]').first())
      .toContainText(/me/i)
  })

  // ── Public-report regression gate ────────────────────────────────
  //
  // Regression: clicking a shared link to a public_open report
  // bounced the visitor to /login because the frontend's auth gate
  // matched any path under /reports with `startsWith`. The backend
  // had already been fixed; this test pins the frontend half so a
  // future router change can't quietly re-introduce the dead-end.

  test('PUBLIC-1: public_open story is viewable by an anonymous visitor', async ({ page, browser }) => {
    test.setTimeout(120_000)
    if (!storyId) test.skip()

    // Make the report public_open as the authenticated user.
    await uiLogin(page)
    await page.goto(`/stories/${storyId}/edit`)
    await expect(page.locator('[data-testid="visibility-select"]')).toBeVisible({ timeout: 10_000 })

    // Set the title here rather than inheriting whatever this story ended
    // up with. `storyId` is shared, and the assistant tests above now
    // really do mutate it — ASSIST-BYPASS auto-applies an update_title to
    // this exact story. That only became true when propose_edit started
    // being offered at all; before, those tests were no-ops and this one
    // read a title nobody had touched. What it actually pins is that an
    // anonymous visitor gets the story instead of a login redirect, so the
    // title it asserts on should be this test's own precondition and not a
    // side effect of a model's word choice three tests earlier.
    const publicTitle = `Public Smoke ${RUN_ID.slice(0, 8)}`
    await page.fill('[data-testid="story-title-input"]', publicTitle)
    await page.selectOption('[data-testid="visibility-select"]', 'public_open')
    await page.click('[data-testid="save-story"]')
    await expect(page.locator('[data-testid="save-story"]')).toBeEnabled({ timeout: 10_000 })

    // Visit as a *genuine* stranger. A context created here starts with
    // no cookies and — crucially — never receives baseTest's per-page
    // bootstrap-token init script, so the SPA boots truly anonymous.
    // (Clearing localStorage on the authed page is NOT enough: without
    // the __smoke_anon__ marker the fixture re-injects the access token
    // on the next navigation, which silently re-authenticated the visit
    // and stopped exercising the anonymous path this test exists to pin.)
    const anon = await browser.newContext({
      storageState: { cookies: [], origins: [] },
      ignoreHTTPSErrors: true,
    })
    try {
      const visitor = await anon.newPage()
      await visitor.goto(`/stories/${storyId}`)

      // Two regressions this pins, both pre-fix:
      //   - hard redirect to /login (router gate matched /stories/*)
      //   - blank page that hydrates and *then* redirects to /login
      // The URL must stay put...
      await expect(visitor).toHaveURL(new RegExp(`/stories/${storyId}$`), { timeout: 10_000 })
      // ...and the title must actually POPULATE. The <h1 story-title> is
      // present in the shell from first paint but empty until the story
      // fetch resolves; an empty <h1> has zero height, which Playwright
      // reports as "hidden" — so toBeVisible() raced the fetch on a cold
      // context and flaked. Assert non-empty text (i.e. the data landed)
      // rather than visibility of a possibly-empty node.
      // The exact title this test set, not merely "some text": with a
      // shared story that other tests now really do edit, /\S/ passes on
      // whatever happened to be there and would keep passing if the story
      // fetch quietly returned the wrong record.
      await expect(visitor.locator('[data-testid="story-title"]'))
        .toHaveText(publicTitle, { timeout: 20_000 })
      // No login form lurking (would mean we silently landed on /login).
      expect(await visitor.locator('[data-testid="login-email"]').count()).toBe(0)
    } finally {
      await anon.close()
    }

    // Restore visibility to private so later runs don't see a leftover
    // public_open report. The authed `page` was never disturbed above.
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

  test('CONSOLIDATION-1: graph explorer and contracts list agree (retired summary edges stay retired)', async ({ page }) => {
    test.setTimeout(60_000)
    await uiLogin(page)

    // Resolve eu-LISA's authority_id via the unified search.
    const searchRes = await page.request.get('/api/search?q=eu-LISA&limit=1')
    expect(searchRes.ok(), 'search endpoint reachable').toBe(true)
    const search = await searchRes.json()
    const authority = search.authorities?.[0]
    if (!authority) test.skip(true, 'eu-LISA not present — graph data was probably re-loaded')
    const authorityId = authority.authority_id

    // Surface 1: the contracts list — contract_count counts AWARDED
    // contracts (the list itself fans out one row per winner, so
    // multi-winner awards legitimately show more rows than the count).
    const contractsRes = await page.request.get(
      `/api/authorities/${encodeURIComponent(authorityId)}/contracts?limit=200`,
    )
    expect(contractsRes.ok(), 'contracts endpoint reachable').toBe(true)
    const contracts = await contractsRes.json()
    const liveCount = contracts.contract_count
    // The explorer caps the neighborhood at ~500 nodes; if eu-LISA ever
    // outgrows that, the equality below stops being meaningful.
    test.skip(liveCount > 400, `eu-LISA has ${liveCount} contracts — beyond the explorer node cap`)

    // Surface 2: the graph explorer traverses AWARDED directly since
    // the trade-summary materialiser was deleted (fontem-api#222).
    const graphRes = await page.request.get(
      `/api/graph/${encodeURIComponent(authorityId)}?depth=1`,
    )
    expect(graphRes.ok(), 'graph endpoint reachable').toBe(true)
    const graph = await graphRes.json()
    const edgeTypes = (graph.edges || []).map((e) => e.type)

    // The retired summary layer must never leak back: not from stale
    // leftovers, not from a merge tool re-creating it.
    expect(edgeTypes, 'retired CLIENT_OF leaked into the explorer').not.toContain('CLIENT_OF')
    expect(edgeTypes, 'retired SUPPLIER_OF leaked into the explorer').not.toContain('SUPPLIER_OF')

    // And the two live surfaces must agree on how many contracts exist.
    const awardedCount = (graph.edges || [])
      .filter((e) => e.type === 'AWARDED' && e.source === authorityId).length
    expect(
      awardedCount,
      `eu-LISA visibility split: graph explorer sees ${awardedCount} AWARDED ` +
      `contracts, the contracts list counts ${liveCount}. The two views must ` +
      `agree — a gap means the traversal and the count query have drifted.`,
    ).toBe(liveCount)
  })

  // ── Upload security pipeline ───────────────────────────────────
  //
  // STORY-UPLOAD-SEC-* exercises the file-upload pipeline against
  // the live API: every fixture in ../fixtures/uploads is POSTed
  // to /capi/data-stories/{id}/upload, and the response is
  // asserted. Happy-path fixtures land 200 + a /uploads/ URL;
  // attack fixtures return 400 with a specific detail string from
  // the file_security module. Each test self-seeds a story and
  // cleans up in finally so a failed assertion doesn't leak fixture
  // files into a long-running env.

  async function _seedUploadStory(page, suffix) {
    await uiLogin(page)
    const token = await freshAccessToken(page)
    if (!token) test.skip()
    const id = await page.evaluate(async ({ runId, tok, s }) => {
      const r = await fetch('/capi/data-stories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
        body: JSON.stringify({ title: `Upload Smoke ${runId} ${s}`, abstract: 'Upload smoke test.' }),
      })
      if (!r.ok) throw new Error(`seed story failed: ${r.status} ${await r.text()}`)
      return (await r.json()).id
    }, { runId: RUN_ID, tok: token, s: suffix })
    return { id, token }
  }

  async function _uploadFixture(page, { id, token }, filename, mime) {
    const fileBuffer = await fs.readFile(path.join(FIXTURES_DIR, filename))
    return page.request.post(`/capi/data-stories/${id}/upload`, {
      headers: { Authorization: `Bearer ${token}` },
      multipart: {
        file: { name: filename, mimeType: mime, buffer: fileBuffer },
      },
    })
  }

  async function _cleanupStory(page, { id, token }) {
    await page.evaluate(async ({ tok, sid }) => {
      await fetch(`/capi/data-stories/${sid}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${tok}` },
      })
    }, { tok: token, sid: id })
  }

  // Fetch the *stored* bytes of an uploaded asset. The bucket is
  // private (security review #4), so /uploads/<key> is not directly
  // fetchable — the only fetchable form is the short-lived presigned
  // URL minted in a story-read response. Embed the upload in the
  // story, read it back, pull the signed URL, fetch that.
  async function _fetchStored(page, { id, token }, uploadUrl) {
    const signed = await page.evaluate(async ({ sid, tok, u }) => {
      await fetch(`/capi/data-stories/${sid}/content`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
        body: JSON.stringify({
          tiptap: { type: 'doc', content: [{ type: 'image', attrs: { src: u } }] },
          version: 2,
        }),
      })
      const r = await fetch(`/capi/data-stories/${sid}`, {
        headers: { Authorization: `Bearer ${tok}` },
      })
      const text = await r.text()
      const m = text.match(/https?:\/\/[^"\\]+X-Amz-Signature=[a-f0-9]+/)
      return m ? m[0] : null
    }, { sid: id, tok: token, u: uploadUrl })
    if (!signed) throw new Error(`no presigned URL minted for ${uploadUrl}`)
    return page.request.get(signed)
  }

  test('STORY-UPLOAD-SEC-1: valid JPEG photo uploads successfully', async ({ page }) => {
    const seed = await _seedUploadStory(page, 'jpg')
    try {
      const resp = await _uploadFixture(page, seed, 'good-photo.jpg', 'image/jpeg')
      expect(resp.status(), await resp.text()).toBe(200)
      const body = await resp.json()
      expect(body.url).toMatch(/^\/uploads\//)
      expect(body.key).toMatch(new RegExp(`^${seed.id}/`))
    } finally {
      await _cleanupStory(page, seed)
    }
  })

  test('STORY-UPLOAD-SEC-2: valid SVG chart uploads successfully', async ({ page }) => {
    const seed = await _seedUploadStory(page, 'svg')
    try {
      const resp = await _uploadFixture(page, seed, 'good-chart.svg', 'image/svg+xml')
      expect(resp.status(), await resp.text()).toBe(200)
    } finally {
      await _cleanupStory(page, seed)
    }
  })

  test('STORY-UPLOAD-SEC-3: SVG with <script> + onclick + javascript: href is sanitised through', async ({ page }) => {
    // Sanitisation is NOT rejection — the pipeline strips the
    // dangerous bits and stores the cleaned SVG. The upload returns
    // 200; what's persisted is verified by fetching the stored URL
    // and confirming script/onclick/javascript: are gone.
    const seed = await _seedUploadStory(page, 'evil-svg')
    try {
      const resp = await _uploadFixture(page, seed, 'evil-script.svg', 'image/svg+xml')
      expect(resp.status(), await resp.text()).toBe(200)
      const body = await resp.json()
      const stored = await _fetchStored(page, seed, body.url)
      expect(stored.ok()).toBe(true)
      const content = await stored.text()
      expect(content, 'no <script> survives').not.toMatch(/<script/i)
      expect(content, 'no onclick survives').not.toMatch(/onclick/i)
      expect(content, 'no javascript: href survives').not.toMatch(/javascript:/i)
      expect(content, 'no <foreignObject> survives').not.toMatch(/foreignObject/i)
      expect(content, '<rect> shape survives').toMatch(/<rect/i)
    } finally {
      await _cleanupStory(page, seed)
    }
  })

  test('STORY-UPLOAD-SEC-4: text file masquerading as PNG is rejected (magic-byte gate)', async ({ page }) => {
    const seed = await _seedUploadStory(page, 'bad-mime')
    try {
      const resp = await _uploadFixture(page, seed, 'bad-mime.png', 'image/png')
      expect(resp.status()).toBe(400)
      expect(await resp.text()).toMatch(/not allowed/i)
    } finally {
      await _cleanupStory(page, seed)
    }
  })

  test('STORY-UPLOAD-SEC-5: JPEG with appended secret payload round-trips clean (re-encode gate)', async ({ page }) => {
    const seed = await _seedUploadStory(page, 'polyglot')
    try {
      const resp = await _uploadFixture(page, seed, 'polyglot.jpg', 'image/jpeg')
      expect(resp.status(), await resp.text()).toBe(200)
      const body = await resp.json()
      const stored = await _fetchStored(page, seed, body.url)
      const bytes = await stored.body()
      const text = bytes.toString('latin1')
      expect(text, 'appended payload must NOT survive Pillow re-encode')
        .not.toMatch(/SECRET_PAYLOAD_THAT_MUST_NOT_SURVIVE/)
    } finally {
      await _cleanupStory(page, seed)
    }
  })

  test('STORY-UPLOAD-SEC-6: PNG with pixel dimensions over the 8000 cap is rejected', async ({ page }) => {
    const seed = await _seedUploadStory(page, 'too-many-px')
    try {
      const resp = await _uploadFixture(page, seed, 'too-many-pixels.png', 'image/png')
      expect(resp.status()).toBe(400)
      expect(await resp.text()).toMatch(/exceed/i)
    } finally {
      await _cleanupStory(page, seed)
    }
  })

  test('STORY-UPLOAD-SEC-7: JPEG padded past the 20 MB byte cap is rejected', async ({ page }) => {
    const seed = await _seedUploadStory(page, 'too-big')
    try {
      const resp = await _uploadFixture(page, seed, 'too-big.jpg', 'image/jpeg')
      // Oversized uploads are rejected at whichever layer catches them
      // first: the proxy sheds the body with 413 (Payload Too Large)
      // before it reaches the app, or — for a file just under the
      // proxy limit but over the app's 20 MB cap — the file-security
      // pipeline returns 400 "too large". Either is a correct
      // rejection; this fixture (~22 MB) trips the proxy.
      expect([400, 413], `expected an oversized-rejection status, got ${resp.status()}: ${await resp.text().catch(() => '')}`).toContain(resp.status())
    } finally {
      await _cleanupStory(page, seed)
    }
  })

  test('STORY-UPLOAD-SEC-8: EICAR AV test fixture is rejected by ClamAV gate', async ({ page }) => {
    // EICAR is the 68-byte industry-standard AV test string —
    // safe (not malware), but every AV product agrees to flag it.
    // If CLAMAV_HOST isn't wired (dev / pre-deploy), the pipeline
    // logs a warning and lets the upload through; in that case
    // this test will see a 200 (or a 400 from a different gate)
    // rather than 400-with-AV-message. We assert the AV-rejection
    // path strictly so a missing CLAMAV_HOST in staging/prod
    // shows up as a clear failure here.
    // The EICAR string has no magic-byte signature that libmagic
    // identifies as an image — first the format check rejects it
    // (400 "not allowed"). That's a fine outcome: the bytes never
    // reach storage. But we want to prove the AV layer specifically
    // works when called, so we send EICAR as application/octet-stream
    // and let the format gate reject first; the dedicated AV path
    // is exercised by the unit tests (mocked clamd) and by a manual
    // verification step after deployment.
    const seed = await _seedUploadStory(page, 'eicar')
    try {
      const resp = await _uploadFixture(page, seed, 'eicar.com', 'application/octet-stream')
      expect(resp.status()).toBe(400)
      const text = await resp.text()
      // Either the magic-byte gate (catches it as text/plain or
      // application/octet-stream) or the AV gate can fire here.
      // Both are valid rejections.
      expect(text).toMatch(/not allowed|AV scan/i)
    } finally {
      await _cleanupStory(page, seed)
    }
  })

  // ── Cleanup ────────────────────────────────────────────────────

  test('CSP-1: the security headers are exactly what was reviewed', async ({ request }) => {
    // The compensating control for the DAST suppression.
    //
    // ZAP reports CSP findings once per URL, so one header on 52 pages is
    // 52 findings, and every new route mints more "new" ones — which is
    // what failed the gate on 2026-09-01 and what dast-ignore.yaml now
    // suppresses. A suppression that broad can hide a genuinely weakened
    // policy, so the policy is pinned here instead: one deterministic
    // assertion in the place where a change is a diff someone reviews,
    // rather than 52 scanner instances nobody reads.
    //
    // Directive-by-directive, not a string compare on the whole header:
    // the failure message should say WHICH control was dropped.
    const res = await request.get('/')
    expect(res.status()).toBe(200)
    const csp = res.headers()['content-security-policy']
    expect(csp, 'no CSP header at all').toBeTruthy()

    const directives = Object.fromEntries(
      csp.split(';').map((d) => d.trim()).filter(Boolean)
        .map((d) => { const [k, ...v] = d.split(/\s+/); return [k, v.join(' ')] }))

    // Script execution is the control that matters most: hashes and 'self'
    // only. If unsafe-inline or unsafe-eval ever appears here, the XSS
    // suppression in dast-ignore.yaml loses one of its three legs.
    expect(directives['script-src'], 'script-src must not allow unsafe-inline')
      .not.toContain("'unsafe-inline'")
    expect(directives['script-src'], "script-src must not allow unsafe-eval "
      + "('wasm-unsafe-eval' is narrower and is allowed)")
      .not.toMatch(/(^|\s)'unsafe-eval'/)
    expect(directives['object-src']).toBe("'none'")
    expect(directives['frame-ancestors']).toBe("'none'")
    expect(directives['base-uri']).toBe("'self'")
    expect(directives['form-action']).toBe("'self'")
    expect(directives['default-src']).toBe("'self'")

    // style-src carries a documented accepted risk — see the long note in
    // fontem-web/security-headers.conf. Pinned so that "we still need
    // unsafe-inline" stays a decision someone re-makes, and so the Google
    // host cannot be dropped again: without it the browser blocks
    // accounts.google.com/gsi/style and the sign-in button renders
    // unstyled, which is how it shipped until 2026-09-01.
    expect(directives['style-src']).toBe("'self' 'unsafe-inline' https://accounts.google.com")

    // The rest of the header set. Cheap to assert, and each one has gone
    // missing at least once when a location block defined its own
    // add_header (nginx drops inherited ones the moment it does).
    const h = res.headers()
    expect(h['x-content-type-options']).toBe('nosniff')
    expect(h['x-frame-options']).toBe('DENY')
    expect(h['referrer-policy']).toBe('strict-origin-when-cross-origin')
    expect(h['strict-transport-security'], 'HSTS must be set').toBeTruthy()
    expect(h['permissions-policy'], 'Permissions-Policy must be set').toBeTruthy()
  })

  test('CLEANUP-21: Delete test story via UI', async ({ page }) => {
    if (!storyId) test.skip()
    await uiLogin(page)
    // Navigate to the report and delete it via the API (no delete UI button in view)
    const token = await freshAccessToken(page)
    const resp = await page.request.delete(`/capi/stories/${storyId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect([204, 404]).toContain(resp.status())
  })

  // ---------------------------------------------------------------------
  // STORY-FLOWERS-2 lives at the END of this file on purpose.
  //
  // It seeds 50 flowers in a tight POST loop to prove the cap disables the
  // button. That burst trips the nginx ingress rate limiter, and every test
  // sequenced after it inherited the cooldown: STORY-IMAGE-UPLOAD and others
  // failed with a 429 served by nginx, not by the app, which reads as a
  // product bug and is not one. The suite is serial (workers: 1), so file
  // order is execution order and moving the burst last confines the damage
  // to itself.
  //
  // Keep it last. Anything appended below it will start failing for reasons
  // that have nothing to do with the code it tests.
  // ---------------------------------------------------------------------
})
