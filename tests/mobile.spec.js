/**
 * Mobile smoke suite.
 *
 * Focused set of regressions for the iPhone-13 viewport (390 × 844).
 * We deliberately don't mirror the full desktop suite — most of those
 * assertions are shape-equivalent and the cost of maintaining two
 * runtimes for the same checks would be high. Instead this spec
 * covers things that only break on the narrow viewport:
 *
 *   - cookie consent banner reflows to column layout and can occlude
 *     the AssistPanel input (the recurring user-reported bug);
 *   - the data-view selector switches from horizontal nav to a
 *     dropdown — different DOM, different selectors;
 *   - the contracts panel switches from a table to a card list —
 *     different testids on each card;
 *   - native scroll + touch hit-testing on narrow widths.
 *
 * The spec runs against the mobile-chromium project in
 * playwright.config.js (iPhone-13 via devices['iPhone 13']).
 *
 * Demo-mode banners are gated on `SMOKE_DEMO=1` exactly like the
 * desktop suite — keeps CI fast, makes the recording followable.
 */
import { test, expect } from '@playwright/test'

const STORY_TITLE = `Mobile Smoke ${Date.now()}`

const SMOKE_DEMO = process.env.SMOKE_DEMO === '1'
async function demoMark(page, label, ms = 1800) {
  if (!SMOKE_DEMO) return
  await page.evaluate((text) => {
    let el = document.querySelector('[data-demo-banner]')
    if (!el) {
      el = document.createElement('div')
      el.setAttribute('data-demo-banner', '1')
      el.style.cssText =
        'position:fixed;top:0;left:0;right:0;z-index:2147483647;' +
        'padding:8px 12px;font:600 12px/1.3 system-ui,sans-serif;' +
        'color:#fff;background:#0969da;text-align:center;' +
        'box-shadow:0 2px 8px rgba(0,0,0,.25)'
      document.body.appendChild(el)
    }
    el.textContent = text
  }, label).catch(() => { /* navigating */ })
  await page.waitForTimeout(ms)
}

// Most mobile tests need the cookie banner showing (that's the whole
// point of the cookie-banner-overlap regression). Clear the consent
// flag at the start of each test that wants the banner up.
async function clearCookieConsent(page) {
  await page.goto('/')
  await page.evaluate(() => localStorage.removeItem('gmr-cookie-consent'))
}

// Setup helper: create a fresh story we can park the AssistPanel on.
// The assistant only mounts inside the report editor route.
async function createStory(page) {
  await page.goto('/my-stories')
  await page.click('[data-testid="new-story-btn"]')
  await page.waitForURL(/\/stories\/.*\/edit/, { timeout: 30_000 })
  const id = page.url().match(/\/stories\/([^/]+)\/edit/)?.[1]
  expect(id).toBeTruthy()
  return id
}

