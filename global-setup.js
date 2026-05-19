/**
 * Global setup — runs once before the whole test suite.
 *
 * Does a single API login against /capi/auth/login and persists the
 * resulting JWT + user object as a Playwright storageState. All tests
 * inherit that state (via playwright.config.js `use.storageState`) so
 * each test starts already-authenticated WITHOUT hammering the
 * /auth/login endpoint.
 *
 * Why this exists: /auth/login has a 5/minute per-IP rate limit
 * (src/api/rate_limit.py in gmr-community-api). With ~6+ tests each
 * doing a UI login via `uiLogin(page)`, serial runs tripped the limit
 * partway through. Sharing state dropped per-run auth calls from 6+
 * to 1 (this setup) + 2 (AUTH-01 clears state to exercise the form,
 * AUTH-02 does a fresh UI login).
 */
import fs from 'node:fs/promises'
import https from 'node:https'
import http from 'node:http'

const ORIGIN = process.env.BASE_URL || 'https://gmr.void42.net'
const EMAIL = process.env.TEST_EMAIL || 'researcher@fontem.eu'
const PASSWORD = process.env.TEST_PASSWORD || 'TestPass123!'
const STATE_PATH = './auth.json'

// Internal envs serve TLS via the private void42 CA. Skip cert validation
// for those only — prod keeps full validation.
const IGNORE_TLS = /\.void42\.internal(\/|$|:)/.test(ORIGIN)

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const client = u.protocol === 'https:' ? https : http
    const data = JSON.stringify(body)
    const req = client.request(
      {
        method: 'POST',
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
        ...(u.protocol === 'https:' && IGNORE_TLS ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8')
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(text)) } catch (e) { reject(e) }
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${text}`))
          }
        })
      },
    )
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

export default async function globalSetup() {
  // One API login, full stop.
  const data = await postJson(`${ORIGIN}/capi/auth/login`, {
    email: EMAIL,
    password: PASSWORD,
  })

  const state = {
    cookies: [],
    origins: [
      {
        origin: ORIGIN,
        localStorage: [
          { name: 'gmr-token', value: data.access_token },
          { name: 'gmr-user', value: JSON.stringify(data.user) },
          // Cookie-consent banner is dismissed so it doesn't overlap UI
          // elements during tests.
          { name: 'gmr-cookie-consent', value: 'declined' },
        ],
      },
    ],
  }

  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2))
  // eslint-disable-next-line no-console
  console.log(`[global-setup] logged in as ${data.user.email}, state → ${STATE_PATH}`)
}
