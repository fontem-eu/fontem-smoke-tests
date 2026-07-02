/**
 * Data Studio end-to-end (real browser). Covers the project → query → plot flow
 * and, critically, the client-side DuckDB-WASM combine — which has two
 * real-browser-only failure modes no jsdom unit test can catch:
 *   1. read_json_auto fetching the JSON extension from extensions.duckdb.org
 *      (CSP-blocked) — we assert ZERO requests to the extension registry.
 *   2. apache-arrow's `new Function` builder tripping script-src 'unsafe-eval'
 *      (we ship 'wasm-unsafe-eval' only) — we assert the combine returns rows
 *      and no eval/worker/wasm CSP block fires.
 * Runs desktop + iPhone 13.
 */
import { test, expect } from './baseTest.js'

test.describe('data studio — projects, queries, client-side DuckDB combine', () => {
  test.setTimeout(120_000)

  test('STUDIO: create project + query, preview result, combine in DuckDB, no extension/eval block', async ({ page }) => {
    const extFetches = []
    const featureCsp = []
    page.on('request', (r) => { if (/duckdb\.org/i.test(r.url())) extFetches.push(r.url()) })
    page.on('console', (m) => {
      if (m.type() !== 'error') return
      const t = m.text()
      // Ignore the pre-existing anti-FOUC inline-script CSP noise (its directive
      // text contains 'wasm-unsafe-eval', so match the message not the directive).
      if (/inline script/i.test(t)) return
      const isFeatureBlock = /evaluating a string as javascript/i.test(t)
        || /worker-src/i.test(t)
        || (/webassembly/i.test(t) && /refused|violat|blocked/i.test(t))
      if (isFeatureBlock) featureCsp.push(t)
    })
    // Name new projects via the native prompt; accept any confirm too.
    page.on('dialog', (d) => d.accept(`Smoke ${Date.now()}`))

    // Start from a clean studio store.
    await page.goto('/studio')
    await page.evaluate(() => localStorage.removeItem('fontem-studio'))
    await page.reload()
    await expect(page.locator('[data-testid="studio-home"]')).toBeVisible({ timeout: 15_000 })

    // New project → project overview.
    await page.click('[data-testid="studio-new-project"]')
    await expect(page.locator('[data-testid="studio-project-view"]')).toBeVisible({ timeout: 15_000 })

    // New query → immersive editor.
    await page.click('[data-testid="project-new-query"]')
    await expect(page.locator('[data-testid="studio-query-view"]')).toBeVisible({ timeout: 15_000 })

    // Pick Cypher (fills the sample), run it, and see the tabular preview.
    await page.click('[data-testid="query-lang-cypher"]')
    await page.click('[data-testid="query-run"]')
    await expect(page.locator('[data-testid="query-result"] table')).toBeVisible({ timeout: 25_000 })
    await expect(page.locator('[data-testid="query-meta"]')).toContainText('rows')

    // Go to the project's plot builder (combine runs DuckDB-WASM client-side).
    const pid = page.url().match(/\/p\/([^/]+)/)[1]
    await page.goto(`/studio/p/${pid}/plot`)
    await expect(page.locator('[data-testid="studio-plot-view"]')).toBeVisible({ timeout: 15_000 })
    await page.check('[data-testid="plot-query-toggle"] input')
    await page.fill('[data-testid="plot-transform-sql"]', 'SELECT count(*) AS companies, sum(contracts) AS total FROM q1')
    await page.click('[data-testid="plot-combine"]')
    await expect(page.locator('[data-testid="plot-result"]')).toBeVisible({ timeout: 45_000 })
    await expect(page.locator('[data-testid="studio-plot"]')).toBeVisible({ timeout: 5_000 })

    const resultText = (await page.locator('[data-testid="plot-result"]').textContent()) || ''
    expect(resultText).toMatch(/\d/)
    expect(extFetches, 'no fetch to the DuckDB extension registry').toEqual([])
    expect(featureCsp, 'no eval / worker / wasm CSP block').toEqual([])
  })
})
