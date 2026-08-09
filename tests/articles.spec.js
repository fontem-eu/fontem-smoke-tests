/**
 * Two full UI-authored investigative articles, mirroring our real stories:
 *   1. Hungarian single-bidder procurement corruption
 *   2. Rape vs migration statistics (uses the correlation-matrix plot)
 *
 * The flow is driven THROUGH THE UI: build plots in the Data Studio (pick
 * source query -> combine -> choose chart incl. correlation matrix + bivariate
 * choropleth -> pocket), then create a data story, write the narrative, and
 * embed the pocketed plots. The API is used ONLY for test setup (auth + creating
 * the studio project's source queries, which are the data pipeline — typing
 * SPARQL/SQL into CodeMirror char-by-char is inherently flaky).
 *
 * Doubles as rich authenticated traffic for the ZAP passive scan.
 */
import fs from 'node:fs'
import { test, expect } from './baseTest.js'

const RUN = String(Date.now())
// The SPARQL side answers in ~50ms (measured); this budget is almost
// entirely the browser fetching and compiling a ~40MB DuckDB wasm on a
// shared CI node. 90s was flaky under cluster load with the old 250m-CPU
// runner; the runner now gets real CPU and this covers the long tail.
const COMBINE = 150_000

function ownerToken() {
  const state = JSON.parse(fs.readFileSync('./auth.json', 'utf8'))
  const origin = (state.origins || [])[0] || {}
  return (origin.localStorage || []).find((e) => e.name === 'gmr-token')?.value
}

async function api(request, tok, method, path, data) {
  const opts = { headers: { Authorization: `Bearer ${tok}` } }
  if (data !== undefined) opts.data = data
  const r = await request[method.toLowerCase()](`/capi${path}`, opts)
  return { status: r.status(), body: await r.json().catch(() => null) }
}

// Create a studio project + its source queries via API (test setup).
async function seedProject(request, tok, name, queries) {
  const proj = await api(request, tok, 'POST', '/studio/projects', { name: `${name} ${RUN}` })
  expect(proj.status, JSON.stringify(proj.body)).toBe(201)
  const pid = proj.body.id
  for (const q of queries) {
    const r = await api(request, tok, 'POST', `/studio/projects/${pid}/queries`, q)
    expect(r.status).toBe(201)
  }
  return pid
}

// Build a plot in the studio UI from a seeded query, then pocket it.
// cfg(page) sets the chart-specific controls after the chart type is chosen.
async function buildPlot(page, pid, { queryName, chart, name, cfg }) {
  await page.goto(`/studio/p/${pid}/plot`)
  await expect(page.locator('[data-testid="studio-plot-view"]')).toBeVisible({ timeout: 30_000 })
  // pick the source query (label text carries the query name)
  await page.locator('[data-testid="plot-query-toggle"]', { hasText: queryName })
    .locator('input[type=checkbox]').check()
  // combine (transform auto-fills to SELECT * FROM q1)
  await page.click('[data-testid="plot-combine"]')
  await expect(page.locator('[data-testid="plot-result"]')).toBeVisible({ timeout: COMBINE })
  // choose chart type + its controls
  await page.selectOption('[data-testid="plot-chart"]', chart)
  if (cfg) await cfg(page)
  await page.fill('[data-testid="plot-name"]', name)
  // pocket it for the story
  await page.click('[data-testid="plot-pocket"]')
  await expect(page.locator('[data-testid="plot-pocket"]')).toContainText('Pocketed', { timeout: 10_000 })
}

