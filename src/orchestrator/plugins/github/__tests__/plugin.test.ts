import { describe, it, expect, spyOn } from 'bun:test'
import { GitHubPrsPlugin } from '../prs-plugin.js'
import { GitHubIssuesPlugin } from '../issues-plugin.js'
import { GitHubNewIssuesPlugin } from '../new-issues-plugin.js'
import { GitHubCommitsPlugin } from '../commits-plugin.js'
import { GhPluginBase } from '../base.js'
import { RATE_LIMIT_WINDOW_MS } from '../../_rate-limit.js'
import type { OrchestratorConfig } from '../../../config.js'
import type { Command } from '../../../dispatcher-dm-handler.js'
import type { PrSnap, IssueSnap } from '../types.js'
import { GhClient, type BatchOutcome, type GhPrNode, type GhIssueNode } from '../github-api.js'
import type { OrchestratorEvent } from '../diff.js'
import { stubRateLimit } from './gh-test-helpers.js'

// Test helpers — wrap the plugin-owned shapes in the dispatcher's
// `{kind:'plugin'}` envelope so test call sites stay readable.
// `raw` is a dispatcher-injected logging field; synthetic test commands use ''.
function watchCmd(plugin: string, number: number, repo: string | null, channels: string[]): Command {
  return { kind: 'plugin', plugin, cmd: { verb: 'watch', number, repo, channels }, raw: '' }
}
function unwatchCmd(plugin: string, number: number, repo: string | null): Command {
  return { kind: 'plugin', plugin, cmd: { verb: 'unwatch', number, repo, channels: [] }, raw: '' }
}
function watchRepoCmd(plugin: string, repo: string, branch: string | null, path: string | null, channels: string[]): Command {
  return { kind: 'plugin', plugin, cmd: { verb: 'watch', repo, branch, path, channels }, raw: '' }
}
function unwatchRepoCmd(plugin: string, repo: string, branch: string | null, path: string | null): Command {
  return { kind: 'plugin', plugin, cmd: { verb: 'unwatch', repo, branch, path, channels: [] }, raw: '' }
}

function fakePrSnap(overrides: Partial<PrSnap> = {}): PrSnap {
  return {
    repo: 'org/repo', number: 25, title: 'P', url: 'https://example.com/p/25',
    head_ref: 'feat/x', head_oid: 'abc', is_draft: false, merged: false,
    state: 'OPEN', labels: [], ci_state: null, linked_issues: [],
    seen_review_comment_ids: [], seen_conversation_comment_ids: [], seen_review_ids: [],
    ...overrides,
  }
}

function fakeIssueSnap(overrides: Partial<IssueSnap> = {}): IssueSnap {
  return {
    repo: 'org/repo', number: 50, title: 'I', url: 'https://example.com/i/50',
    state: 'open', labels: [], seen_comment_ids: [], ...overrides,
  }
}

// The plugins read via one batched GraphQL call, then map each ok node → snapshot
// through the snapshotPr/snapshotIssue seam. These routing tests inject a
// controlled (snap, events) pair at that seam and stub fetchPrsBatch/
// fetchIssuesBatch to return an ok node per watched entry, so every entry reaches
// the seam. The node→snapshot mapping itself has direct coverage in the
// scraper/graphql tests. stubPr/stubIssue return a handle whose mockRestore()
// tears down both spies — matching the single-spy shape the call sites use.
type PrResult = { snap: PrSnap; events: OrchestratorEvent[] }
type IssueResult = { snap: IssueSnap; events: OrchestratorEvent[] }
const PrSeam = GitHubPrsPlugin.prototype as unknown as {
  snapshotPr(repo: string, number: number, node: GhPrNode, prev: PrSnap | null | undefined, agents: Set<string>): PrResult
}
const IssueSeam = GitHubIssuesPlugin.prototype as unknown as {
  snapshotIssue(repo: string, number: number, node: GhIssueNode, prev: IssueSnap | null | undefined, agents: Set<string>): IssueResult
}
function okBatch<T>(entries: ReadonlyArray<{ repo: string; number: number }>, node: T): Map<string, BatchOutcome<T>> {
  const m = new Map<string, BatchOutcome<T>>()
  for (const e of entries) m.set(`${e.repo}#${e.number}`, { ok: true, node })
  return m
}
function stubPr(result: PrResult | ((repo: string, num: number) => PrResult)): { mockRestore(): void } {
  const batch = spyOn(GhClient.prototype, 'fetchPrsBatch').mockImplementation(async (entries) => okBatch(entries, {} as GhPrNode))
  const impl = typeof result === 'function' ? (repo: string, number: number) => result(repo, number) : () => result
  const snap = spyOn(PrSeam, 'snapshotPr').mockImplementation(impl)
  return { mockRestore() { snap.mockRestore(); batch.mockRestore() } }
}
function stubIssue(result: IssueResult | ((repo: string, num: number) => IssueResult)): { mockRestore(): void } {
  const batch = spyOn(GhClient.prototype, 'fetchIssuesBatch').mockImplementation(async (entries) => okBatch(entries, {} as GhIssueNode))
  const impl = typeof result === 'function' ? (repo: string, number: number) => result(repo, number) : () => result
  const snap = spyOn(IssueSeam, 'snapshotIssue').mockImplementation(impl)
  return { mockRestore() { snap.mockRestore(); batch.mockRestore() } }
}

describe('GitHubPrsPlugin.runTick', () => {
  stubRateLimit()

  it('routes a PR comment to linked-issue channels unioned with entry channels', async () => {
    const commentEv: OrchestratorEvent = {
      kind: 'pr_review_comment',
      repo: 'org/repo', pr: 25, url: 'https://example.com/p/25',
      author: 'alice', body: 'x', body_preview: 'x', is_worker_reply: false,
      comment_id: 1, comment_url: 'https://example.com/c/1',
      linked_issues: [{ repo: 'org/repo', number: 14 }],
    } as OrchestratorEvent

    const spy = stubPr({
      snap: fakePrSnap({ linked_issues: [{ repo: 'org/repo', number: 14 }] }),
      events: [commentEv],
    })
    try {
      const cfg: OrchestratorConfig = {
        project: 'proj',
        repo: 'org/repo',
        plugins: {
          'github-prs': { watched: [{ number: 25, channels: ['#extra'] }] },
          'github-issues': { watched: [] },
        },
      }
      const result = await new GitHubPrsPlugin('#proj').runTick(cfg, { prs: {} })
      expect(result.taggedEvents).toHaveLength(1)
      expect(result.taggedEvents[0]?.channels.sort()).toEqual(['#extra', '#proj-issue-14'])
      expect(result.taggedEvents[0]?.payload.kind).toBe('multiline')
      expect(result.channels).toContain('#proj-issue-14')
      expect(result.channels).toContain('#extra')
    } finally { spy.mockRestore() }
  })

  it('persists scraped PR state under its own slice', async () => {
    const spy = stubPr({
      snap: fakePrSnap({ linked_issues: [{ repo: 'org/repo', number: 7 }] }), events: [],
    })
    try {
      const cfg: OrchestratorConfig = {
        project: 'proj',
        repo: 'org/repo',
        plugins: {
          'github-prs': { watched: [{ number: 25 }] },
          'github-issues': { watched: [] },
        },
      }
      const result = await new GitHubPrsPlugin('#proj').runTick(cfg, null)
      const state = result.state as { prs: Record<string, PrSnap> }
      expect(state.prs['org/repo#25']?.linked_issues).toEqual([{ repo: 'org/repo', number: 7 }])
      expect(result.channels).toContain('#proj-issue-7')
    } finally { spy.mockRestore() }
  })

  it('routes pr_no_linked_issues to project channel', async () => {
    const warningEv: OrchestratorEvent = {
      kind: 'pr_no_linked_issues',
      repo: 'org/repo', pr: 25, url: 'https://example.com/p/25', title: 'P',
    } as OrchestratorEvent
    const spy = stubPr({
      snap: fakePrSnap({ linked_issues: [] }),
      events: [warningEv],
    })
    try {
      const cfg: OrchestratorConfig = {
        project: 'proj', repo: 'org/repo',
        plugins: { 'github-prs': { watched: [{ number: 25 }] } },
      }
      const result = await new GitHubPrsPlugin('#proj').runTick(cfg, { prs: {} })
      expect(result.taggedEvents).toHaveLength(1)
      expect(result.taggedEvents[0]?.channels).toContain('#proj-leads')
    } finally { spy.mockRestore() }
  })

  it('suppresses now-watching when pr_added_to_watch has no linked issues', async () => {
    const seedEv: OrchestratorEvent = {
      kind: 'pr_added_to_watch', repo: 'org/repo', pr: 25, url: 'u', title: 't',
    } as OrchestratorEvent
    const spy = stubPr({
      snap: fakePrSnap(), events: [seedEv],
    })
    try {
      const cfg: OrchestratorConfig = {
        project: 'proj', repo: 'org/repo',
        plugins: { 'github-prs': { watched: [{ number: 25 }] } },
      }
      const result = await new GitHubPrsPlugin('#proj').runTick(cfg, { prs: {} })
      expect(result.taggedEvents).toHaveLength(0)
    } finally { spy.mockRestore() }
  })

  it('emits now-watching to project channel when pr_added_to_watch has linked issues', async () => {
    const seedEv: OrchestratorEvent = {
      kind: 'pr_added_to_watch', repo: 'org/repo', pr: 25, url: 'u', title: 't',
      linked_issues: [{ repo: 'org/repo', number: 7 }, { repo: 'org/repo', number: 14 }],
    } as OrchestratorEvent
    const spy = stubPr({
      snap: fakePrSnap({ linked_issues: [{ repo: 'org/repo', number: 7 }, { repo: 'org/repo', number: 14 }] }), events: [seedEv],
    })
    try {
      const cfg: OrchestratorConfig = {
        project: 'proj', repo: 'org/repo',
        plugins: { 'github-prs': { watched: [{ number: 25 }] } },
      }
      const result = await new GitHubPrsPlugin('#proj').runTick(cfg, { prs: {} })
      expect(result.taggedEvents).toHaveLength(1)
      expect(result.taggedEvents[0]?.channels).toEqual(['#proj-leads'])
      expect(result.taggedEvents[0]?.payload).toEqual({
        kind: 'oneline',
        text: 'now watching PR org/repo#25 — routing events to #proj-issue-7, #proj-issue-14',
      })
    } finally { spy.mockRestore() }
  })

  it('includes entry channels in now-watching routing list', async () => {
    const seedEv: OrchestratorEvent = {
      kind: 'pr_added_to_watch', repo: 'org/repo', pr: 25, url: 'u', title: 't',
      linked_issues: [{ repo: 'org/repo', number: 7 }],
    } as OrchestratorEvent
    const spy = stubPr({
      snap: fakePrSnap({ linked_issues: [{ repo: 'org/repo', number: 7 }] }), events: [seedEv],
    })
    try {
      const cfg: OrchestratorConfig = {
        project: 'proj', repo: 'org/repo',
        plugins: { 'github-prs': { watched: [{ number: 25, channels: ['#extra'] }] } },
      }
      const result = await new GitHubPrsPlugin('#proj').runTick(cfg, { prs: {} })
      expect(result.taggedEvents).toHaveLength(1)
      expect(result.taggedEvents[0]?.channels).toEqual(['#proj-leads'])
      const text = (result.taggedEvents[0]?.payload as { kind: 'oneline'; text: string }).text
      expect(text).toContain('#proj-issue-7')
      expect(text).toContain('#extra')
    } finally { spy.mockRestore() }
  })
})

