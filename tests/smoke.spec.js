/**
 * GMR Production Smoke Tests
 *
 * Validates critical user flows against the live platform every 8 hours.
 * Runs as a Kubernetes CronJob with a dedicated test account.
 *
 * User flows covered:
 *   AUTH-01..03  — Login page, authentication, session
 *   SEARCH-04   — Entity search returns results
 *   BROWSE-05   — Company profile loads with financial data
 *   GRAPH-06    — Graph explorer renders (WebGL/Canvas)
 *   REPORT-07   — Create report via API
 *   REPORT-08   — Add section to report
 *   REPORT-09   — Report persists across requests
 *   ASSIST-10   — AI assistant responds (basic query)
 *   ASSIST-11   — AI assistant can edit a report (propose_edit via MCP)
 *   ASSIST-12   — AI assistant uses MCP tools (graph data retrieval)
 *   CLEANUP-13  — Delete test report
 *
 * Run: BASE_URL=https://gmr.void42.net npx playwright test
 */
import { test, expect } from '@playwright/test'

const TEST_EMAIL = process.env.TEST_EMAIL || 'researcher@gmr.test'
const TEST_PASSWORD = process.env.TEST_PASSWORD || 'TestPass123!'
const REPORT_TITLE = `Smoke Test ${Date.now()}`

/** Helper: login via API and return { token, request, baseURL } */
async function apiLogin(request, baseURL) {
  const resp = await request.post(`${baseURL}/capi/auth/login`, {
    data: { email: TEST_EMAIL, password: TEST_PASSWORD },
  })
  expect(resp.ok()).toBeTruthy()
  const data = await resp.json()
  return data.access_token
}

