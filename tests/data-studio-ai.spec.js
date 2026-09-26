/**
 * Data Studio × assistant — query proposals, end to end (real browser,
 * authenticated, scripted model).
 *
 * The owner's rules for this feature, each pinned by one of the tests below:
 *   1. one conversation per Studio project, inside the existing assistant;
 *   2. a proposed change is shown as an inline diff in the query editor;
 *   3. while a proposal is neither accepted nor rejected the assistant is
 *      LOCKED for the user;
 *   4. a proposal is ALL OR NOTHING — no per-hunk accept/reject;
 *   5. the user never has to write the query: the empty editor and a failed
 *      run both hand the assistant a ready prompt.
 *
 * Driven through the UI where the rules live (the editor, the bar above it,
 * the panel). The API is used for setup and cleanup (a project and a query
 * per test, deleted afterwards — data-studio.spec.js leaves its projects
 * behind and the shared account has been collecting them), and for the
 * server-side proof that the turn landed in the project's conversation.
 *
 * Runs on the scripted model (`mock-e2e`, see ASSIST-23 in smoke.spec.js for
 * why): the assertion is that the platform shows, locks, applies and
 * records a proposal, not that a 1.7B model feels like making one. The mock
 * reads the open query's ids out of the same system prompt a real model
 * gets, so a platform that stops telling the model what is open fails here
 * with "MOCK-FAIL: no open query" in the transcript rather than a timeout.
 *
 * Named to sort before smoke.spec.js: STORY-FLOWERS-2 ends that file with a
 * burst that trips the nginx limiter, and everything after it inherits the
 * cooldown.
 */
import { test, expect } from './baseTest.js'

const RUN = String(Date.now())

// The query every scenario starts from. The mock proposes a count in its
// place; "c.name" is how the tests tell the original from the proposal.
const ORIGINAL_QUERY = 'MATCH (c:Company) RETURN c.name AS name LIMIT 5'

/**
 * The bootstrap access token the base fixture injects into every page.
 * Read back rather than minted through /auth/refresh — refreshing here
 * would rotate the family and race the SPA's own restore (see baseTest.js).
 * Needs a navigated page: the init script runs on navigation, not on
 * about:blank.
 */
async function freshAccessToken(page) {
  const token = await page.evaluate(() => window.__FONTEM_BOOTSTRAP_TOKEN__ || null)
  if (!token) throw new Error('no bootstrap access token injected')
  return token
}

async function openAssistant(page) {
  await page.click('[data-testid="assist-toggle"]')
  await expect(page.locator('[data-testid="assist-panel"]')).toBeVisible({ timeout: 5_000 })
}

/**
 * Send a message and wait for the turn to settle: a new assistant bubble,
 * the streaming status gone, and prose OR a proposal card in it. Same shape
 * as the helper in smoke.spec.js (not exported there). The status wait is
 * part of the contract here, not an optional extra: the lock assertions
 * below read `assist-input` disabled, and while the stream is running the
 * input is disabled for a different reason (`loading`).
 */
async function sendAssistMessage(page, message, waitMs = 200_000) {
  const beforeCount = await page.locator('.assist-msg--assistant').count()
  await page.fill('[data-testid="assist-input"]', message)
  await page.click('[data-testid="assist-send"]')
  await page.locator(`.assist-msg--assistant >> nth=${beforeCount}`)
    .waitFor({ state: 'visible', timeout: waitMs })
  await expect(page.locator('[data-testid="assist-status"]')).toBeHidden({ timeout: waitMs })
  const body = page.locator('.assist-msg--assistant .msg-text').last()
  const card = page.locator('[data-testid="assist-proposals"]')
  await expect
    .poll(async () => (await body.innerText()).trim().length + await card.count(),
      { timeout: 60_000, message: 'assistant produced neither prose nor a proposal' })
    .toBeGreaterThan(0)
  return body.innerText()
}

/**
 * One test's world: the scripted model picked for the shared account, a
 * project with one Cypher query, and the promise to undo both.
 *
 * The model is picked BEFORE anything is created so a 422 (mock not enabled
 * here) skips with nothing to clean up. Everything after that runs inside a
 * try/finally: the account goes back to the environment default and the
 * project is deleted whatever the assertions did — the suite shares one
 * account, and a leaked pick would silently move every later assistant test
 * onto the mock.
 */
