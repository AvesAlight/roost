import { describe, it, expect, spyOn } from 'bun:test'
import { GitHubPrsPlugin } from '../prs-plugin.js'
import { GitHubIssuesPlugin } from '../issues-plugin.js'
import { GhPluginBase } from '../base.js'
import type { OrchestratorConfig } from '../../../config.js'
import type { PrSnap, IssueSnap } from '../types.js'
import { GhScraper } from '../scraper.js'
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

    const spy = spyOn(GhScraper.prototype, 'scrapePr').mockResolvedValue({
      snap: fakePrSnap({ linked_issues: [14] }),
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
    const spy = spyOn(GhScraper.prototype, 'scrapePr').mockResolvedValue({
      snap: fakePrSnap({ linked_issues: [7] }), events: [],
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
      expect(state.prs['org/repo#25']?.linked_issues).toEqual([7])
      expect(result.channels).toContain('#proj-issue-7')
    } finally { spy.mockRestore() }
  })

  it('routes pr_no_linked_issues to project channel', async () => {
    const warningEv: OrchestratorEvent = {
      kind: 'pr_no_linked_issues',
      repo: 'org/repo', pr: 25, url: 'https://example.com/p/25', title: 'P',
    } as OrchestratorEvent
    const spy = spyOn(GhScraper.prototype, 'scrapePr').mockResolvedValue({
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
    const spy = spyOn(GhScraper.prototype, 'scrapePr').mockResolvedValue({
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
      linked_issues: [7, 14],
    } as OrchestratorEvent
    const spy = spyOn(GhScraper.prototype, 'scrapePr').mockResolvedValue({
      snap: fakePrSnap({ linked_issues: [7, 14] }), events: [seedEv],
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
      linked_issues: [7],
    } as OrchestratorEvent
    const spy = spyOn(GhScraper.prototype, 'scrapePr').mockResolvedValue({
      snap: fakePrSnap({ linked_issues: [7] }), events: [seedEv],
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

describe('GitHubIssuesPlugin.runTick', () => {
  it('emits now-watching to project channel on issue_added_to_watch', async () => {
    const seedEv: OrchestratorEvent = {
      kind: 'issue_added_to_watch', repo: 'org/repo', issue: 50, url: 'u', title: 't',
    } as OrchestratorEvent
    const spy = spyOn(GhScraper.prototype, 'scrapeIssue').mockResolvedValue({
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
    const spy = spyOn(GhScraper.prototype, 'scrapeIssue').mockResolvedValue({
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

    const spy = spyOn(GhScraper.prototype, 'scrapeIssue').mockResolvedValue({
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
})

describe('GhBase.handleCommand — issues plugin (target=null)', () => {
  const issues = () => new GitHubIssuesPlugin('#proj')

  it('claims bare watch (target=null)', () => {
    const config: OrchestratorConfig = {}
    const out = issues().handleCommand!(config, { kind: 'watch', target: null, number: 5, channels: [] })
    expect(out).toMatch(/watching issue #5/)
    expect((config.plugins?.['github-issues'] as { watched: unknown[] }).watched).toEqual([{ number: 5 }])
  })

  it('ignores `watch pr` (returns null)', () => {
    const config: OrchestratorConfig = {}
    const out = issues().handleCommand!(config, { kind: 'watch', target: 'pr', number: 5, channels: [] })
    expect(out).toBeNull()
    expect(config.plugins?.['github-issues']).toBeUndefined()
  })

  it('is idempotent on duplicate watch', () => {
    const config: OrchestratorConfig = { plugins: { 'github-issues': { watched: [{ number: 5 }] } } }
    const out = issues().handleCommand!(config, { kind: 'watch', target: null, number: 5, channels: [] })
    expect(out).toMatch(/already watching/)
  })

  it('appends + dedupes channels onto existing entry', () => {
    const config: OrchestratorConfig = {
      plugins: { 'github-issues': { watched: [{ number: 5, channels: ['#a'] }] } },
    }
    issues().handleCommand!(config, { kind: 'watch', target: null, number: 5, channels: ['#a', '#b'] })
    const entry = (config.plugins!['github-issues'] as { watched: { channels: string[] }[] }).watched[0]
    expect(entry.channels).toEqual(['#a', '#b'])
  })

  it('no-op channel add does not dirty entry.channels', () => {
    const before = ['#a', '#b']
    const config: OrchestratorConfig = {
      plugins: { 'github-issues': { watched: [{ number: 5, channels: before }] } },
    }
    const out = issues().handleCommand!(config, { kind: 'watch', target: null, number: 5, channels: ['#a', '#b'] })
    expect(out).toMatch(/channels unchanged/)
    const after = (config.plugins!['github-issues'] as { watched: { channels: string[] }[] }).watched[0].channels
    expect(after).toBe(before)
  })

  it('removes an entry on unwatch', () => {
    const config: OrchestratorConfig = {
      plugins: { 'github-issues': { watched: [{ number: 5 }, { number: 6 }] } },
    }
    issues().handleCommand!(config, { kind: 'unwatch', target: null, number: 5 })
    expect((config.plugins!['github-issues'] as { watched: { number: number }[] }).watched).toEqual([{ number: 6 }])
  })

  it('reports not-watching on unwatch of unknown entry', () => {
    const out = issues().handleCommand!({}, { kind: 'unwatch', target: null, number: 5 })
    expect(out).toMatch(/not watching/)
  })

  it('list returns the github-issues section', () => {
    const config: OrchestratorConfig = {
      plugins: { 'github-issues': { watched: [{ number: 5 }, { number: 6, channels: ['#a'] }] } },
    }
    const out = issues().handleCommand!(config, { kind: 'list' })
    expect(out).toContain('github-issues (2):')
    expect(out).toContain('  #5')
    expect(out).toContain('  #6 + #a')
  })

  it('list reports (none) for empty slice', () => {
    expect(issues().handleCommand!({}, { kind: 'list' })).toContain('(none)')
  })

  it('help returns this plugin\'s usage block', () => {
    const out = issues().handleCommand!({}, { kind: 'help' })!
    expect(out).toContain('github-issues commands')
    expect(out).toMatch(/watch <N>/)
    expect(out).toMatch(/unwatch <N>/)
    // No `pr` keyword in issues help.
    expect(out).not.toContain('pr <N>')
  })
})

describe('GhBase.handleCommand — prs plugin (target=pr)', () => {
  const prs = () => new GitHubPrsPlugin('#proj')

  it('claims `watch pr` (target=pr)', () => {
    const config: OrchestratorConfig = {}
    const out = prs().handleCommand!(config, { kind: 'watch', target: 'pr', number: 10, channels: ['#x'] })
    expect(out).toMatch(/watching pr #10 \+ #x/)
    expect(config.plugins?.['github-prs']).toEqual({ watched: [{ number: 10, channels: ['#x'] }] })
    expect(config.plugins?.['github-issues']).toBeUndefined()
  })

  it('ignores bare watch (returns null)', () => {
    const out = prs().handleCommand!({}, { kind: 'watch', target: null, number: 10, channels: [] })
    expect(out).toBeNull()
  })

  it('help mentions `pr <N>` form', () => {
    const out = prs().handleCommand!({}, { kind: 'help' })!
    expect(out).toContain('github-prs commands')
    expect(out).toMatch(/watch pr <N>/)
    expect(out).toMatch(/unwatch pr <N>/)
  })
})

describe('GhPluginBase.observeRateLimit integration', () => {
  it('merges observeRateLimit warning events into runTick taggedEvents', async () => {
    const warningEvent = { channels: ['#proj-leads'], payload: { kind: 'oneline' as const, text: 'rate limit warning' } }
    const scrapeSpy = spyOn(GhScraper.prototype, 'scrapePr').mockResolvedValue({ snap: fakePrSnap(), events: [] })
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
