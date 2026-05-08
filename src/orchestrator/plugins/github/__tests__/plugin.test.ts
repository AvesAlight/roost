import { describe, it, expect, spyOn } from 'bun:test'
import { GitHubPrsPlugin } from '../prs-plugin.js'
import { GitHubIssuesPlugin } from '../issues-plugin.js'
import type { OrchestratorConfig } from '../../../config.js'
import type { PrSnap, IssueSnap } from '../types.js'
import * as scraper from '../scraper.js'
import type { OrchestratorEvent } from '../diff.js'

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

describe('GitHubPrsPlugin.runTick', () => {
  it('routes a PR comment to linked-issue channels unioned with entry channels', async () => {
    const commentEv: OrchestratorEvent = {
      kind: 'pr_review_comment',
      repo: 'org/repo', pr: 25, url: 'https://example.com/p/25',
      author: 'alice', body: 'x', body_preview: 'x', is_worker_reply: false,
      comment_id: 1, comment_url: 'https://example.com/c/1',
      linked_issues: [14],
    } as OrchestratorEvent

    const spy = spyOn(scraper, 'scrapePr').mockResolvedValue({
      snap: fakePrSnap({ linked_issues: [14] }),
      events: [commentEv],
    })
    try {
      const cfg: OrchestratorConfig = {
        repo: 'org/repo',
        watched_prs: [{ number: 25, channels: ['#extra'] }],
        watched_issues: [],
      }
      const result = await new GitHubPrsPlugin('#proj').runTick(cfg, { prs: {} })
      expect(result.taggedEvents).toHaveLength(1)
      expect(result.taggedEvents[0]?.channels.sort()).toEqual(['#extra', '#issue-14'])
      expect(result.taggedEvents[0]?.payload.kind).toBe('multiline')
      expect(result.channels).toContain('#issue-14')
      expect(result.channels).toContain('#extra')
    } finally { spy.mockRestore() }
  })

  it('persists scraped PR state under its own slice', async () => {
    const spy = spyOn(scraper, 'scrapePr').mockResolvedValue({
      snap: fakePrSnap({ linked_issues: [7] }), events: [],
    })
    try {
      const cfg: OrchestratorConfig = {
        repo: 'org/repo',
        watched_prs: [{ number: 25 }],
        watched_issues: [],
      }
      const result = await new GitHubPrsPlugin('#proj').runTick(cfg, null)
      const state = result.state as { prs: Record<string, PrSnap> }
      expect(state.prs['org/repo#25']?.linked_issues).toEqual([7])
      expect(result.channels).toContain('#issue-7')
    } finally { spy.mockRestore() }
  })

  it('filters non-pushable events (e.g. pr_added_to_watch) before tagging', async () => {
    const seedEv: OrchestratorEvent = {
      kind: 'pr_added_to_watch', repo: 'org/repo', pr: 25, url: 'u', title: 't',
    } as OrchestratorEvent
    const spy = spyOn(scraper, 'scrapePr').mockResolvedValue({
      snap: fakePrSnap(), events: [seedEv],
    })
    try {
      const cfg: OrchestratorConfig = { repo: 'org/repo', watched_prs: [{ number: 25 }] }
      const result = await new GitHubPrsPlugin('#proj').runTick(cfg, { prs: {} })
      expect(result.taggedEvents).toHaveLength(0)
    } finally { spy.mockRestore() }
  })
})

describe('GitHubIssuesPlugin.runTick', () => {
  it('routes an issue comment to its own channel unioned with entry channels', async () => {
    const issueEv: OrchestratorEvent = {
      kind: 'issue_comment',
      repo: 'org/repo', issue: 50, url: 'https://example.com/i/50',
      author: 'bob', body: 'y', body_preview: 'y', is_worker_reply: false,
      comment_id: 2, comment_url: 'https://example.com/c/2',
    } as OrchestratorEvent

    const spy = spyOn(scraper, 'scrapeIssue').mockResolvedValue({
      snap: fakeIssueSnap(), events: [issueEv],
    })
    try {
      const cfg: OrchestratorConfig = {
        repo: 'org/repo',
        watched_prs: [],
        watched_issues: [{ number: 50, channels: ['#leads'] }],
      }
      const result = await new GitHubIssuesPlugin('#proj').runTick(cfg, { issues: {} })
      expect(result.taggedEvents).toHaveLength(1)
      expect(result.taggedEvents[0]?.channels.sort()).toEqual(['#issue-50', '#leads'])
    } finally { spy.mockRestore() }
  })
})

describe('desiredChannels', () => {
  it('PrsPlugin includes #issue-N + entry channels for watched_prs only', () => {
    const cfg: OrchestratorConfig = {
      repo: 'org/repo',
      watched_prs: [{ number: 25, channels: ['#extra'] }],
      watched_issues: [{ number: 14 }],
    }
    expect(new GitHubPrsPlugin('#proj').desiredChannels(cfg).sort()).toEqual(['#extra', '#issue-25'])
  })

  it('IssuesPlugin includes #issue-N + entry channels for watched_issues only', () => {
    const cfg: OrchestratorConfig = {
      repo: 'org/repo',
      watched_prs: [{ number: 25 }],
      watched_issues: [{ number: 14, channels: ['#extra', '#more'] }],
    }
    expect(new GitHubIssuesPlugin('#proj').desiredChannels(cfg).sort()).toEqual(['#extra', '#issue-14', '#more'])
  })

  it('returns empty when no watches configured', () => {
    expect(new GitHubPrsPlugin('#proj').desiredChannels({})).toEqual([])
    expect(new GitHubIssuesPlugin('#proj').desiredChannels({})).toEqual([])
  })
})