async function withStudio(page, { tag, query, scripted = true }, body) {
  await page.goto('/studio')
  await expect(page.locator('[data-testid="studio-home"]')).toBeVisible({ timeout: 15_000 })
  const token = await freshAccessToken(page)
  const headers = { Authorization: `Bearer ${token}` }
  const pick = (id) => page.request.put('/capi/assist/models', { headers, data: { model_id: id } })

  if (scripted) {
    const chose = await pick('mock-e2e')
    test.skip(chose.status() === 422, 'scripted model not enabled here (assistMockModel unset)')
    expect(chose.ok(), `could not select the scripted model: ${chose.status()}`).toBeTruthy()
  }

  let pid = null
  try {
    const proj = await page.request.post('/capi/studio/projects',
      { headers, data: { name: `E2E studio-ai ${RUN} ${tag}` } })
    expect(proj.status(), 'project creation (setup)').toBe(201)
    pid = (await proj.json()).id
    const q = await page.request.post(`/capi/studio/projects/${pid}/queries`,
      { headers, data: { name: 'companies', lang: 'cypher', query } })
    expect(q.status(), 'query creation (setup)').toBe(201)
    const qid = (await q.json()).id
    await body({ headers, pid, qid })
  } finally {
    if (scripted) await pick('qwen3-1.7b')
    if (pid) await page.request.delete(`/capi/studio/projects/${pid}`, { headers }).catch(() => {})
  }
}

async function openQuery(page, pid, qid) {
  await page.goto(`/studio/p/${pid}/q/${qid}`)
  await expect(page.locator('[data-testid="studio-query-view"]')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('[data-testid="query-editor"] .cm-content')).toContainText('MATCH')
}

/**
 * Ask the scripted model for a proposal on the open query and prove the
 * turn went where rule 1 says: the request names this project's
 * conversation and the open query. Asserting on the request localises a
 * regression to the client — a turn sent under `global` would still get a
 * proposal back, it would just be filed in the wrong place.
 */
async function askForProposal(page, { pid, qid }, message) {
  await openAssistant(page)
  const [streamReq, prose] = await Promise.all([
    page.waitForRequest((r) => r.url().includes('/assist/chat/stream'), { timeout: 30_000 }),
    sendAssistMessage(page, message),
  ])
  const sent = JSON.parse(streamReq.postData() || '{}')
  expect(sent.conversation_key, 'the turn belongs to this project\'s conversation')
    .toBe(`studio:${pid}`)
  expect(sent.studio?.project_id, 'the turn names the project on screen').toBe(pid)
  expect(sent.studio?.query?.id, 'the turn names the open query').toBe(qid)
  expect(sent.studio?.query?.text, 'the turn carries the editor text').toContain('c.name')
  return prose
}

/** What the server has for this query right now (not what the editor shows). */
async function storedQueryText(page, headers, pid, qid) {
  const res = await page.request.get(`/capi/studio/projects/${pid}`, { headers })
  expect(res.ok(), `project fetch failed: ${res.status()}`).toBeTruthy()
  const q = ((await res.json()).queries || []).find((x) => x.id === qid)
  expect(q, 'the query is missing from its project').toBeTruthy()
  return q.query
}

