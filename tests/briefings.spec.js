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

/**
 * Where a briefing card takes you.
 *
 * A card whose headline is a fact about a contract, a company or a
 * lobbying declaration is only half the story: the reader has to be able
 * to reach the record. These links come from the named query that found
 * the item (its `link` column), so they are data, not markup — which is
 * exactly why they need an end-to-end check. The failure mode is silent:
 * a query emitting a truncated path still renders a perfectly clickable
 * card that lands nowhere, and that is what shipped.
 *
 * Reads the REAL briefings, not the synthetic fixture above: that
 * fixture's rows link to /briefings, so they would prove nothing about
 * entity routing.
 *
 * Runs signed OUT, in a context without the suite's storageState. That
 * is the product promise being checked — a stranger's first visit gets
 * the public-investment seed rather than an empty page — and it is the
 * path with the most links to follow.
 */
test.describe('briefing card links', () => {
  test.setTimeout(120_000)

  /** Entity routes a briefing item is allowed to point at. */
  const ENTITY_PATH = /^\/(contract|company|authority|lobbyist)\/[^/]+/

  /** A genuinely signed-out page: no storageState, no bootstrap token. */
  async function anonymousPage(browser) {
    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } })
    const page = await ctx.newPage()
    await page.goto('/')
    await expect(page.locator('[data-testid="feed-briefings"]')).toBeVisible({ timeout: 30_000 })
    return { ctx, page }
  }

  test('BRIEF-LINK-1: the landing feed carries briefing cards for a stranger', async ({ browser }) => {
    // The signed-out seed is a product promise. If it is empty the rest
    // of this group is vacuous, so it fails here loudly rather than
    // letting the others pass over no data.
    const { ctx, page } = await anonymousPage(browser)
    const cards = page.locator('li[data-testid^="feed-briefing-"]')
    expect(await cards.count(), 'the signed-out landing feed seeded no briefing items')
      .toBeGreaterThan(0)
    await ctx.close()
  })

  test('BRIEF-LINK-2: every card link is an in-app entity path, never the baked-in origin', async ({ browser }) => {
    // The queries hard-code an absolute origin, so a card rendered as a
    // raw href sends a reader on staging to production. Every link must
    // have been reduced to a path first.
    const { ctx, page } = await anonymousPage(browser)
    const links = page.locator('[data-testid^="feed-briefing-link-"]')
    const n = await links.count()
    expect(n, 'no briefing card offered a destination').toBeGreaterThan(0)
    for (let i = 0; i < n; i++) {
      const href = await links.nth(i).getAttribute('href')
      expect(href, `card ${i} rendered as a link with no href`).toBeTruthy()
      expect(href, `card ${i} points off-site: ${href}`).toMatch(ENTITY_PATH)
    }
    await ctx.close()
  })

  test('BRIEF-LINK-3: following a card lands on the record, not a 404', async ({ browser }) => {
    // The bug this pins: a query emitting '<origin>/company/' with the id
    // coalesced away renders a clickable card that resolves to nothing.
    const { ctx, page } = await anonymousPage(browser)
    const first = page.locator('[data-testid^="feed-briefing-link-"]').first()
    await expect(first).toBeVisible({ timeout: 10_000 })
    const href = await first.getAttribute('href')
    await first.click()
    await page.waitForURL((u) => u.pathname === href.split('?')[0], { timeout: 15_000 })

    // The SPA answers 200 for every path, so "did it 404" is a DOM
    // question rather than a status-code one.
    await expect(page.locator('.notfound-code')).toHaveCount(0)

    // And the record itself rendered, per destination type.
    const path = new URL(page.url()).pathname
    if (path.startsWith('/contract/')) {
      await expect(page.locator('[data-testid="contract-detail"]')).toBeVisible({ timeout: 20_000 })
    } else if (path.startsWith('/lobbyist/')) {
      await expect(page.locator('[data-testid="lobbyist-name"]')).toBeVisible({ timeout: 20_000 })
    } else {
      await expect(page.locator('[data-testid="ticker-detail"]')).toBeVisible({ timeout: 20_000 })
    }
    await ctx.close()
  })

  test('BRIEF-LINK-4: a card with no resolvable record is not a dead click', async ({ browser }) => {
    // ~4 in 5 register entrants resolve to no company we hold. Those
    // items are still news, so they render — as text, not as a link into
    // nothing.
    const { ctx, page } = await anonymousPage(browser)
    const anchors = page.locator('[data-testid="feed-briefings"] a')
    const n = await anchors.count()
    for (let i = 0; i < n; i++) {
      const href = await anchors.nth(i).getAttribute('href')
      expect(href, `dead link rendered: ${href}`)
        .not.toMatch(/\/(company|contract|lobbyist|authority)\/?$/)
    }
    await ctx.close()
  })
})
