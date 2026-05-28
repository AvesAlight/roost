// Integration coverage for the gh-call resilience layer (GhPluginBase.readEntry
// + the shared rate-limit breaker), exercised through plugin runTicks.
//
// Block 1 (repo-feed plugins: new-prs/new-issues) — the four readEntry outcomes:
// success, transient/404 skip+note, rate-limit→breaker, 422/non-GhError→throw,
// plus the missing-repo cooldown and breaker quiet path.
//
// Block 2 (per-N plugins: prs/issues) — the multi-entry skip path that block 1
// can't reach: carrying a flapped entry's prev snapshot (and its dynamic
// channels) forward, the cross/multi-repo recovery command, and the empty-watch
// early-return that keeps an idle plugin from resetting a sibling's escalation.
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { GitHubNewPrsPlugin, type NewPrsPluginState } from '../new-prs-plugin.js'
import { GitHubNewIssuesPlugin, type NewIssuesPluginState } from '../new-issues-plugin.js'
import { GitHubPrsPlugin } from '../prs-plugin.js'
import { GitHubIssuesPlugin } from '../issues-plugin.js'
import { GhClient, GhError, type GhRepoPr } from '../github-api.js'
import { GhScraper } from '../scraper.js'
import { GhPluginBase } from '../base.js'
import { RateLimitBreaker } from '../backoff.js'
import type { OrchestratorConfig } from '../../../config.js'
import type { PrSnap, IssueSnap, PrPluginState, IssuePluginState } from '../types.js'
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

function prSnap(overrides: Partial<PrSnap> = {}): PrSnap {
  return {
    repo: 'org/repo', number: 1, title: 'P', url: 'https://github.com/org/repo/pull/1',
    head_ref: 'feat/x', head_oid: 'abc', is_draft: false, merged: false,
    state: 'OPEN', labels: [], ci_state: null, linked_issues: [],
    seen_review_comment_ids: [], seen_conversation_comment_ids: [], seen_review_ids: [],
    ...overrides,
  }
}
function issueSnap(overrides: Partial<IssueSnap> = {}): IssueSnap {
  return {
    repo: 'org/repo', number: 1, title: 'I', url: 'https://github.com/org/repo/issues/1',
    state: 'open', labels: [], seen_comment_ids: [], ...overrides,
  }
}

// Minimal Linear attachment query stub (mirrors plugin.test.ts) — maps a Linear
// identifier to the PR URLs it's attached to, so the resolver cross-links a
// watched PR to its Linear channel.
type Attachment = { id: string; sourceType: string | null; url: string | null }
type IssueNode = { identifier: string; attachments: { nodes: Attachment[] } | null }
type QueryFn = (teamKey: string, numbers: number[]) => Promise<{ nodes: IssueNode[]; hasNextPage: boolean }>
function linearStub(byId: Record<string, string[]>): QueryFn {
  return async (team, numbers) => {
    const nodes: IssueNode[] = []
    for (const n of numbers) {
      const id = `${team}-${n}`
      const urls = byId[id]
      if (urls) nodes.push({ identifier: id, attachments: { nodes: urls.map(u => ({ id: `att-${u}`, sourceType: 'github', url: u })) } })
    }
    return { nodes, hasNextPage: false }
  }
}

