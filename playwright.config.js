import { defineConfig, devices } from '@playwright/test'

const BASE_URL = process.env.BASE_URL || 'https://gmr.void42.net'

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,        // serial — tests share auth state
  workers: 1,
  retries: 1,
  timeout: 60_000,
  reporter: [
    ['list'],
    ['junit', { outputFile: 'test-results/results.xml' }],
    ['json',  { outputFile: 'test-results/results.json' }],
  ],
  use: {
    baseURL: BASE_URL,
    // Internal envs serve TLS signed by the void42 private CA (via Vault PKI).
    // Chromium doesn't trust it by default, so ignore cert errors only when
    // targeting *.void42.internal. Prod (gmr.void42.net) keeps full cert
    // validation against the public chain.
    ignoreHTTPSErrors: /\.void42\.internal(\/|$|:)/.test(BASE_URL),
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
