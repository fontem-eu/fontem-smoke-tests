/**
 * The Data Studio combine runs client-side in DuckDB-WASM. It has two
 * real-browser-only failure modes, both of which bit us on first deploy and
 * neither of which a jsdom unit test can catch:
 *
 *  1. read_json_auto pulled the JSON extension from extensions.duckdb.org — a
 *     network fetch our CSP (rightly) blocks. The fix loads source tables via
 *     Arrow (core, no extension). This asserts ZERO requests to the DuckDB
 *     extension registry.
 *  2. apache-arrow floated a major version ahead of the one DuckDB-WASM bundles,
 *     so the combine threw a wasm "function signature mismatch" and never
 *     produced a result. This asserts the combine actually returns rows.
 *
 * Also asserts no wasm/worker CSP block (needs script-src 'wasm-unsafe-eval' +
 * worker-src blob:). Pre-existing inline-script CSP noise (the anti-FOUC theme
 * snippet) is unrelated to this feature and deliberately ignored — same policy
 * as atlas-widget.spec.js.
 */
import { test, expect } from './baseTest.js'

test.describe('data studio — client-side DuckDB combine', () => {
  test.setTimeout(120_000)

  test('STUDIO-COMBINE: cypher source + DuckDB transform renders a result, no extension fetch', async ({ page }) => {
    const extFetches = []
    const featureCsp = []
    page.on('request', (r) => { if (/duckdb\.org/i.test(r.url())) extFetches.push(r.url()) })
    page.on('console', (m) => {
      if (m.type() !== 'error') return
      const t = m.text()
      // Ignore the pre-existing anti-FOUC inline-script CSP noise (its directive
      // text contains 'wasm-unsafe-eval', so a naive /wasm/ match false-positives
      // on it — match the *message*, not the directive). Flag exactly the
      // failure signatures this feature hit: the arrow-builder eval, a blocked
      // worker, or a blocked WebAssembly compile.
      if (/inline script/i.test(t)) return
      const isFeatureBlock = /evaluating a string as javascript/i.test(t)
        || /worker-src/i.test(t)
        || (/webassembly/i.test(t) && /refused|violat|blocked/i.test(t))
      if (isFeatureBlock) featureCsp.push(t)
    })

    await page.goto('/studio')
    await expect(page.locator('[data-testid="data-studio"]')).toBeVisible({ timeout: 15_000 })

    // Source cell: clicking a language auto-fills that engine's sample query.
    await page.click('[data-testid="source-lang-cypher"]')
    await page.click('[data-testid="source-run"]')
    // Combine only enables once the source cell has a result table.
    await expect(page.locator('[data-testid="transform-run"]')).toBeEnabled({ timeout: 30_000 })

    // The DuckDB-WASM step: aggregate the source table 'q1' in the browser.
    await page.fill('[data-testid="transform-sql"]', 'SELECT count(*) AS companies, sum(contracts) AS total_contracts FROM q1')
    await page.click('[data-testid="transform-run"]')
    await expect(page.locator('[data-testid="transform-result"]')).toBeVisible({ timeout: 45_000 })

    // A real number came back from DuckDB (not an error placeholder).
    const resultText = (await page.locator('[data-testid="transform-result"]').textContent()) || ''
    expect(resultText).toMatch(/\d/)

    // The plot surface appears once there's a transform result.
    await expect(page.locator('[data-testid="studio-plot"]')).toBeVisible({ timeout: 5_000 })

    expect(extFetches, 'no fetch to the DuckDB extension registry').toEqual([])
    expect(featureCsp, 'no eval / worker / wasm CSP block').toEqual([])
  })
})
