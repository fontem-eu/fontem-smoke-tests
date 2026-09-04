/**
 * Permissions matrix — UI-driven, with multiple real users.
 *
 * Every ACCESS / GRANT / REMOVAL / ESCALATION / OVERRIDE behaviour is asserted
 * by DRIVING THE UI: a persona navigates to a page and we check what renders
 * (the resource, or its access-denied error), and the owner grants/removes/shares
 * through the actual forms. API is reserved for SETUP only — registering the
 * throwaway personas and minting their auth token (the suite already authenticates
 * the researcher the same way), plus building the fixture (an investigation with
 * an article / dossier). Each persona drives its own authenticated browser context.
 */
import fs from 'node:fs'
import { request as apiRequest } from '@playwright/test'
import { test, expect } from './baseTest.js'

const RUN = String(Date.now())
const PW = 'TestPass123!'

function ownerToken() {
  const state = JSON.parse(fs.readFileSync('./auth.json', 'utf8'))
  const origin = (state.origins || [])[0] || {}
  return (origin.localStorage || []).find((e) => e.name === 'gmr-token')?.value
}

// ── setup-only API helpers ──
async function registerLogin(request, email) {
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const reg = await request.post('/capi/auth/register', { data: { email, password: PW, name: email } })
    if (reg.ok() || reg.status() === 409) break       // created, or already exists — done
    if (reg.status() !== 429) throw new Error(`register ${email}: HTTP ${reg.status()}`)
    await new Promise((r) => { setTimeout(r, Math.min(2000 * attempt, 6000)) })  // bounded backoff
  }
  // Login is rate-limited too (researcher + 3 personas log in back-to-back),
  // so retry it on 429 with the same bounded backoff — a single 429 here was
  // the real source of the PERM-UI flake.
  let login
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    login = await request.post('/capi/auth/login', { data: { email, password: PW } })
    if (login.ok() || login.status() !== 429) break
    await new Promise((r) => { setTimeout(r, Math.min(2000 * attempt, 6000)) })
  }
  expect(login.ok(), `login ${email}: HTTP ${login.status()}`).toBeTruthy()
  return (await login.json()).access_token
}

const _cache = {}
async function persona(request, key) {
  if (!_cache[key]) {
    const email = `permui-${key}@example.com`  // stable: 409 on re-runs => no rate-limit
    _cache[key] = { email, token: await registerLogin(request, email) }
  }
  return _cache[key]
}

async function apiSetup(request, token, method, path, data) {
  const opts = { headers: { Authorization: `Bearer ${token}` } }
  if (data !== undefined) opts.data = data
  const r = await request[method.toLowerCase()](`/capi${path}`, opts)
  return { status: r.status(), body: await r.json().catch(() => null) }
}

// An authenticated browser page for a persona (token-injected, same seam the
// suite uses for the researcher — this is auth setup, not the behaviour under test).
async function personaPage(browser, token) {
  // Under the DAST runner, route persona traffic through ZAP too (so the
  // multi-user permission flows are part of the passive scan).
  const proxy = process.env.PLAYWRIGHT_PROXY ? { proxy: { server: process.env.PLAYWRIGHT_PROXY } } : {}
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, ...proxy })
  await ctx.addInitScript((t) => { globalThis.__FONTEM_BOOTSTRAP_TOKEN__ = t }, token)
  const pg = await ctx.newPage()
  return { ctx, pg }
}

// fixture: an investigation owned by the researcher + an article inside it.
async function makeInvWithArticle(request, owner, tag) {
  const inv = await apiSetup(request, owner, 'POST', '/investigations', { name: `PermUI ${tag} ${RUN}` })
  expect(inv.status, JSON.stringify(inv.body)).toBe(201)
  const iid = inv.body.id
  const story = await apiSetup(request, owner, 'POST', '/data-stories', { title: 'Secret', abstract: '' })
  await apiSetup(request, owner, 'POST', `/investigations/${iid}/stories`, { report_id: story.body.id })
  return { iid, sid: story.body.id }
}

