/**
 * Data-quality dashboards — endpoint + page smoke.
 *
 * Read-only checks against the live deployment. These exist because the
 * DQ dashboards have repeatedly broken at the *environment* boundary in
 * ways unit/component tests can't see: a server 500 from a dependency
 * drift, and a 503 because the api server was never wired to the events
 * DB (so /etl-runs and the pipeline-health endpoints failed). Each check
 * loads the real backend.
 *
 * Two layers:
 *   DQ-API  — every dashboard-backing endpoint must not 5xx.
 *   DQ-PAGE — every dashboard route must render with no 5xx on its
 *             /api/data-quality/* calls and no server-error banner.
 */
import { test, expect } from '@playwright/test'

// Endpoints that back the dashboards. A 5xx here is always a bug; 4xx is
// tolerated (a feed may legitimately have no data / no endpoint yet).
const DQ_ENDPOINTS = [
  '/api/data-quality',
  '/api/data-quality/coverage',
  '/api/data-quality/etl-runs',
  '/api/data-quality/pipeline',
  '/api/data-quality/pipeline/contracts/timeline',
  '/api/data-quality/contracts/value-quality',
  '/api/data-quality/contracts/by-country',
  '/api/data-quality/gleif',
  '/api/data-quality/edgar',
  '/api/data-quality/esef',
  '/api/data-quality/lobbying',
  '/api/data-quality/sanctions',
  '/api/data-quality/firds',
  '/api/data-quality/openfigi',
  '/api/data-quality/nuts',
  '/api/data-quality/eu-knowledge-graph',
  '/api/data-quality/cdp',
]

// Endpoints that MUST be 200 (the operational core + the regressions
// these tests were written to catch).
const DQ_MUST_200 = new Set([
  '/api/data-quality',
  '/api/data-quality/etl-runs',
  '/api/data-quality/pipeline',
])

const DQ_ROUTES = [
  '/data-quality',
  '/data-quality/etl-runs',
  '/data-quality/overview',
  '/data-quality/contracts',
  '/data-quality/gleif',
  '/data-quality/edgar',
  '/data-quality/esef',
  '/data-quality/lobbying',
  '/data-quality/sanctions',
  '/data-quality/firds',
  '/data-quality/nuts',
  '/data-quality/eu-knowledge-graph',
  '/data-quality/theme/procurement',
  '/data-quality/theme/corporate',
  '/data-quality/theme/influence',
  '/data-quality/theme/securities',
  '/data-quality/theme/geography',
]

test.describe('Data Quality — endpoints', () => {
  for (const ep of DQ_ENDPOINTS) {
    test(`DQ-API ${ep} does not 5xx`, async ({ request }) => {
      const res = await request.get(ep)
      const status = res.status()
      if (DQ_MUST_200.has(ep)) {
        expect(status, `${ep} should be 200`).toBe(200)
      } else {
        expect(status, `${ep} returned a server error`).toBeLessThan(500)
      }
    })
  }
})

test.describe('Data Quality — dashboard pages', () => {
  for (const route of DQ_ROUTES) {
    test(`DQ-PAGE ${route} renders without a server error`, async ({ page }) => {
      const serverErrors = []
      page.on('response', (r) => {
        if (r.url().includes('/api/data-quality') && r.status() >= 500) {
          serverErrors.push(`${r.status()} ${r.url()}`)
        }
      })
      await page.goto(route, { waitUntil: 'networkidle', timeout: 30_000 })
      // No server-error banner leaked into the UI.
      await expect(page.locator('body')).not.toContainText(
        /Internal Server Error|HTTP 5\d\d|events store unavailable/i,
        { timeout: 10_000 },
      )
      expect(serverErrors, `5xx DQ responses on ${route}`).toEqual([])
    })
  }
})
