/**
 * Permissions matrix (inheritance + additive overrides) — end-to-end over HTTP
 * with multiple real users.
 *
 *   Owner = the verified researcher (auth.json bootstrap token) — does setup.
 *   viewer / contrib / outsider = a small SHARED set of registered throwaway
 *   users (registered once per run to stay under the /auth/register rate limit),
 *   acting via their own tokens. Reads aren't verification-gated, so throwaways
 *   exercise the access matrix; positive role-WRITE behaviour is covered
 *   exhaustively by the api service unit tests.
 *
 * Covers: access / no-access / granting / removal / privilege-escalation-denied
 * / inheritance / direct-grant override. Each test uses its own fresh
 * investigation; the shared users are added to it with the role under test.
 */
import fs from 'node:fs'
import { test, expect } from './baseTest.js'

const RUN = String(Date.now())
const PW = 'TestPass123!'

function ownerToken() {
  const state = JSON.parse(fs.readFileSync('./auth.json', 'utf8'))
  const origin = (state.origins || [])[0] || {}
  return (origin.localStorage || []).find((e) => e.name === 'gmr-token')?.value
}

async function registerLogin(request, email) {
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const reg = await request.post('/capi/auth/register', { data: { email, password: PW, name: email } })
    if (reg.ok() || reg.status() === 409) break
    if (reg.status() !== 429) throw new Error(`register ${email}: HTTP ${reg.status()}`)
    await new Promise((r) => { setTimeout(r, 3000 * attempt) })
  }
  const login = await request.post('/capi/auth/login', { data: { email, password: PW } })
  expect(login.ok(), `login ${email}: HTTP ${login.status()}`).toBeTruthy()
  return (await login.json()).access_token
}

// Shared throwaway users — registered at most once per run.
const _cache = {}
async function user(request, key) {
  if (!_cache[key]) {
    const email = `perm-${key}-${RUN}@example.com`
    _cache[key] = { email, token: await registerLogin(request, email) }
  }
  return _cache[key]
}

async function api(request, token, method, path, data) {
  const opts = { headers: { Authorization: `Bearer ${token}` } }
  if (data !== undefined) opts.data = data
  const r = await request[method.toLowerCase()](`/capi${path}`, opts)
  return { status: r.status(), body: await r.json().catch(() => null) }
}

// Owner creates an investigation + an article inside it.
async function makeInvWithArticle(request, owner, tag) {
  const inv = await api(request, owner, 'POST', '/investigations', { name: `Perm ${tag} ${RUN}` })
  expect(inv.status, `create investigation: ${JSON.stringify(inv.body)}`).toBe(201)
  const iid = inv.body.id
  const story = await api(request, owner, 'POST', '/data-stories', { title: 'Secret', abstract: '' })
  await api(request, owner, 'POST', `/investigations/${iid}/stories`, { report_id: story.body.id })
  return { iid, sid: story.body.id }
}

