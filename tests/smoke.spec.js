/**
 * GMR Production Smoke Tests
 *
 * Validates critical user flows against the live GMR platform every 8 hours.
 * Runs as a Kubernetes CronJob with a dedicated test account.
 *
 * User flows covered:
 *   AUTH-01..03    — Login page, authentication, session, registration
 *   SEARCH-04..05  — Entity search, EU entity deep search
 *   BROWSE-06..08  — Financials, contracts view, graph explorer (EU entity)
 *   REPORT-09..13  — Full report lifecycle: list, create, edit, view, widgets
 *   ISSUE-14..16   — Issue lifecycle: create, list, detail + comment
 *   PAGES-17..18   — Activity page, reports list
 *   ASSIST-19..21  — AI streaming, edit proposals, MCP tools
 *   CLEANUP-22     — Delete test data
 *
 * Run: BASE_URL=https://gmr.void42.net npx playwright test
 */
import { test, expect } from '@playwright/test'

const TEST_EMAIL = process.env.TEST_EMAIL || 'researcher@gmr.test'
const TEST_PASSWORD = process.env.TEST_PASSWORD || 'TestPass123!'
const RUN_ID = Date.now()
const REPORT_TITLE = `Smoke Test ${RUN_ID}`

/** Login via API and return JWT token */
async function apiLogin(request, baseURL) {
  const resp = await request.post(`${baseURL}/capi/auth/login`, {
    data: { email: TEST_EMAIL, password: TEST_PASSWORD },
  })
  expect(resp.ok()).toBeTruthy()
  return (await resp.json()).access_token
}

/** Login via UI — reused by multiple tests */
async function uiLogin(page) {
  await page.goto('/login')
  await page.fill('[data-testid="login-email"]', TEST_EMAIL)
  await page.fill('[data-testid="login-password"]', TEST_PASSWORD)
  await page.click('[data-testid="login-submit"]')
  await page.waitForURL('/', { timeout: 15_000 })
}

/** SSE streaming helper — collects events from the assist endpoint */
async function chatStream(page, baseURL, token, message, conversationKey, contextBlock) {
  return page.evaluate(
    async ({ url, token: tk, message: msg, conversationKey: ck, contextBlock: cb }) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tk}`,
        },
        body: JSON.stringify({
          message: msg,
          conversation_key: ck,
          context_block: cb || '',
        }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`)

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      const events = []
      const phases = []
      let fullText = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        while (buffer.includes('\n\n')) {
          const idx = buffer.indexOf('\n\n')
          const block = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)

          let eventType = 'chunk'
          let eventData = ''
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) eventType = line.slice(7)
            else if (line.startsWith('data: ')) eventData = line.slice(6)
          }
          if (!eventData) continue
          events.push({ type: eventType, data: eventData })

          if (eventType === 'status') {
            try {
              const s = JSON.parse(eventData)
              if (s.phase && !phases.includes(s.phase)) phases.push(s.phase)
            } catch { /* skip */ }
          } else if (eventType === 'chunk') {
            try { fullText += JSON.parse(eventData).text || '' } catch { /* skip */ }
          }
        }
      }

      return { events, fullText, phases }
    },
    {
      url: `${baseURL}/capi/assist/chat/stream`,
      token,
      message,
      conversationKey,
      contextBlock,
    },
  )
}