// Author a data story in the UI: title, abstract, narrative, embedded plots.
async function authorStory(page, { title, abstract, paras, plots }) {
  await page.goto('/my-stories')
  await page.click('[data-testid="create-btn"]')
  await page.click('[data-testid="new-story-btn"]')
  await page.waitForURL(/\/stories\/.*\/edit/, { timeout: 30_000 })
  const storyId = page.url().match(/\/stories\/([^/]+)\/edit/)?.[1]
  await expect(page.locator('[data-testid="editor-body"]')).toBeVisible({ timeout: 15_000 })
  await page.fill('[data-testid="story-title-input"]', title)
  await page.fill('[data-testid="story-abstract-input"]', abstract)

  const body = page.locator('.tiptap-editor .tiptap')
  await body.click()
  for (const p of paras) { await body.pressSequentially(p, { delay: 1 }); await body.press('Enter') }

  // embed each pocketed plot from the widget picker
  for (const name of plots) {
    await page.click('[data-testid="tb-widget"]')
    await expect(page.locator('[data-testid="pocket-modal"]')).toBeVisible({ timeout: 10_000 })
    await page.locator('[data-testid="pocket-list"] .pocket-item', { hasText: name })
      .locator('.pocket-item-info').first().click()
    await expect(page.locator('[data-testid="pocket-modal"]')).toHaveCount(0, { timeout: 10_000 })
    await body.press('ArrowDown') // move off the freshly-inserted block
  }

  await page.click('[data-testid="save-story"]')
  await expect(page.locator('[data-testid="save-story"]')).toBeEnabled({ timeout: 10_000 })
  // reload → the embedded plots persisted + re-render live
  await page.goto(`/stories/${storyId}/edit`)
  await expect(page.locator('[data-testid="editor-body"]')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('[data-testid="widget-viz"]')).toHaveCount(plots.length, { timeout: 30_000 })
  return storyId
}

// ── SPARQL / SQL data pipelines (real Fontem data) ──
const SB_RATE = `PREFIX f: <http://data.fontem.eu/ontology#>
PREFIX wdt: <http://www.wikidata.org/prop/direct/>
SELECT ?country (COUNT(?c) AS ?contracts) (ROUND(SUM(IF(?sb,1,0))*1000.0/COUNT(?c))/10 AS ?single_pct)
WHERE { ?c a f:Contract ; f:awardedBy ?a ; f:isSingleBidder ?sb . ?a wdt:P17 ?country }
GROUP BY ?country HAVING (COUNT(?c) >= 20) ORDER BY DESC(?single_pct)`

const HU_SUPPLIERS = `PREFIX f: <http://data.fontem.eu/ontology#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX wdt: <http://www.wikidata.org/prop/direct/>
SELECT ?company (ROUND(SUM(?v)/1000000) AS ?million_eur)
WHERE { ?c a f:Contract ; f:awardedBy ?a ; f:awardedTo ?co ; f:valueEur ?v . ?a wdt:P17 "HUN" . ?co rdfs:label ?company }
GROUP BY ?company ORDER BY DESC(?million_eur) LIMIT 15`

const CRIME_MIGRATION = `SELECT c.geo_code AS country,
  MAX(c.value) FILTER (WHERE c.dimensions->>'iccs'='ICCS03011') AS rape,
  MAX(c.value) FILTER (WHERE c.dimensions->>'iccs'='ICCS0101') AS homicide,
  m.migration
FROM observation c
JOIN (SELECT geo_code, SUM(value) AS migration FROM observation WHERE dataset_code='migr_acq' AND time='2019-01-01T00:00:00+00:00' GROUP BY geo_code) m ON m.geo_code=c.geo_code
WHERE c.dataset_code='crim_off_cat' AND c.dimensions->>'unit'='P_HTHAB' AND c.time='2019-01-01T00:00:00+00:00'
GROUP BY c.geo_code, m.migration
HAVING MAX(c.value) FILTER (WHERE c.dimensions->>'iccs'='ICCS03011') IS NOT NULL
ORDER BY country`

