/**
 * GET that honours nginx's rate limit.
 *
 * fontem-web's /api/ location allows 30 r/s with a burst of 100 per client,
 * and the whole suite runs as one client, so a request that lands at the
 * tail of a busy stretch can come back 429. A 429 says "slow down", not
 * anything about the route: wait as told and ask again, and hand back the
 * response once it is not a 429 or after the fifth attempt, so a limit
 * that never lifts still fails the test that made the request.
 */
export async function getHonouringRateLimit(ctx, url, options) {
  for (let attempt = 1; ; attempt++) {
    const res = await ctx.get(url, options)
    if (res.status() !== 429 || attempt === 5) return res
    const retryAfter = Number(res.headers()['retry-after'])
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(retryAfter * 1000, 5000)
      : Math.min(500 * 2 ** attempt, 5000)
    await new Promise((r) => { setTimeout(r, waitMs) })
  }
}
