/**
 * What a crawler actually receives.
 *
 * Lives here rather than in fontem-web/tests/e2e because THIS is the
 * suite the gitops promote workflow runs as its hard gate against
 * testing. fontem-web's own e2e directory is not wired into any
 * workflow, so a copy kept only there would guard nothing — which it
 * did, silently, until someone checked.
 *
 * Every request here goes through `request.get()`, not `page.goto()`, on
 * purpose: that fetches the raw HTML without executing JavaScript, which
 * is exactly what GPTBot, ClaudeBot, PerplexityBot and CCBot do. A test
 * driven through the browser would hydrate the SPA and pass while the
 * crawler-visible bytes stayed empty — which is how the bug these cover
 * survived in the first place.
 *
 * The bug: nginx fell back to `/index.html`, which IS the prerendered
 * homepage, so every route without its own file served the homepage's
 * title, description, JSON-LD and canonical. A canonical of `/` on
 * `/stories/<id>` tells Google that page is the homepage — an
 * instruction not to index it — while sitemap-stories.xml submitted
 * those very URLs.
 *
 * Assertions are on the canonical PATH, never the host. CANONICAL_URL is
 * not set per environment, so testing and staging both bake the
 * production origin; the host would differ by env but the path invariant
 * holds everywhere.
 */
import { test, expect } from '@playwright/test'

const canonicalOf = (html) => {
  const m = html.match(/<link rel="canonical" href="([^"]+)"/i)
  return m ? m[1] : null
}
const titleOf = (html) => {
  const m = html.match(/<title>([^<]*)<\/title>/i)
  return m ? m[1] : null
}
const metaOf = (html, name) => {
  const m = html.match(new RegExp(`<meta name="${name}" content="([^"]*)"`, 'i'))
  return m ? m[1] : null
}

// Routes Vue Router owns on the client — no prerendered file exists, so
// nginx serves the SPA shell. A non-existent id is deliberate: the shell
// is served for any unmatched path, so these need no fixture data.
const SPA_ROUTES = [
  '/stories/00000000-0000-0000-0000-000000000000',
  '/company/does-not-exist',
  '/authority/does-not-exist',
  '/contract/does-not-exist',
]

test.describe('crawler-visible HTML', () => {
  test('a prerendered page points its canonical at itself', async ({ request }) => {
    const html = await (await request.get('/about')).text()
    const canonical = canonicalOf(html)
    expect(canonical, '/about must carry a canonical').toBeTruthy()
    expect(new URL(canonical).pathname).toBe('/about')
  })

  test('the homepage points its canonical at the root', async ({ request }) => {
    const html = await (await request.get('/')).text()
    expect(new URL(canonicalOf(html)).pathname).toBe('/')
  })

  for (const route of SPA_ROUTES) {
    test(`${route} does not claim to be the homepage`, async ({ request }) => {
      const res = await request.get(route)
      expect(res.status()).toBe(200)
      const html = await res.text()

      // The regression. Either no canonical (correct — Google then uses
      // the request URL) or one that names this page. Never the root.
      const canonical = canonicalOf(html)
      if (canonical !== null) {
        expect(new URL(canonical).pathname,
          `${route} canonical must not point at another page`).toBe(route)
      }

      // The landing's ItemList describes the feed, not whatever page
      // fell back to the shell; shipping it here misdescribes the page.
      expect(html).not.toContain('"@type":"ItemList"')
    })
  }

  test('SPA routes do not all share the homepage title', async ({ request }) => {
    const home = titleOf(await (await request.get('/')).text())
    for (const route of SPA_ROUTES) {
      const title = titleOf(await (await request.get(route)).text())
      expect(title, `${route} needs a title`).toBeTruthy()
      expect(title, `${route} must not reuse the homepage title`).not.toBe(home)
    }
  })

  test('prerendered pages each have a distinct title', async ({ request }) => {
    const paths = ['/', '/about', '/privacy', '/data-quality', '/sparql', '/development']
    const titles = []
    for (const p of paths) titles.push(titleOf(await (await request.get(p)).text()))
    expect(titles.every(Boolean)).toBe(true)
    expect(new Set(titles).size, 'duplicate titles collapse in search results')
      .toBe(paths.length)
  })

  test('meta stays inside what a search result renders', async ({ request }) => {
    for (const p of ['/', '/about', '/privacy', '/data-quality', '/sparql', '/development']) {
      const html = await (await request.get(p)).text()
      expect(titleOf(html).length, `${p} title`).toBeLessThanOrEqual(60)
      expect(metaOf(html, 'description').length, `${p} description`).toBeLessThanOrEqual(160)
    }
  })
})