test.describe('Investigative articles (UI-authored)', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(360_000)

  test('ARTICLE-1: Hungarian single-bidder procurement corruption', async ({ page, request }) => {
    const tok = ownerToken()
    // feature-detect the studio sharing model is deployed
    const probe = await api(request, tok, 'POST', '/studio/projects', { name: `probe ${RUN}` })
    test.skip(probe.status !== 201, 'studio not deployed here')

    const pid = await seedProject(request, tok, 'Hungary corruption', [
      { name: 'single-bidder by country', lang: 'sparql', query: SB_RATE },
      { name: 'Hungarian-state suppliers', lang: 'sparql', query: HU_SUPPLIERS },
    ])

    // Plot A — bar: single-bidder rate by country
    await buildPlot(page, pid, {
      queryName: 'single-bidder by country', chart: 'bar_h', name: `SB rate by country ${RUN}`,
      cfg: async (p) => {
        await p.selectOption('[data-testid="plot-x"]', 'country')
        await p.selectOption('[data-testid="plot-y"]', 'single_pct')
      },
    })
    // Plot B — bivariate choropleth: rate (colour) × contract volume (opacity)
    await buildPlot(page, pid, {
      queryName: 'single-bidder by country', chart: 'atlas_map', name: `SB bivariate map ${RUN}`,
      cfg: async (p) => {
        await p.selectOption('[data-testid="plot-geo"]', 'country')
        await p.selectOption('[data-testid="plot-value"]', 'single_pct')
        await p.selectOption('[data-testid="plot-bivariate"]', 'choropleth')
        await p.selectOption('[data-testid="plot-value2"]', 'contracts')
        await expect(p.locator('[data-testid="studio-map"]')).toBeVisible({ timeout: 20_000 })
      },
    })
    // Plot C — bar: top suppliers to the Hungarian state (€M)
    await buildPlot(page, pid, {
      queryName: 'Hungarian-state suppliers', chart: 'bar_h', name: `Top HU suppliers ${RUN}`,
      cfg: async (p) => {
        await p.selectOption('[data-testid="plot-x"]', 'company')
        await p.selectOption('[data-testid="plot-y"]', 'million_eur')
      },
    })

    await authorStory(page, {
      title: `Following the money: Hungary's single-bidder problem ${RUN}`,
      abstract: 'Across EU procurement, Hungary awards nearly half its public contracts with a single bidder — far above the EU norm. We map where the money goes.',
      paras: [
        'Single-bidder contracts — where only one company competes — are the clearest structural red flag in public procurement.',
        'Hungary sits near the top of the EU table, with the state directing large sums to a concentrated set of suppliers.',
      ],
      plots: [`SB rate by country ${RUN}`, `SB bivariate map ${RUN}`, `Top HU suppliers ${RUN}`],
    })
  })

  test('ARTICLE-2: Rape vs migration — a spurious correlation, examined', async ({ page, request }) => {
    const tok = ownerToken()
    const probe = await api(request, tok, 'GET', '/studio/projects')
    test.skip(probe.status !== 200, 'studio not deployed here')

    const pid = await seedProject(request, tok, 'Rape vs migration', [
      { name: 'crime + migration by country', lang: 'sql', query: CRIME_MIGRATION },
    ])

    // Plot A — the correlation matrix (the headline analytical tool)
    await buildPlot(page, pid, {
      queryName: 'crime + migration by country', chart: 'corr_matrix', name: `Crime-migration correlation ${RUN}`,
      cfg: async (p) => {
        await expect(p.locator('[data-testid="corr-matrix"] rect.cm-cell').first()).toBeVisible({ timeout: 15_000 })
      },
    })
    // Plot B — bivariate choropleth: rape rate (colour) × migration (opacity)
    await buildPlot(page, pid, {
      queryName: 'crime + migration by country', chart: 'atlas_map', name: `Rape-migration map ${RUN}`,
      cfg: async (p) => {
        await p.selectOption('[data-testid="plot-geo"]', 'country')
        await p.selectOption('[data-testid="plot-value"]', 'rape')
        await p.selectOption('[data-testid="plot-bivariate"]', 'alpha')
        await p.selectOption('[data-testid="plot-value2"]', 'migration')
        await expect(p.locator('[data-testid="studio-map"]')).toBeVisible({ timeout: 20_000 })
      },
    })
    // Plot C — line: rape vs homicide rates across countries
    await buildPlot(page, pid, {
      queryName: 'crime + migration by country', chart: 'line', name: `Crime rates by country ${RUN}`,
      cfg: async (p) => {
        await p.selectOption('[data-testid="plot-x"]', 'country')
        // series checkboxes: rape + homicide
        const series = p.locator('[data-testid="plot-series"]')
        await series.locator('input[type=checkbox][value="rape"]').check()
        await series.locator('input[type=checkbox][value="homicide"]').check()
        await expect(p.locator('[data-testid="multi-line-chart"] path.mlc-line').first()).toBeVisible({ timeout: 15_000 })
      },
    })

    await authorStory(page, {
      title: `Rape and migration: what the correlation actually shows ${RUN}`,
      abstract: 'A correlation matrix across EU countries tests the claim that migration drives sexual violence. The data tells a more careful story.',
      paras: [
        'A correlation matrix lets us compare recorded rape rates, homicide rates and migration side by side across countries.',
        'Correlation is not causation: reporting rates, legal definitions and population structure all confound a naive reading.',
      ],
      plots: [`Crime-migration correlation ${RUN}`, `Rape-migration map ${RUN}`, `Crime rates by country ${RUN}`],
    })
  })
})
