/**
 * Article translations, end to end:
 *   TRANS-01 — a story with a Portuguese translation renders the translated
 *              title/body when the reader switches language; editing the
 *              ORIGINAL flips the translation to potentially-outdated (yellow
 *              badge on the story page); the editor's resolve action clears
 *              the flag without touching the translated text.
 *   TRANS-02 — the editor prefills an untranslated language with the
 *              original text so the translator starts from the full article.
 *
 * Setup (story + translation + original edit) goes through the API — the
 * dynamics under test are the UI's rendering of translation state, not
 * typing latin text into TipTap.
 */
import fs from 'node:fs'
import { test, expect } from './baseTest.js'

const RUN = String(Date.now())

function ownerToken() {
  const state = JSON.parse(fs.readFileSync('./auth.json', 'utf8'))
  const origin = (state.origins || [])[0] || {}
  return (origin.localStorage || []).find((e) => e.name === 'gmr-token')?.value
}

// The access token is captured once by global-setup and this file runs ~15
// minutes into the suite, by which point the JWT has expired — TRANS-01 was
// failing on its first call with {"detail":"Invalid or expired token"}. The
// browser-driven tests never saw it because their context carries the
// httpOnly refresh cookie and the app renews silently; a raw bearer does not.
//
// So renew the same way the app does. `request` inherits the storageState
// cookies, so /auth/refresh works without touching /auth/login — which
// matters, because login is rate limited to 5/min per IP and a retry storm
// there would take out the whole suite.
let _tok = null
async function freshToken(request) {
  if (_tok === null) _tok = ownerToken()
  return _tok
}

async function api(request, tok, method, path, data) {
  const call = async (t) => {
    const opts = { headers: { Authorization: `Bearer ${t}` } }
    if (data !== undefined) opts.data = data
    const r = await request[method.toLowerCase()](`/capi${path}`, opts)
    return { status: r.status(), body: await r.json().catch(() => null) }
  }
  let out = await call(tok || (await freshToken(request)))
  if (out.status === 401) {
    const r = await request.post('/capi/auth/refresh')
    if (r.ok()) {
      const body = await r.json().catch(() => null)
      if (body?.access_token) {
        _tok = body.access_token
        out = await call(_tok)
      }
    }
  }
  return out
}

const doc = (text) => ({
  tiptap: { type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text }] }] },
  version: 2,
})

const EN_BODY = `The original English body of the story ${RUN}.`
const EN_BODY_V2 = `The REVISED original English body ${RUN}.`
const PT_TITLE = `Título em português ${RUN}`
const PT_BODY = `O corpo traduzido em português ${RUN}.`

