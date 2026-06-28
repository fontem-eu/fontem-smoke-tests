/**
 * Atlas map widget must actually render in a story. The "shows nothing" bug was
 * a CSP-blocked external map style (openfreemap.org), which silently stops
 * maplibre 'load' from firing so the choropleth layer is never added. We assert
 * the widget mounts, its data + boundary requests succeed, and NO map resource
 * is blocked by CSP (the deterministic signature of the bug — no WebGL needed).
 */
import { test, expect } from './baseTest.js'

const ATLAS = {
  widget_type: 'atlas_map', name: 'Recorded rape 2013',
  config: { dataset: 'crim_off_cat', nuts_level: 0, year: 2013, dimensions: { iccs: 'ICCS03011', unit: 'P_HTHAB' } },
}

test.describe('atlas map widget', () => {
  test.setTimeout(120_000)
  test('ATLAS-WIDGET: renders in a story with no CSP-blocked map resources', async ({ page }) => {
    const cspErrors = []
    const seen = {}
    page.on('console', (m) => {
      if (m.type() !== 'error') return
      const t = m.text()
      // Only flag map-RESOURCE fetch blocks (connect-src/img-src) — the actual
      // bug. Ignore unrelated inline-script (script-src) CSP noise elsewhere on
      // the page, which is a separate concern, not the atlas widget.
      const isFetchBlock = /refused to connect|fetch api cannot load/i.test(t)
        || /violates[\s\S]*?(connect-src|img-src)/i.test(t)
      if (isFetchBlock && !/inline script|script-src/i.test(t)) cspErrors.push(t)
    })
    page.on('response', (r) => {
      const u = r.url()
      if (/\/atlas\/series/.test(u)) seen.series = r.status()
      if (/\/geo\/nuts-boundaries/.test(u)) seen.boundaries = r.status()
    })

    await page.goto('/my-stories')
    await page.evaluate((item) => localStorage.setItem('gmr-pocket', JSON.stringify([item])), ATLAS)
    await page.reload()
    await page.click('[data-testid="create-btn"]')
    await page.click('[data-testid="new-story-btn"]')
    await page.waitForURL(/\/stories\/.*\/edit/, { timeout: 30_000 })
    await page.click('[data-testid="tb-widget"]')
    await expect(page.locator('[data-testid="pocket-modal"]')).toBeVisible({ timeout: 10_000 })
    await page.locator('[data-testid="pocket-list"] .pocket-item', { hasText: 'Recorded rape 2013' }).locator('.pocket-item-info').first().click()
    await expect(page.locator('[data-testid="pocket-modal"]')).toHaveCount(0, { timeout: 10_000 })

    const w = page.locator('[data-testid="widget-atlas-map"]')
    await expect(w).toBeVisible({ timeout: 20_000 })
    await page.waitForTimeout(5000) // let the map style + data settle

    // 1) the data path resolved
    expect(seen.series, 'atlas /series request fired + succeeded').toBe(200)
    expect(seen.boundaries, 'nuts-boundaries request fired + succeeded').toBe(200)
    // 2) the widget is not in its error state
    await expect(page.locator('[data-testid="widget-atlas-error"]')).toHaveCount(0)
    // 3) NO map resource was blocked by CSP (the actual bug)
    expect(cspErrors, `CSP blocked a map resource:\n${cspErrors.join('\n')}`).toEqual([])
  })
})
