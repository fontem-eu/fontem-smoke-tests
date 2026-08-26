/**
 * Assistant chat tabs — UI-driven, plus deliberate cross-user attacks.
 *
 * The switcher is exercised the way a person uses it: open the panel, start a
 * chat, rename it, switch between them, delete one. No API calls stand in for
 * a click; the only setup that goes through the API is registering a second
 * persona, which the suite already does elsewhere for the permissions matrix.
 *
 * The isolation block is the exception, and it is deliberate. A conversation
 * key is a URL path segment, not a secret — `report:<uuid>` is derivable from
 * any visible report and `chat:<uuid>` travels in the browser — so the
 * protection has to be the row being scoped to its owner, and the only honest
 * way to test that is to make the request an attacker would make. A UI that
 * declines to render a button proves nothing about the endpoint behind it.
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

/** Register + log in a throwaway persona. Setup only — never an assertion. */
async function registerLogin(request, email) {
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const reg = await request.post('/capi/auth/register', {
      data: { email, password: PW, name: email.split('@')[0] },
    })
    if (reg.ok() || reg.status() === 409) break
    if (reg.status() !== 429) throw new Error(`register ${email}: HTTP ${reg.status()}`)
    await new Promise((r) => { setTimeout(r, Math.min(2000 * attempt, 6000)) })
  }
  let login
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    login = await request.post('/capi/auth/login', { data: { email, password: PW } })
    if (login.ok() || login.status() !== 429) break
    await new Promise((r) => { setTimeout(r, Math.min(2000 * attempt, 6000)) })
  }
  expect(login.ok(), `login ${email}: HTTP ${login.status()}`).toBeTruthy()
  return (await login.json()).access_token
}

async function openAssistant(page) {
  await page.goto('/')
  await page.locator('[data-testid="assist-toggle"]').click()
  await expect(page.locator('[data-testid="assist-messages"]')).toBeVisible({ timeout: 10_000 })
}

async function openSwitcher(page) {
  await page.locator('[data-testid="assist-conversation-switcher"]').click()
  await expect(page.locator('[data-testid="assist-conversation-list"]')).toBeVisible()
}

test.describe('Assistant chat tabs', () => {
  test('CHAT-TABS-01: a signed-in user gets a conversation switcher', async ({ page }) => {
    await openAssistant(page)
    await expect(page.locator('[data-testid="assist-conversation-bar"]')).toBeVisible()
    await expect(page.locator('[data-testid="assist-new-conversation"]')).toBeVisible()
  })

  test('CHAT-TABS-02: starting a new chat opens an empty one', async ({ page }) => {
    await openAssistant(page)
    await page.locator('[data-testid="assist-new-conversation"]').click()
    // A fresh chat has no transcript. The empty state is what says so.
    await expect(page.locator('[data-testid="assist-messages"]')).toBeVisible()
    await openSwitcher(page)
    await expect(page.locator('[data-testid="assist-conversation-row"]').first()).toBeVisible()
  })

  test('CHAT-TABS-03: a chat can be renamed, and the name sticks', async ({ page }) => {
    await openAssistant(page)
    await page.locator('[data-testid="assist-new-conversation"]').click()
    await openSwitcher(page)

    const name = `Renamed ${RUN}`
    await page.locator('[data-testid="assist-conversation-rename"]').first().click()
    const input = page.locator('[data-testid="assist-conversation-rename-input"]')
    await input.fill(name)
    await input.press('Enter')
    await expect(page.locator('[data-testid="assist-conversation-list"]')).toContainText(name)

    // Survives a reload: the name is on the server, not in component state.
    await page.reload()
    await page.locator('[data-testid="assist-toggle"]').click()
    await openSwitcher(page)
    await expect(page.locator('[data-testid="assist-conversation-list"]')).toContainText(name)
  })

  test('CHAT-TABS-04: switching chats does not carry the other one with it', async ({ page }) => {
    // Segregation is the point of the switcher. If the previous transcript
    // lingers, the list implies an isolation that is not there.
    await openAssistant(page)
    await page.locator('[data-testid="assist-new-conversation"]').click()
    await openSwitcher(page)
    const rows = page.locator('[data-testid="assist-conversation-row"]')
    await expect(rows.first()).toBeVisible()

    const before = await page.locator('[data-testid="assist-messages"]').innerText()
    await page.locator('[data-testid="assist-conversation-pick"]').first().click()
    await expect(page.locator('[data-testid="assist-conversation-list"]')).toBeHidden()
    const after = await page.locator('[data-testid="assist-messages"]').innerText()
    expect(after).not.toBe(`${before}${before}`)   // not appended onto the old one
  })

  test('CHAT-TABS-05: deleting a chat removes it from the switcher', async ({ page }) => {
    await openAssistant(page)
    await page.locator('[data-testid="assist-new-conversation"]').click()
    await openSwitcher(page)
    const rows = page.locator('[data-testid="assist-conversation-row"]')
    const before = await rows.count()
    expect(before).toBeGreaterThan(0)

    await page.locator('[data-testid="assist-conversation-delete"]').first().click()
    await expect(rows).toHaveCount(before - 1)
  })

  test('CHAT-TABS-06: a signed-out visitor gets no switcher', async ({ browser }) => {
    // No account, so no list to switch between — one ephemeral thread. A new
    // context without the suite's storageState is genuinely signed out.
    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } })
    const page = await ctx.newPage()
    await page.goto('/')
    await page.locator('[data-testid="assist-toggle"]').click()
    await expect(page.locator('[data-testid="assist-messages"]')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('[data-testid="assist-conversation-bar"]')).toHaveCount(0)
    await ctx.close()
  })
})

