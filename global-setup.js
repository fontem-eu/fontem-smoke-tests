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
            try {
              resolve({
                body: JSON.parse(text),
                setCookie: res.headers['set-cookie'] || [],
              })
            } catch (e) { reject(e) }
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

/**
 * Convert the server's Set-Cookie header into Playwright storageState
 * cookies. The session migration (2026-06-13) puts the refresh token in
 * an httpOnly cookie that has to round-trip in every test context, so
 * we capture it here once and let every test inherit it.
 */
function parseSetCookies(setCookieHeaders, hostname) {
  const cookies = []
  for (const raw of setCookieHeaders) {
    const parts = raw.split(';').map((s) => s.trim())
    const [name, ...valueParts] = parts[0].split('=')
    const value = valueParts.join('=')
    const attrs = Object.fromEntries(parts.slice(1).map((p) => {
      const [k, ...vs] = p.split('=')
      return [k.toLowerCase(), vs.join('=') || true]
    }))
    cookies.push({
      name,
      value,
      domain: hostname,
      path: attrs.path || '/',
      expires: attrs['max-age']
        ? Math.floor(Date.now() / 1000) + parseInt(attrs['max-age'], 10)
        : -1,
      httpOnly: 'httponly' in attrs,
      secure: 'secure' in attrs,
      sameSite: attrs.samesite
        ? attrs.samesite[0].toUpperCase() + attrs.samesite.slice(1).toLowerCase()
        : 'Lax',
    })
  }
  return cookies
}

export default async function globalSetup() {
  // One API login, full stop.
  const { body: data, setCookie } = await postJson(`${ORIGIN}/capi/auth/login`, {
    email: EMAIL,
    password: PASSWORD,
  })

  const hostname = new URL(ORIGIN).hostname
  const state = {
    cookies: parseSetCookies(setCookie, hostname),
    origins: [
      {
        origin: ORIGIN,
        localStorage: [
          // Legacy ``gmr-token`` retained so any pre-migration test
          // helper that still reads localStorage doesn't bomb — the
          // SPA itself no longer reads it (sessions are in-memory +
          // cookie after 2026-06-13). New tests should call
          // ``freshAccessToken(page)`` instead.
          { name: 'gmr-token', value: data.access_token },
          { name: 'gmr-user', value: JSON.stringify(data.user) },
          // The post-migration user-cache key the new SPA reads.
          { name: 'fontem-user', value: JSON.stringify(data.user) },
          // Cookie-consent banner is dismissed so it doesn't overlap UI
          // elements during tests.
          { name: 'gmr-cookie-consent', value: 'declined' },
        ],
      },
    ],
  }

  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2))
  // eslint-disable-next-line no-console
  console.log(
    `[global-setup] logged in as ${data.user.email}, ` +
    `${state.cookies.length} cookie(s) captured, state → ${STATE_PATH}`,
  )
}