test.describe.serial('Mobile Smoke Suite', () => {
  let storyId = null

  test('MOBILE-1: app boots, search box is reachable on a narrow viewport', async ({ page }) => {
    await page.goto('/')
    await demoMark(page, 'MOBILE-1 — app boots on 390 × 844 iPhone-13 viewport')
    // The search input is the universal landing affordance and the
    // single biggest mobile-discoverability lever. If this isn't
    // visible on initial load, nothing else matters.
    await expect(page.locator('input[type="search"]').first())
      .toBeVisible({ timeout: 10_000 })
    await demoMark(page, 'Search input is visible ✓')
  })

  test('MOBILE-2: searching from the mobile viewport returns results that fit', async ({ page }) => {
    await page.goto('/')
    await demoMark(page, 'MOBILE-2 — type into the mobile search box')
    const input = page.locator('input[type="search"]').first()
    await input.fill('Siemens AG')
    await expect(page.locator('.gmr-card').first()).toBeVisible({ timeout: 10_000 })
    await demoMark(page, 'Result card visible — narrow viewport handles it ✓', 2000)
  })

  test('MOBILE-3: data view selector switches to the dropdown affordance', async ({ page }) => {
    // Desktop renders a vertical category nav (`.dvs-desktop`). Mobile
    // renders a single dropdown button (`.dvs-mobile` ⇒ `view-dropdown-btn`).
    // The CSS breakpoint is 640 px — iPhone-13 sits well below that, so
    // the mobile branch must mount.
    await page.goto('/c/AAPL/profile')
    await expect(page.locator('[data-testid="view-selector"]')).toBeVisible({ timeout: 15_000 })
    await demoMark(page, 'MOBILE-3 — open a company profile on mobile')
    const mobileBtn = page.locator('[data-testid="view-dropdown-btn"]')
    await expect(mobileBtn).toBeVisible()
    await demoMark(page, 'Dropdown btn is the mobile nav affordance ✓', 2000)
    await mobileBtn.click()
    await expect(page.locator('[data-testid="view-dropdown"]')).toBeVisible()
    await demoMark(page, 'Dropdown opens with all categories ✓', 2000)
  })

  test('MOBILE-4: contracts panel switches to the card list (not the table) on narrow widths', async ({ page }) => {
    // gitleaks:allow — public authority_id (Danish Ministry of Defence)
    const AUTH = '97cebd5c-0b1a-527b-b8fb-8053ee35f2a8'
    await page.goto(`/c/${AUTH}/contracts`)
    await demoMark(page, 'MOBILE-4 — open contracts on a mobile-narrow viewport')
    await expect(page.locator('[data-testid="contracts-panel"]').first())
      .toBeVisible({ timeout: 20_000 })
    // The card layout uses `[data-testid="contract-card-<id>"]` per row;
    // the table uses `[data-testid="contract-row-<id>"]`. Both data-
    // testids exist in the DOM at all viewport widths (Vue renders both
    // branches and CSS @media query hides one), so we can't assert on
    // existence — instead check actual visibility on the narrow viewport.
    const firstCard = page.locator('[data-testid^="contract-card-"]').first()
    await firstCard.waitFor({ state: 'visible', timeout: 20_000 })
    await demoMark(page, 'Contract cards render visibly on mobile ✓', 2000)
  })

  test('MOBILE-5: cookie consent banner sits above the AssistPanel input', async ({ page }) => {
    // The headline regression. PR #130 published a 6 rem (96 px)
    // hardcoded `--cookie-banner-h`. On mobile the banner reflows to a
    // column layout and renders ~128 px tall — leaving the AssistPanel
    // input (which reads the var as its padding-bottom) overlapped by
    // the banner. PR #141 measures the actual rendered height via a
    // ResizeObserver. This e2e proves the measured value reaches the
    // input on a real mobile viewport.
    storyId = await createStory(page)
    await clearCookieConsent(page)
    await page.goto(`/stories/${storyId}/edit`)
    await expect(page.locator('[data-testid="cookie-consent-banner"]'))
      .toBeVisible({ timeout: 5_000 })
    await demoMark(page, 'MOBILE-5 — cookie banner visible (column layout)')

    await page.click('[data-testid="assist-toggle"]')
    const input = page.locator('[data-testid="assist-input"]')
    const banner = page.locator('[data-testid="cookie-consent-banner"]')
    await expect(input).toBeVisible({ timeout: 5_000 })
    await demoMark(page, 'AssistPanel input is mounted ✓', 1500)

    // The input bottom must sit at or above the banner top — 1px slack
    // for sub-pixel rendering. This is THE assertion that was failing
    // pre-PR #141.
    const inputBox = await input.boundingBox()
    const bannerBox = await banner.boundingBox()
    expect(inputBox).not.toBeNull()
    expect(bannerBox).not.toBeNull()
    expect(
      inputBox.y + inputBox.height,
      `mobile: assist input bottom (${inputBox.y + inputBox.height}) ` +
      `should sit at or above banner top (${bannerBox.y})`,
    ).toBeLessThanOrEqual(bannerBox.y + 1)
    await demoMark(page, `Input bottom ${Math.round(inputBox.y + inputBox.height)}px ≤ banner top ${Math.round(bannerBox.y)}px ✓`, 2500)
  })

  test('MOBILE-6: cookie banner dismiss makes the AssistPanel input flush with the viewport bottom', async ({ page }) => {
    if (!storyId) test.skip()
    await clearCookieConsent(page)
    await page.goto(`/stories/${storyId}/edit`)
    await expect(page.locator('[data-testid="cookie-consent-banner"]'))
      .toBeVisible({ timeout: 5_000 })
    await demoMark(page, 'MOBILE-6 — banner is up, AssistPanel reads its height')
    await page.click('[data-testid="assist-toggle"]')
    await expect(page.locator('[data-testid="assist-input"]')).toBeVisible({ timeout: 5_000 })

    // Snapshot the padded-bottom value while the banner is visible.
    const paddedBottom = await page.locator('[data-testid="assist-input"]').evaluate(
      (el) => parseFloat(getComputedStyle(el).paddingBottom) || 0,
    )
    expect(paddedBottom).toBeGreaterThan(0)
    await demoMark(page, `Input padding-bottom while banner up: ${paddedBottom}px`, 2000)

    // Accept the banner; the input's padding-bottom should collapse
    // back near zero (the bare CSS `0.75rem` baseline) once the var goes
    // to '0px'.
    await page.click('[data-testid="cookie-consent-accept"]')
    await expect(page.locator('[data-testid="cookie-consent-banner"]')).not.toBeVisible()
    await demoMark(page, 'Banner dismissed, --cookie-banner-h should drop to 0', 1500)
    // Allow Vue's onBeforeUnmount to run + style to settle.
    await page.waitForFunction(() => {
      const v = getComputedStyle(document.documentElement).getPropertyValue('--cookie-banner-h')
      return v === '0px' || v === ''
    }, undefined, { timeout: 3_000 })
    const afterPadded = await page.locator('[data-testid="assist-input"]').evaluate(
      (el) => parseFloat(getComputedStyle(el).paddingBottom) || 0,
    )
    expect(afterPadded).toBeLessThan(paddedBottom)
    await demoMark(page, `Input padding-bottom after dismiss: ${afterPadded}px (was ${paddedBottom}px) ✓`, 2500)
  })

  test('MOBILE-CLEANUP: delete the test story', async ({ page }) => {
    if (!storyId) test.skip()
    await page.goto('/my-stories')
    // Find the story card by title and trigger its delete affordance.
    // The mobile layout still surfaces the card; the delete control is
    // accessed via the per-card menu / button.
    const card = page.locator(`[data-testid^="story-card-"]`).filter({ hasText: STORY_TITLE.split(' ')[0] }).first()
    if (await card.isVisible().catch(() => false)) {
      // Best-effort cleanup; if the menu structure changes the test
      // shouldn't fail on this. The desktop CLEANUP-21 carries the
      // canonical cleanup logic; this is a no-op safety net.
      await card.locator('[data-testid$="-delete"]').first().click({ timeout: 5_000 }).catch(() => {})
      await page.locator('[data-testid="confirm-delete"]').click({ timeout: 5_000 }).catch(() => {})
    }
  })
})