describe('GitHubPrsPlugin.runTick — routing when no linked issues', () => {
  stubRateLimit()

  it('routes PR event to defaultChannel when no linked issues and no entry channels (resolveChannels empty/empty fallback)', async () => {
    const ciEv: OrchestratorEvent = {
      kind: 'ci_transitioned',
      repo: 'org/repo', pr: 25, url: 'u',
      from: 'PENDING', to: 'SUCCESS', head_oid: 'abc', linked_issues: [],
    } as OrchestratorEvent
    const spy = stubPr({
      snap: fakePrSnap({ linked_issues: [] }), events: [ciEv],
    })
    try {
      const cfg: OrchestratorConfig = {
        project: 'proj', repo: 'org/repo',
        plugins: { 'github-prs': { watched: [{ number: 25 }] } },
      }
      const result = await new GitHubPrsPlugin('#proj-leads').runTick(cfg, { prs: {} })
      expect(result.taggedEvents).toHaveLength(1)
      expect(result.taggedEvents[0]?.channels).toEqual(['#proj-leads'])
    } finally { spy.mockRestore() }
  })

  it('routes PR review event to entry channels when no linked issues but entry channels specified', async () => {
    const reviewEv: OrchestratorEvent = {
      kind: 'pr_review_submitted',
      repo: 'org/repo', pr: 25, url: 'u',
      review_id: 1, review_url: 'ru', author: 'alice', state: 'APPROVED',
      body: '', body_preview: '', is_worker_reply: false, linked_issues: [],
    } as OrchestratorEvent
    const spy = stubPr({
      snap: fakePrSnap({ linked_issues: [] }), events: [reviewEv],
    })
    try {
      const cfg: OrchestratorConfig = {
        project: 'proj', repo: 'org/repo',
        plugins: { 'github-prs': { watched: [{ number: 25, channels: ['#proj-issue-576'] }] } },
      }
      const result = await new GitHubPrsPlugin('#proj-leads').runTick(cfg, { prs: {} })
      expect(result.taggedEvents).toHaveLength(1)
      expect(result.taggedEvents[0]?.channels).toEqual(['#proj-issue-576'])
    } finally { spy.mockRestore() }
  })

  it('routes PR CI event to entry channels when no linked issues but entry channels specified', async () => {
    const ciEv: OrchestratorEvent = {
      kind: 'ci_transitioned',
      repo: 'org/repo', pr: 25, url: 'u',
      from: 'PENDING', to: 'FAILURE', head_oid: 'abc', linked_issues: [],
    } as OrchestratorEvent
    const spy = stubPr({
      snap: fakePrSnap({ linked_issues: [] }), events: [ciEv],
    })
    try {
      const cfg: OrchestratorConfig = {
        project: 'proj', repo: 'org/repo',
        plugins: { 'github-prs': { watched: [{ number: 25, channels: ['#proj-issue-576'] }] } },
      }
      const result = await new GitHubPrsPlugin('#proj-leads').runTick(cfg, { prs: {} })
      expect(result.taggedEvents).toHaveLength(1)
      expect(result.taggedEvents[0]?.channels).toEqual(['#proj-issue-576'])
    } finally { spy.mockRestore() }
  })
})

describe('GitHubPrsPlugin.runTick — pr_no_linked_issues notification', () => {
  stubRateLimit()

  it('emits note to project channel naming the routing destination when no entry channels', async () => {
    const noLinkedEv: OrchestratorEvent = {
      kind: 'pr_no_linked_issues',
      repo: 'org/repo', pr: 25, url: 'https://example.com/p/25', title: 'P',
    } as OrchestratorEvent
    const spy = stubPr({
      snap: fakePrSnap({ linked_issues: [] }), events: [noLinkedEv],
    })
    try {
      const cfg: OrchestratorConfig = {
        project: 'proj', repo: 'org/repo',
        plugins: { 'github-prs': { watched: [{ number: 25 }] } },
      }
      const result = await new GitHubPrsPlugin('#proj-leads').runTick(cfg, { prs: {} })
      expect(result.taggedEvents).toHaveLength(1)
      expect(result.taggedEvents[0]?.channels).toEqual(['#proj-leads'])
      const text = (result.taggedEvents[0]?.payload as { kind: 'oneline'; text: string }).text
      expect(text).toContain('org/repo#25')
      expect(text).toContain('#proj-leads')
      expect(text).not.toContain('won\'t be routed')
    } finally { spy.mockRestore() }
  })

  it('emits confirmation to project channel when entry channels specified', async () => {
    const noLinkedEv: OrchestratorEvent = {
      kind: 'pr_no_linked_issues',
      repo: 'org/repo', pr: 25, url: 'u', title: 'P',
    } as OrchestratorEvent
    const spy = stubPr({
      snap: fakePrSnap({ linked_issues: [] }), events: [noLinkedEv],
    })
    try {
      const cfg: OrchestratorConfig = {
        project: 'proj', repo: 'org/repo',
        plugins: { 'github-prs': { watched: [{ number: 25, channels: ['#proj-issue-576'] }] } },
      }
      const result = await new GitHubPrsPlugin('#proj-leads').runTick(cfg, { prs: {} })
      expect(result.taggedEvents).toHaveLength(1)
      expect(result.taggedEvents[0]?.channels).toEqual(['#proj-leads'])
      const text = (result.taggedEvents[0]?.payload as { kind: 'oneline'; text: string }).text
      expect(text).toContain('org/repo#25')
      expect(text).toContain('#proj-issue-576')
      expect(text).not.toContain('won\'t be routed')
    } finally { spy.mockRestore() }
  })

  it('routes notification to project channel only, not to entry channels', async () => {
    const noLinkedEv: OrchestratorEvent = {
      kind: 'pr_no_linked_issues',
      repo: 'org/repo', pr: 25, url: 'u', title: 'P',
    } as OrchestratorEvent
    const spy = stubPr({
      snap: fakePrSnap({ linked_issues: [] }), events: [noLinkedEv],
    })
    try {
      const cfg: OrchestratorConfig = {
        project: 'proj', repo: 'org/repo',
        plugins: { 'github-prs': { watched: [{ number: 25, channels: ['#some-channel'] }] } },
      }
      const result = await new GitHubPrsPlugin('#proj-leads').runTick(cfg, { prs: {} })
      expect(result.taggedEvents[0]?.channels).toEqual(['#proj-leads'])
      expect(result.taggedEvents[0]?.channels).not.toContain('#some-channel')
    } finally { spy.mockRestore() }
  })
})

