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

async function api(request, tok, method, path, data) {
  const opts = { headers: { Authorization: `Bearer ${tok}` } }
  if (data !== undefined) opts.data = data
  const r = await request[method.toLowerCase()](`/capi${path}`, opts)
  return { status: r.status(), body: await r.json().catch(() => null) }
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

    await page.goto(`/stories/${sid}`)
    await expect(page.locator('[data-testid="translation-bar"]')).toBeVisible({ timeout: 20_000 })
    await page.selectOption('[data-testid="translation-picker"]', 'pt')
    // translated text still renders…
    await expect(page.locator('[data-testid="story-body"]')).toContainText(PT_BODY, { timeout: 15_000 })
    // …under the yellow potentially-outdated label
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