test.describe('data studio × assistant — query proposals', () => {
  test.setTimeout(300_000)

  test('STUDIO-AI-1: a proposal locks the assistant, shows a whole diff, and accepting applies it', async ({ page }) => {
    await withStudio(page, { tag: 'accept', query: ORIGINAL_QUERY }, async ({ headers, pid, qid }) => {
      await openQuery(page, pid, qid)
      const prose = await askForProposal(page, { pid, qid }, 'E2E-SCENARIO: studio propose a count')
      expect(prose, `the mock reported a failure: "${prose}"`).not.toMatch(/MOCK-FAIL/)

      // The card names the action, and the bar above the editor is the
      // decision point.
      await expect(page.locator('[data-testid="proposal-action"]').last())
        .toContainText(/propose[ _]query/i)
      const bar = page.locator('[data-testid="query-proposal"]')
      await expect(bar).toBeVisible({ timeout: 60_000 })
      await expect(page.locator('[data-testid="query-proposal-explanation"]'))
        .toContainText('MOCK-PROPOSAL')

      // ── Rule 3: locked while undecided ────────────────────────
      // The stream has ended (sendAssistMessage waited for the status to
      // go), so a disabled composer here is the lock and nothing else.
      await expect(page.locator('[data-testid="assist-locked"]')).toBeVisible()
      await expect(page.locator('[data-testid="assist-input"]'),
        'the composer must be disabled while a proposal waits').toBeDisabled()
      await expect(page.locator('[data-testid="assist-send"]')).toBeDisabled()

      // ── Rules 2 + 4: a diff, with nothing to pick from ────────
      const editor = page.locator('[data-testid="query-editor"]')
      await expect(editor).toHaveAttribute('data-proposal', '1')
      await expect(editor.locator('.cm-deletedChunk'),
        'the diff shows what the proposal removes').not.toHaveCount(0)
      await expect(editor.locator('.cm-chunkButtons'),
        'no per-hunk accept/reject: the proposal is all or nothing').toHaveCount(0)
      // Pending is pending: the server still has the user's text. Only an
      // accept may write, and the autosave must not do it on the side.
      expect(await storedQueryText(page, headers, pid, qid),
        'a pending proposal must not be persisted').toBe(ORIGINAL_QUERY)

      // Decide from the bar. The panel is a fixed drawer on the right;
      // close it first so it cannot sit over the button (the same overlay
      // once intercepted an editor Save click in smoke.spec.js).
      await page.click('[data-testid="assist-close"]')
      await page.click('[data-testid="query-proposal-accept"]')
      await expect(bar).toBeHidden({ timeout: 15_000 })
      await expect(editor).not.toHaveAttribute('data-proposal', '1')
      // Whole replacement: the count is in, the original is out.
      const content = editor.locator('.cm-content')
      await expect(content).toContainText('count(c)')
      await expect(content).not.toContainText('c.name')

      // Lock released.
      await openAssistant(page)
      await expect(page.locator('[data-testid="assist-locked"]')).toHaveCount(0)
      await expect(page.locator('[data-testid="assist-input"]'),
        'accepting must unlock the composer').toBeEnabled()

      // Applied means SAVED: a cold reload shows the proposal, not the draft
      // the page happened to hold.
      await page.reload()
      await expect(page.locator('[data-testid="studio-query-view"]')).toBeVisible({ timeout: 15_000 })
      await expect(page.locator('[data-testid="query-editor"] .cm-content')).toContainText('count(c)')

      // ── Rule 1: the record lives under the project ────────────
      // Read through the API rather than the DOM: the panel could render a
      // card from the live stream and store nothing.
      const conv = await page.request.get(`/capi/assist/conversations/studio:${pid}`, { headers })
      expect(conv.ok(), `conversation fetch failed: ${conv.status()}`).toBeTruthy()
      const messages = (await conv.json()).messages || []
      const turnStart = messages.map((m) => m.role === 'user'
        && (m.content || '').includes('E2E-SCENARIO: studio')).lastIndexOf(true)
      expect(turnStart, 'this turn is missing from the project\'s conversation').toBeGreaterThan(-1)
      const tools = messages.slice(turnStart).filter((m) => m.role === 'tool').map((m) => m.content)
      expect(tools, 'the proposal must be recorded as a tool call')
        .toContain('mcp__gmr__studio_propose_query')
    })
  })

  test('STUDIO-AI-2: rejecting a proposal restores the editor and persists nothing', async ({ page }) => {
    await withStudio(page, { tag: 'reject', query: ORIGINAL_QUERY }, async ({ headers, pid, qid }) => {
      await openQuery(page, pid, qid)
      const prose = await askForProposal(page, { pid, qid }, 'E2E-SCENARIO: studio propose a count')
      expect(prose, `the mock reported a failure: "${prose}"`).not.toMatch(/MOCK-FAIL/)

      const bar = page.locator('[data-testid="query-proposal"]')
      await expect(bar).toBeVisible({ timeout: 60_000 })
      await expect(page.locator('[data-testid="assist-input"]'),
        'the composer must be disabled while a proposal waits').toBeDisabled()
      const editor = page.locator('[data-testid="query-editor"]')
      await expect(editor).toHaveAttribute('data-proposal', '1')

      await page.click('[data-testid="assist-close"]')
      await page.click('[data-testid="query-proposal-reject"]')
      await expect(bar).toBeHidden({ timeout: 15_000 })
      await expect(editor).not.toHaveAttribute('data-proposal', '1')
      // Nothing of the proposal survives: the user's text, whole.
      const content = editor.locator('.cm-content')
      await expect(content).toContainText('c.name')
      await expect(content).not.toContainText('count(c)')

      await openAssistant(page)
      await expect(page.locator('[data-testid="assist-locked"]')).toHaveCount(0)
      await expect(page.locator('[data-testid="assist-input"]'),
        'rejecting must unlock the composer').toBeEnabled()

      // And the server never saw it — the diff was drawn over the draft,
      // not written into it, so the autosave had nothing to send.
      await page.reload()
      await expect(page.locator('[data-testid="studio-query-view"]')).toBeVisible({ timeout: 15_000 })
      await expect(page.locator('[data-testid="query-editor"] .cm-content')).toContainText('c.name')
      await expect(page.locator('[data-testid="query-editor"] .cm-content')).not.toContainText('count(c)')
      expect(await storedQueryText(page, headers, pid, qid),
        'a rejected proposal must leave the stored query untouched').toBe(ORIGINAL_QUERY)
    })
  })

  test('STUDIO-AI-3: a proposal the engine refuses never reaches the editor or the lock', async ({ page }) => {
    // The mock proposes text Neo4j flags (a label typo). The platform checks
    // every proposal against the engine before showing it: the card says
    // refused, the editor and the composer are untouched.
    await withStudio(page, { tag: 'refused', query: ORIGINAL_QUERY }, async ({ pid, qid }) => {
      await openQuery(page, pid, qid)
      const prose = await askForProposal(page, { pid, qid }, 'E2E-SCENARIO: studio-bad propose a broken count')
      // The mock itself reads the tool result: MOCK-FAIL here means the bad
      // query was accepted by the server, which is the bug this guards.
      expect(prose, `the mock did not see a refusal: "${prose}"`).not.toMatch(/MOCK-FAIL/)

      await expect(page.locator('[data-testid="proposal-refused"]').last()).toBeVisible({ timeout: 60_000 })
      await expect(page.locator('[data-testid="query-proposal"]'),
        'a refused proposal must not offer a decision').toHaveCount(0)
      await expect(page.locator('[data-testid="assist-locked"]')).toHaveCount(0)
      await expect(page.locator('[data-testid="assist-input"]'),
        'a refused proposal must not lock the composer').toBeEnabled()
      const editor = page.locator('[data-testid="query-editor"]')
      await expect(editor).not.toHaveAttribute('data-proposal', '1')
      await expect(editor.locator('.cm-content')).toContainText('c.name')
      await expect(editor.locator('.cm-content')).not.toContainText('Compnay')
    })
  })

  test('STUDIO-AI-4: the empty editor and a failed run both hand the assistant a prompt', async ({ page }) => {
    // Rule 5, without a turn: both doors only prefill the composer, the user
    // still sends. No model pick here — nothing is asked of any model.
    await withStudio(page, { tag: 'entry', query: '', scripted: false }, async ({ pid, qid }) => {
      await page.goto(`/studio/p/${pid}/q/${qid}`)
      await expect(page.locator('[data-testid="studio-query-view"]')).toBeVisible({ timeout: 15_000 })

      // "Write it for me". The prompt names no language: which store
      // answers the question — the graph, the statistics, Virtuoso — is the
      // assistant's call, and "Write a Cypher query" pinned it to one.
      await expect(page.locator('[data-testid="query-assist-hint"]')).toBeVisible()
      await page.click('[data-testid="query-assist-ask"]')
      await expect(page.locator('[data-testid="assist-panel"]')).toBeVisible({ timeout: 5_000 })
      const askInput = page.locator('[data-testid="assist-input"]')
      await expect(askInput, 'the ask prefills a write prompt').toHaveValue(/Write a query that/i)
      await expect(askInput, 'the prompt must leave the store to the assistant')
        .not.toHaveValue(/Cypher|SPARQL|SQL/)

      // A run that fails → "fix it", carrying the engine's error. The panel
      // is closed first so it cannot sit over the editor; the editor is
      // CodeMirror (contenteditable), so click in, select-all and type —
      // closeBrackets closes the "(" for us and the statement stays broken.
      await page.click('[data-testid="assist-close"]')
      const content = page.locator('[data-testid="query-editor"] .cm-content')
      await content.click()
      await page.keyboard.press('ControlOrMeta+a')
      await page.keyboard.type('MATCH (c:Compnay RETURN c')
      // The ask is not only for an empty editor: it stays once there is text.
      await expect(page.locator('[data-testid="query-assist-ask"]'),
        'the ask must stay offered once the query has text').toBeVisible()
      await page.click('[data-testid="query-run"]')
      await expect(page.locator('[data-testid="query-error"]')).toBeVisible({ timeout: 25_000 })
      // A failed run adds the fix NEXT TO the ask — both doors at once.
      await expect(page.locator('[data-testid="query-assist-fix"]')).toBeVisible()
      await expect(page.locator('[data-testid="query-assist-ask"]')).toBeVisible()
      await page.click('[data-testid="query-assist-fix"]')
      await expect(page.locator('[data-testid="assist-panel"]')).toBeVisible({ timeout: 5_000 })
      await expect(page.locator('[data-testid="assist-input"]'),
        'the fix prompt must quote the failure').toHaveValue(/fails with/)
    })
  })
})
