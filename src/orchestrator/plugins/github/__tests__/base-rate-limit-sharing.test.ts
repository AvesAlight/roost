// Regression coverage for the cross-instance rate-limit history bug (C-1627
// fix 3): GhPluginBase._breaker/_statics/_gqlStatics are class-static because
// every GH plugin instance polls the same account-wide budget, but
// _rateLimitHistory/_graphqlRateLimitHistory were left as plain instance
// fields — so two different plugin instances (e.g. issues + prs) each built
// their own partial, understated view of consumption against one real shared
// budget. These tests exercise that sharing directly, distinct from
// plugin.test.ts's single-instance pruning/anchor-selection coverage.
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { GitHubIssuesPlugin } from '../issues-plugin.js'
import { GitHubPrsPlugin } from '../prs-plugin.js'
import { GhPluginBase } from '../base.js'
import type { RateLimitSnapshot } from '../github-api.js'

function snapshot(remaining: number, resetInMs = 60 * 60_000): RateLimitSnapshot {
  return {
    core: { remaining, limit: 5000, resetAt: Math.floor((Date.now() + resetInMs) / 1000) },
    graphql: null,
  }
}

describe('GhPluginBase rate-limit history — shared across instances', () => {
  beforeEach(() => {
    GhPluginBase.resetBreakerForTest()
    GhPluginBase.resetRateLimitHistoryForTest()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(GhPluginBase as any)._statics.warnedAt = null
  })
  afterEach(() => {
    GhPluginBase.resetBreakerForTest()
    GhPluginBase.resetRateLimitHistoryForTest()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(GhPluginBase as any)._statics.warnedAt = null
  })

  it('a second, distinct plugin instance sees the first instance\'s sample as its anchor', async () => {
    const issuesPlugin = new GitHubIssuesPlugin('#proj-leads')
    const prsPlugin = new GitHubPrsPlugin('#proj-leads')

    // Sanity: two different classes, both extending GhPluginBase.
    expect(issuesPlugin.constructor).not.toBe(prsPlugin.constructor)

    // Seed the shared history as though the *issues* instance sampled 5000
    // remaining 160s ago (past the half-window gate).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(GhPluginBase as any)._rateLimitHistory = [{ remaining: 5000, ts: Date.now() - 160_000 }]
    void issuesPlugin // seeded directly; instance only used for the sanity check above

    // A *different instance of a different class* observes next. If history
    // were per-instance (the bug), this call would see an empty history and
    // never warn regardless of the drop.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const events = await (prsPlugin as any).observeRateLimit('#proj-leads', async () => snapshot(100, 60 * 60_000))
    expect(events).toHaveLength(1)
    expect(events[0].text).toMatch(/rate limit warning/)
  })

  it('the shared history array accumulates samples from every instance, not one length-1 array per instance', async () => {
    const a = new GitHubIssuesPlugin('#proj-leads')
    const b = new GitHubPrsPlugin('#proj-leads')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (a as any).observeRateLimit('#proj-leads', async () => snapshot(5000))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (b as any).observeRateLimit('#proj-leads', async () => snapshot(4900))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (a as any).observeRateLimit('#proj-leads', async () => snapshot(4800))

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((GhPluginBase as any)._rateLimitHistory.length).toBe(3)
  })
})