describe('gh-call resilience — per-N skip path (issues/prs)', () => {
  stubRateLimit()
  beforeEach(() => { GhPluginBase.resetBreakerForTest() })
  afterEach(() => { GhPluginBase.resetBreakerForTest() })

  it('prs transient skip: carries the flapped PR forward and re-adds its dynamic channels', async () => {
    const prevPr1 = prSnap({ number: 1, url: 'https://github.com/org/repo/pull/1', linked_issues: [{ repo: 'org/repo', number: 42 }] })
    const prevPr2 = prSnap({ number: 2, url: 'https://github.com/org/repo/pull/2' })
    const spy = spyOn(GhScraper.prototype, 'scrapePr').mockImplementation(async (_repo: string, number: number) => {
      if (number === 1) throw ghErr('gh: HTTP 404: Not Found')
      return { snap: prSnap({ number: 2, url: 'https://github.com/org/repo/pull/2' }), events: [] }
    })
    try {
      const config: OrchestratorConfig = {
        project: 'proj', repo: 'org/repo',
        plugins: {
          'github-prs': { watched: [{ number: 1 }, { number: 2 }] },
          'linear-issues': { watched: [{ identifier: 'TEAM-7' }] },
        },
      }
      const plugin = new GitHubPrsPlugin('#proj-leads')
      plugin._setLinearQueryForTest(linearStub({ 'TEAM-7': ['https://github.com/org/repo/pull/1'] }))
      const prev: PrPluginState = { prs: { 'org/repo#1': prevPr1, 'org/repo#2': prevPr2 } }
      const result = await plugin.runTick(config, prev)

      // The flapped entry skips with a hedged note; the healthy sibling is untouched.
      expect(result.taggedEvents).toHaveLength(1)
      const text = oneline(result.taggedEvents[0]!)
      expect(text).toContain('github-prs: org/repo#1 read failing (deleted/renamed or GH flaking)')
      expect(text).toContain('unwatch pr 1')  // single-repo → bare number, no repo suffix

      // prevPr1 carried forward verbatim — a flap doesn't drop the snapshot.
      const state = result.state as PrPluginState
      expect(state.prs['org/repo#1']).toEqual(prevPr1)
      expect(state.prs['org/repo#2']).toBeDefined()
      // Linked-issue channel re-added — desiredChannels does NOT carry #42 (it's a
      // dynamic closure target, not a watched entry), so this pins the re-add.
      expect(result.channels).toContain('#proj-issue-42')
      // Linear cross-link channel is also present (the carry-forward re-add runs;
      // desiredChannels seeds watched Linear channels too, so this asserts
      // membership rather than isolating the re-add).
      expect(result.channels).toContain('#proj-issue-team-7')
    } finally { spy.mockRestore() }
  })

  it('issues transient skip: carries the flapped issue forward, emits the hedged note', async () => {
    const prevIssue1 = issueSnap({ number: 1 })
    const spy = spyOn(GhScraper.prototype, 'scrapeIssue').mockImplementation(async (_repo: string, number: number) => {
      if (number === 1) throw ghErr('gh: HTTP 404: Not Found')
      return { snap: issueSnap({ number: 2 }), events: [] }
    })
    try {
      const config: OrchestratorConfig = {
        project: 'proj', repo: 'org/repo',
        plugins: { 'github-issues': { watched: [{ number: 1 }, { number: 2 }] } },
      }
      const prev: IssuePluginState = { issues: { 'org/repo#1': prevIssue1, 'org/repo#2': issueSnap({ number: 2 }) } }
      const result = await new GitHubIssuesPlugin('#proj-leads').runTick(config, prev)

      expect(result.taggedEvents).toHaveLength(1)
      const text = oneline(result.taggedEvents[0]!)
      expect(text).toContain('github-issues: org/repo#1 read failing (deleted/renamed or GH flaking)')
      expect(text).toContain('unwatch 1')
      expect((result.state as IssuePluginState).issues['org/repo#1']).toEqual(prevIssue1)
    } finally { spy.mockRestore() }
  })

  it('cross/multi-repo skip note qualifies the recovery command with the repo', async () => {
    // Multi-repo (no config.repo): bare `unwatch pr <N>` / `unwatch <N>` would hit
    // bareError, so the note must carry the repo (mirrors formatEntryLabel).
    const prsSpy = spyOn(GhScraper.prototype, 'scrapePr').mockRejectedValue(ghErr('gh: HTTP 404: Not Found'))
    try {
      const config: OrchestratorConfig = {
        project: 'proj', plugins: { 'github-prs': { watched: [{ number: 5, repo: 'org/other' }] } },
      }
      const result = await new GitHubPrsPlugin('#proj-leads').runTick(config, { prs: {} })
      expect(oneline(result.taggedEvents[0]!)).toContain('unwatch pr 5 org/other')
    } finally { prsSpy.mockRestore() }

    GhPluginBase.resetBreakerForTest()
    const issuesSpy = spyOn(GhScraper.prototype, 'scrapeIssue').mockRejectedValue(ghErr('gh: HTTP 404: Not Found'))
    try {
      const config: OrchestratorConfig = {
        project: 'proj', plugins: { 'github-issues': { watched: [{ number: 8, repo: 'org/other' }] } },
      }
      const result = await new GitHubIssuesPlugin('#proj-leads').runTick(config, { issues: {} })
      expect(oneline(result.taggedEvents[0]!)).toContain('unwatch 8 org/other')
    } finally { issuesSpy.mockRestore() }
  })

  it('empty watch list returns before the breaker block — an idle plugin never resets the breaker', async () => {
    const resetSpy = spyOn(RateLimitBreaker.prototype, 'reset')
    try {
      const emptyPrs: OrchestratorConfig = { project: 'proj', repo: 'org/repo', plugins: { 'github-prs': { watched: [] } } }
      const prsResult = await new GitHubPrsPlugin('#proj-leads').runTick(emptyPrs, { prs: {} })
      expect(prsResult.taggedEvents).toHaveLength(0)
      expect(prsResult.channels).toEqual([])

      const emptyIssues: OrchestratorConfig = { project: 'proj', repo: 'org/repo', plugins: { 'github-issues': { watched: [] } } }
      const issuesResult = await new GitHubIssuesPlugin('#proj-leads').runTick(emptyIssues, { issues: {} })
      expect(issuesResult.taggedEvents).toHaveLength(0)
      expect(issuesResult.channels).toEqual([])

      // Neither idle plugin touched the breaker — at half-open this is what keeps
      // an empty sibling from clearing an in-flight escalation back to 5m.
      expect(resetSpy).not.toHaveBeenCalled()

      // Positive control: a non-empty clean tick *does* reset, proving the spy
      // works and that the empty-watch early-return is what suppresses it.
      const okSpy = spyOn(GhScraper.prototype, 'scrapePr').mockResolvedValue({ snap: prSnap({ number: 1 }), events: [] })
      try {
        const cfg: OrchestratorConfig = { project: 'proj', repo: 'org/repo', plugins: { 'github-prs': { watched: [{ number: 1 }] } } }
        await new GitHubPrsPlugin('#proj-leads').runTick(cfg, { prs: { 'org/repo#1': prSnap({ number: 1 }) } })
        expect(resetSpy).toHaveBeenCalled()
      } finally { okSpy.mockRestore() }
    } finally { resetSpy.mockRestore() }
  })
})