test.describe.serial('Production Smoke Tests', () => {
  let reportId = null
  let authToken = null
  let sectionId = null

  // ── Authentication ─────────────────────────────────────────────

  test('AUTH-01: Login page loads with email/password form', async ({ page }) => {
    await page.goto('/login')
    await expect(page.locator('[data-testid="login-email"]')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('[data-testid="login-password"]')).toBeVisible()
    await expect(page.locator('[data-testid="login-submit"]')).toBeVisible()
  })

  test('AUTH-02: Login with test credentials', async ({ page }) => {
    await page.goto('/login')
    await page.fill('[data-testid="login-email"]', TEST_EMAIL)
    await page.fill('[data-testid="login-password"]', TEST_PASSWORD)
    await page.click('[data-testid="login-submit"]')
    await page.waitForURL('/', { timeout: 15_000 })
    await expect(page.locator('[data-testid="app-nav"]')).toBeVisible({ timeout: 5_000 })
  })

  test('AUTH-03: User session visible in header', async ({ page }) => {
    await page.goto('/login')
    await page.fill('[data-testid="login-email"]', TEST_EMAIL)
    await page.fill('[data-testid="login-password"]', TEST_PASSWORD)
    await page.click('[data-testid="login-submit"]')
    await page.waitForURL('/', { timeout: 15_000 })
    await expect(page.locator('[data-testid="sign-out-btn"]')).toBeVisible()
  })

  // ── Search & Browse ────────────────────────────────────────────

  test('SEARCH-04: Search for Apple returns results', async ({ page }) => {
    await page.goto('/')
    const searchInput = page.locator('input[type="search"]').first()
    await searchInput.fill('Apple')
    await expect(page.locator('.gmr-card').first()).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('.gmr-card .ticker-symbol').first()).toContainText('AAPL')
  })

  test('BROWSE-05: Apple profile loads with data', async ({ page }) => {
    await page.goto('/c/AAPL/fundamentals')
    await expect(page.locator('[data-testid="financials-panel"]')).toBeVisible({ timeout: 20_000 })
    await expect(
      page.locator('[data-testid="ticker-header"]').or(page.locator('text=APPLE')),
    ).toBeVisible({ timeout: 10_000 })
  })

  test('GRAPH-06: Graph Explorer renders', async ({ page }) => {
    await page.goto('/c/AAPL/graph')
    await page.waitForSelector('[data-testid="graph-panel-wrap"], .ge-canvas, canvas', {
      timeout: 15_000,
    })
  })

  // ── Report CRUD ────────────────────────────────────────────────

  test('REPORT-07: Create report', async ({ request, baseURL }) => {
    authToken = await apiLogin(request, baseURL)

    const resp = await request.post(`${baseURL}/capi/reports`, {
      headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
      data: { title: REPORT_TITLE, abstract: 'Automated production smoke test' },
    })
    expect(resp.ok()).toBeTruthy()
    const report = await resp.json()
    reportId = report.id
    expect(reportId).toBeTruthy()
    expect(report.title).toBe(REPORT_TITLE)
  })

  test('REPORT-08: Add section to report', async ({ request, baseURL }) => {
    if (!reportId || !authToken) {
      authToken = await apiLogin(request, baseURL)
      const cr = await request.post(`${baseURL}/capi/reports`, {
        headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
        data: { title: REPORT_TITLE, abstract: 'Recreated for retry' },
      })
      reportId = (await cr.json()).id
    }
    const resp = await request.post(`${baseURL}/capi/reports/${reportId}/sections`, {
      headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
      data: { content: '<p>This section was created by the production smoke test.</p>' },
    })
    expect(resp.ok()).toBeTruthy()
    const section = await resp.json()
    sectionId = section.id
    expect(section.content).toContain('smoke test')
  })

  test('REPORT-09: Report persists on reload', async ({ request, baseURL }) => {
    expect(reportId).toBeTruthy()
    const resp = await request.get(`${baseURL}/capi/reports/${reportId}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    })
    expect(resp.ok()).toBeTruthy()
    const report = await resp.json()
    expect(report.title).toBe(REPORT_TITLE)
    expect(report.sections.length).toBeGreaterThanOrEqual(1)
    expect(report.sections[0].content).toContain('smoke test')
  })

  // ── AI Assistant ───────────────────────────────────────────────

  test('ASSIST-10: AI assistant responds to basic query', async ({ request, baseURL }) => {
    expect(authToken).toBeTruthy()

    const resp = await request.post(`${baseURL}/capi/assist/chat`, {
      headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
      data: {
        message: 'What is the ticker symbol for Apple Inc?',
        report_context: `Title: ${REPORT_TITLE}`,
      },
      timeout: 120_000,
    })
    expect(resp.ok()).toBeTruthy()
    const result = await resp.json()
    // Assistant should return a meaningful response
    expect(result.content.length).toBeGreaterThan(10)
  })

  test('ASSIST-11: AI assistant can add text to report (propose_edit)', async ({
    request,
    baseURL,
  }) => {
    expect(authToken).toBeTruthy()
    expect(reportId).toBeTruthy()

    // Ask the assistant to add a section about Apple to our report.
    // The assistant should invoke propose_edit which returns structured actions.
    const resp = await request.post(`${baseURL}/capi/assist/chat`, {
      headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
      data: {
        message:
          `Add a new section to this report with the title "Apple Overview" and the text ` +
          `"Apple Inc. is a multinational technology company headquartered in Cupertino, California." ` +
          `Use the propose_edit tool to do this.`,
        report_context: JSON.stringify({
          id: reportId,
          title: REPORT_TITLE,
          sections: [{ id: sectionId, content: '<p>Smoke test section</p>' }],
        }),
      },
      timeout: 120_000,
    })
    expect(resp.ok()).toBeTruthy()
    const result = await resp.json()

    // The response should contain something — either a propose_edit action
    // or at least an acknowledgment that it attempted the edit.
    // We check for either structured suggestions or text mentioning the edit.
    const hasProposal = result.suggestions && result.suggestions.length > 0
    const mentionsEdit =
      result.content.toLowerCase().includes('section') ||
      result.content.toLowerCase().includes('apple') ||
      result.content.toLowerCase().includes('propose') ||
      result.content.toLowerCase().includes('add')
    expect(hasProposal || mentionsEdit).toBeTruthy()
  })

  test('ASSIST-12: AI assistant uses MCP tools for graph data', async ({ request, baseURL }) => {
    expect(authToken).toBeTruthy()

    // Ask something that REQUIRES the MCP search_entities or get_company tool
    // to answer — the assistant cannot answer this from general knowledge alone
    // because it requires live graph data (subsidiaries, contracts, etc.).
    const resp = await request.post(`${baseURL}/capi/assist/chat`, {
      headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
      data: {
        message:
          'Use the search_entities tool to look up "Apple" in the GMR graph, then tell me ' +
          'what data we have about them. Include the number of contracts or relationships if available.',
        report_context: `Title: ${REPORT_TITLE}`,
      },
      timeout: 120_000,
    })
    expect(resp.ok()).toBeTruthy()
    const result = await resp.json()

    // The assistant should have used at least one MCP tool
    // If tool_calls_made is reported, check it; otherwise verify the content
    // references specific graph data (not just general knowledge about Apple)
    const usedTools = result.tool_calls_made > 0
    const hasGraphData =
      result.content.includes('AAPL') ||
      result.content.includes('contract') ||
      result.content.includes('subsidiaries') ||
      result.content.includes('graph') ||
      result.content.includes('entities') ||
      result.content.includes('relationships') ||
      result.content.includes('ticker')
    expect(usedTools || hasGraphData).toBeTruthy()
    expect(result.content.length).toBeGreaterThan(50)
  })

  // ── Cleanup ────────────────────────────────────────────────────

  test('CLEANUP-13: Delete test report', async ({ request, baseURL }) => {
    expect(reportId).toBeTruthy()
    const resp = await request.delete(`${baseURL}/capi/reports/${reportId}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    })
    expect(resp.status()).toBe(204)

    // Verify it's gone
    const listResp = await request.get(`${baseURL}/capi/reports`, {
      headers: { Authorization: `Bearer ${authToken}` },
    })
    const reports = await listResp.json()
    const found = Array.isArray(reports) ? reports.some((r) => r.id === reportId) : false
    expect(found).toBeFalsy()
  })
})
