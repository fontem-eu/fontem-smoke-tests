/**
 * Briefings end-to-end: browse, watch, read, and the Atom feed.
 *
 * Runs against the synthetic briefing seeded by fixtures/seed_e2e_briefings.py
 * in an init container before this suite starts. That fixture's query invents
 * its own rows rather than reading the graph, so these assertions are fixed
 * instead of chasing data that changes daily — and nothing invented ever
 * lands in the shared graph that staging also reads.
 *
 * The fixture spans nested regions on purpose: PT165 ⊂ PT16 ⊂ PT, plus ES300
 * and DE300. So "PT" sees three items, "PT16" sees one, and a prefix filter
 * has something to actually discriminate.
 */
import { test, expect } from './baseTest.js'

const FIXTURE = 'E2E smoke'
const FIXTURE_TITLE = /SMOKE TEST FIXTURE/

/** Remove every watch this account holds, so a run starts from zero and a
 *  previous failed run cannot make the next one pass. */
async function clearWatches(page) {
  const watches = await page.evaluate(async () => {
    const token = globalThis.__FONTEM_BOOTSTRAP_TOKEN__
    const res = await fetch('/capi/me/watches', {
      headers: { Authorization: `Bearer ${token}` },
    })
    return res.ok ? res.json() : []
  })
  for (const w of watches) {
    await page.evaluate(async (id) => {
      const token = globalThis.__FONTEM_BOOTSTRAP_TOKEN__
      await fetch(`/capi/me/watches/${id}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
      })
    }, w.id)
  }
}

test.describe('briefings', () => {
  test.setTimeout(120_000)

  test.beforeEach(async ({ page }) => {
    await page.goto('/briefings')
    await clearWatches(page)
    await page.reload()
  })

  test('BRIEF-01: the catalogue is browsable and a card expands with a sample', async ({ page }) => {
    const card = page.getByTestId('briefing-e2e-smoke')
    await expect(card).toBeVisible()

    // Nothing is fetched until the card is opened.
    await expect(page.getByTestId('panel-e2e-smoke')).toHaveCount(0)
    await card.click()

    const panel = page.getByTestId('panel-e2e-smoke')
    await expect(panel).toBeVisible()
    // Controls live inside the card, not in a pane elsewhere on the page.
    await expect(panel.getByTestId('volume-e2e-smoke')).toBeVisible()
    await expect(panel.getByTestId('add-e2e-smoke')).toBeVisible()
    // ...and a short sample of what is actually in it.
    await expect(page.getByTestId('items-e2e-smoke').getByText(FIXTURE_TITLE).first())
      .toBeVisible()
  })

  test('BRIEF-02: a briefing can be watched several times at different scopes', async ({ page }) => {
    // The case the data model forbade until 017: 50 a week from one region,
    // 10 from its parent, 10 from everywhere — one briefing, three feeds.
    await page.getByTestId('briefing-e2e-smoke').click()
    const panel = page.getByTestId('panel-e2e-smoke')

    for (const [region, volume] of [['PT165', '50'], ['PT', '10'], ['', '25']]) {
      if (region) {
        await panel.getByTestId('region-input').fill(region)
        await panel.getByTestId(`region-option-${region}`).click()
      }
      await panel.getByTestId('volume-e2e-smoke').selectOption(volume)
      await panel.getByTestId('add-e2e-smoke').click()
      // Clear the region for the next pass.
      const chosen = panel.getByTestId('region-clear')
      if (await chosen.count()) await chosen.click()
    }

    const subs = page.getByTestId('subscriptions')
    await expect(subs.locator('.bf-sub-row')).toHaveCount(3)
    // Three subscriptions, three feed URLs — not one overwritten three times.
    await expect(subs.getByText('50 a week')).toBeVisible()
    await expect(subs.getByText('25 a week')).toBeVisible()
    // And the card says how many, rather than a yes/no.
    await expect(page.getByTestId('watching-e2e-smoke')).toContainText('3')
  })

  test('BRIEF-03: editing one subscription leaves the others alone', async ({ page }) => {
    await page.getByTestId('briefing-e2e-smoke').click()
    const panel = page.getByTestId('panel-e2e-smoke')
    await panel.getByTestId('volume-e2e-smoke').selectOption('10')
    await panel.getByTestId('add-e2e-smoke').click()
    await panel.getByTestId('volume-e2e-smoke').selectOption('50')
    await panel.getByTestId('add-e2e-smoke').click()

    const subs = page.getByTestId('subscriptions')
    await expect(subs.locator('.bf-sub-row')).toHaveCount(2)

    const rows = subs.locator('.bf-sub-row')
    const editButton = rows.first().getByRole('button', { name: /edit/i })
    await editButton.click()
    const editor = subs.locator('[data-testid^="editor-"]')
    await expect(editor).toBeVisible()
    await editor.locator('select').selectOption('3')
    await subs.locator('[data-testid^="save-"]').click()

    await expect(subs.getByText('3 a week')).toBeVisible()
    // The other one is untouched.
    await expect(subs.locator('.bf-sub-row')).toHaveCount(2)
  })

  test('BRIEF-04: the region filter narrows what a subscription sees', async ({ page }) => {
    await page.getByTestId('briefing-e2e-smoke').click()
    const panel = page.getByTestId('panel-e2e-smoke')
    const items = page.getByTestId('items-e2e-smoke')

    // Everywhere: the fixture spans five regions, so the sample is capped at
    // four rather than empty.
    await expect(items.locator('li')).toHaveCount(4)

    // PT165 is one item; the prefix filter has to actually discriminate.
    await panel.getByTestId('region-input').fill('PT165')
    await panel.getByTestId('region-option-PT165').click()
    await expect(items.locator('li')).toHaveCount(1)
  })

  test('BRIEF-05: watched items appear in the reading list, tagged by briefing', async ({ page }) => {
    await page.getByTestId('briefing-e2e-smoke').click()
    await page.getByTestId('panel-e2e-smoke').getByTestId('add-e2e-smoke').click()
    await expect(page.getByTestId('subscriptions').locator('.bf-sub-row')).toHaveCount(1)

    await page.goto('/my-briefings')
    const items = page.getByTestId('items')
    await expect(items.getByText(FIXTURE_TITLE).first()).toBeVisible()
    // Every entry says which briefing produced it.
    await expect(items.getByTestId('source-tag').first()).toHaveText(FIXTURE)
  })

  test('BRIEF-06: overlapping subscriptions do not double up in the reading list', async ({ page }) => {
    // PT165 and PT both cover the same item. Each feed is right to include
    // it; the merged reading view is one stream and must show it once.
    await page.getByTestId('briefing-e2e-smoke').click()
    const panel = page.getByTestId('panel-e2e-smoke')
    await panel.getByTestId('region-input').fill('PT165')
    await panel.getByTestId('region-option-PT165').click()
    await panel.getByTestId('add-e2e-smoke').click()
    await panel.getByTestId('region-clear').click()
    await panel.getByTestId('region-input').fill('PT')
    await panel.getByTestId('region-option-PT').click()
    await panel.getByTestId('add-e2e-smoke').click()
    await expect(page.getByTestId('subscriptions').locator('.bf-sub-row')).toHaveCount(2)

    await page.goto('/my-briefings')
    const titles = await page.getByTestId('items').locator('li a').allTextContents()
    const fixtures = titles.filter((t) => FIXTURE_TITLE.test(t))
    expect(fixtures.length).toBeGreaterThan(0)
    expect(new Set(fixtures).size).toBe(fixtures.length)
  })

  test('BRIEF-07: every subscription has a working Atom feed', async ({ page, request }) => {
    await page.getByTestId('briefing-e2e-smoke').click()
    await page.getByTestId('panel-e2e-smoke').getByTestId('add-e2e-smoke').click()

    const feedUrl = await page.evaluate(async () => {
      const token = globalThis.__FONTEM_BOOTSTRAP_TOKEN__
      const res = await fetch('/capi/me/watches', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const watches = await res.json()
      return watches[0].feed_url
    })
    expect(feedUrl).toMatch(/\.atom$/)

    // Atom readers cannot authenticate: the token in the URL is the whole
    // credential, so this must work with no session at all.
    const path = new URL(feedUrl).pathname
    const res = await request.get(path, { headers: { Authorization: '' } })
    expect(res.status()).toBe(200)
    expect(res.headers()['content-type']).toContain('atom+xml')

    const body = await res.text()
    expect(body).toContain('<feed')
    expect(body).toMatch(FIXTURE_TITLE)
    // Conditional GET, so a reader polling every 15 minutes costs a 304.
    const etag = res.headers().etag
    expect(etag).toBeTruthy()
    const again = await request.get(path, { headers: { 'If-None-Match': etag } })
    expect(again.status()).toBe(304)
  })

  test('BRIEF-08: an unknown feed token is a 404, not a 500', async ({ request }) => {
    const res = await request.get('/capi/feeds/definitely-not-a-real-token.atom')
    expect(res.status()).toBe(404)
  })

  test('BRIEF-09: the catalogue is readable without signing in', async ({ browser }) => {
    // Deciding whether a briefing is worth watching means seeing inside it,
    // and that should not require an account.
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } })
    const page = await context.newPage()
    await page.goto('/briefings')
    await expect(page.getByTestId('briefing-e2e-smoke')).toBeVisible()
    await page.getByTestId('briefing-e2e-smoke').click()
    await expect(page.getByTestId('items-e2e-smoke').getByText(FIXTURE_TITLE).first())
      .toBeVisible()
    // ...but watching does need one, and says so rather than hiding.
    await expect(page.getByTestId('watch-login-e2e-smoke')).toBeVisible()
    await context.close()
  })
})