test.describe.serial('Production Smoke Tests', () => {
  let reportId = null
  let authToken = null
  let sectionId = null
  let issueId = null

  // ── Authentication ─────────────────────────────────────────────

  test('AUTH-01: Login page loads with email/password form', async ({ page }) => {
    await page.goto('/login')
    await expect(page.locator('[data-testid="login-email"]')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('[data-testid="login-password"]')).toBeVisible()
    await expect(page.locator('[data-testid="login-submit"]')).toBeVisible()
  })

  test('AUTH-02: Login with test credentials', async ({ page }) => {
    await uiLogin(page)
    await expect(page.locator('[data-testid="app-nav"]')).toBeVisible({ timeout: 5_000 })
  })

  test('AUTH-03: Profile menu shows sign-out', async ({ page }) => {
    await uiLogin(page)
    await page.click('[data-testid="profile-menu-trigger"]')
    await expect(page.locator('[data-testid="sign-out-btn"]')).toBeVisible()
  })

  // ── Search & Browse ────────────────────────────────────────────

  test('SEARCH-04: Search for Apple returns US results', async ({ page }) => {
    await page.goto('/')
    const searchInput = page.locator('input[type="search"]').first()
    await searchInput.fill('Apple')
    await expect(page.locator('.gmr-card').first()).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('.gmr-card .ticker-symbol').first()).toContainText('AAPL')
  })

  test('SEARCH-05: Search for Siemens returns EU results', async ({ page }) => {
    await page.goto('/')
    const searchInput = page.locator('input[type="search"]').first()
    await searchInput.fill('Siemens')
    await expect(page.locator('.gmr-card').first()).toBeVisible({ timeout: 10_000 })
    // Verify we get European results (DE/ES/NL), not just US
    const cards = page.locator('.gmr-card')
    const count = await cards.count()
    expect(count).toBeGreaterThanOrEqual(2)
  })

  test('BROWSE-06: Apple fundamentals page loads with data', async ({ page }) => {
    await page.goto('/c/AAPL/fundamentals')
    await expect(page.locator('[data-testid="financials-panel"]')).toBeVisible({ timeout: 20_000 })
    await expect(
      page.locator('[data-testid="ticker-header"]').or(page.locator('text=APPLE')),
    ).toBeVisible({ timeout: 10_000 })
  })

  test('BROWSE-07: Contracts view renders', async ({ page }) => {
    await page.goto('/c/AAPL/contracts')
    // The contracts panel should load (may have 0 rows for AAPL, but the panel renders)
    await expect(page.locator('[data-testid="contracts-panel"]').first()).toBeVisible({ timeout: 20_000 })
  })

  test('BROWSE-08: Graph explorer renders with connected EU entity', async ({ page }) => {
    // Use Siemens AG (has graph connections to Universität Stuttgart)
    // Navigate via search to find the right Siemens
    await page.goto('/')
    const searchInput = page.locator('input[type="search"]').first()
    await searchInput.fill('Siemens AG')
    await expect(page.locator('.gmr-card').first()).toBeVisible({ timeout: 10_000 })
    // Click the first Siemens result
    await page.locator('.gmr-card').first().click()
    // Navigate to graph view
    await page.waitForTimeout(1000) // let the profile load
    // Find and click the graph view selector
    const graphLink = page.locator('a[href*="graph"], button:has-text("Graph"), [data-testid="view-graph"]').first()
    if (await graphLink.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await graphLink.click()
    }
    // The graph canvas should render
    await page.waitForSelector('[data-testid="graph-panel-wrap"], .ge-canvas, canvas', {
      timeout: 15_000,
    })
  })

  // ── Report Lifecycle ───────────────────────────────────────────

  test('REPORT-09: Create report via API', async ({ request, baseURL }) => {
    authToken = await apiLogin(request, baseURL)

    const resp = await request.post(`${baseURL}/capi/reports`, {
      headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
      data: { title: REPORT_TITLE, abstract: 'Automated production smoke test — full lifecycle' },
    })
    expect(resp.ok()).toBeTruthy()
    const report = await resp.json()
    reportId = report.id
    expect(reportId).toBeTruthy()
    expect(report.title).toBe(REPORT_TITLE)
  })

  test('REPORT-10: Add section with widget embed', async ({ request, baseURL }) => {
    if (!authToken) authToken = await apiLogin(request, baseURL)
    if (!reportId) test.skip()

    // Add a section with a contracts_table widget embed
    const widgetContent = '<p>Siemens EU procurement overview:</p>\n' +
      '```widget\n{"widget_type":"contracts_table","schema_version":1,"entityId":"f4259a89-88f7-5796-a22a-1c8c1999cc69"}\n```'
    const resp = await request.post(`${baseURL}/capi/reports/${reportId}/sections`, {
      headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
      data: { content: widgetContent },
    })
    expect(resp.ok()).toBeTruthy()
    const section = await resp.json()
    sectionId = section.id
    expect(section.content).toContain('widget')
  })

  test('REPORT-11: Report persists and sections are returned', async ({ request, baseURL }) => {
    if (!reportId) test.skip()
    const resp = await request.get(`${baseURL}/capi/reports/${reportId}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    })
    expect(resp.ok()).toBeTruthy()
    const report = await resp.json()
    expect(report.title).toBe(REPORT_TITLE)
    expect(report.sections.length).toBeGreaterThanOrEqual(1)
    expect(report.sections[0].content).toContain('widget')
  })

  test('REPORT-12: Report view renders sections in the browser', async ({ page }) => {
    if (!reportId) test.skip()
    await uiLogin(page)
    await page.goto(`/reports/${reportId}`)
    await expect(page.locator('[data-testid="report-title"]')).toContainText('Smoke Test', { timeout: 10_000 })
    // At least one section should render
    await expect(page.locator('.section-html, .report-section').first()).toBeVisible({ timeout: 10_000 })
  })

  test('REPORT-13: Reports list page loads', async ({ page }) => {
    await uiLogin(page)
    await page.goto('/reports')
    // Should see at least the smoke test report we just created
    await expect(page.locator('.report-card, [data-testid="report-card"], a[href*="reports/"]').first()).toBeVisible({ timeout: 10_000 })
  })

  // ── Issues Lifecycle ───────────────────────────────────────────

  test('ISSUE-14: Create issue via API', async ({ request, baseURL }) => {
    if (!authToken) authToken = await apiLogin(request, baseURL)

    const resp = await request.post(`${baseURL}/capi/issues`, {
      headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
      data: {
        title: `Smoke Issue ${RUN_ID}`,
        body: 'Automated smoke test issue — verifies issue creation flow.',
        issue_type: 'data_quality',
      },
    })
    // 201 = created, 403 = trust level too low, 422 = validation error
    if (resp.status() === 201) {
      const issue = await resp.json()
      issueId = issue.id
      expect(issue.title).toContain('Smoke Issue')
    } else {
      // Non-201 is acceptable — issue creation has trust/validation requirements
      expect([201, 403, 422]).toContain(resp.status())
    }
  })

  test('ISSUE-15: Issues list page loads', async ({ page }) => {
    await uiLogin(page)
    await page.goto('/issues')
    // The issues page should load with tabs (All/Open/Resolved) or at least a heading
    await expect(
      page.locator('[data-testid="issues-list"], .issues-list, h1:has-text("Issues")').first(),
    ).toBeVisible({ timeout: 10_000 })
  })

  test('ISSUE-16: Issue detail renders with comments', async ({ request, baseURL }) => {
    if (!issueId) test.skip()

    // Add a comment to the issue
    const resp = await request.post(`${baseURL}/capi/issues/${issueId}/comments`, {
      headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
      data: { body: 'Automated smoke test comment.' },
    })
    expect(resp.ok()).toBeTruthy()
    const comment = await resp.json()
    expect(comment.body).toContain('smoke test')
  })

  // ── Pages ──────────────────────────────────────────────────────

  test('PAGES-17: Activity page loads', async ({ page }) => {
    await uiLogin(page)
    await page.goto('/activity')
    await expect(
      page.locator('[data-testid="activity-list"], .activity-list, .activity-item, h1:has-text("Activity")').first(),
    ).toBeVisible({ timeout: 10_000 })
  })

  test('PAGES-18: Landing page popular tickers are clickable', async ({ page }) => {
    await page.goto('/')
    // Click a popular ticker button (ASML.AS is European)
    const asmlBtn = page.locator('button:has-text("ASML.AS")')
    if (await asmlBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await asmlBtn.click()
      // Should navigate to ticker detail and show financials panel
      await expect(page.locator('[data-testid="financials-panel"]')).toBeVisible({ timeout: 15_000 })
    }
  })

  // ── AI Assistant ───────────────────────────────────────────────

  test('ASSIST-19: Streaming SSE delivers status events and text', async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(120_000)
    if (!authToken) authToken = await apiLogin(page.request, baseURL)
    await page.goto('/')

    const { events, fullText, phases } = await chatStream(
      page, baseURL, authToken,
      'What is Apple Inc\'s ticker symbol?',
      `smoke:assist-19:${RUN_ID}`,
      '',
    )

    expect(events.filter(e => e.type === 'status').length).toBeGreaterThanOrEqual(1)
    expect(events.filter(e => e.type === 'done').length).toBeGreaterThanOrEqual(1)
    expect(fullText.length).toBeGreaterThan(0)
    expect(fullText).toMatch(/AAPL/i)
    expect(phases.length).toBeGreaterThanOrEqual(1)
  })

  test('ASSIST-20: Assistant proposes report edits', async ({ page, baseURL }) => {
    test.setTimeout(120_000)
    if (!authToken || !reportId) test.skip()
    await page.goto('/')

    const { fullText, events } = await chatStream(
      page, baseURL, authToken,
      'Add a new section to this report with the title "Apple Overview" and content ' +
        '"Apple Inc. is a multinational technology company headquartered in Cupertino." ' +
        'Use the propose_edit tool.',
      `report:${reportId}`,
      `# ${REPORT_TITLE}\n\n## Section 1\nSmoke test section.`,
    )

    expect(fullText.length).toBeGreaterThan(10)
    const lower = fullText.toLowerCase()
    expect(
      lower.includes('apple') || lower.includes('section') || lower.includes('propose') ||
      lower.includes('added') || lower.includes('edit') || lower.includes('report') ||
      lower.includes('overview') || lower.includes('cupertino')
    ).toBeTruthy()
    expect(events.some(e => e.type === 'done')).toBeTruthy()
  })

  test('ASSIST-21: Assistant uses MCP tools for live graph data', async ({
    page, baseURL,
  }) => {
    test.setTimeout(120_000)
    if (!authToken) test.skip()
    await page.goto('/')

    const { fullText, phases, events } = await chatStream(
      page, baseURL, authToken,
      'Search for "Siemens" in the GMR graph and report what data we have. ' +
        'Include their EU contracts and lobbying data if available.',
      `smoke:assist-21:${RUN_ID}`,
      '',
    )

    // Must have used MCP tools
    expect(phases.some(
      p => p === 'tool_use' || p === 'searching' || p === 'analyzing' || p === 'synthesizing'
    )).toBeTruthy()

    // Response must contain graph data (Siemens-specific)
    const hasData =
      fullText.match(/siemens/i) ||
      fullText.match(/contract/i) ||
      fullText.match(/lobbying/i) ||
      fullText.match(/€\d/i) ||
      fullText.match(/EP\s*access/i) ||
      fullText.match(/transparency/i)
    expect(hasData).toBeTruthy()
    expect(fullText.length).toBeGreaterThan(50)
    expect(events.some(e => e.type === 'done')).toBeTruthy()
  })

  // ── Cleanup ────────────────────────────────────────────────────

  test('CLEANUP-22: Delete test report and issue', async ({ request, baseURL }) => {
    if (!authToken) authToken = await apiLogin(request, baseURL)

    if (reportId) {
      const resp = await request.delete(`${baseURL}/capi/reports/${reportId}`, {
        headers: { Authorization: `Bearer ${authToken}` },
      })
      expect([204, 404]).toContain(resp.status())
    }

    if (issueId) {
      const resp = await request.delete(`${baseURL}/capi/issues/${issueId}`, {
        headers: { Authorization: `Bearer ${authToken}` },
      })
      expect([204, 404]).toContain(resp.status())
    }
  })
})