describe('GitHubPrsPlugin.runTick — Linear attachment cross-link', () => {
  stubRateLimit()

  type Attachment = { id: string; sourceType: string | null; url: string | null }
  type IssueNode = { identifier: string; attachments: { nodes: Attachment[] } | null }
  type QueryResult = { nodes: IssueNode[]; hasNextPage: boolean }
  type QueryFn = (teamKey: string, numbers: number[]) => Promise<QueryResult>

  function plugin(query: QueryFn | null): GitHubPrsPlugin {
    const p = new GitHubPrsPlugin('#proj')
    p._setLinearQueryForTest(query)
    return p
  }

  function attachment(prUrl: string): Attachment {
    return { id: `att-${prUrl}`, sourceType: 'github', url: prUrl }
  }

  // Helper: build a query stub from a flat identifier-keyed map of attachments
  // (test-side convenience — resolver does the team grouping internally).
  function stubFromMap(byId: Record<string, Attachment[]>): QueryFn {
    return async (team, numbers) => {
      const nodes: IssueNode[] = []
      for (const n of numbers) {
        const id = `${team}-${n}`
        if (byId[id] !== undefined) nodes.push({ identifier: id, attachments: { nodes: byId[id] } })
      }
      return { nodes, hasNextPage: false }
    }
  }

  it('matches cross-links case-insensitively (snap.repo casing may diverge from Linear attachment URL casing)', async () => {
    const ev: OrchestratorEvent = {
      kind: 'pr_review_comment',
      repo: 'AvesAlight/Roost', pr: 9, url: 'u',
      author: 'alice', body: 'x', body_preview: 'x', is_worker_reply: false,
      comment_id: 1, comment_url: 'https://example.com/c/1',
      linked_issues: [],
    } as OrchestratorEvent
    // snap.repo is mixed-case; the Linear attachment URL is lowercase.
    // Routing must still resolve because the prKey normalization lowercases
    // both sides.
    const spy = stubPr({
      snap: fakePrSnap({ repo: 'AvesAlight/Roost', number: 9 }),
      events: [ev],
    })
    try {
      const cfg: OrchestratorConfig = {
        project: 'proj', repo: 'AvesAlight/Roost',
        plugins: {
          'github-prs': { watched: [{ number: 9 }] },
          'linear-issues': { watched: [{ identifier: 'C-1' }] },
        },
      }
      const result = await plugin(stubFromMap({
        'C-1': [attachment('https://github.com/avesalight/roost/pull/9')],
      })).runTick(cfg, { prs: {} })
      expect(result.taggedEvents[0]?.channels).toContain('#proj-issue-c-1')
    } finally { spy.mockRestore() }
  })

  it('routes a PR event to the Linear-issue channel when an attachment matches the PR URL', async () => {
    const commentEv: OrchestratorEvent = {
      kind: 'pr_review_comment',
      repo: 'org/repo', pr: 25, url: 'https://github.com/org/repo/pull/25',
      author: 'alice', body: 'x', body_preview: 'x', is_worker_reply: false,
      comment_id: 1, comment_url: 'https://example.com/c/1',
      linked_issues: [],
    } as OrchestratorEvent
    const spy = stubPr({
      snap: fakePrSnap({ linked_issues: [] }),
      events: [commentEv],
    })
    try {
      const cfg: OrchestratorConfig = {
        project: 'proj', repo: 'org/repo',
        plugins: {
          'github-prs': { watched: [{ number: 25 }] },
          'linear-issues': { watched: [{ identifier: 'C-758' }] },
        },
      }
      const result = await plugin(stubFromMap({
        'C-758': [attachment('https://github.com/org/repo/pull/25')],
      })).runTick(cfg, { prs: {} })
      expect(result.taggedEvents).toHaveLength(1)
      expect(result.taggedEvents[0]?.channels).toEqual(['#proj-issue-c-758'])
      expect(result.channels).toContain('#proj-issue-c-758')
    } finally { spy.mockRestore() }
  })

  it('does not route to Linear when the linear-issues slice is absent (no resolver constructed)', async () => {
    const commentEv: OrchestratorEvent = {
      kind: 'pr_review_comment',
      repo: 'org/repo', pr: 25, url: 'u',
      author: 'alice', body: 'x', body_preview: 'x', is_worker_reply: false,
      comment_id: 1, comment_url: 'https://example.com/c/1',
      linked_issues: [],
    } as OrchestratorEvent
    const spy = stubPr({
      snap: fakePrSnap(), events: [commentEv],
    })
    try {
      let calls = 0
      const queryFn: QueryFn = async () => { calls++; return { nodes: [], hasNextPage: false } }
      const cfg: OrchestratorConfig = {
        project: 'proj', repo: 'org/repo',
        plugins: { 'github-prs': { watched: [{ number: 25 }] } },
      }
      const result = await plugin(queryFn).runTick(cfg, { prs: {} })
      expect(calls).toBe(0)
      expect(result.taggedEvents[0]?.channels).toEqual(['#proj'])
      expect(result.channels).not.toContain('#proj-issue-c-758')
    } finally { spy.mockRestore() }
  })

  it('stops routing to the Linear channel on the next tick when the attachment is removed', async () => {
    const commentEv: OrchestratorEvent = {
      kind: 'pr_review_comment',
      repo: 'org/repo', pr: 25, url: 'u',
      author: 'alice', body: 'x', body_preview: 'x', is_worker_reply: false,
      comment_id: 1, comment_url: 'https://example.com/c/1',
      linked_issues: [],
    } as OrchestratorEvent
    const spy = stubPr({
      snap: fakePrSnap(), events: [commentEv],
    })
    try {
      const cfg: OrchestratorConfig = {
        project: 'proj', repo: 'org/repo',
        plugins: {
          'github-prs': { watched: [{ number: 25 }] },
          'linear-issues': { watched: [{ identifier: 'C-758' }] },
        },
      }
      let attached = true
      const p = plugin(async () => attached
        ? { nodes: [{ identifier: 'C-758', attachments: { nodes: [attachment('https://github.com/org/repo/pull/25')] } }], hasNextPage: false }
        : { nodes: [{ identifier: 'C-758', attachments: { nodes: [] } }], hasNextPage: false })
      const tick1 = await p.runTick(cfg, { prs: {} })
      expect(tick1.taggedEvents[0]?.channels).toContain('#proj-issue-c-758')
      attached = false
      const tick2 = await p.runTick(cfg, tick1.state)
      expect(tick2.taggedEvents[0]?.channels).not.toContain('#proj-issue-c-758')
      expect(tick2.taggedEvents[0]?.channels).toEqual(['#proj'])
    } finally { spy.mockRestore() }
  })

  it('issues exactly one query per Linear team regardless of N watched PRs or N watched same-team identifiers', async () => {
    const ev: OrchestratorEvent = {
      kind: 'pr_review_comment',
      repo: 'org/repo', pr: 0, url: 'u',
      author: 'alice', body: 'x', body_preview: 'x', is_worker_reply: false,
      comment_id: 1, comment_url: 'https://example.com/c/1',
      linked_issues: [],
    } as OrchestratorEvent
    const spy = stubPr((_repo, num) => ({
      snap: fakePrSnap({ number: num }),
      events: [{ ...ev, pr: num } as OrchestratorEvent],
    }))
    try {
      const teamCalls: string[] = []
      const queryFn: QueryFn = async (team) => {
        teamCalls.push(team)
        return { nodes: [], hasNextPage: false }
      }
      const cfg: OrchestratorConfig = {
        project: 'proj', repo: 'org/repo',
        plugins: {
          'github-prs': { watched: [{ number: 1 }, { number: 2 }, { number: 3 }, { number: 4 }] },
          'linear-issues': { watched: [{ identifier: 'C-1' }, { identifier: 'C-2' }, { identifier: 'C-3' }] },
        },
      }
      await plugin(queryFn).runTick(cfg, { prs: {} })
      expect(teamCalls).toEqual(['C'])
    } finally { spy.mockRestore() }
  })

  it('issues one query per distinct Linear team when watched identifiers span teams', async () => {
    const ev: OrchestratorEvent = {
      kind: 'pr_review_comment',
      repo: 'org/repo', pr: 25, url: 'u',
      author: 'alice', body: 'x', body_preview: 'x', is_worker_reply: false,
      comment_id: 1, comment_url: 'https://example.com/c/1',
      linked_issues: [],
    } as OrchestratorEvent
    const spy = stubPr({
      snap: fakePrSnap(), events: [ev],
    })
    try {
      const teamCalls: string[] = []
      const queryFn: QueryFn = async (team) => {
        teamCalls.push(team)
        return { nodes: [], hasNextPage: false }
      }
      const cfg: OrchestratorConfig = {
        project: 'proj', repo: 'org/repo',
        plugins: {
          'github-prs': { watched: [{ number: 25 }] },
          'linear-issues': { watched: [{ identifier: 'C-1' }, { identifier: 'M-7' }, { identifier: 'C-2' }] },
        },
      }
      await plugin(queryFn).runTick(cfg, { prs: {} })
      expect(teamCalls.sort()).toEqual(['C', 'M'])
    } finally { spy.mockRestore() }
  })

  it('routes to multiple Linear channels when a PR is attached to multiple Linear issues', async () => {
    const ev: OrchestratorEvent = {
      kind: 'pr_review_comment',
      repo: 'org/repo', pr: 25, url: 'u',
      author: 'alice', body: 'x', body_preview: 'x', is_worker_reply: false,
      comment_id: 1, comment_url: 'https://example.com/c/1',
      linked_issues: [],
    } as OrchestratorEvent
    const spy = stubPr({
      snap: fakePrSnap(), events: [ev],
    })
    try {
      const cfg: OrchestratorConfig = {
        project: 'proj', repo: 'org/repo',
        plugins: {
          'github-prs': { watched: [{ number: 25 }] },
          'linear-issues': { watched: [{ identifier: 'C-1' }, { identifier: 'C-2' }] },
        },
      }
      const result = await plugin(stubFromMap({
        'C-1': [attachment('https://github.com/org/repo/pull/25')],
        'C-2': [attachment('https://github.com/org/repo/pull/25')],
      })).runTick(cfg, { prs: {} })
      expect(result.taggedEvents[0]?.channels.sort()).toEqual([
        '#proj-issue-c-1', '#proj-issue-c-2',
      ])
    } finally { spy.mockRestore() }
  })

  it('lists Linear channels in the pr_added_to_watch heads-up when only a Linear cross-link exists', async () => {
    const seedEv: OrchestratorEvent = {
      kind: 'pr_added_to_watch', repo: 'org/repo', pr: 25, url: 'u', title: 't',
    } as OrchestratorEvent
    const spy = stubPr({
      snap: fakePrSnap(), events: [seedEv],
    })
    try {
      const cfg: OrchestratorConfig = {
        project: 'proj', repo: 'org/repo',
        plugins: {
          'github-prs': { watched: [{ number: 25 }] },
          'linear-issues': { watched: [{ identifier: 'C-758' }] },
        },
      }
      const result = await plugin(stubFromMap({
        'C-758': [attachment('https://github.com/org/repo/pull/25')],
      })).runTick(cfg, { prs: {} })
      expect(result.taggedEvents).toHaveLength(1)
      const text = (result.taggedEvents[0]?.payload as { kind: 'oneline'; text: string }).text
      expect(text).toContain('#proj-issue-c-758')
    } finally { spy.mockRestore() }
  })

  it('routes pr_no_linked_issues to the project channel only, even when a Linear cross-link exists', async () => {
    const warnEv: OrchestratorEvent = {
      kind: 'pr_no_linked_issues', repo: 'org/repo', pr: 25, url: 'u', title: 't',
    } as OrchestratorEvent
    const spy = stubPr({
      snap: fakePrSnap(), events: [warnEv],
    })
    try {
      const cfg: OrchestratorConfig = {
        project: 'proj', repo: 'org/repo',
        plugins: {
          'github-prs': { watched: [{ number: 25 }] },
          'linear-issues': { watched: [{ identifier: 'C-758' }] },
        },
      }
      const result = await plugin(stubFromMap({
        'C-758': [attachment('https://github.com/org/repo/pull/25')],
      })).runTick(cfg, { prs: {} })
      const warn = result.taggedEvents.find(e => (e.payload as { kind: string }).kind === 'oneline')
      expect(warn?.channels).toEqual(['#proj-leads'])
    } finally { spy.mockRestore() }
  })

  it('pr_no_linked_issues note names the Linear channel as routing destination when cross-link exists but no GitHub link', async () => {
    const warnEv: OrchestratorEvent = {
      kind: 'pr_no_linked_issues', repo: 'org/repo', pr: 25, url: 'u', title: 't',
    } as OrchestratorEvent
    const spy = stubPr({
      snap: fakePrSnap(), events: [warnEv],
    })
    try {
      const cfg: OrchestratorConfig = {
        project: 'proj', repo: 'org/repo',
        plugins: {
          'github-prs': { watched: [{ number: 25 }] },
          'linear-issues': { watched: [{ identifier: 'C-758' }] },
        },
      }
      const result = await plugin(stubFromMap({
        'C-758': [attachment('https://github.com/org/repo/pull/25')],
      })).runTick(cfg, { prs: {} })
      const text = (result.taggedEvents[0]?.payload as { kind: 'oneline'; text: string }).text
      expect(text).toContain('#proj-issue-c-758')
      expect(text).not.toContain('#proj-leads')
    } finally { spy.mockRestore() }
  })

  it('declares Linear channels in desiredChannels for every watched Linear identifier', () => {
    const cfg: OrchestratorConfig = {
      project: 'proj', repo: 'org/repo',
      plugins: {
        'github-prs': { watched: [{ number: 25 }] },
        'linear-issues': { watched: [{ identifier: 'C-1' }, { identifier: 'C-2' }] },
      },
    }
    const p = new GitHubPrsPlugin('#proj')
    const chans = p.desiredChannels(cfg)
    expect(chans).toContain('#proj-issue-c-1')
    expect(chans).toContain('#proj-issue-c-2')
  })

  it('degrades to github-only routing when the Linear query throws (best-effort)', async () => {
    const commentEv: OrchestratorEvent = {
      kind: 'pr_review_comment',
      repo: 'org/repo', pr: 25, url: 'u',
      author: 'alice', body: 'x', body_preview: 'x', is_worker_reply: false,
      comment_id: 1, comment_url: 'https://example.com/c/1',
      linked_issues: [],
    } as OrchestratorEvent
    const spy = stubPr({
      snap: fakePrSnap(), events: [commentEv],
    })
    try {
      const cfg: OrchestratorConfig = {
        project: 'proj', repo: 'org/repo',
        plugins: {
          'github-prs': { watched: [{ number: 25 }] },
          'linear-issues': { watched: [{ identifier: 'C-758' }] },
        },
      }
      const result = await plugin(async () => { throw new Error('linear down') }).runTick(cfg, { prs: {} })
      expect(result.taggedEvents[0]?.channels).toEqual(['#proj'])
    } finally { spy.mockRestore() }
  })
})

