/**
 * Consolidator — the shape of its public edge.
 *
 * These used to hit /api/consolidator/* through fontem-web's nginx, which
 * proxied the consolidator's ENTIRE API to the internet with no
 * authentication of any kind — /consolidate, /resolve, /events/dispatch
 * and the Neo4j webhook included, all of which write to the graph. That
 * block was removed deliberately.
 *
 * The four routes the admin review screen needs are republished by
 * fontem-api under /api/consolidator/*, behind its data-admin gate. The
 * machine-to-machine half is not published at all and reaches the
 * consolidator over the cluster network instead.
 *
 * So the tests assert the security property rather than the old open
 * behaviour: the write-capable surface is gone from the edge, and what
 * remains demands a token. That is worth more than what they checked
 * before, which was that an unauthenticated caller could read internals.
 */
import { test, expect, request } from '@playwright/test'

const BASE = process.env.BASE_URL || 'https://fontem.testing.void42.internal'

/** Routes fontem-api republishes, all behind require_data_admin. */
const GATED = ['/api/consolidator/candidates', '/api/consolidator/relationships']

/**
 * Routes that must NOT be reachable from the edge. /health and /rules
 * expose internals; the rest write to the graph. None is republished, so
 * each falls through to fontem-api's /api/ handler and 404s.
 */
const UNPUBLISHED = [
  '/api/consolidator/health',
  '/api/consolidator/rules',
  '/api/consolidator/consolidate/batch',
  '/api/consolidator/events/dispatch',
  '/api/consolidator/webhooks/neo4j-trigger',
]

test.describe('Consolidator — public edge', () => {
  for (const path of UNPUBLISHED) {
    test(`CON-01 ${path} is not published at the edge`, async () => {
      const ctx = await request.newContext({ ignoreHTTPSErrors: true })
      const res = await ctx.get(`${BASE}${path}`)
      // 404 because the route does not exist here. A 200 would mean the
      // nginx proxy came back and the write API is on the internet again.
      expect(res.status(), `${path} answered ${res.status()}`).toBe(404)
    })
  }

  for (const path of GATED) {
    test(`CON-02 ${path} requires a token`, async () => {
      const ctx = await request.newContext({ ignoreHTTPSErrors: true })
      const res = await ctx.get(`${BASE}${path}?limit=1`)
      // 401: no credentials. Not 200 — that was the old behaviour and is
      // the regression this guards. Not 404 either: the route must still
      // exist for the review screen.
      expect([401, 403], `${path} answered ${res.status()}`)
        .toContain(res.status())
    })

    test(`CON-03 ${path} rejects a junk token`, async () => {
      const ctx = await request.newContext({ ignoreHTTPSErrors: true })
      const res = await ctx.get(`${BASE}${path}?limit=1`, {
        headers: { Authorization: 'Bearer not-a-real-token' },
      })
      expect([401, 403], `${path} answered ${res.status()}`)
        .toContain(res.status())
    })
  }
})