test.describe('Article translations', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(240_000)

  let sid

  test.afterAll(async ({ request }) => {
    if (sid) await api(request, ownerToken(), 'DELETE', `/data-stories/${sid}`)
  })

  test('TRANS-01: translated content renders; original edits flag it; resolve clears it', async ({ page, request }) => {
    const tok = ownerToken()
    // feature-detect the translations API is deployed here
    const probe = await api(request, tok, 'POST', '/data-stories', { title: `Translation e2e ${RUN}` })
    expect(probe.status, JSON.stringify(probe.body)).toBe(201)
    sid = probe.body.id
    const hasTranslations = await api(request, tok, 'GET', `/data-stories/${sid}/translations`)
    test.skip(hasTranslations.status !== 200, 'translations API not deployed here')

    await api(request, tok, 'PUT', `/data-stories/${sid}/content`, doc(EN_BODY))
    const put = await api(request, tok, 'PUT', `/data-stories/${sid}/translations/pt`, {
      title: PT_TITLE, abstract: 'Resumo em português', tiptap: doc(PT_BODY).tiptap, version: 2,
    })
    expect(put.status, JSON.stringify(put.body)).toBe(200)

    // ── reader: switch to the translation, see translated text, no badge ──
    await page.goto(`/stories/${sid}`)
    await expect(page.locator('[data-testid="translation-bar"]')).toBeVisible({ timeout: 20_000 })
    await page.selectOption('[data-testid="translation-picker"]', 'pt')
    await expect(page.locator('[data-testid="story-title"]')).toHaveText(PT_TITLE, { timeout: 15_000 })
    await expect(page.locator('[data-testid="story-body"]')).toContainText(PT_BODY)
    await expect(page.locator('[data-testid="translation-outdated-badge"]')).toHaveCount(0)
    // and back to the original
    await page.selectOption('[data-testid="translation-picker"]', '')
    await expect(page.locator('[data-testid="story-body"]')).toContainText(EN_BODY)

    // ── the original moves on: translation becomes potentially outdated ──
    const bump = await api(request, tok, 'PUT', `/data-stories/${sid}/content`, doc(EN_BODY_V2))
    expect(bump.status).toBe(200)

    // A reader whose UI language is the stale one must NOT be silently served
    // it. This is the regression the policy change exists for: before, the
    // story auto-opened in pt and rendered drifted text under a small badge.
    await page.addInitScript(() => localStorage.setItem('gmr-lang', 'pt'))
    await page.goto(`/stories/${sid}`)
    await expect(page.locator('[data-testid="story-body"]')).toContainText(EN_BODY_V2, { timeout: 20_000 })
    await expect(page.locator('[data-testid="translation-picker"]')).toHaveValue('')
    await expect(page.locator('[data-testid="stale-translation-notice"]')).toHaveCount(0)
    await page.addInitScript(() => localStorage.removeItem('gmr-lang'))

    await page.goto(`/stories/${sid}`)
    await expect(page.locator('[data-testid="translation-bar"]')).toBeVisible({ timeout: 20_000 })
    await page.selectOption('[data-testid="translation-picker"]', 'pt')
    // Picking it explicitly shows the ORIGINAL text plus a notice saying why —
    // a stale translation is never rendered.
    await expect(page.locator('[data-testid="stale-translation-notice"]')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('[data-testid="story-body"]')).toContainText(EN_BODY_V2)
    await expect(page.locator('[data-testid="story-body"]')).not.toContainText(PT_BODY)
    // the picker keeps the chosen language, and still flags it
    await expect(page.locator('[data-testid="translation-outdated-badge"]')).toBeVisible()

    // ── editor: the translation carries the flag; resolving clears it ──
    await page.goto(`/stories/${sid}/edit`)
    await expect(page.locator('[data-testid="editor-body"]')).toBeVisible({ timeout: 20_000 })
    await page.selectOption('[data-testid="translation-select"]', 'pt')
    // the translated text loaded into the editing surface
    await expect(page.locator('[data-testid="story-title-input"]')).toHaveValue(PT_TITLE, { timeout: 15_000 })
    await expect(page.locator('[data-testid="translation-outdated-flag"]')).toBeVisible()
    await page.click('[data-testid="resolve-translation"]')
    await expect(page.locator('[data-testid="translation-outdated-flag"]')).toHaveCount(0, { timeout: 10_000 })

    // ── reader again: the badge is gone, the text was never touched ──
    await page.goto(`/stories/${sid}`)
    await expect(page.locator('[data-testid="translation-bar"]')).toBeVisible({ timeout: 20_000 })
    await page.selectOption('[data-testid="translation-picker"]', 'pt')
    await expect(page.locator('[data-testid="story-body"]')).toContainText(PT_BODY, { timeout: 15_000 })
    await expect(page.locator('[data-testid="translation-outdated-badge"]')).toHaveCount(0)
  })

  test('TRANS-03: story opens in the reader UI language when a translation exists', async ({ page }) => {
    test.skip(!sid, 'TRANS-01 setup did not run')
    // Reader prefers Portuguese -> the PT translation loads without any interaction.
    await page.addInitScript(() => localStorage.setItem('gmr-lang', 'pt'))
    await page.goto(`/stories/${sid}`)
    await expect(page.locator('[data-testid="story-title"]')).toHaveText(PT_TITLE, { timeout: 20_000 })
    await expect(page.locator('[data-testid="translation-picker"]')).toHaveValue('pt')
    // Reader prefers German (no translation) -> the original loads.
    await page.addInitScript(() => localStorage.setItem('gmr-lang', 'de'))
    await page.goto(`/stories/${sid}`)
    await expect(page.locator('[data-testid="story-body"]')).toContainText(EN_BODY_V2, { timeout: 20_000 })
    await expect(page.locator('[data-testid="translation-picker"]')).toHaveValue('')
  })

  test('TRANS-04: story lists show the translated title for the reader language', async ({ page }) => {
    test.skip(!sid, 'TRANS-01 setup did not run')
    await page.addInitScript(() => localStorage.setItem('gmr-lang', 'pt'))
    await page.goto('/my-stories')
    // the card for the seeded story carries the PT title, not the original
    await expect(page.getByText(PT_TITLE).first()).toBeVisible({ timeout: 20_000 })
  })

  test('TRANS-05: anonymous first visit infers language from the IP country', async ({ browser }) => {
    // Fresh context: no auth token, no localStorage — the platform only
    // has the caller's IP. The runner egresses from a French address, so
    // the geo endpoint should answer fr and the SPA should adopt it.
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true })
    const page = await ctx.newPage()
    const geo = await page.request.get('/api/geo/client-language')
    expect(geo.ok()).toBe(true)
    const hint = await geo.json()
    test.skip(!hint.lang, `IP ${hint.country || 'unknown'} has no language mapping — cannot assert adoption`)

    await page.goto('/')
    await expect
      .poll(async () => page.evaluate(() => document.documentElement.lang), { timeout: 15_000 })
      .toBe(hint.lang)
    // detection is a hint, not a choice — nothing persisted
    expect(await page.evaluate(() => localStorage.getItem('gmr-lang'))).toBeNull()
    expect(await page.evaluate(() => sessionStorage.getItem('gmr-geo-lang'))).toBe(hint.lang)
    await ctx.close()
  })

  test('TRANS-02: untranslated language prefills the editor with the original', async ({ page, request }) => {
    test.skip(!sid, 'TRANS-01 setup did not run')
    await page.goto(`/stories/${sid}/edit`)
    await expect(page.locator('[data-testid="editor-body"]')).toBeVisible({ timeout: 20_000 })
    // German has no translation — the surface prefills from the original
    await page.selectOption('[data-testid="translation-select"]', 'de')
    await expect(page.locator('[data-testid="story-title-input"]')).toHaveValue(`Translation e2e ${RUN}`, { timeout: 15_000 })
    await expect(page.locator('[data-testid="editor-body"]')).toContainText(EN_BODY_V2)
    // no outdated flag for a not-yet-existing translation
    await expect(page.locator('[data-testid="translation-outdated-flag"]')).toHaveCount(0)
  })
})