describe('GitHubIssuesPlugin.runTick', () => {
  stubRateLimit()

  it('emits now-watching to project channel on issue_added_to_watch', async () => {
    const seedEv: OrchestratorEvent = {
      kind: 'issue_added_to_watch', repo: 'org/repo', issue: 50, url: 'u', title: 't',
    } as OrchestratorEvent
    const spy = stubIssue({
      snap: fakeIssueSnap(), events: [seedEv],
    })
    try {
      const cfg: OrchestratorConfig = {
        project: 'proj', repo: 'org/repo',
        plugins: { 'github-issues': { watched: [{ number: 50 }] } },
      }
      const result = await new GitHubIssuesPlugin('#proj').runTick(cfg, { issues: {} })
      expect(result.taggedEvents).toHaveLength(1)
      expect(result.taggedEvents[0]?.channels).toEqual(['#proj-leads'])
      expect(result.taggedEvents[0]?.payload).toEqual({
        kind: 'oneline',
        text: 'now watching issue org/repo#50 — routing events to #proj-issue-50',
      })
    } finally { spy.mockRestore() }
  })

  it('includes entry channels in now-watching routing list for issues', async () => {
    const seedEv: OrchestratorEvent = {
      kind: 'issue_added_to_watch', repo: 'org/repo', issue: 50, url: 'u', title: 't',
    } as OrchestratorEvent
    const spy = stubIssue({
      snap: fakeIssueSnap(), events: [seedEv],
    })
    try {
      const cfg: OrchestratorConfig = {
        project: 'proj', repo: 'org/repo',
        plugins: { 'github-issues': { watched: [{ number: 50, channels: ['#extra'] }] } },
      }
      const result = await new GitHubIssuesPlugin('#proj').runTick(cfg, { issues: {} })
      expect(result.taggedEvents).toHaveLength(1)
      expect(result.taggedEvents[0]?.channels).toEqual(['#proj-leads'])
      const text = (result.taggedEvents[0]?.payload as { kind: 'oneline'; text: string }).text
      expect(text).toContain('#proj-issue-50')
      expect(text).toContain('#extra')
    } finally { spy.mockRestore() }
  })

  it('routes an issue comment to its own channel unioned with entry channels', async () => {
    const issueEv: OrchestratorEvent = {
      kind: 'issue_comment',
      repo: 'org/repo', issue: 50, url: 'https://example.com/i/50',
      author: 'bob', body: 'y', body_preview: 'y', is_worker_reply: false,
      comment_id: 2, comment_url: 'https://example.com/c/2',
    } as OrchestratorEvent

    const spy = stubIssue({
      snap: fakeIssueSnap(), events: [issueEv],
    })
    try {
      const cfg: OrchestratorConfig = {
        project: 'proj',
        repo: 'org/repo',
        plugins: {
          'github-prs': { watched: [] },
          'github-issues': { watched: [{ number: 50, channels: ['#leads'] }] },
        },
      }
      const result = await new GitHubIssuesPlugin('#proj').runTick(cfg, { issues: {} })
      expect(result.taggedEvents).toHaveLength(1)
      expect(result.taggedEvents[0]?.channels.sort()).toEqual(['#leads', '#proj-issue-50'])
    } finally { spy.mockRestore() }
  })

  it('skips event routing for an entry whose own repo slug fails to derive, keeping a healthy sibling routed', async () => {
    const badEv: OrchestratorEvent = {
      kind: 'issue_comment', repo: 'org/my.tool', issue: 6, url: 'u',
      author: 'bob', body: 'x', body_preview: 'x', is_worker_reply: false,
      comment_id: 1, comment_url: 'u',
    } as OrchestratorEvent
    const goodEv: OrchestratorEvent = {
      kind: 'issue_comment', repo: 'org/repo', issue: 50, url: 'u',
      author: 'bob', body: 'y', body_preview: 'y', is_worker_reply: false,
      comment_id: 2, comment_url: 'u',
    } as OrchestratorEvent
    const logs: string[] = []
    const spy = stubIssue((repo, number) => number === 6
      ? { snap: fakeIssueSnap({ repo: 'org/my.tool', number: 6 }), events: [badEv] }
      : { snap: fakeIssueSnap({ repo: 'org/repo', number: 50 }), events: [goodEv] })
    try {
      const cfg: OrchestratorConfig = {
        project: 'proj',
        plugins: {
          'github-issues': { watched: [{ number: 6, repo: 'org/my.tool' }, { number: 50, repo: 'org/repo' }] },
        },
      }
      const result = await new GitHubIssuesPlugin('#proj', (m) => { logs.push(m) }).runTick(cfg, { issues: {} })
      expect(result.taggedEvents).toHaveLength(1)
      expect(result.taggedEvents[0]?.channels).toEqual(['#proj-repo-issue-50'])
      expect(logs.some(l => l.includes('org/my.tool#6') && l.includes('cannot derive slug'))).toBe(true)
      // No prior snapshot for the bad entry (first-ever tick) → skip leaves
      // its state key unset rather than advancing to the new snapshot, so
      // it's treated as a fresh entry (and its events replay) once the repo
      // alias is fixed, instead of the diff baseline silently moving on.
      expect(result.state).toEqual({ issues: { 'org/repo#50': expect.objectContaining({ number: 50 }) } })
    } finally { spy.mockRestore() }
  })

  it('retries a bad-slug entry from its prior snapshot instead of dropping it on advance', async () => {
    const badEv: OrchestratorEvent = {
      kind: 'issue_comment', repo: 'org/my.tool', issue: 6, url: 'u',
      author: 'bob', body: 'x', body_preview: 'x', is_worker_reply: false,
      comment_id: 1, comment_url: 'u',
    } as OrchestratorEvent
    const prev = fakeIssueSnap({ repo: 'org/my.tool', number: 6, title: 'stale' })
    const spy = stubIssue({ snap: fakeIssueSnap({ repo: 'org/my.tool', number: 6, title: 'fresh' }), events: [badEv] })
    try {
      const cfg: OrchestratorConfig = {
        project: 'proj',
        plugins: { 'github-issues': { watched: [{ number: 6, repo: 'org/my.tool' }] } },
      }
      const result = await new GitHubIssuesPlugin('#proj').runTick(cfg, { issues: { 'org/my.tool#6': prev } })
      expect(result.taggedEvents).toHaveLength(0)
      expect(result.state).toEqual({ issues: { 'org/my.tool#6': prev } })
    } finally { spy.mockRestore() }
  })
})

describe('desiredChannels', () => {
  it('PrsPlugin includes #<project>-issue-N + entry channels for github-prs.watched only', () => {
    const cfg: OrchestratorConfig = {
      project: 'proj',
      repo: 'org/repo',
      plugins: {
        'github-prs': { watched: [{ number: 25, channels: ['#extra'] }] },
        'github-issues': { watched: [{ number: 14 }] },
      },
    }
    expect(new GitHubPrsPlugin('#proj').desiredChannels(cfg).sort()).toEqual(['#extra', '#proj-issue-25'])
  })

  it('IssuesPlugin includes #<project>-issue-N + entry channels for github-issues.watched only', () => {
    const cfg: OrchestratorConfig = {
      project: 'proj',
      repo: 'org/repo',
      plugins: {
        'github-prs': { watched: [{ number: 25 }] },
        'github-issues': { watched: [{ number: 14, channels: ['#extra', '#more'] }] },
      },
    }
    expect(new GitHubIssuesPlugin('#proj').desiredChannels(cfg).sort()).toEqual(['#extra', '#more', '#proj-issue-14'])
  })

  it('falls back to repo basename when project is unset', () => {
    const cfg: OrchestratorConfig = {
      repo: 'org/myrepo',
      plugins: { 'github-issues': { watched: [{ number: 7 }] } },
    }
    expect(new GitHubIssuesPlugin('#proj').desiredChannels(cfg)).toEqual(['#myrepo-issue-7'])
  })

  it('returns empty when no watches configured', () => {
    expect(new GitHubPrsPlugin('#proj').desiredChannels({})).toEqual([])
    expect(new GitHubIssuesPlugin('#proj').desiredChannels({})).toEqual([])
  })

  it('threads the slug for multi-repo entries (PRs)', () => {
    const cfg: OrchestratorConfig = {
      project: 'proj',
      plugins: { 'github-prs': { watched: [{ number: 25, repo: 'org/foo' }, { number: 7, repo: 'org/bar' }] } },
    }
    expect(new GitHubPrsPlugin('#proj').desiredChannels(cfg).sort())
      .toEqual(['#proj-bar-issue-7', '#proj-foo-issue-25'])
  })

  it('threads the slug for multi-repo entries (issues)', () => {
    const cfg: OrchestratorConfig = {
      project: 'proj',
      plugins: { 'github-issues': { watched: [{ number: 14, repo: 'org/foo' }] } },
    }
    expect(new GitHubIssuesPlugin('#proj').desiredChannels(cfg)).toEqual(['#proj-foo-issue-14'])
  })

  it('normalizes an underscore repo basename instead of dropping its channel', () => {
    const cfg: OrchestratorConfig = {
      project: 'proj',
      plugins: { 'github-prs': { watched: [{ number: 6, repo: 'GoCarrot/debian13_root' }] } },
    }
    expect(new GitHubPrsPlugin('#proj').desiredChannels(cfg)).toEqual(['#proj-debian13-root-issue-6'])
  })

  it('skips just the entry whose slug fails to derive, keeping a healthy sibling channel joined', () => {
    const logs: string[] = []
    const cfg: OrchestratorConfig = {
      project: 'proj',
      plugins: {
        'github-prs': {
          watched: [
            { number: 6, repo: 'org/my.tool' },
            { number: 25, repo: 'org/repo' },
          ],
        },
      },
    }
    const chans = new GitHubPrsPlugin('#proj', (m) => { logs.push(m) }).desiredChannels(cfg)
    expect(chans).toEqual(['#proj-repo-issue-25'])
    expect(logs.some(l => l.includes('org/my.tool') && l.includes('cannot derive slug'))).toBe(true)
  })

  it('keeps an entry watched via an explicit channel even when its auto-derived slug throws', () => {
    const logs: string[] = []
    const cfg: OrchestratorConfig = {
      project: 'proj',
      plugins: {
        'github-prs': { watched: [{ number: 6, repo: 'org/my.tool', channels: ['#explicit-chan'] }] },
      },
    }
    const chans = new GitHubPrsPlugin('#proj', (m) => { logs.push(m) }).desiredChannels(cfg)
    expect(chans).toEqual(['#explicit-chan'])
    expect(logs.some(l => l.includes('org/my.tool') && l.includes('cannot derive slug'))).toBe(true)
  })
})