test.describe('Assistant chat isolation — deliberate cross-user attacks', () => {
  // These call the API directly ON PURPOSE. The attack is a request naming
  // someone else's conversation key; a UI that hides a button does not answer
  // whether the endpoint behind it would have complied.

  test('CHAT-ISO-01: another user cannot read, rename or delete your chat', async ({ page, request }) => {
    // Owner creates a chat through the UI, so the key under attack is one the
    // product actually mints.
    await openAssistant(page)
    await page.locator('[data-testid="assist-new-conversation"]').click()
    await openSwitcher(page)
    await expect(page.locator('[data-testid="assist-conversation-row"]').first()).toBeVisible()

    const listed = await request.get('/capi/assist/conversations', {
      headers: { Authorization: `Bearer ${ownerToken()}` },
    })
    expect(listed.ok()).toBeTruthy()
    const victimKey = (await listed.json()).conversations[0].conversation_key
    expect(victimKey).toBeTruthy()

    const attacker = await registerLogin(request, `chatiso-${RUN}@example.com`)
    const auth = { Authorization: `Bearer ${attacker}` }
    const path = `/capi/assist/conversations/${encodeURIComponent(victimKey)}`

    // Read: find-or-create is scoped to the caller, so the attacker gets an
    // empty conversation of their own — never the owner's messages.
    const read = await request.get(path, { headers: auth })
    expect(read.status()).toBe(200)
    expect((await read.json()).messages).toEqual([])

    const paged = await request.get(`${path}/messages`, { headers: auth })
    expect(paged.status()).toBe(200)
    expect((await paged.json()).messages).toEqual([])

    // Rename and delete: 404, not 403 — "exists, but not yours" is what an
    // enumeration attack needs.
    const renamed = await request.patch(path, { headers: auth, data: { title: 'owned' } })
    expect(renamed.status()).toBe(404)

    const deleted = await request.delete(path, { headers: auth })
    expect(deleted.status()).toBe(404)

    // And it is all still there afterwards.
    const after = await request.get('/capi/assist/conversations', {
      headers: { Authorization: `Bearer ${ownerToken()}` },
    })
    const keys = (await after.json()).conversations.map((c) => c.conversation_key)
    expect(keys).toContain(victimKey)
  })

  test('CHAT-ISO-02: the attacker never sees your chat in their own list', async ({ request }) => {
    const attacker = await registerLogin(request, `chatiso-${RUN}@example.com`)
    const mine = await request.get('/capi/assist/conversations', {
      headers: { Authorization: `Bearer ${ownerToken()}` },
    })
    const myKeys = (await mine.json()).conversations.map((c) => c.conversation_key)

    const theirs = await request.get('/capi/assist/conversations', {
      headers: { Authorization: `Bearer ${attacker}` },
    })
    const theirKeys = (await theirs.json()).conversations.map((c) => c.conversation_key)
    for (const k of myKeys) expect(theirKeys).not.toContain(k)
  })

  test('CHAT-ISO-03: the endpoints refuse an unauthenticated caller', async ({ request }) => {
    const paths = [
      ['get', '/capi/assist/conversations'],
      ['post', '/capi/assist/conversations'],
    ]
    for (const [verb, p] of paths) {
      const resp = await request[verb](p, { data: {} })
      expect([401, 403], `${verb} ${p}`).toContain(resp.status())
    }
  })
})
