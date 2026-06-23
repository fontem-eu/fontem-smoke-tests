import { defineConfig, devices } from '@playwright/test'

const BASE_URL = process.env.BASE_URL || 'https://gmr.void42.net'

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,        // serial — tests share auth state
  workers: 1,
  retries: 1,
  timeout: 60_000,
  // One API login at suite start, saved as storageState, reused by every
  // test. Avoids hitting the /auth/login 5/min rate limit when many tests
  // each do a UI login. See global-setup.js for details.
  globalSetup: './global-setup.js',
  reporter: [
    ['list'],
    ['junit', { outputFile: 'test-results/results.xml' }],
    ['json',  { outputFile: 'test-results/results.json' }],
  ],
  use: {
    baseURL: BASE_URL,
    storageState: './auth.json',
    // Internal envs serve TLS signed by the void42 private CA (via Vault PKI).
    // Chromium doesn't trust it by default, so ignore cert errors only when
    // targeting *.void42.internal. Prod (gmr.void42.net) keeps full cert
    // validation against the public chain.
    ignoreHTTPSErrors: /\.void42\.internal(\/|$|:)/.test(BASE_URL),
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    // When PLAYWRIGHT_PROXY is set (the DAST runner pointing at the ZAP
    // container), funnel every browser request through it so ZAP gets to
    // passively scan the same traffic the smoke suite generates. Unset on
    // prod / dev runs — direct connections.
    ...(process.env.PLAYWRIGHT_PROXY
      ? { proxy: { server: process.env.PLAYWRIGHT_PROXY } }
      : {}),
  },
  projects: [
    {
      name: 'chromium',
      // Desktop suite covers tests/{smoke,auth-helper,consolidator,i18n}.spec.js
      // — the mobile spec is opted out via the matcher below.
      testMatch: /(smoke|auth-helper|consolidator|i18n|pocket-story|investigations|investigation-stories|investigation-viz|dossiers)\.spec\.js$/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile-chromium',
      // Focused mobile suite. Smaller set of tests targeting the
      // 390 × 844 iPhone-13 viewport — most desktop assertions are
      // shape-equivalent on mobile, so we don't duplicate them
      // here. The mobile spec covers the things the desktop suite
      // CAN'T see: cookie-banner / chat-input overlap, mobile dropdown
      // nav, narrow contracts-cards rendering.
      testMatch: /mobile\.spec\.js$/,
      use: { ...devices['iPhone 13'] },
    },
  ],
})