describe('multi-repo runTick — slug-aware channel routing', () => {
  stubRateLimit()

  it('PR event routes to the slugged linked-issue channel', async () => {
    const commentEv: OrchestratorEvent = {
      kind: 'pr_review_comment',
      repo: 'org/foo', pr: 25, url: 'u',
      author: 'a', body: 'x', body_preview: 'x', is_worker_reply: false,
      comment_id: 1, comment_url: 'cu',
      linked_issues: [{ repo: 'org/foo', number: 14 }],
    } as OrchestratorEvent
    const spy = stubPr({
      snap: fakePrSnap({ repo: 'org/foo', linked_issues: [{ repo: 'org/foo', number: 14 }] }),
      events: [commentEv],
    })
    try {
      const cfg: OrchestratorConfig = {
        project: 'proj',
        plugins: { 'github-prs': { watched: [{ number: 25, repo: 'org/foo' }] } },
      }
      const result = await new GitHubPrsPlugin('#proj').runTick(cfg, { prs: {} })
      expect(result.taggedEvents).toHaveLength(1)
      expect(result.taggedEvents[0]?.channels).toEqual(['#proj-foo-issue-14'])
    } finally { spy.mockRestore() }
  })

  it('issue event routes to its slugged channel', async () => {
    const issueEv: OrchestratorEvent = {
      kind: 'issue_comment',
      repo: 'org/bar', issue: 50, url: 'u',
      author: 'a', body: 'y', body_preview: 'y', is_worker_reply: false,
      comment_id: 2, comment_url: 'cu',
    } as OrchestratorEvent
    const spy = stubIssue({
      snap: fakeIssueSnap({ repo: 'org/bar' }), events: [issueEv],
    })
    try {
      const cfg: OrchestratorConfig = {
        project: 'proj',
        plugins: { 'github-issues': { watched: [{ number: 50, repo: 'org/bar' }] } },
      }
      const result = await new GitHubIssuesPlugin('#proj').runTick(cfg, { issues: {} })
      expect(result.taggedEvents).toHaveLength(1)
      expect(result.taggedEvents[0]?.channels).toEqual(['#proj-bar-issue-50'])
    } finally { spy.mockRestore() }
  })

  it('single-repo path is unchanged when config.repo is set and entry repo matches', async () => {
    const issueEv: OrchestratorEvent = {
      kind: 'issue_comment',
      repo: 'org/main', issue: 50, url: 'u',
      author: 'a', body: 'y', body_preview: 'y', is_worker_reply: false,
      comment_id: 2, comment_url: 'cu',
    } as OrchestratorEvent
    const spy = stubIssue({
      snap: fakeIssueSnap({ repo: 'org/main' }), events: [issueEv],
    })
    try {
      const cfg: OrchestratorConfig = {
        project: 'proj', repo: 'org/main',
        plugins: { 'github-issues': { watched: [{ number: 50, repo: 'org/main' }] } },
      }
      const result = await new GitHubIssuesPlugin('#proj').runTick(cfg, { issues: {} })
      expect(result.taggedEvents).toHaveLength(1)
      expect(result.taggedEvents[0]?.channels).toEqual(['#proj-issue-50'])
    } finally { spy.mockRestore() }
  })
})

describe('GitHubPrsPlugin.runTick — cross-repo linked issues', () => {
  it('multi-mode: PR in repoA closing issue in repoB routes to repoB slug', async () => {
    const commentEv: OrchestratorEvent = {
      kind: 'pr_review_comment',
      repo: 'org/foo', pr: 25, url: 'u',
      author: 'a', body: 'x', body_preview: 'x', is_worker_reply: false,
      comment_id: 1, comment_url: 'cu',
      linked_issues: [{ repo: 'org/bar', number: 14 }],
    } as OrchestratorEvent
    const spy = stubPr({
      snap: fakePrSnap({ repo: 'org/foo', linked_issues: [{ repo: 'org/bar', number: 14 }] }),
      events: [commentEv],
    })
    try {
      const cfg: OrchestratorConfig = {
        project: 'proj',
        plugins: { 'github-prs': { watched: [{ number: 25, repo: 'org/foo' }] } },
      }
      const result = await new GitHubPrsPlugin('#proj').runTick(cfg, { prs: {} })
      expect(result.taggedEvents).toHaveLength(1)
      expect(result.taggedEvents[0]?.channels).toEqual(['#proj-bar-issue-14'])
      expect(result.channels).toContain('#proj-bar-issue-14')
    } finally { spy.mockRestore() }
  })

  it('multi-mode: PR with mixed same-repo + cross-repo linked issues routes to both slugged channels', async () => {
    const commentEv: OrchestratorEvent = {
      kind: 'pr_review_comment',
      repo: 'org/foo', pr: 25, url: 'u',
      author: 'a', body: 'x', body_preview: 'x', is_worker_reply: false,
      comment_id: 1, comment_url: 'cu',
      linked_issues: [{ repo: 'org/bar', number: 14 }, { repo: 'org/foo', number: 7 }],
    } as OrchestratorEvent
    const spy = stubPr({
      snap: fakePrSnap({ repo: 'org/foo', linked_issues: [{ repo: 'org/bar', number: 14 }, { repo: 'org/foo', number: 7 }] }),
      events: [commentEv],
    })
    try {
      const cfg: OrchestratorConfig = {
        project: 'proj',
        plugins: { 'github-prs': { watched: [{ number: 25, repo: 'org/foo' }] } },
      }
      const result = await new GitHubPrsPlugin('#proj').runTick(cfg, { prs: {} })
      expect(result.taggedEvents[0]?.channels.sort()).toEqual(['#proj-bar-issue-14', '#proj-foo-issue-7'])
    } finally { spy.mockRestore() }
  })

  it('single-mode: foreign-repo linked issue is dropped from routing and logged to stderr', async () => {
    const commentEv: OrchestratorEvent = {
      kind: 'pr_review_comment',
      repo: 'org/main', pr: 25, url: 'u',
      author: 'a', body: 'x', body_preview: 'x', is_worker_reply: false,
      comment_id: 1, comment_url: 'cu',
      linked_issues: [{ repo: 'org/other', number: 14 }],
    } as OrchestratorEvent
    const spy = stubPr({
      snap: fakePrSnap({ repo: 'org/main', number: 25, linked_issues: [{ repo: 'org/other', number: 14 }] }),
      events: [commentEv],
    })
    const logs: string[] = []
    try {
      const cfg: OrchestratorConfig = {
        project: 'proj', repo: 'org/main',
        plugins: { 'github-prs': { watched: [{ number: 25 }] } },
      }
      const result = await new GitHubPrsPlugin('#proj', (m) => { logs.push(m) }).runTick(cfg, { prs: {} })
      // Foreign repo dropped → all linked issues dropped → falls back to defaultChannel.
      expect(result.taggedEvents[0]?.channels).toEqual(['#proj'])
      // The cross-repo channel must not appear in the desired-channel set.
      expect(result.channels).not.toContain('#proj-issue-14')
      // Operator-visible stderr warning naming both sides + the remediation.
      const dropWarn = logs.find(l => l.includes('cross-repo closure not routed'))
      expect(dropWarn).toContain('org/main#25')
      expect(dropWarn).toContain('org/other#14')
      expect(dropWarn).toContain('add org/other to config')
    } finally { spy.mockRestore() }
  })

  it('single-mode: same-repo linked issue retained, foreign one dropped (mixed case)', async () => {
    const commentEv: OrchestratorEvent = {
      kind: 'pr_review_comment',
      repo: 'org/main', pr: 25, url: 'u',
      author: 'a', body: 'x', body_preview: 'x', is_worker_reply: false,
      comment_id: 1, comment_url: 'cu',
      linked_issues: [{ repo: 'org/main', number: 7 }, { repo: 'org/other', number: 14 }],
    } as OrchestratorEvent
    const spy = stubPr({
      snap: fakePrSnap({ repo: 'org/main', linked_issues: [{ repo: 'org/main', number: 7 }, { repo: 'org/other', number: 14 }] }),
      events: [commentEv],
    })
    try {
      const cfg: OrchestratorConfig = {
        project: 'proj', repo: 'org/main',
        plugins: { 'github-prs': { watched: [{ number: 25 }] } },
      }
      const result = await new GitHubPrsPlugin('#proj').runTick(cfg, { prs: {} })
      // Same-repo issue routes normally; cross-repo dropped.
      expect(result.taggedEvents[0]?.channels).toEqual(['#proj-issue-7'])
    } finally { spy.mockRestore() }
  })

  it('multi-mode: snap.linked_issues populates the dispatcher channel set for cross-repo issues', async () => {
    const spy = stubPr({
      snap: fakePrSnap({ repo: 'org/foo', linked_issues: [{ repo: 'org/bar', number: 14 }] }),
      events: [],
    })
    try {
      const cfg: OrchestratorConfig = {
        project: 'proj',
        plugins: { 'github-prs': { watched: [{ number: 25, repo: 'org/foo' }] } },
      }
      const result = await new GitHubPrsPlugin('#proj').runTick(cfg, { prs: {} })
      expect(result.channels).toContain('#proj-bar-issue-14')
    } finally { spy.mockRestore() }
  })

  it('single-mode: pr_added_to_watch with only foreign-repo linked issues announces routing to projectChannel, not empty', async () => {
    const seedEv: OrchestratorEvent = {
      kind: 'pr_added_to_watch', repo: 'org/main', pr: 25, url: 'u', title: 't',
      linked_issues: [{ repo: 'org/other', number: 14 }],
    } as OrchestratorEvent
    const spy = stubPr({
      snap: fakePrSnap({ repo: 'org/main', linked_issues: [{ repo: 'org/other', number: 14 }] }),
      events: [seedEv],
    })
    try {
      const cfg: OrchestratorConfig = {
        project: 'proj', repo: 'org/main',
        plugins: { 'github-prs': { watched: [{ number: 25 }] } },
      }
      const result = await new GitHubPrsPlugin('#proj-leads').runTick(cfg, { prs: {} })
      expect(result.taggedEvents).toHaveLength(1)
      const text = (result.taggedEvents[0]?.payload as { kind: 'oneline'; text: string }).text
      expect(text).toContain('#proj-leads')
      expect(text).not.toMatch(/routing events to\s*$/)
    } finally { spy.mockRestore() }
  })

  it('multi-mode: pr_added_to_watch cross-repo routes the now-watching list through the linked-issue slug', async () => {
    const seedEv: OrchestratorEvent = {
      kind: 'pr_added_to_watch', repo: 'org/foo', pr: 25, url: 'u', title: 't',
      linked_issues: [{ repo: 'org/bar', number: 14 }],
    } as OrchestratorEvent
    const spy = stubPr({
      snap: fakePrSnap({ repo: 'org/foo', linked_issues: [{ repo: 'org/bar', number: 14 }] }),
      events: [seedEv],
    })
    try {
      const cfg: OrchestratorConfig = {
        project: 'proj',
        plugins: { 'github-prs': { watched: [{ number: 25, repo: 'org/foo' }] } },
      }
      const result = await new GitHubPrsPlugin('#proj').runTick(cfg, { prs: {} })
      expect(result.taggedEvents).toHaveLength(1)
      expect(result.taggedEvents[0]?.channels).toEqual(['#proj-leads'])
      expect(result.taggedEvents[0]?.payload).toEqual({
        kind: 'oneline',
        text: 'now watching PR org/foo#25 — routing events to #proj-bar-issue-14',
      })
    } finally { spy.mockRestore() }
  })

  it('single-mode: stderr drop warning debounced by head_oid (no re-warn across same-head ticks)', async () => {
    const spy = stubPr({
      snap: fakePrSnap({ repo: 'org/main', number: 25, head_oid: 'sha-A', linked_issues: [{ repo: 'org/other', number: 14 }] }),
      events: [],
    })
    const logs: string[] = []
    try {
      const cfg: OrchestratorConfig = {
        project: 'proj', repo: 'org/main',
        plugins: { 'github-prs': { watched: [{ number: 25 }] } },
      }
      const plugin = new GitHubPrsPlugin('#proj', (m) => { logs.push(m) })
      // First tick: drops are new → one warning.
      const r1 = await plugin.runTick(cfg, { prs: {} })
      // Second tick with prev state: same head_oid → no re-warn.
      await plugin.runTick(cfg, r1.state)
      // Third tick: still same head_oid → still no re-warn.
      await plugin.runTick(cfg, r1.state)
      const drops = logs.filter(l => l.includes('cross-repo closure not routed'))
      expect(drops).toHaveLength(1)
    } finally { spy.mockRestore() }
  })

  it('single-mode: drop warning re-fires when head_oid changes (force-push alters closures)', async () => {
    const logs: string[] = []
    const plugin = new GitHubPrsPlugin('#proj', (m) => { logs.push(m) })
    const cfg: OrchestratorConfig = {
      project: 'proj', repo: 'org/main',
      plugins: { 'github-prs': { watched: [{ number: 25 }] } },
    }
    // Tick 1: head sha-A.
    const spy1 = stubPr({
      snap: fakePrSnap({ repo: 'org/main', number: 25, head_oid: 'sha-A', linked_issues: [{ repo: 'org/other', number: 14 }] }),
      events: [],
    })
    let prevState: unknown
    try {
      const r1 = await plugin.runTick(cfg, { prs: {} })
      prevState = r1.state
    } finally { spy1.mockRestore() }
    // Tick 2: head sha-B (force-push), same dropped link.
    const spy2 = stubPr({
      snap: fakePrSnap({ repo: 'org/main', number: 25, head_oid: 'sha-B', linked_issues: [{ repo: 'org/other', number: 14 }] }),
      events: [],
    })
    try {
      await plugin.runTick(cfg, prevState)
    } finally { spy2.mockRestore() }
    const drops = logs.filter(l => l.includes('cross-repo closure not routed'))
    expect(drops).toHaveLength(2)
  })
})

