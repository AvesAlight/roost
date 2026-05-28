// Integration coverage for the gh-call resilience layer (GhPluginBase.readEntry
// + the shared rate-limit breaker), exercised through plugin runTicks. The four
// readEntry outcomes — success, transient/404 skip+note, rate-limit→breaker,
// 422/non-GhError→throw — plus the missing-repo cooldown and breaker quiet path.
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { GitHubNewPrsPlugin, type NewPrsPluginState } from '../new-prs-plugin.js'
import { GitHubNewIssuesPlugin, type NewIssuesPluginState } from '../new-issues-plugin.js'
import { GhClient, GhError, type GhRepoPr } from '../github-api.js'
import { GhPluginBase } from '../base.js'
import type { OrchestratorConfig } from '../../../config.js'
import { stubRateLimit } from './gh-test-helpers.js'

function prsConfig(): OrchestratorConfig {
  return { project: 'proj', repo: 'org/repo', plugins: { 'github-new-prs': { watched: [{ repo: 'org/repo' }] } } }
}
function issuesConfig(): OrchestratorConfig {
  return { project: 'proj', repo: 'org/repo', plugins: { 'github-new-issues': { watched: [{ repo: 'org/repo' }] } } }
}
function pr(n: number): GhRepoPr {
  return { number: n, title: `PR ${n}`, html_url: `https://github.com/org/repo/pull/${n}`, labels: [], user: { login: 'ext' } }
}
function oneline(e: { payload: unknown }): string {
  return (e.payload as { kind: 'oneline'; text: string }).text
}
function ghErr(stderr: string): GhError {
  return new GhError(`gh failed (exit 1)\n${stderr}`, stderr, 3)
}

describe('gh-call resilience (readEntry + breaker)', () => {
  stubRateLimit()
  beforeEach(() => { GhPluginBase.resetBreakerForTest() })
  afterEach(() => { GhPluginBase.resetBreakerForTest() })

  it('success path: a clean read emits events normally', async () => {
    const spy = spyOn(GhClient.prototype, 'fetchRepoOpenPrs').mockResolvedValue([pr(1), pr(2)])
    try {
      const result = await new GitHubNewPrsPlugin('#proj-leads').runTick(prsConfig(), { repos: { 'org/repo': [1] } })
      expect(result.taggedEvents).toHaveLength(1)
      expect(oneline(result.taggedEvents[0]!)).toContain('org/repo#2')
    } finally { spy.mockRestore() }
  })

  it('transient/404 past retries: skips the entry with a hedged cooldown note, preserves prev state', async () => {
    const spy = spyOn(GhClient.prototype, 'fetchRepoOpenPrs').mockRejectedValue(ghErr('gh: HTTP 404: Not Found'))
    try {
      const prev: NewPrsPluginState = { repos: { 'org/repo': [1, 2] } }
      const result = await new GitHubNewPrsPlugin('#proj-leads').runTick(prsConfig(), prev)
      expect(result.taggedEvents).toHaveLength(1)
      const text = oneline(result.taggedEvents[0]!)
      expect(text).toContain('github-new-prs: org/repo read failing (deleted/renamed or GH flaking)')
      expect(text).toContain('unwatch new-prs org/repo')
      // Prev state carried forward untouched — nothing lost, nothing replayed.
      expect((result.state as NewPrsPluginState).repos['org/repo']).toEqual([1, 2])
    } finally { spy.mockRestore() }
  })

  it('missing-repo note is cooldown-gated — recurs only once per window per repo', async () => {
    const spy = spyOn(GhClient.prototype, 'fetchRepoOpenPrs').mockRejectedValue(ghErr('gh: HTTP 404: Not Found'))
    try {
      const plugin = new GitHubNewPrsPlugin('#proj-leads')  // same instance → shared cooldown map
      const prev: NewPrsPluginState = { repos: { 'org/repo': [1] } }
      const first = await plugin.runTick(prsConfig(), prev)
      const second = await plugin.runTick(prsConfig(), first.state)
      expect(first.taggedEvents).toHaveLength(1)
      expect(second.taggedEvents).toHaveLength(0)  // suppressed within the window
    } finally { spy.mockRestore() }
  })

  it('rate-limit: trips the breaker, emits a backoff notice, preserves prev state', async () => {
    const spy = spyOn(GhClient.prototype, 'fetchRepoOpenPrs').mockRejectedValue(ghErr('gh: HTTP 429: Too Many Requests'))
    try {
      const prev: NewPrsPluginState = { repos: { 'org/repo': [1] } }
      const result = await new GitHubNewPrsPlugin('#proj-leads').runTick(prsConfig(), prev)
      expect(result.taggedEvents).toHaveLength(1)
      expect(oneline(result.taggedEvents[0]!)).toBe('[dispatcher] GH rate-limited, backing off 5m')
      expect((result.state as NewPrsPluginState).repos['org/repo']).toEqual([1])
    } finally { spy.mockRestore() }
  })

  it('rate-limit quiets the next tick: breaker open → no poll, no events', async () => {
    const spy = spyOn(GhClient.prototype, 'fetchRepoOpenPrs').mockRejectedValue(ghErr('gh: HTTP 429: Too Many Requests'))
    try {
      const plugin = new GitHubNewPrsPlugin('#proj-leads')
      await plugin.runTick(prsConfig(), { repos: { 'org/repo': [1] } })
      expect(spy).toHaveBeenCalledTimes(1)
      const second = await plugin.runTick(prsConfig(), { repos: { 'org/repo': [1] } })
      expect(spy).toHaveBeenCalledTimes(1)  // breaker open → did not poll again
      expect(second.taggedEvents).toHaveLength(0)  // silent
    } finally { spy.mockRestore() }
  })

  it('422 (real defect) is not swallowed — runTick rejects', async () => {
    const spy = spyOn(GhClient.prototype, 'fetchRepoOpenPrs').mockRejectedValue(ghErr('gh: HTTP 422: Validation Failed'))
    try {
      await expect(new GitHubNewPrsPlugin('#proj-leads').runTick(prsConfig(), { repos: { 'org/repo': [1] } }))
        .rejects.toThrow(GhError)
    } finally { spy.mockRestore() }
  })

  it('non-GhError (upstream bug) is not swallowed — runTick rejects', async () => {
    const spy = spyOn(GhClient.prototype, 'fetchRepoOpenPrs').mockRejectedValue(new Error('bun.spawn died'))
    try {
      await expect(new GitHubNewPrsPlugin('#proj-leads').runTick(prsConfig(), { repos: { 'org/repo': [1] } }))
        .rejects.toThrow('bun.spawn died')
    } finally { spy.mockRestore() }
  })

  it('github-new-issues missing-repo: hedged note with the verbatim unwatch recovery', async () => {
    const spy = spyOn(GhClient.prototype, 'fetchRepoOpenIssues').mockRejectedValue(ghErr('gh: HTTP 404: Not Found'))
    try {
      const prev: NewIssuesPluginState = { repos: { 'org/repo': [1] } }
      const result = await new GitHubNewIssuesPlugin('#proj-leads').runTick(issuesConfig(), prev)
      expect(result.taggedEvents).toHaveLength(1)
      const text = oneline(result.taggedEvents[0]!)
      expect(text).toContain('github-new-issues: org/repo read failing (deleted/renamed or GH flaking)')
      expect(text).toContain('unwatch new-issues org/repo')
      expect((result.state as NewIssuesPluginState).repos['org/repo']).toEqual([1])
    } finally { spy.mockRestore() }
  })
})