// fixture: an investigation owned by the researcher + a data project attached.
async function makeInvWithProject(request, owner, tag) {
  const inv = await apiSetup(request, owner, 'POST', '/investigations', { name: `PermUI ${tag} ${RUN}` })
  const iid = inv.body.id
  const proj = await apiSetup(request, owner, 'POST', '/studio/projects',
    { name: `Shared ${tag} ${RUN}`, investigation_id: iid })
  await apiSetup(request, owner, 'POST', `/studio/projects/${proj.body.id}/queries`,
    { name: 'q', lang: 'cypher', query: 'MATCH (n) RETURN n LIMIT 1' })
  return { iid, pid: proj.body.id }
}
async function openProject(pg, pid) {
  await pg.goto(`/studio/p/${pid}`, { waitUntil: 'domcontentloaded' })
}

const NAV = 25_000
async function expectStoryVisible(pg, sid) {
  await pg.goto(`/stories/${sid}`, { waitUntil: 'domcontentloaded' })
  await expect(pg.locator('[data-testid="story-title"]')).toBeVisible({ timeout: NAV })
}
async function expectStoryDenied(pg, sid) {
  await pg.goto(`/stories/${sid}`, { waitUntil: 'domcontentloaded' })
  await expect(pg.locator('[data-testid="story-error"]')).toBeVisible({ timeout: NAV })
}

