// Integration coverage for the gh-call resilience layer (GhPluginBase.readEntry
// + the shared rate-limit breaker), exercised through plugin runTicks, plus a
// direct state-machine block for readEntry's failure-threshold/throttle logic
// (runTick reads Date.now(), so only the direct block can drive the time
// windows).
//
// Block 1 (repo-feed plugins: new-prs/new-issues) — the readEntry outcomes:
// success, the warn-after-threshold note, the degraded-entry read throttle,
// rate-limit→breaker, 422 isolating per-entry (no longer a whole-tick crash),
// non-GhError→throw.
//
// Block 2 (per-N plugins: prs/issues) — the batched-read paths block 1 can't
// reach: a per-alias miss (one dead PR) isolating while its sibling resolves and
// the breaker does NOT escalate on a per-entry 404, carrying the missed entry's
// prev snapshot (and its dynamic channels) forward, a whole-batch rate-limit
// tripping the breaker (primary window + the shorter secondary floor), a
// whole-batch transient staying quiet, the cross/multi-repo recovery command,
// and the empty-watch early-return.
//
// Block 3 — readEntry directly, with an injected clock: warn threshold, read
// throttle, clean-probe recovery, the 401 reason path, rate-limit passthrough,
// and the non-GhError rethrow boundary.
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { GitHubNewPrsPlugin, type NewPrsPluginState } from '../new-prs-plugin.js'
import { GitHubNewIssuesPlugin, type NewIssuesPluginState } from '../new-issues-plugin.js'
import { GitHubPrsPlugin } from '../prs-plugin.js'
import { GitHubIssuesPlugin } from '../issues-plugin.js'
import { GhClient, GhError, type GhRepoPr, type BatchOutcome, type GhPrNode, type GhIssueNode } from '../github-api.js'
import { GhPluginBase, type ReadEntryResult } from '../base.js'
import { RateLimitBreaker, READ_FAILURE_THRESHOLD } from '../backoff.js'
import { WARN_COOLDOWN_MS } from '../../_rate-limit.js'
import type { OrchestratorConfig } from '../../../config.js'
import type { PluginTickResult } from '../../../plugin.js'
import type { OrchestratorEvent } from '../diff.js'
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

