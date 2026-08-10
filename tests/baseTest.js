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
 * Fix: global-setup mints an access token and stashes it in auth.json.
 * Here we read it and inject it as globalThis.__FONTEM_BOOTSTRAP_TOKEN__ via
 * addInitScript, which runs before the SPA boots on every navigation.
 * fontem-web's restoreSession() picks it up and authenticates from it
 * directly — no per-context cookie refresh, no rotation, no rate
 * limits. The seam is test-only; production never sets that global.
 *
 * The token is renewed mid-run. It has a 15-minute TTL, and this file
 * used to call that "comfortably longer than a full smoke run" — true
 * when the suite took 4.9 minutes, false now that the assistant tests
 * have taken it to 15. The assumption expired literally.
 *
 * What that looked like: a different test failing every run, always near
 * the end (indices 100, 114, 153, 154, 169, 174), each one passing on
 * its own in seconds, with TRANS-01 finally saying it plainly — 401
 * where it wanted 201. It reads exactly like flakiness, and it is not;
 * it is a clock. Raising timeouts only changed which test was unlucky.
 *
 * Renewal is a fresh login rather than /auth/refresh, deliberately: the
 * refresh-token family rotates, and one shared cookie replayed by every
 * context is what caused the 401 storm this fixture exists to avoid.
 * /auth/login is rate-limited to 5/minute per IP, so this renews only
 * when the token is within RENEW_MARGIN of expiry — once or twice in a
 * full run, not per test.
 */
import { test as base } from '@playwright/test'
import fs from 'node:fs'
import https from 'node:https'
import http from 'node:http'

// Re-export Playwright's `expect` so specs import test + expect from
// this single module (Sonar S7763 prefers `export…from` to an import
// followed by a bare re-export).
export { expect } from '@playwright/test'

let cachedToken = null
let renewing = null

/** Renew this long before the token actually expires. */
const RENEW_MARGIN_MS = 4 * 60 * 1000

const ORIGIN = process.env.BASE_URL || 'https://fontem.testing.void42.internal'
const EMAIL = process.env.TEST_EMAIL || 'researcher@fontem.eu'
const PASSWORD = process.env.TEST_PASSWORD || 'TestPass123!'

function readStoredToken() {
  try {
    const state = JSON.parse(fs.readFileSync('./auth.json', 'utf8'))
    const origin = (state.origins || [])[0] || {}
    const entry = (origin.localStorage || []).find((e) => e.name === 'gmr-token')
    return entry ? entry.value : ''
  } catch {
    return ''
  }
}

/** Milliseconds until `token` expires, or Infinity if it carries no exp. */
function msUntilExpiry(token) {
  try {
    const [, payload] = token.split('.')
    const json = Buffer.from(payload, 'base64url').toString('utf8')
    const { exp } = JSON.parse(json)
    return exp ? exp * 1000 - Date.now() : Infinity
  } catch {
    return Infinity
  }
}

function login() {
  return new Promise((resolve) => {
    const body = JSON.stringify({ email: EMAIL, password: PASSWORD })
    const url = new URL(`${ORIGIN}/capi/auth/login`)
    const client = url.protocol === 'https:' ? https : http
    const req = client.request(url, {
      method: 'POST',
      rejectUnauthorized: false,
      headers: { 'Content-Type': 'application/json',
                 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let out = ''
      res.on('data', (c) => { out += c })
      res.on('end', () => {
        try {
          resolve(JSON.parse(out).access_token || '')
        } catch { resolve('') }
      })
    })
    // A failed renewal must not fail the test that triggered it: the old
    // token may still have minutes left, and a hard throw here would
    // report an auth blip as whatever assertion came next.
    req.on('error', () => resolve(''))
    req.write(body)
    req.end()
  })
}

export async function bootstrapToken() {
  if (cachedToken === null) cachedToken = readStoredToken()
  if (!cachedToken) return ''
  if (msUntilExpiry(cachedToken) > RENEW_MARGIN_MS) return cachedToken
  // Single in-flight renewal: workers share this module, and five
  // simultaneous logins would spend the whole 5/minute budget at once.
  renewing = renewing || login().finally(() => { renewing = null })
  const fresh = await renewing
  if (fresh) cachedToken = fresh
  return cachedToken
}

export const test = base.extend({
  page: async ({ page }, use) => {
    const token = await bootstrapToken()
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