test.describe('crawler discovery', () => {
  test('robots.txt allows the AI crawlers and names the sitemap', async ({ request }) => {
    const body = await (await request.get('/robots.txt')).text()
    for (const bot of ['GPTBot', 'ClaudeBot', 'PerplexityBot', 'CCBot', 'Googlebot']) {
      expect(body, `${bot} should be addressed explicitly`).toContain(bot)
    }
    expect(body).toMatch(/^Sitemap:\s*https?:\/\/\S+\/sitemap\.xml$/m)
  })

  test('the sitemap index resolves to child sitemaps that carry URLs', async ({ request }) => {
    const index = await (await request.get('/sitemap.xml')).text()
    expect(index).toContain('<sitemapindex')
    const children = [...index.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])
    expect(children.length, 'the index must list child sitemaps').toBeGreaterThan(0)

    let total = 0
    for (const child of children) {
      // Fetch by path so this works against whichever env BASE_URL names,
      // rather than following the baked production origin.
      const res = await request.get(new URL(child).pathname)
      expect(res.status(), `${child} must be fetchable`).toBe(200)
      const body = await res.text()
      expect(body, `${child} must be a urlset`).toContain('<urlset')
      total += (body.match(/<url>/g) || []).length
    }
    // In aggregate, not per shard. Company shards are per country, and a
    // country with no listed companies yet is legitimately empty — that
    // is data, not a broken sitemap.
    expect(total, 'the sitemap as a whole must advertise URLs').toBeGreaterThan(0)
  })

  test('company shards are sharded per country, small states included', async ({ request }) => {
    const index = await (await request.get('/sitemap.xml')).text()
    // A global "top N" would bury these entirely; each gets its own file.
    for (const code of ['MLT', 'CYP', 'LUX', 'EST', 'LIE']) {
      expect(index, `${code} needs its own shard`).toContain(`/sitemap-companies-${code}.xml`)
    }
  })

  test('authority shards are advertised per country too', async ({ request }) => {
    // Held out until /authority/:authority_id rendered the full entity
    // page — the SPA catch-all used to answer 200 with a not-found view,
    // so these would have been ~16,000 soft-404s.
    const index = await (await request.get('/sitemap.xml')).text()
    for (const code of ['MLT', 'CYP', 'LUX', 'EST', 'LIE']) {
      expect(index, `${code} needs an authority shard`)
        .toContain(`/sitemap-authorities-${code}.xml`)
    }
  })

  test('an advertised entity URL is actually served', async ({ request }) => {
    // The soft-404 guard, from the crawler's side: whatever the shards
    // point at has to be a page, not the catch-all.
    for (const p of ['/company/does-not-exist', '/authority/does-not-exist']) {
      expect((await request.get(p)).status(), p).toBe(200)
    }
  })

  test('every URL the core sitemap advertises is actually served', async ({ request }) => {
    const body = await (await request.get('/sitemap-core.xml')).text()
    const locs = [...body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]).pathname)
    expect(locs.length).toBeGreaterThan(0)
    for (const p of locs) {
      expect((await request.get(p)).status(), `${p} is in the sitemap`).toBe(200)
    }
  })
})
