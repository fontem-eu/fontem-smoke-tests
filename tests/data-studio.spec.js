/**
 * Data Studio end-to-end (real browser, authenticated). The studio is now a
 * logged-in feature: projects, queries and plots persist to the user's account
 * (server-side); only the DuckDB combine runs in the browser.
 *
 * Covers: create a project + query (assert it PERSISTS across a reload — proves
 * server-side storage), preview a query result, then combine in DuckDB-WASM and
 * SAVE the plot to the project. Still guards the two DuckDB-under-CSP failure
 * modes: no extension-registry fetch, no eval/worker/wasm CSP block.
 */
import { test, expect } from './baseTest.js'

test.describe('data studio — server-backed projects, queries, plots', () => {
  test.setTimeout(120_000)

  test('STUDIO: create + persist project/query, preview result, combine + save a plot', async ({ page }) => {
    const extFetches = []
    const featureCsp = []
    page.on('request', (r) => { if (/duckdb\.org/i.test(r.url())) extFetches.push(r.url()) })
    page.on('console', (m) => {
      if (m.type() !== 'error') return
      const t = m.text()
      if (/inline script/i.test(t)) return
      const isFeatureBlock = /evaluating a string as javascript/i.test(t)
        || /worker-src/i.test(t)
        || (/webassembly/i.test(t) && /refused|violat|blocked/i.test(t))
      if (isFeatureBlock) featureCsp.push(t)
    })

    // Authenticated home (baseTest injects the session token).
    await page.goto('/studio')
    await expect(page.locator('[data-testid="studio-home"]')).toBeVisible({ timeout: 15_000 })

    // New project → overview → new query → editor (no browser prompts).
    await page.click('[data-testid="studio-new-project"]')
    await expect(page.locator('[data-testid="studio-project-view"]')).toBeVisible({ timeout: 15_000 })
    const pid = page.url().match(/\/p\/([^/?]+)/)[1]
    await page.click('[data-testid="project-new-query"]')
    await expect(page.locator('[data-testid="studio-query-view"]')).toBeVisible({ timeout: 15_000 })
    const qUrl = page.url()

    // Cypher sample, run it, see the tabular preview.
    await page.click('[data-testid="query-lang-cypher"]')
    await page.click('[data-testid="query-run"]')
    await expect(page.locator('[data-testid="query-result"] table')).toBeVisible({ timeout: 25_000 })
    await expect(page.locator('[data-testid="query-meta"]')).toContainText('rows')

    // SERVER-SIDE PERSISTENCE: reload the editor URL cold — the query survives.
    await page.goto(qUrl)
    await expect(page.locator('[data-testid="studio-query-view"]')).toBeVisible({ timeout: 15_000 })
    // CodeMirror renders a contenteditable div, not a textarea — assert
    // the persisted query text through the editor's content element.
    await expect(page.locator('[data-testid="query-editor"] .cm-content')).toContainText('MATCH')

    // Combine in DuckDB-WASM and SAVE the plot to the project.
    await page.goto(`/studio/p/${pid}/plot`)
    await expect(page.locator('[data-testid="studio-plot-view"]')).toBeVisible({ timeout: 15_000 })
    await page.check('[data-testid="plot-query-toggle"] input')
    // The transform editor is CodeMirror (contenteditable), not a textarea:
    // click in, select-all, and type. closeBrackets types-over the auto ')'.
    const tf = page.locator('[data-testid="plot-transform-sql"] .cm-content')
    await tf.click()
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.type('SELECT count(*) AS companies, sum(contracts) AS total FROM q1')
    await page.click('[data-testid="plot-combine"]')
    await expect(page.locator('[data-testid="plot-result"]')).toBeVisible({ timeout: 45_000 })
    const resultText = (await page.locator('[data-testid="plot-result"]').textContent()) || ''
    expect(resultText).toMatch(/\d/)
    await page.click('[data-testid="plot-save"]')
    await expect(page.locator('[data-testid="plot-save"]')).toContainText('Saved', { timeout: 10_000 })

    // The saved plot persists on the project overview.
    await page.goto(`/studio/p/${pid}`)
    await expect(page.locator('[data-testid="project-plot"]')).toBeVisible({ timeout: 15_000 })

    expect(extFetches, 'no fetch to the DuckDB extension registry').toEqual([])
    expect(featureCsp, 'no eval / worker / wasm CSP block').toEqual([])
  })
})