test.describe('Permissions matrix (UI)', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(200_000)

  // Register the throwaway personas once, in setup — keeps registration's
  // rate-limit backoff out of the test bodies (and out of their timeouts).
  test.beforeAll(async ({ baseURL }) => {
    // Registering 3 personas can hit the auth rate-limiter; registerLogin backs
    // off up to ~60s each, which blows the default 60s *hook* timeout. Give the
    // setup hook its own generous budget (this is setup, not the test).
    test.setTimeout(240_000)
    const ctx = await apiRequest.newContext({ baseURL, ignoreHTTPSErrors: true })
    try {
      for (const key of ['viewer', 'contrib', 'outsider']) await persona(ctx, key)
    } finally {
      await ctx.dispose()
    }
  })

  test('PERM-UI-1 ACCESS+NO-ACCESS: members see the article in the UI; outsider is denied', async ({ request, browser }) => {
    const owner = ownerToken()
    // feature-detect the model is deployed
    const probe = await apiSetup(request, owner, 'POST', '/investigations', { name: `probe ${RUN}` })
    test.skip(probe.status !== 201, 'permissions model not deployed yet')

    const viewer = await persona(request, 'viewer')
    const contrib = await persona(request, 'contrib')
    const outsider = await persona(request, 'outsider')
    const { iid, sid } = await makeInvWithArticle(request, owner, 'a')
    await apiSetup(request, owner, 'POST', `/investigations/${iid}/members`, { email: viewer.email, role: 'viewer' })
    await apiSetup(request, owner, 'POST', `/investigations/${iid}/members`, { email: contrib.email, role: 'contributor' })

    const v = await personaPage(browser, viewer.token)
    const c = await personaPage(browser, contrib.token)
    const x = await personaPage(browser, outsider.token)
    try {
      await expectStoryVisible(v.pg, sid)        // viewer sees it (inherited)
      await expectStoryVisible(c.pg, sid)        // contributor sees it
      await expectStoryDenied(x.pg, sid)         // outsider denied
      await x.pg.goto(`/investigations/${iid}`)  // and can't open the investigation
      await expect(x.pg.locator('[data-testid="investigation-detail-error"]')).toBeVisible({ timeout: NAV })
    } finally {
      await v.ctx.close(); await c.ctx.close(); await x.ctx.close()
    }
  })

  test('PERM-UI-2 GRANTING: owner invites via the UI → the user then sees the article', async ({ page, request, browser }) => {
    const owner = ownerToken()
    const x = await persona(request, 'outsider')
    const { iid, sid } = await makeInvWithArticle(request, owner, 'b')
    const xp = await personaPage(browser, x.token)
    try {
      await expectStoryDenied(xp.pg, sid)        // before: no access
      // owner grants through the invite FORM (the researcher page)
      await page.goto(`/investigations/${iid}`)
      await page.fill('[data-testid="invite-email-input"]', x.email)
      await page.selectOption('[data-testid="invite-role"]', 'viewer')
      await page.click('[data-testid="invite-add-btn"]')
      await expect(page.locator('[data-testid="investigation-members"] li', { hasText: x.email }))
        .toBeVisible({ timeout: 10_000 })
      await expectStoryVisible(xp.pg, sid)       // after: access granted
    } finally {
      await xp.ctx.close()
    }
  })

  test('PERM-UI-3 REMOVAL: owner removes via the UI → the user loses access', async ({ page, request, browser }) => {
    const owner = ownerToken()
    const x = await persona(request, 'outsider')
    const { iid, sid } = await makeInvWithArticle(request, owner, 'c')
    await apiSetup(request, owner, 'POST', `/investigations/${iid}/members`, { email: x.email, role: 'viewer' })
    const xp = await personaPage(browser, x.token)
    try {
      await expectStoryVisible(xp.pg, sid)       // member sees it
      // owner removes them via the UI (the × button on their member row)
      await page.goto(`/investigations/${iid}`)
      const row = page.locator('[data-testid="investigation-members"] li', { hasText: x.email })
      await row.locator('[data-testid^="remove-"]').click()
      await expect(row).toBeHidden({ timeout: 10_000 })
      await expectStoryDenied(xp.pg, sid)        // access revoked
    } finally {
      await xp.ctx.close()
    }
  })

  test('PERM-UI-4 ESCALATION: the management UI is hidden from non-admins', async ({ page, request, browser }) => {
    const owner = ownerToken()
    const contrib = await persona(request, 'contrib')
    const viewer = await persona(request, 'viewer')
    const inv = await apiSetup(request, owner, 'POST', '/investigations', { name: `PermUI d ${RUN}` })
    const iid = inv.body.id
    await apiSetup(request, owner, 'POST', `/investigations/${iid}/members`, { email: contrib.email, role: 'contributor' })
    await apiSetup(request, owner, 'POST', `/investigations/${iid}/members`, { email: viewer.email, role: 'viewer' })
    const c = await personaPage(browser, contrib.token)
    const v = await personaPage(browser, viewer.token)
    try {
      // owner sees the manage surface; contributor + viewer do not
      await page.goto(`/investigations/${iid}`)
      await expect(page.locator('[data-testid="investigation-invite"]')).toBeVisible({ timeout: 10_000 })
      await expect(page.locator('[data-testid="investigation-delete-btn"]')).toBeVisible()

      await c.pg.goto(`/investigations/${iid}`)
      await expect(c.pg.locator('[data-testid="investigation-title"]')).toBeVisible({ timeout: 10_000 })
      await expect(c.pg.locator('[data-testid="investigation-invite"]')).toHaveCount(0)
      await expect(c.pg.locator('[data-testid="investigation-delete-btn"]')).toHaveCount(0)

      await v.pg.goto(`/investigations/${iid}`)
      await expect(v.pg.locator('[data-testid="investigation-invite"]')).toHaveCount(0)
    } finally {
      await c.ctx.close(); await v.ctx.close()
    }
  })

  test('PERM-UI-5 OVERRIDE: owner shares a dossier in the modal → outsider sees it; revoke removes it', async ({ page, request, browser }) => {
    const owner = ownerToken()
    const x = await persona(request, 'outsider')
    const inv = await apiSetup(request, owner, 'POST', '/investigations', { name: `PermUI e ${RUN}` })
    const dossier = await apiSetup(request, owner, 'POST', '/dossiers', { name: 'D', investigation_id: inv.body.id })
    const did = dossier.body.id
    test.skip(!did, 'dossier create failed')
    const xp = await personaPage(browser, x.token)
    try {
      await xp.pg.goto(`/dossiers/${did}`, { waitUntil: 'domcontentloaded' })  // before: denied
      await expect(xp.pg.locator('[data-testid="dossier-error"]')).toBeVisible({ timeout: NAV })

      // owner shares directly through the Share modal
      await page.goto(`/dossiers/${did}`)
      await page.click('[data-testid="dossier-share-btn"]')
      await expect(page.locator('[data-testid="dossier-share-modal"]')).toBeVisible({ timeout: 10_000 })
      await page.fill('[data-testid="share-email-input"]', x.email)
      await page.selectOption('[data-testid="share-level"]', 'viewer')
      // Same shape as PERM-UI-7: wait for the grant request itself, so a
      // refusal reads as a refusal instead of a missing element.
      const shared = page.waitForResponse(
        (r) => /\/dossiers\/[^/]+\/access$/.test(new URL(r.url()).pathname)
          && r.request().method() === 'POST',
        { timeout: 20_000 },
      )
      await page.click('[data-testid="share-add-btn"]')
      const shareResp = await shared
      expect(shareResp.ok(), `sharing the dossier was refused: HTTP ${shareResp.status()}`).toBeTruthy()
      await expect(page.locator('[data-testid^="share-access-"]', { hasText: x.email }))
        .toBeVisible({ timeout: 10_000 })

      await xp.pg.goto(`/dossiers/${did}`, { waitUntil: 'domcontentloaded' })  // after grant: visible
      await expect(xp.pg.locator('[data-testid="dossier-title"]')).toBeVisible({ timeout: NAV })

      // revoke through the modal
      const grantRow = page.locator('[data-testid^="share-access-"]', { hasText: x.email })
      await grantRow.locator('[data-testid^="share-remove-"]').click()
      await expect(grantRow).toBeHidden({ timeout: 10_000 })

      await xp.pg.goto(`/dossiers/${did}`, { waitUntil: 'domcontentloaded' })  // after revoke: denied again
      await expect(xp.pg.locator('[data-testid="dossier-error"]')).toBeVisible({ timeout: NAV })
    } finally {
      await xp.ctx.close()
    }
  })

  test('PERM-UI-6 STUDIO: owner edits, viewer read-only, outsider denied', async ({ page, request, browser }) => {
    const owner = ownerToken()
    // feature-detect the studio sharing model is deployed (my_access present)
    const probe = await apiSetup(request, owner, 'POST', '/studio/projects', { name: `probe ${RUN}` })
    test.skip(probe.status !== 201, 'studio not deployed')
    const feat = await apiSetup(request, owner, 'GET', `/studio/projects/${probe.body.id}`)
    test.skip(!(feat.body && feat.body.my_access), 'studio sharing not deployed yet')

    // NOTE: throwaway personas are email-unverified, and every EDIT/SHARE action
    // is verification-gated platform-wide — so an unverified member can only
    // VIEW. We therefore drive the EDIT case from the verified owner and use the
    // personas for the read-only / denied floor (the security-critical cases).
    const viewer = await persona(request, 'viewer')
    const outsider = await persona(request, 'outsider')
    const { iid, pid } = await makeInvWithProject(request, owner, 'f')
    await apiSetup(request, owner, 'POST', `/investigations/${iid}/members`, { email: viewer.email, role: 'viewer' })

    const v = await personaPage(browser, viewer.token)
    const x = await personaPage(browser, outsider.token)
    try {
      // owner (verified): full edit + share affordances, owner badge
      await page.goto(`/studio/p/${pid}`)
      await expect(page.locator('[data-testid="project-access"]')).toHaveText('owner', { timeout: NAV })
      await expect(page.locator('[data-testid="project-new-query"]')).toBeVisible()
      await expect(page.locator('[data-testid="project-share"]')).toBeVisible()
      await expect(page.locator('[data-testid="project-readonly"]')).toHaveCount(0)
      // viewer member: read-only banner + badge, NO create/share (can't escalate)
      await openProject(v.pg, pid)
      await expect(v.pg.locator('[data-testid="project-readonly"]')).toBeVisible({ timeout: NAV })
      await expect(v.pg.locator('[data-testid="project-access"]')).toHaveText('viewer')
      await expect(v.pg.locator('[data-testid="project-new-query"]')).toHaveCount(0)
      await expect(v.pg.locator('[data-testid="project-share"]')).toHaveCount(0)
      // outsider: bounced off — the project view never renders
      await openProject(x.pg, pid)
      await expect(x.pg.locator('[data-testid="project-access"]')).toHaveCount(0)
    } finally {
      await v.ctx.close(); await x.ctx.close()
    }
  })

  test('PERM-UI-7 STUDIO OVERRIDE: owner shares a project in the modal → outsider gains read access; revoke removes it', async ({ page, request, browser }) => {
    const owner = ownerToken()
    const probe = await apiSetup(request, owner, 'POST', '/studio/projects', { name: `probe2 ${RUN}` })
    test.skip(probe.status !== 201, 'studio not deployed')
    const feat = await apiSetup(request, owner, 'GET', `/studio/projects/${probe.body.id}`)
    test.skip(!(feat.body && feat.body.my_access), 'studio sharing not deployed yet')

    const x = await persona(request, 'outsider')
    const proj = await apiSetup(request, owner, 'POST', '/studio/projects', { name: `OverrideShare ${RUN}` })
    const pid = proj.body.id
    const xp = await personaPage(browser, x.token)
    try {
      await openProject(xp.pg, pid)                                   // before: denied
      await expect(xp.pg.locator('[data-testid="project-access"]')).toHaveCount(0)
      // owner shares directly through the studio Share modal
      await page.goto(`/studio/p/${pid}`)
      await page.click('[data-testid="project-share"]')
      await expect(page.locator('[data-testid="studio-share-modal"]')).toBeVisible({ timeout: 10_000 })
      await page.fill('[data-testid="studio-share-email"]', x.email)
      await page.selectOption('[data-testid="studio-share-level"]', 'viewer')
      // Wait on the CAUSE, not on a deadline. addPerson() POSTs the
      // grant and then refreshes the list; if the POST is refused the
      // modal catches it into `studio-share-error` and no row ever
      // appears — which, waiting only for the row, is indistinguishable
      // from the request merely being slow. Both surfaced as
      // "element(s) not found" and cost a gate run to diagnose.
      const granted = page.waitForResponse(
        (r) => /\/studio\/projects\/[^/]+\/access$/.test(new URL(r.url()).pathname)
          && r.request().method() === 'POST',
        { timeout: 20_000 },
      )
      await page.click('[data-testid="studio-share-add"]')
      const grantResp = await granted
      expect(grantResp.ok(), `granting access was refused: HTTP ${grantResp.status()}`).toBeTruthy()
      await expect(page.locator('[data-testid="studio-share-error"]'), 'the modal reported an error')
        .toHaveCount(0)
      await expect(page.locator('[data-testid="studio-grant"]', { hasText: x.email }))
        .toBeVisible({ timeout: 15_000 })
      // after grant: outsider can open it read-only
      await openProject(xp.pg, pid)
      await expect(xp.pg.locator('[data-testid="project-readonly"]')).toBeVisible({ timeout: NAV })
      // revoke through the modal → denied again
      const grantRow = page.locator('[data-testid="studio-grant"]', { hasText: x.email })
      await grantRow.locator('[data-testid="studio-grant-remove"]').click()
      await expect(grantRow).toBeHidden({ timeout: 10_000 })
      await openProject(xp.pg, pid)
      await expect(xp.pg.locator('[data-testid="project-access"]')).toHaveCount(0)
    } finally {
      await xp.ctx.close()
    }
  })
})