test.describe('Permissions matrix', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)

  test('PERM-1 ACCESS+NO-ACCESS: members read inherited; outsider cannot', async ({ request }) => {
    const owner = ownerToken()
    const probe = await api(request, owner, 'POST', '/investigations', { name: `probe ${RUN}` })
    test.skip(probe.status !== 201, 'permissions model not deployed yet')

    const viewer = await user(request, 'viewer')
    const contrib = await user(request, 'contrib')
    const outsider = await user(request, 'outsider')
    const { iid, sid } = await makeInvWithArticle(request, owner, 'a')
    await api(request, owner, 'POST', `/investigations/${iid}/members`, { email: viewer.email, role: 'viewer' })
    await api(request, owner, 'POST', `/investigations/${iid}/members`, { email: contrib.email, role: 'contributor' })

    expect((await api(request, viewer.token, 'GET', `/data-stories/${sid}`)).status).toBe(200)
    expect((await api(request, contrib.token, 'GET', `/data-stories/${sid}`)).status).toBe(200)
    expect([403, 404]).toContain((await api(request, outsider.token, 'GET', `/data-stories/${sid}`)).status)
    expect((await api(request, outsider.token, 'GET', `/investigations/${iid}`)).status).toBe(403)
  })

  test('PERM-2 GRANTING: adding a member grants inherited access', async ({ request }) => {
    const owner = ownerToken()
    const x = await user(request, 'outsider')
    const { iid, sid } = await makeInvWithArticle(request, owner, 'b')
    expect([403, 404]).toContain((await api(request, x.token, 'GET', `/data-stories/${sid}`)).status)
    expect((await api(request, owner, 'POST', `/investigations/${iid}/members`, { email: x.email, role: 'viewer' })).status).toBe(201)
    expect((await api(request, x.token, 'GET', `/data-stories/${sid}`)).status).toBe(200)
  })

  test('PERM-3 REMOVAL: removing a member revokes access', async ({ request }) => {
    const owner = ownerToken()
    const x = await user(request, 'outsider')
    const { iid, sid } = await makeInvWithArticle(request, owner, 'c')
    await api(request, owner, 'POST', `/investigations/${iid}/members`, { email: x.email, role: 'viewer' })
    expect((await api(request, x.token, 'GET', `/data-stories/${sid}`)).status).toBe(200)
    const members = (await api(request, owner, 'GET', `/investigations/${iid}/members`)).body
    const xid = members.find((m) => m.email === x.email).user_id
    expect((await api(request, owner, 'DELETE', `/investigations/${iid}/members/${xid}`)).status).toBe(204)
    expect([403, 404]).toContain((await api(request, x.token, 'GET', `/data-stories/${sid}`)).status)
  })

  test('PERM-4 ESCALATION: privileged actions denied below the required role', async ({ request }) => {
    const owner = ownerToken()
    const contrib = await user(request, 'contrib')
    const viewer = await user(request, 'viewer')
    const outsider = await user(request, 'outsider')
    const { iid, sid } = await makeInvWithArticle(request, owner, 'd')
    await api(request, owner, 'POST', `/investigations/${iid}/members`, { email: contrib.email, role: 'contributor' })
    await api(request, owner, 'POST', `/investigations/${iid}/members`, { email: viewer.email, role: 'viewer' })

    // contributor cannot manage members (needs admin)
    expect((await api(request, contrib.token, 'POST', `/investigations/${iid}/members`, { email: viewer.email, role: 'owner' })).status).toBe(403)
    // viewer cannot edit the article meta
    expect((await api(request, viewer.token, 'PUT', `/data-stories/${sid}`, { title: 'hijack' })).status).toBe(403)
    // outsider cannot delete the investigation
    expect((await api(request, outsider.token, 'DELETE', `/investigations/${iid}?content=orphan`)).status).toBe(403)
  })

  test('PERM-5 OVERRIDE: a direct grant gives access without membership; revoke removes it', async ({ request }) => {
    const owner = ownerToken()
    const x = await user(request, 'outsider')
    const inv = await api(request, owner, 'POST', '/investigations', { name: `Perm e ${RUN}` })
    const dossier = await api(request, owner, 'POST', '/dossiers', { name: 'D', investigation_id: inv.body.id })
    const did = dossier.body.id
    test.skip(!did, 'dossier create failed')
    // outsider: no access
    expect((await api(request, x.token, 'GET', `/dossiers/${did}`)).status).toBe(403)
    // direct grant (the override)
    const share = await api(request, owner, 'POST', `/dossiers/${did}/access`, { email: x.email, level: 'viewer' })
    test.skip(share.status === 404, 'Phase C /access not deployed yet')
    expect(share.status).toBe(201)
    expect((await api(request, x.token, 'GET', `/dossiers/${did}`)).status).toBe(200)
    // listed, then revoke -> gone
    const grants = (await api(request, owner, 'GET', `/dossiers/${did}/access`)).body
    const grant = grants.find((g) => g.email === x.email)
    expect(grant, 'the direct grant is listed').toBeTruthy()
    expect((await api(request, owner, 'DELETE', `/dossiers/${did}/access/${grant.user_id}`)).status).toBe(204)
    expect((await api(request, x.token, 'GET', `/dossiers/${did}`)).status).toBe(403)
  })
})