// Drive `n` runTicks on one plugin instance, threading state forward, and return
// every tick's result. The threshold/cooldown gating lives on the instance, so
// the same instance must see all the ticks.
async function runTicks(
  plugin: { runTick(c: OrchestratorConfig, s: unknown): Promise<PluginTickResult> },
  config: OrchestratorConfig,
  seed: unknown,
  n: number,
): Promise<PluginTickResult[]> {
  const results: PluginTickResult[] = []
  let state = seed
  for (let i = 0; i < n; i++) {
    const r = await plugin.runTick(config, state)
    results.push(r)
    state = r.state
  }
  return results
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

  it('a transient flap stays silent below the threshold, then warns on the Nth consecutive failure', async () => {
    const spy = spyOn(GhClient.prototype, 'fetchRepoOpenPrs').mockRejectedValue(ghErr('gh: Not Found (HTTP 404)'))
    try {
      const plugin = new GitHubNewPrsPlugin('#proj-leads')
      const results = await runTicks(plugin, prsConfig(), { repos: { 'org/repo': [1, 2] } }, READ_FAILURE_THRESHOLD)
      // Every tick before the last is silent — a one-off flap never pings IRC.
      for (const r of results.slice(0, -1)) expect(r.taggedEvents).toHaveLength(0)
      // The Nth consecutive failure warns, with the failure reason + recovery cmd.
      const warned = results[results.length - 1]!
      expect(warned.taggedEvents).toHaveLength(1)
      const text = oneline(warned.taggedEvents[0]!)
      expect(text).toContain('github-new-prs: org/repo read failing: deleted/renamed (HTTP 404)')
      expect(text).toContain('recover: unwatch new-prs org/repo')
      // Prev state carried forward untouched across every skipped tick.
      expect((warned.state as NewPrsPluginState).repos['org/repo']).toEqual([1, 2])
    } finally { spy.mockRestore() }
  })

  it('once degraded it throttles reads — stops re-reading every tick, suppresses repeat warns', async () => {
    const spy = spyOn(GhClient.prototype, 'fetchRepoOpenPrs').mockRejectedValue(ghErr('gh: Not Found (HTTP 404)'))
    try {
      const plugin = new GitHubNewPrsPlugin('#proj-leads')  // same instance → shared failure state
      const warmup = await runTicks(plugin, prsConfig(), { repos: { 'org/repo': [1] } }, READ_FAILURE_THRESHOLD)
      expect(spy).toHaveBeenCalledTimes(READ_FAILURE_THRESHOLD)  // read every tick up to the threshold
      expect(warmup[warmup.length - 1]!.taggedEvents).toHaveLength(1)  // warned on the Nth
      // Next tick: degraded entry inside the cooldown → no re-read, no repeat warn.
      const throttled = await plugin.runTick(prsConfig(), warmup[warmup.length - 1]!.state)
      expect(spy).toHaveBeenCalledTimes(READ_FAILURE_THRESHOLD)  // did NOT re-read
      expect(throttled.taggedEvents).toHaveLength(0)
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

  it('422 isolates to its entry instead of crashing the tick — warns with the query-bug reason', async () => {
    const spy = spyOn(GhClient.prototype, 'fetchRepoOpenPrs').mockRejectedValue(ghErr('gh: HTTP 422: Validation Failed'))
    try {
      const plugin = new GitHubNewPrsPlugin('#proj-leads')
      // No throw — a 422 is now a per-entry condition, not a whole-tick crash.
      const results = await runTicks(plugin, prsConfig(), { repos: { 'org/repo': [1] } }, READ_FAILURE_THRESHOLD)
      const warned = results[results.length - 1]!
      expect(oneline(warned.taggedEvents[0]!)).toContain('read failing: validation failed (HTTP 422), likely a query bug')
    } finally { spy.mockRestore() }
  })

  it('non-GhError (upstream bug) is not swallowed — runTick rejects', async () => {
    const spy = spyOn(GhClient.prototype, 'fetchRepoOpenPrs').mockRejectedValue(new Error('bun.spawn died'))
    try {
      await expect(new GitHubNewPrsPlugin('#proj-leads').runTick(prsConfig(), { repos: { 'org/repo': [1] } }))
        .rejects.toThrow('bun.spawn died')
    } finally { spy.mockRestore() }
  })

  it('github-new-issues missing-repo: warns after the threshold with the verbatim unwatch recovery', async () => {
    const spy = spyOn(GhClient.prototype, 'fetchRepoOpenIssues').mockRejectedValue(ghErr('gh: Not Found (HTTP 404)'))
    try {
      const plugin = new GitHubNewIssuesPlugin('#proj-leads')
      const results = await runTicks(plugin, issuesConfig(), { repos: { 'org/repo': [1] } }, READ_FAILURE_THRESHOLD)
      const warned = results[results.length - 1]!
      const text = oneline(warned.taggedEvents[0]!)
      expect(text).toContain('github-new-issues: org/repo read failing: deleted/renamed (HTTP 404)')
      expect(text).toContain('recover: unwatch new-issues org/repo')
      expect((warned.state as NewIssuesPluginState).repos['org/repo']).toEqual([1])
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

// The per-N plugins read via one batched GraphQL call (GhClient.fetchPrsBatch/
// fetchIssuesBatch) returning a per-entry outcome Map, then map each ok node →
// snapshot through the snapshotPr/snapshotIssue seam. These helpers stub the
// batch (per-entry ok node vs alias miss) and the seam (controlled snap+events
// for the clean siblings), so the isolation tests drive one dead alias against a
// healthy sibling without standing up gh or the diff.
const PrSeam = GitHubPrsPlugin.prototype as unknown as {
  snapshotPr(repo: string, number: number, node: GhPrNode, prev: PrSnap | null | undefined, agents: Set<string>): { snap: PrSnap; events: OrchestratorEvent[] }
}
const IssueSeam = GitHubIssuesPlugin.prototype as unknown as {
  snapshotIssue(repo: string, number: number, node: GhIssueNode, prev: IssueSnap | null | undefined, agents: Set<string>): { snap: IssueSnap; events: OrchestratorEvent[] }
}
// A per-alias miss — what fetchPrsBatch returns for one dead entry (deleted PR /
// renamed repo). The reason mirrors describeGraphqlAliasError(NOT_FOUND).
function miss(reason = 'deleted/renamed (not found)'): { ok: false; reason: string; logDetail: string } {
  return { ok: false, reason, logDetail: reason }
}
function stubPrsBatch(fn: (n: number) => BatchOutcome<GhPrNode>): { mockRestore(): void } {
  return spyOn(GhClient.prototype, 'fetchPrsBatch').mockImplementation(async (entries) => {
    const m = new Map<string, BatchOutcome<GhPrNode>>()
    for (const e of entries) m.set(`${e.repo}#${e.number}`, fn(e.number))
    return m
  })
}
function stubIssuesBatch(fn: (n: number) => BatchOutcome<GhIssueNode>): { mockRestore(): void } {
  return spyOn(GhClient.prototype, 'fetchIssuesBatch').mockImplementation(async (entries) => {
    const m = new Map<string, BatchOutcome<GhIssueNode>>()
    for (const e of entries) m.set(`${e.repo}#${e.number}`, fn(e.number))
    return m
  })
}

describe('gh-call resilience — per-N skip path (issues/prs)', () => {
  stubRateLimit()
  beforeEach(() => { GhPluginBase.resetBreakerForTest() })
  afterEach(() => { GhPluginBase.resetBreakerForTest() })

  it('per-alias miss carries the flapped PR forward and re-adds its dynamic channels', async () => {
    const prevPr1 = prSnap({ number: 1, url: 'https://github.com/org/repo/pull/1', linked_issues: [{ repo: 'org/repo', number: 42 }] })
    const prevPr2 = prSnap({ number: 2, url: 'https://github.com/org/repo/pull/2' })
    const batch = stubPrsBatch(n => n === 1 ? miss() : { ok: true, node: {} as GhPrNode })
    const seam = spyOn(PrSeam, 'snapshotPr').mockReturnValue({ snap: prSnap({ number: 2, url: 'https://github.com/org/repo/pull/2' }), events: [] })
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
      const results = await runTicks(plugin, config, prev, READ_FAILURE_THRESHOLD)
      const result = results[results.length - 1]!

      // The dead entry warns once past the threshold; the healthy sibling is untouched.
      expect(result.taggedEvents).toHaveLength(1)
      const text = oneline(result.taggedEvents[0]!)
      expect(text).toContain('github-prs: org/repo#1 read failing: deleted/renamed (not found)')
      expect(text).toContain('recover: unwatch pr 1')  // single-repo → bare number, no repo suffix

      // prevPr1 carried forward verbatim on every tick — a miss doesn't drop the snapshot.
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
    } finally { seam.mockRestore(); batch.mockRestore() }
  })

  it('a per-alias miss isolates to its entry: the sibling is processed, the tick never throws, and the breaker does NOT escalate (Q2)', async () => {
    // One dead alias (deleted PR) must not sink its siblings and must not trip
    // the shared rate-limit breaker — a per-entry 404 is not a rate-limit.
    const batch = stubPrsBatch(n => n === 1 ? miss() : { ok: true, node: {} as GhPrNode })
    const seam = spyOn(PrSeam, 'snapshotPr').mockReturnValue({ snap: prSnap({ number: 2, title: 'P2-fresh' }), events: [] })
    const tripSpy = spyOn(RateLimitBreaker.prototype, 'trip')
    try {
      const config: OrchestratorConfig = {
        project: 'proj', repo: 'org/repo',
        plugins: { 'github-prs': { watched: [{ number: 1 }, { number: 2 }] } },
      }
      const prevPr1 = prSnap({ number: 1 })
      const prev: PrPluginState = { prs: { 'org/repo#1': prevPr1, 'org/repo#2': prSnap({ number: 2, title: 'P2-stale' }) } }
      const result = await new GitHubPrsPlugin('#proj-leads').runTick(config, prev)
      // First miss tick is silent (below threshold) but did NOT throw.
      expect(result.taggedEvents).toHaveLength(0)
      const state = result.state as PrPluginState
      expect(state.prs['org/repo#1']).toEqual(prevPr1)            // dead entry carried forward
      expect(state.prs['org/repo#2']!.title).toBe('P2-fresh')     // sibling freshly processed
      expect(tripSpy).not.toHaveBeenCalled()                      // per-entry 404 never trips the breaker
    } finally { tripSpy.mockRestore(); seam.mockRestore(); batch.mockRestore() }
  })

  it('issues per-alias miss: carries the flapped issue forward, warns after the threshold', async () => {
    const prevIssue1 = issueSnap({ number: 1 })
    const batch = stubIssuesBatch(n => n === 1 ? miss() : { ok: true, node: {} as GhIssueNode })
    const seam = spyOn(IssueSeam, 'snapshotIssue').mockReturnValue({ snap: issueSnap({ number: 2 }), events: [] })
    try {
      const config: OrchestratorConfig = {
        project: 'proj', repo: 'org/repo',
        plugins: { 'github-issues': { watched: [{ number: 1 }, { number: 2 }] } },
      }
      const prev: IssuePluginState = { issues: { 'org/repo#1': prevIssue1, 'org/repo#2': issueSnap({ number: 2 }) } }
      const results = await runTicks(new GitHubIssuesPlugin('#proj-leads'), config, prev, READ_FAILURE_THRESHOLD)
      const result = results[results.length - 1]!

      expect(result.taggedEvents).toHaveLength(1)
      const text = oneline(result.taggedEvents[0]!)
      expect(text).toContain('github-issues: org/repo#1 read failing: deleted/renamed (not found)')
      expect(text).toContain('recover: unwatch 1')
      expect((result.state as IssuePluginState).issues['org/repo#1']).toEqual(prevIssue1)
    } finally { seam.mockRestore(); batch.mockRestore() }
  })

  it('cross/multi-repo skip note qualifies the recovery command with the repo', async () => {
    // Multi-repo (no config.repo): bare `unwatch pr <N>` / `unwatch <N>` would hit
    // bareError, so the note must carry the repo (mirrors formatEntryLabel).
    const prsBatch = stubPrsBatch(() => miss())
    try {
      const config: OrchestratorConfig = {
        project: 'proj', plugins: { 'github-prs': { watched: [{ number: 5, repo: 'org/other' }] } },
      }
      const results = await runTicks(new GitHubPrsPlugin('#proj-leads'), config, { prs: {} }, READ_FAILURE_THRESHOLD)
      expect(oneline(results[results.length - 1]!.taggedEvents[0]!)).toContain('recover: unwatch pr 5 org/other')
    } finally { prsBatch.mockRestore() }

    GhPluginBase.resetBreakerForTest()
    const issuesBatch = stubIssuesBatch(() => miss())
    try {
      const config: OrchestratorConfig = {
        project: 'proj', plugins: { 'github-issues': { watched: [{ number: 8, repo: 'org/other' }] } },
      }
      const results = await runTicks(new GitHubIssuesPlugin('#proj-leads'), config, { issues: {} }, READ_FAILURE_THRESHOLD)
      expect(oneline(results[results.length - 1]!.taggedEvents[0]!)).toContain('recover: unwatch 8 org/other')
    } finally { issuesBatch.mockRestore() }
  })

  it('a whole-batch rate-limit trips the breaker and emits the backoff notice (per-N path)', async () => {
    const batch = spyOn(GhClient.prototype, 'fetchPrsBatch').mockRejectedValue(ghErr('gh: HTTP 429: Too Many Requests'))
    try {
      const config: OrchestratorConfig = { project: 'proj', repo: 'org/repo', plugins: { 'github-prs': { watched: [{ number: 1 }] } } }
      const prev: PrPluginState = { prs: { 'org/repo#1': prSnap({ number: 1 }) } }
      const result = await new GitHubPrsPlugin('#proj-leads').runTick(config, prev)
      expect(oneline(result.taggedEvents[0]!)).toBe('[dispatcher] GH rate-limited, backing off 5m')
      expect((result.state as PrPluginState).prs['org/repo#1']).toBeDefined()  // prev preserved
    } finally { batch.mockRestore() }
  })

  it('a whole-batch secondary rate-limit gets the shorter secondary floor (#616)', async () => {
    const batch = spyOn(GhClient.prototype, 'fetchPrsBatch').mockRejectedValue(ghErr('gh: HTTP 403: You have exceeded a secondary rate limit'))
    try {
      const config: OrchestratorConfig = { project: 'proj', repo: 'org/repo', plugins: { 'github-prs': { watched: [{ number: 1 }] } } }
      const result = await new GitHubPrsPlugin('#proj-leads').runTick(config, { prs: {} })
      expect(oneline(result.taggedEvents[0]!)).toBe('[dispatcher] GH secondary rate-limited, backing off 1m')
    } finally { batch.mockRestore() }
  })

  it('a whole-batch transient failure preserves prev and stays quiet — no per-entry warn, no breaker trip', async () => {
    const batch = spyOn(GhClient.prototype, 'fetchPrsBatch').mockRejectedValue(ghErr('gh: HTTP 500: Internal Server Error'))
    const tripSpy = spyOn(RateLimitBreaker.prototype, 'trip')
    try {
      const config: OrchestratorConfig = { project: 'proj', repo: 'org/repo', plugins: { 'github-prs': { watched: [{ number: 1 }, { number: 2 }] } } }
      const prev: PrPluginState = { prs: { 'org/repo#1': prSnap({ number: 1 }), 'org/repo#2': prSnap({ number: 2 }) } }
      // A whole-batch error is not a per-entry condition, so it never spikes the
      // per-entry failure counters — silent across every tick, prev intact.
      const results = await runTicks(new GitHubPrsPlugin('#proj-leads'), config, prev, READ_FAILURE_THRESHOLD + 1)
      for (const r of results) expect(r.taggedEvents).toHaveLength(0)
      expect((results[results.length - 1]!.state as PrPluginState).prs['org/repo#1']).toBeDefined()
      expect(tripSpy).not.toHaveBeenCalled()  // a 500 is transient, not rate-limit
    } finally { tripSpy.mockRestore(); batch.mockRestore() }
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
      const okBatch = stubPrsBatch(() => ({ ok: true, node: {} as GhPrNode }))
      const okSeam = spyOn(PrSeam, 'snapshotPr').mockReturnValue({ snap: prSnap({ number: 1 }), events: [] })
      try {
        const cfg: OrchestratorConfig = { project: 'proj', repo: 'org/repo', plugins: { 'github-prs': { watched: [{ number: 1 }] } } }
        await new GitHubPrsPlugin('#proj-leads').runTick(cfg, { prs: { 'org/repo#1': prSnap({ number: 1 }) } })
        expect(resetSpy).toHaveBeenCalled()
      } finally { okSeam.mockRestore(); okBatch.mockRestore() }
    } finally { resetSpy.mockRestore() }
  })
})

// readEntry exposes a protected state machine that runTick can't drive across
// time (runTick stamps its own Date.now()). A minimal concrete plugin surfaces
// it so these can inject the clock and pin the threshold/throttle/recovery edges.
class ReadEntryProbe extends GhPluginBase {
  readonly name = 'probe'
  desiredChannels(): string[] { return [] }
  async runTick(): Promise<PluginTickResult> { return { state: null, taggedEvents: [], channels: [] } }
  call<T>(key: string, body: () => Promise<T>, now: number): Promise<ReadEntryResult<T>> {
    return this.readEntry(key, ['#probe'], 'unwatch probe', body, now)
  }
}

describe('readEntry failure-threshold state machine (direct, injected clock)', () => {
  const T0 = 1_700_000_000_000

  function probe(): ReadEntryProbe { return new ReadEntryProbe('#probe', () => {}) }
  function failBody(stderr: string): () => Promise<never> {
    return async () => { throw new GhError(`gh failed\n${stderr}`, stderr, 3) }
  }
  function isSilentSkip(r: ReadEntryResult<unknown>): boolean {
    return !r.ok && !r.rateLimited && r.events.length === 0
  }
  function noteText(r: ReadEntryResult<unknown>): string {
    if (r.ok || r.rateLimited) throw new Error('expected a per-entry note result')
    expect(r.events).toHaveLength(1)
    return (r.events[0]!.payload as { kind: 'oneline'; text: string }).text
  }

  it('stays silent below the threshold, then warns on the Nth consecutive failure', async () => {
    const p = probe()
    const body = failBody('gh: Not Found (HTTP 404)')
    for (let i = 1; i < READ_FAILURE_THRESHOLD; i++) {
      expect(isSilentSkip(await p.call('k', body, T0 + i))).toBe(true)
    }
    const text = noteText(await p.call('k', body, T0 + READ_FAILURE_THRESHOLD))
    expect(text).toContain('read failing: deleted/renamed (HTTP 404)')
    expect(text).toContain('recover: unwatch probe')
  })

  it('throttles a degraded entry: skips body() within the cooldown, probes after it', async () => {
    const p = probe()
    let calls = 0
    const body = async (): Promise<never> => { calls++; throw new GhError('gh failed\nHTTP 404', 'HTTP 404', 3) }
    for (let i = 1; i <= READ_FAILURE_THRESHOLD; i++) await p.call('k', body, T0 + i)
    expect(calls).toBe(READ_FAILURE_THRESHOLD)  // read every tick up to the threshold
    // Inside the cooldown → throttled: body untouched, silent.
    const throttled = await p.call('k', body, T0 + READ_FAILURE_THRESHOLD + 1)
    expect(calls).toBe(READ_FAILURE_THRESHOLD)
    expect(isSilentSkip(throttled)).toBe(true)
    // Past the cooldown → a single probe runs and re-warns.
    const probed = await p.call('k', body, T0 + READ_FAILURE_THRESHOLD + WARN_COOLDOWN_MS + 1)
    expect(calls).toBe(READ_FAILURE_THRESHOLD + 1)
    expect(noteText(probed)).toContain('read failing')
  })

  it('a clean probe clears the failure state — the count restarts from the next failure', async () => {
    const p = probe()
    const fail = failBody('gh: Not Found (HTTP 404)')
    for (let i = 1; i <= READ_FAILURE_THRESHOLD; i++) await p.call('k', fail, T0 + i)  // degraded + warned
    // Past the cooldown the probe succeeds → state cleared, entry recovers.
    const ok = await p.call('k', async () => 'value', T0 + WARN_COOLDOWN_MS + 10)
    expect(ok).toEqual({ ok: true, value: 'value' })
    // A fresh failure is consecutive #1 again → silent until the threshold.
    expect(isSilentSkip(await p.call('k', fail, T0 + WARN_COOLDOWN_MS + 11))).toBe(true)
  })

  it('surfaces the 401 reason once past the threshold (the #602 path)', async () => {
    const p = probe()
    const body = failBody('gh: Bad credentials (HTTP 401)')
    for (let i = 1; i < READ_FAILURE_THRESHOLD; i++) expect(isSilentSkip(await p.call('k', body, T0 + i))).toBe(true)
    expect(noteText(await p.call('k', body, T0 + READ_FAILURE_THRESHOLD)))
      .toContain('auth rejected (HTTP 401), rotate token if it persists')
  })

  it('rate-limit returns the breaker signal and does not advance the failure count', async () => {
    const p = probe()
    expect(await p.call('k', failBody('gh: HTTP 429: Too Many Requests'), T0)).toEqual({ ok: false, rateLimited: true, kind: 'primary' })
    // The 429 didn't count — a following transient failure is consecutive #1, silent.
    expect(isSilentSkip(await p.call('k', failBody('gh: HTTP 503'), T0 + 1))).toBe(true)
  })

  it('classifies a secondary rate-limit as kind=secondary (feeds the shorter backoff floor)', async () => {
    const p = probe()
    expect(await p.call('k', failBody('gh: HTTP 403: You have exceeded a secondary rate limit'), T0))
      .toEqual({ ok: false, rateLimited: true, kind: 'secondary' })
  })

  it('a non-GhError (real infra/code bug) is rethrown — it must crash the tick', async () => {
    const p = probe()
    await expect(p.call('k', async () => { throw new Error('bun.spawn died') }, T0)).rejects.toThrow('bun.spawn died')
  })
})
