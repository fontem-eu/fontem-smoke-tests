/**
 * Smoke test base — extends Playwright's `test` with one auto-fixture
 * that authenticates every page WITHOUT relying on the rotating
 * refresh cookie.
 *
 * Why: refresh-token families rotate on every /auth/refresh (a
 * deliberate, reuse-resistant property of the 2026-06 session work).
 * The suite seeds every browser context from ONE shared storageState
 * refresh cookie, so the first context to refresh rotates it and all
 * other contexts replay a now-stale token → a /auth/refresh 401 storm
 * + rate-limit (429) hits, which cascaded the serial suite into
 * failure.
 *
 * Fix: global-setup mints ONE access token (15-min TTL, comfortably
 * longer than a full smoke run) and stashes it in auth.json. Here we
 * read it and inject it as globalThis.__FONTEM_BOOTSTRAP_TOKEN__ via
 * addInitScript, which runs before the SPA boots on every navigation.
 * fontem-web's restoreSession() picks it up and authenticates from it
 * directly — no per-context cookie refresh, no rotation, no rate
 * limits. The seam is test-only; production never sets that global.
 */
import { test as base } from '@playwright/test'
import fs from 'node:fs'

// Re-export Playwright's `expect` so specs import test + expect from
// this single module (Sonar S7763 prefers `export…from` to an import
// followed by a bare re-export).
export { expect } from '@playwright/test'

let cachedToken = null

function bootstrapToken() {
  if (cachedToken !== null) return cachedToken
  try {
    const state = JSON.parse(fs.readFileSync('./auth.json', 'utf8'))
    const origin = (state.origins || [])[0] || {}
    const entry = (origin.localStorage || []).find((e) => e.name === 'gmr-token')
    cachedToken = entry ? entry.value : ''
  } catch {
    cachedToken = ''
  }
  return cachedToken
}

export const test = base.extend({
  page: async ({ page }, use) => {
    const token = bootstrapToken()
    if (token) {
      await page.addInitScript((t) => {
        // Anonymous-flow tests (login form, fresh login, register) call
        // clearSession(), which sets this marker. Skip the token
        // injection so the SPA boots unauthenticated and the login form
        // renders. The marker lives in localStorage (survives the
        // reload; readable here at document-start) and never reaches
        // the static storageState, so it doesn't leak across tests.
        try {
          // eslint-disable-next-line no-undef
          if (localStorage.getItem('__smoke_anon__') === '1') return
        } catch { /* localStorage unavailable — inject anyway */ }
        globalThis.__FONTEM_BOOTSTRAP_TOKEN__ = t
      }, token)
    }
    await use(page)
  },
})
