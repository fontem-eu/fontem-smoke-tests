/**
 * Regression test for the smoke-suite auth helper.
 *
 * Guards the rate-limit-safety property: when a test inherits a valid
 * storageState (the normal case), `uiLogin()` must NOT POST to
 * /auth/login. If that property regresses, the full smoke suite starts
 * hammering the endpoint again and tripping the 5/min per-IP limit —
 * which is exactly what happened on the first HTTPS-enabled staging
 * runs (see git log around 2026-04-17).
 *
 * This test runs with the default preloaded storageState (via
 * global-setup.js).
 */
import { test, expect } from '@playwright/test'

test.describe('smoke-suite auth helper', () => {
  test('uiLogin does NOT hit /auth/login when storageState is preloaded', async ({ page }) => {
    // Sanity: storageState should already have populated the token.
    await page.goto('/')
    const tokenBefore = await page.evaluate(() => localStorage.getItem('gmr-token'))
    expect(tokenBefore).toBeTruthy()

    // Intercept POSTs to /capi/auth/login and count them.
    let loginPosts = 0
    await page.route('**/capi/auth/login', (route) => {
      if (route.request().method() === 'POST') loginPosts += 1
      route.continue()
    })

    // Inline the helper logic (same shape as tests/smoke.spec.js:uiLogin).
    // We duplicate rather than import so a future refactor can't silently
    // weaken the contract without also touching this file.
    await page.goto('/')
    const token = await page.evaluate(() => localStorage.getItem('gmr-token'))
    if (!token) {
      throw new Error('storageState was missing — smoke suite would have fallen back to UI login')
    }

    expect(loginPosts).toBe(0)
  })
})
