/**
 * gmr-consolidator smoke tests.
 *
 * Read-only checks against the live consolidator (deployed in `gmr` ns,
 * shared by all envs). Runs alongside the main smoke suite via the same
 * CronJob. Never mutates the graph.
 */
import { test, expect, request } from '@playwright/test'

// Goes through the gmr-web nginx proxy: /api/consolidator/* → consolidator svc
// Testing by default — e2e is a promotion gate and never targets prod.
const BASE = process.env.BASE_URL || 'https://fontem.testing.void42.internal'

test.describe('Consolidator — read-only smoke', () => {
  test('CON-01: /health returns ok', async () => {
    const ctx = await request.newContext({ ignoreHTTPSErrors: true })
    const res = await ctx.get(`${BASE}/api/consolidator/health`)
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('ok')
  })

  test('CON-02: /rules lists registered rules with metadata', async () => {
    const ctx = await request.newContext({ ignoreHTTPSErrors: true })
    const res = await ctx.get(`${BASE}/api/consolidator/rules`)
    expect(res.status()).toBe(200)
    const rules = await res.json()
    expect(Array.isArray(rules)).toBe(true)
    expect(rules.length).toBeGreaterThanOrEqual(12)

    const names = rules.map(r => r.name)
    // Spot-check key rules
    for (const expected of [
      'exact_lei_match',
      'exact_vat_match',
      'exact_name_country_match',
      'fuzzy_name_same_country',
      'gds_node_similarity_company',
      'gds_node_similarity_authority',
      'exact_authority_id_match',
    ]) {
      expect(names).toContain(expected)
    }

    // Each rule has the metadata the UI cards need
    for (const r of rules) {
      expect(r.confidence).toBeGreaterThan(0)
      expect(['merge', 'link', 'flag', 'noop', 'enrich']).toContain(r.action)
      expect(Array.isArray(r.entity_types)).toBe(true)
    }
  })

  test('CON-03: /candidates is read-only and pagination-safe', async () => {
    const ctx = await request.newContext({ ignoreHTTPSErrors: true })
    const res = await ctx.get(`${BASE}/api/consolidator/candidates?reviewed=false&limit=1`)
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
  })
})