describe('GhBase.handleCommand — issues plugin (target=null)', () => {
  const issues = () => new GitHubIssuesPlugin('#proj')
  // Single-repo mode: bare watch/unwatch DMs are only valid here. Multi-mode
  // rejection is covered in its own describe block below.
  const singleRepo = (extra: Partial<OrchestratorConfig> = {}): OrchestratorConfig =>
    ({ repo: 'org/r', ...extra })

  it('claims bare watch (target=null) and writes to local', () => {
    const merged: OrchestratorConfig = singleRepo()
    const local: OrchestratorConfig = {}
    const out = issues().handleCommand!(merged, local, watchCmd('github-issues', 5, null, []))
    expect(out).toMatch(/watching issue #5/)
    expect((local.plugins?.['github-issues'] as { watched: unknown[] }).watched).toEqual([{ number: 5 }])
    expect(merged.plugins?.['github-issues']).toBeUndefined()
  })

  it('ignores cmds routed to a different plugin', () => {
    const local: OrchestratorConfig = {}
    const out = issues().handleCommand!(singleRepo(), local, watchCmd('github-prs', 5, null, []))
    expect(out).toBeNull()
    expect(local.plugins?.['github-issues']).toBeUndefined()
  })

  it('is idempotent on duplicate watch (entry visible via merged)', () => {
    const merged: OrchestratorConfig = singleRepo({ plugins: { 'github-issues': { watched: [{ number: 5 }] } } })
    const local: OrchestratorConfig = {}
    const out = issues().handleCommand!(merged, local, watchCmd('github-issues', 5, null, []))
    expect(out).toMatch(/already watching/)
    expect(local.plugins?.['github-issues']).toBeUndefined()
  })

  it('appends + dedupes channels onto the local entry', () => {
    const slice = { watched: [{ number: 5, channels: ['#a'] }] }
    const merged: OrchestratorConfig = singleRepo({ plugins: { 'github-issues': slice } })
    const local: OrchestratorConfig = { plugins: { 'github-issues': slice } }
    issues().handleCommand!(merged, local, watchCmd('github-issues', 5, null, ['#a', '#b']))
    const entry = (local.plugins!['github-issues'] as { watched: { channels: string[] }[] }).watched[0]
    expect(entry.channels).toEqual(['#a', '#b'])
  })

  it('refuses to add channels to a tracked-only entry', () => {
    const merged: OrchestratorConfig = singleRepo({ plugins: { 'github-issues': { watched: [{ number: 5 }] } } })
    const local: OrchestratorConfig = {}
    const out = issues().handleCommand!(merged, local, watchCmd('github-issues', 5, null, ['#x']))
    expect(out).toBe('issue #5 in tracked config.json — hand-edit to add channels')
    expect(local.plugins?.['github-issues']).toBeUndefined()
  })

  it('no-op channel add does not dirty entry.channels', () => {
    const before = ['#a', '#b']
    const slice = { watched: [{ number: 5, channels: before }] }
    const merged: OrchestratorConfig = singleRepo({ plugins: { 'github-issues': slice } })
    const local: OrchestratorConfig = { plugins: { 'github-issues': slice } }
    const out = issues().handleCommand!(merged, local, watchCmd('github-issues', 5, null, ['#a', '#b']))
    expect(out).toMatch(/channels unchanged/)
    const after = (local.plugins!['github-issues'] as { watched: { channels: string[] }[] }).watched[0].channels
    expect(after).toBe(before)
  })

  it('removes a local entry on unwatch', () => {
    const local: OrchestratorConfig = {
      plugins: { 'github-issues': { watched: [{ number: 5 }, { number: 6 }] } },
    }
    const merged: OrchestratorConfig = singleRepo({ plugins: { 'github-issues': { watched: [{ number: 5 }, { number: 6 }] } } })
    issues().handleCommand!(merged, local, unwatchCmd('github-issues', 5, null))
    expect((local.plugins!['github-issues'] as { watched: { number: number }[] }).watched).toEqual([{ number: 6 }])
  })

  it('refuses to unwatch a tracked-only entry', () => {
    const merged: OrchestratorConfig = singleRepo({ plugins: { 'github-issues': { watched: [{ number: 5 }] } } })
    const local: OrchestratorConfig = {}
    const out = issues().handleCommand!(merged, local, unwatchCmd('github-issues', 5, null))
    expect(out).toBe('issue #5 in tracked config.json — hand-edit to remove')
  })

  it('reports not-watching on unwatch of unknown entry', () => {
    const out = issues().handleCommand!(singleRepo(), {}, unwatchCmd('github-issues', 5, null))
    expect(out).toMatch(/not watching/)
  })

  it('list returns the github-issues section from the merged view', () => {
    const merged: OrchestratorConfig = {
      plugins: { 'github-issues': { watched: [{ number: 5 }, { number: 6, channels: ['#a'] }] } },
    }
    const out = issues().handleCommand!(merged, {}, { kind: 'list' })
    expect(out).toContain('github-issues (2):')
    expect(out).toContain('  #5')
    expect(out).toContain('  #6 + #a')
  })

  it('list reports (none) for empty slice', () => {
    expect(issues().handleCommand!({}, {}, { kind: 'list' })).toContain('(none)')
  })

  it('list dedupes duplicate numbers (concat-merge artifact) and unions channels', () => {
    // Simulates the post-upgrade case where the same number lives in both
    // base and local — the loader concatenates rather than deduping, so
    // the display layer has to do it.
    const merged: OrchestratorConfig = {
      plugins: { 'github-issues': { watched: [
        { number: 5, channels: ['#a'] },
        { number: 5, channels: ['#b'] },
        { number: 6 },
      ] } },
    }
    const out = issues().handleCommand!(merged, {}, { kind: 'list' })!
    expect(out).toContain('github-issues (2):')
    expect(out).toContain('  #5 + #a #b')
    expect(out).toContain('  #6')
  })

  it('help returns this plugin\'s usage block', () => {
    const out = issues().handleCommand!({}, {}, { kind: 'help' })!
    expect(out).toContain('github-issues commands')
    expect(out).toMatch(/watch <N>/)
    expect(out).toMatch(/unwatch <N>/)
    // No `pr` keyword in issues help.
    expect(out).not.toContain('pr <N>')
  })
})

describe('GhBase.handleCommand — multi-repo mode (bare watch only)', () => {
  it('rejects bare watch and points at the repo-arg fix', () => {
    const merged: OrchestratorConfig = { project: 'p' }
    const local: OrchestratorConfig = {}
    const out = new GitHubIssuesPlugin('#proj').handleCommand!(
      merged,
      local,
      watchCmd('github-issues', 5, null, []),
    )
    expect(out).toMatch(/multi-repo mode/)
    expect(out).toMatch(/<owner>\/<repo>/)
    expect(local.plugins?.['github-issues']).toBeUndefined()
  })

  it('rejects bare unwatch', () => {
    const merged: OrchestratorConfig = {
      project: 'p',
      plugins: { 'github-issues': { watched: [{ number: 5, repo: 'org/a' }] } },
    }
    const local: OrchestratorConfig = {
      plugins: { 'github-issues': { watched: [{ number: 5, repo: 'org/a' }] } },
    }
    const out = new GitHubIssuesPlugin('#proj').handleCommand!(
      merged,
      local,
      unwatchCmd('github-issues', 5, null),
    )
    expect(out).toMatch(/multi-repo mode/)
    expect((local.plugins!['github-issues'] as { watched: unknown[] }).watched).toHaveLength(1)
  })

  it('rejects bare `watch pr`', () => {
    const merged: OrchestratorConfig = { project: 'p' }
    const out = new GitHubPrsPlugin('#proj').handleCommand!(
      merged,
      {},
      watchCmd('github-prs', 10, null, []),
    )
    expect(out).toMatch(/multi-repo mode/)
  })

  it('ACCEPTS `watch pr <N> <owner>/<repo>` — repo disambiguates', () => {
    const merged: OrchestratorConfig = { project: 'p' }
    const local: OrchestratorConfig = {}
    const out = new GitHubPrsPlugin('#proj').handleCommand!(
      merged,
      local,
      watchCmd('github-prs', 10, 'org/a', []),
    )
    expect(out).toMatch(/watching pr org\/a#10/)
    expect((local.plugins!['github-prs'] as { watched: { number: number; repo: string }[] }).watched)
      .toEqual([{ number: 10, repo: 'org/a' }])
  })
})

describe('GhBase.handleCommand — prs plugin (target=pr)', () => {
  const prs = () => new GitHubPrsPlugin('#proj')

  it('claims `watch pr` (target=pr) and writes to local', () => {
    const merged: OrchestratorConfig = { repo: 'org/r' }
    const local: OrchestratorConfig = {}
    const out = prs().handleCommand!(merged, local, watchCmd('github-prs', 10, null, ['#x']))
    expect(out).toMatch(/watching pr #10 \+ #x/)
    expect(local.plugins?.['github-prs']).toEqual({ watched: [{ number: 10, channels: ['#x'] }] })
    expect(local.plugins?.['github-issues']).toBeUndefined()
  })

  it('ignores cmds routed to a different plugin', () => {
    const out = prs().handleCommand!({ repo: 'org/r' }, {}, watchCmd('github-issues', 10, null, []))
    expect(out).toBeNull()
  })

  it('help mentions `pr <N>` form with the optional repo positional', () => {
    const out = prs().handleCommand!({ repo: 'org/r' }, {}, { kind: 'help' })!
    expect(out).toContain('github-prs commands')
    expect(out).toMatch(/watch pr <N> \[<owner>\/<repo>\]/)
    expect(out).toMatch(/unwatch pr <N> \[<owner>\/<repo>\]/)
  })
})

describe('GhBase.handleCommand — cross-repo watch/unwatch (single-repo mode)', () => {
  const prs = () => new GitHubPrsPlugin('#proj')
  const issues = () => new GitHubIssuesPlugin('#proj')

  it('creates a cross-repo entry, displays repo prefix, pins repo on the stored entry', () => {
    const merged: OrchestratorConfig = { repo: 'org/main' }
    const local: OrchestratorConfig = {}
    const out = prs().handleCommand!(merged, local, watchCmd('github-prs', 10, 'org/other', []))
    expect(out).toBe('watching pr org/other#10')
    expect(local.plugins?.['github-prs']).toEqual({ watched: [{ number: 10, repo: 'org/other' }] })
  })

  it('explicit repo that matches config.repo is equivalent to bare — no entry.repo, no prefix', () => {
    const merged: OrchestratorConfig = { repo: 'org/main' }
    const local: OrchestratorConfig = {}
    const out = prs().handleCommand!(merged, local, watchCmd('github-prs', 10, 'org/main', []))
    expect(out).toBe('watching pr #10')
    expect(local.plugins?.['github-prs']).toEqual({ watched: [{ number: 10 }] })
  })

  it('bare and cross-repo with the same number are two distinct entries', () => {
    const merged: OrchestratorConfig = {
      repo: 'org/main',
      plugins: { 'github-prs': { watched: [{ number: 10 }] } },
    }
    const local: OrchestratorConfig = {}
    const out = prs().handleCommand!(merged, local, watchCmd('github-prs', 10, 'org/other', []))
    expect(out).toBe('watching pr org/other#10')
    expect(local.plugins?.['github-prs']).toEqual({ watched: [{ number: 10, repo: 'org/other' }] })
  })

  it('idempotent on duplicate cross-repo watch', () => {
    const slice = { watched: [{ number: 10, repo: 'org/other' }] }
    const merged: OrchestratorConfig = { repo: 'org/main', plugins: { 'github-prs': slice } }
    const out = prs().handleCommand!(merged, { plugins: { 'github-prs': slice } }, watchCmd('github-prs', 10, 'org/other', []))
    expect(out).toBe('already watching pr org/other#10')
  })

  it('refuses to add channels to a tracked-only cross-repo entry, with repo in the message', () => {
    const merged: OrchestratorConfig = {
      repo: 'org/main',
      plugins: { 'github-prs': { watched: [{ number: 10, repo: 'org/other' }] } },
    }
    const local: OrchestratorConfig = {}
    const out = prs().handleCommand!(merged, local, watchCmd('github-prs', 10, 'org/other', ['#x']))
    expect(out).toBe('pr org/other#10 in tracked config.json — hand-edit to add channels')
  })

  it('cross-repo unwatch removes the local entry only', () => {
    const local: OrchestratorConfig = {
      plugins: { 'github-prs': { watched: [{ number: 10, repo: 'org/other' }, { number: 10 }] } },
    }
    const merged: OrchestratorConfig = {
      repo: 'org/main',
      plugins: { 'github-prs': { watched: [{ number: 10, repo: 'org/other' }, { number: 10 }] } },
    }
    const out = prs().handleCommand!(merged, local, unwatchCmd('github-prs', 10, 'org/other'))
    expect(out).toBe('unwatched pr org/other#10')
    expect((local.plugins!['github-prs'] as { watched: unknown[] }).watched).toEqual([{ number: 10 }])
  })

  it('list shows cross-repo entries with a repo prefix and bare entries without', () => {
    const merged: OrchestratorConfig = {
      repo: 'org/main',
      plugins: { 'github-prs': { watched: [
        { number: 1 },
        { number: 2, repo: 'org/other' },
        { number: 3, repo: 'org/main' },
      ] } },
    }
    const out = prs().handleCommand!(merged, {}, { kind: 'list' })!
    expect(out).toContain('github-prs (3):')
    expect(out).toContain('  #1')
    expect(out).toContain('  org/other#2')
    expect(out).toContain('  #3')
  })

  it('multi-repo mode + repo arg creates a cross-repo entry (parser-clean local)', () => {
    const merged: OrchestratorConfig = { project: 'p' }
    const local: OrchestratorConfig = {}
    const out = issues().handleCommand!(merged, local, watchCmd('github-issues', 7, 'org/a', []))
    expect(out).toBe('watching issue org/a#7')
    expect(local.plugins?.['github-issues']).toEqual({ watched: [{ number: 7, repo: 'org/a' }] })
  })
})

describe('github-commits handleCommand', () => {
  const commits = () => new GitHubCommitsPlugin('#proj-leads')

  it('writes a watch-repo entry to local with explicit branch+path', () => {
    const local: OrchestratorConfig = {}
    const out = commits().handleCommand!({}, local, watchRepoCmd('github-commits', 'AvesAlight/homebrew-tap', 'main', 'Formula/roost.rb', []))
    expect(out).toBe('watching repo AvesAlight/homebrew-tap@main:Formula/roost.rb')
    expect(local.plugins?.['github-commits']).toEqual({ watched: [{
      repo: 'AvesAlight/homebrew-tap', branch: 'main', path: 'Formula/roost.rb',
    }] })
  })

  it('writes a watch-repo entry with implicit branch (omits entry.branch)', () => {
    const local: OrchestratorConfig = {}
    const out = commits().handleCommand!({}, local, watchRepoCmd('github-commits', 'org/r', null, null, ['#chan']))
    expect(out).toBe('watching repo org/r@main + #chan')
    expect(local.plugins?.['github-commits']).toEqual({ watched: [{ repo: 'org/r', channels: ['#chan'] }] })
  })

  it('treats implicit (null) branch as equivalent to explicit "main" for dedup', () => {
    const slice = { watched: [{ repo: 'org/r' }] }
    const merged: OrchestratorConfig = { plugins: { 'github-commits': slice } }
    const local: OrchestratorConfig = { plugins: { 'github-commits': slice } }
    const out = commits().handleCommand!(merged, local, watchRepoCmd('github-commits', 'org/r', 'main', null, []))
    expect(out).toBe('already watching repo org/r@main')
  })

  it('different branches are distinct entries', () => {
    const merged: OrchestratorConfig = { plugins: { 'github-commits': { watched: [{ repo: 'org/r' }] } } }
    const local: OrchestratorConfig = {}
    const out = commits().handleCommand!(merged, local, watchRepoCmd('github-commits', 'org/r', 'develop', null, []))
    expect(out).toBe('watching repo org/r@develop')
    expect(local.plugins?.['github-commits']).toEqual({ watched: [{ repo: 'org/r', branch: 'develop' }] })
  })

  it('refuses to add channels to a tracked-only entry', () => {
    const merged: OrchestratorConfig = { plugins: { 'github-commits': { watched: [{ repo: 'org/r', branch: 'main', path: 'x.rb' }] } } }
    const out = commits().handleCommand!(merged, {}, watchRepoCmd('github-commits', 'org/r', 'main', 'x.rb', ['#c']))
    expect(out).toBe('repo org/r@main:x.rb in tracked config.json — hand-edit to add channels')
  })

  it('augments + dedups channels on a local entry', () => {
    const slice = { watched: [{ repo: 'org/r', channels: ['#a'] }] }
    const merged: OrchestratorConfig = { plugins: { 'github-commits': slice } }
    const local: OrchestratorConfig = { plugins: { 'github-commits': slice } }
    const out = commits().handleCommand!(merged, local, watchRepoCmd('github-commits', 'org/r', null, null, ['#a', '#b']))
    expect(out).toBe('repo org/r@main + #b')
    expect((local.plugins!['github-commits'] as { watched: { channels: string[] }[] }).watched[0].channels)
      .toEqual(['#a', '#b'])
  })

  it('removes a local entry on unwatch', () => {
    const local: OrchestratorConfig = { plugins: { 'github-commits': { watched: [{ repo: 'org/r' }, { repo: 'org/s' }] } } }
    const merged: OrchestratorConfig = { plugins: { 'github-commits': { watched: [{ repo: 'org/r' }, { repo: 'org/s' }] } } }
    const out = commits().handleCommand!(merged, local, unwatchRepoCmd('github-commits', 'org/r', null, null))
    expect(out).toBe('unwatched repo org/r@main')
    expect((local.plugins!['github-commits'] as { watched: { repo: string }[] }).watched)
      .toEqual([{ repo: 'org/s' }])
  })

  it('refuses to unwatch a tracked-only entry', () => {
    const merged: OrchestratorConfig = { plugins: { 'github-commits': { watched: [{ repo: 'org/r' }] } } }
    const out = commits().handleCommand!(merged, {}, unwatchRepoCmd('github-commits', 'org/r', null, null))
    expect(out).toBe('repo org/r@main in tracked config.json — hand-edit to remove')
  })

  it('reports not-watching on unknown entry', () => {
    const out = commits().handleCommand!({}, {}, unwatchRepoCmd('github-commits', 'org/r', null, null))
    expect(out).toBe('not watching repo org/r@main')
  })

  it('ignores commands with target!=repo', () => {
    expect(commits().handleCommand!({}, {}, watchRepoCmd('github-new-issues', 'org/r', null, null, []))).toBeNull()
    expect(commits().handleCommand!({}, {}, watchCmd('github-issues', 5, null, []))).toBeNull()
  })

  it('list returns the entry list in canonical form', () => {
    const merged: OrchestratorConfig = { plugins: { 'github-commits': { watched: [
      { repo: 'org/r' },
      { repo: 'org/s', branch: 'develop', path: 'a/b.rb', channels: ['#x'] },
    ] } } }
    const out = commits().handleCommand!(merged, {}, { kind: 'list' })!
    expect(out).toContain('github-commits (2):')
    expect(out).toContain('  org/r@main')
    expect(out).toContain('  org/s@develop:a/b.rb + #x')
  })

  it('help mentions the watch repo / unwatch repo forms', () => {
    const out = commits().handleCommand!({}, {}, { kind: 'help' })!
    expect(out).toContain('github-commits commands')
    expect(out).toMatch(/watch repo <owner>\/<repo>\[@<branch>\[:<path>\]\]/)
  })
})

describe('github-new-issues handleCommand', () => {
  const plugin = () => new GitHubNewIssuesPlugin('#proj-leads')

  it('writes a new-issues entry to local', () => {
    const local: OrchestratorConfig = {}
    const out = plugin().handleCommand!({}, local, watchRepoCmd('github-new-issues', 'org/r', null, null, ['#chan']))
    expect(out).toBe('watching new-issues org/r + #chan')
    expect(local.plugins?.['github-new-issues']).toEqual({ watched: [{ repo: 'org/r', channels: ['#chan'] }] })
  })

  it('rejects @branch/:path — new-issues entries are repo-only', () => {
    const out = plugin().handleCommand!({}, {}, watchRepoCmd('github-new-issues', 'org/r', 'main', null, []))
    expect(out).toMatch(/does not support @branch/)
  })

  it('idempotent on duplicate', () => {
    const slice = { watched: [{ repo: 'org/r' }] }
    const merged: OrchestratorConfig = { plugins: { 'github-new-issues': slice } }
    const out = plugin().handleCommand!(merged, { plugins: { 'github-new-issues': slice } }, watchRepoCmd('github-new-issues', 'org/r', null, null, []))
    expect(out).toBe('already watching new-issues org/r')
  })

  it('refuses to unwatch a tracked-only entry', () => {
    const merged: OrchestratorConfig = { plugins: { 'github-new-issues': { watched: [{ repo: 'org/r' }] } } }
    const out = plugin().handleCommand!(merged, {}, unwatchRepoCmd('github-new-issues', 'org/r', null, null))
    expect(out).toBe('new-issues org/r in tracked config.json — hand-edit to remove')
  })

  it('ignores target=repo (claimed by github-commits)', () => {
    expect(plugin().handleCommand!({}, {}, watchRepoCmd('github-commits', 'org/r', null, null, []))).toBeNull()
  })
})

describe('assertRepoMode — GhBase (PRs/issues)', () => {
  it('accepts a single-repo slice whose entries omit or match repo', () => {
    const cfg: OrchestratorConfig = {
      project: 'p', repo: 'org/main',
      plugins: { 'github-prs': { watched: [{ number: 1 }, { number: 2, repo: 'org/main' }] } },
    }
    expect(() => new GitHubPrsPlugin('#proj').assertRepoMode(cfg)).not.toThrow()
  })

  it('rejects a single-repo entry that pins a divergent repo', () => {
    const cfg: OrchestratorConfig = {
      project: 'p', repo: 'org/main',
      plugins: { 'github-prs': { watched: [{ number: 1, repo: 'org/other' }] } },
    }
    expect(() => new GitHubPrsPlugin('#proj').assertRepoMode(cfg))
      .toThrow(/single-repo mode.*github-prs #1 pins repo=org\/other/)
  })

  it('accepts a multi-repo slice where every entry carries repo', () => {
    const cfg: OrchestratorConfig = {
      project: 'p',
      plugins: { 'github-issues': { watched: [{ number: 9, repo: 'org/a' }] } },
    }
    expect(() => new GitHubIssuesPlugin('#proj').assertRepoMode(cfg)).not.toThrow()
  })

  it('rejects a multi-repo entry missing repo', () => {
    const cfg: OrchestratorConfig = {
      project: 'p',
      plugins: { 'github-issues': { watched: [{ number: 9 }] } },
    }
    expect(() => new GitHubIssuesPlugin('#proj').assertRepoMode(cfg))
      .toThrow(/multi-repo mode.*github-issues #9 is missing one/)
  })

  it('passes through when the slice is absent', () => {
    expect(() => new GitHubPrsPlugin('#proj').assertRepoMode({ project: 'p', repo: 'org/r' })).not.toThrow()
  })
})

describe('assertRepoMode — GitHubNewIssuesPlugin', () => {
  it('accepts a single-repo slice whose entries all match config.repo', () => {
    const cfg: OrchestratorConfig = {
      project: 'p', repo: 'org/main',
      plugins: { 'github-new-issues': { watched: [{ repo: 'org/main' }] } },
    }
    expect(() => new GitHubNewIssuesPlugin('#proj').assertRepoMode(cfg)).not.toThrow()
  })

  it('rejects a single-repo entry that pins a divergent repo', () => {
    const cfg: OrchestratorConfig = {
      project: 'p', repo: 'org/main',
      plugins: { 'github-new-issues': { watched: [{ repo: 'org/other' }] } },
    }
    expect(() => new GitHubNewIssuesPlugin('#proj').assertRepoMode(cfg))
      .toThrow(/single-repo mode.*github-new-issues \(repo=org\/other\) pins repo=org\/other/)
  })

  it('accepts a multi-repo slice (every entry carries repo by type)', () => {
    const cfg: OrchestratorConfig = {
      project: 'p',
      plugins: { 'github-new-issues': { watched: [{ repo: 'org/a' }, { repo: 'org/b' }] } },
    }
    expect(() => new GitHubNewIssuesPlugin('#proj').assertRepoMode(cfg)).not.toThrow()
  })

  it('passes through when the slice has no watched entries', () => {
    const cfg: OrchestratorConfig = { project: 'p', plugins: { 'github-new-issues': {} } }
    expect(() => new GitHubNewIssuesPlugin('#proj').assertRepoMode(cfg)).not.toThrow()
  })
})

describe('GhPluginBase.observeRateLimit integration', () => {
  it('merges observeRateLimit warning events into runTick taggedEvents', async () => {
    const warningEvent = { channels: ['#proj-leads'], payload: { kind: 'oneline' as const, text: 'rate limit warning' } }
    const scrapeSpy = stubPr({ snap: fakePrSnap(), events: [] })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const observeSpy = spyOn(GhPluginBase.prototype as any, 'observeRateLimit').mockResolvedValue([warningEvent])
    try {
      const cfg: OrchestratorConfig = {
        project: 'proj', repo: 'org/repo',
        plugins: { 'github-prs': { watched: [{ number: 25 }] } },
      }
      const result = await new GitHubPrsPlugin('#proj').runTick(cfg, { prs: {} })
      expect(result.taggedEvents).toContainEqual(warningEvent)
    } finally {
      scrapeSpy.mockRestore()
      observeSpy.mockRestore()
    }
  })
})

describe('GhPluginBase.observeRateLimit — pruning and anchor selection', () => {
  function observe(plugin: GitHubPrsPlugin, remaining: number, resetInMs = 60 * 60_000) {
    const fetch = async () => ({
      core: { remaining, limit: 5000, resetAt: Math.floor((Date.now() + resetInMs) / 1000) },
      graphql: null,
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (plugin as any).observeRateLimit('#proj', fetch)
  }

  it('no warning on cold-start (first call)', async () => {
    const plugin = new GitHubPrsPlugin('#proj')
    expect(await observe(plugin, 5000)).toEqual([])
  })

  it('no warning when nothing consumed', async () => {
    const plugin = new GitHubPrsPlugin('#proj')
    await observe(plugin, 5000)
    expect(await observe(plugin, 5000)).toEqual([])
  })

  it('prunes stale history and cold-starts after a long gap', async () => {
    const plugin = new GitHubPrsPlugin('#proj')
    // Inject a stale entry that would trigger a warning if used as anchor.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(plugin as any)._rateLimitHistory = [
      { remaining: 5000, ts: Date.now() - RATE_LIMIT_WINDOW_MS - 10_000 },
    ]
    // After pruning the stale entry, history is empty → cold-start → no warning.
    expect(await observe(plugin, 100, 60 * 60_000)).toEqual([])
  })

  it('warns when rolling window rate predicts exhaustion before reset', async () => {
    const plugin = new GitHubPrsPlugin('#proj')
    // Inject history entry 160 seconds ago (> half-window threshold) with 5000 remaining.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(plugin as any)._rateLimitHistory = [
      { remaining: 5000, ts: Date.now() - 160_000 },
    ]
    // Now 100 remaining, reset in 60 min. 4900 consumed in 160s → very high rate → warns.
    const result = await observe(plugin, 100, 60 * 60_000)
    expect(result).toHaveLength(1)
    expect(result[0].payload.text).toMatch(/rate limit warning/)
  })

  it('uses oldest entry as anchor, diluting mid-window bursts', async () => {
    const plugin = new GitHubPrsPlugin('#proj')
    const now = Date.now()
    // History: oldest=300s ago (5000), mid=10s ago (4800) — burst between mid and now would be 0.
    // Anchor is oldest: 5000 - 4800 = 200 consumed in 300s → 40/min.
    // 4800 remaining at 40/min → 120 min to exhaust. Reset in 60 min. 120 >= 60 → no warning.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(plugin as any)._rateLimitHistory = [
      { remaining: 5000, ts: now - 300_000 },
      { remaining: 4800, ts: now - 10_000 },
    ]
    expect(await observe(plugin, 4800, 60 * 60_000)).toEqual([])
  })
})

describe('GhPluginBase.observeRateLimit — graphql budget', () => {
  function snapshotFetch(core: { remaining: number; resetInMs?: number }, graphql: { remaining: number; resetInMs?: number } | null) {
    return async () => ({
      core: { remaining: core.remaining, limit: 5000, resetAt: Math.floor((Date.now() + (core.resetInMs ?? 60 * 60_000)) / 1000) },
      graphql: graphql
        ? { remaining: graphql.remaining, limit: 5000, resetAt: Math.floor((Date.now() + (graphql.resetInMs ?? 60 * 60_000)) / 1000) }
        : null,
    })
  }

  it('logs both core and graphql budgets in one tick', async () => {
    const plugin = new GitHubPrsPlugin('#proj')
    const logs: string[] = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(plugin as any).log = (m: string) => logs.push(m)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (plugin as any).observeRateLimit('#proj', snapshotFetch({ remaining: 5000 }, { remaining: 4000 }))
    expect(logs.some(l => l.includes('[ratelimit] gh remaining=5000'))).toBe(true)
    expect(logs.some(l => l.includes('[ratelimit] gh-graphql remaining=4000'))).toBe(true)
  })

  it('omits graphql log line when the snapshot has no graphql budget', async () => {
    const plugin = new GitHubPrsPlugin('#proj')
    const logs: string[] = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(plugin as any).log = (m: string) => logs.push(m)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (plugin as any).observeRateLimit('#proj', snapshotFetch({ remaining: 5000 }, null))
    expect(logs.some(l => l.includes('[ratelimit] gh remaining='))).toBe(true)
    expect(logs.some(l => l.includes('gh-graphql'))).toBe(false)
  })

  it('graphql warning fires while core is in cooldown from a prior warn', async () => {
    const plugin = new GitHubPrsPlugin('#proj')
    const now = Date.now()
    // Force core's cross-instance cooldown active, as if it just warned —
    // deterministic instead of relying on a real prior warn elsewhere in the
    // suite (GhPluginBase._statics is shared by every GH plugin/test in the file).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(GhPluginBase as any)._statics.warnedAt = now
    // graphql's static must start clear so this test isn't order-dependent either.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(GhPluginBase as any)._gqlStatics.warnedAt = null

    // Core bursts too (would warn if not suppressed); graphql also bursts for
    // the first time and should still fire — proving the cooldowns are independent.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(plugin as any)._rateLimitHistory = [{ remaining: 5000, ts: now - 160_000 }]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(plugin as any)._graphqlRateLimitHistory = [{ remaining: 5000, ts: now - 160_000 }]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (plugin as any).observeRateLimit('#proj', snapshotFetch({ remaining: 100 }, { remaining: 100 }))
    expect(result).toHaveLength(1)
    expect((result[0].payload as { text: string }).text).toContain('GH-GraphQL')
  })
})
