import { describe, it, expect, spyOn } from 'bun:test'
import { GitHubNewIssuesPlugin, type NewIssuesPluginState } from '../new-issues-plugin.js'
import { GhClient, type GhRepoIssue } from '../github-api.js'
import type { OrchestratorConfig } from '../../../config.js'

function issue(n: number, overrides: Partial<GhRepoIssue> = {}): GhRepoIssue {
  return {
    number: n,
    title: `Issue ${n}`,
    html_url: `https://github.com/org/repo/issues/${n}`,
    state: 'open',
    labels: [],
    ...overrides,
  }
}

function baseConfig(overrides: Partial<OrchestratorConfig> = {}): OrchestratorConfig {
  return {
    project: 'proj',
    repo: 'org/repo',
    plugins: { 'github-new-issues': {} },
    ...overrides,
  }
}

// Plugin owns its GhClient; intercept fetch at the prototype seam — same shape
// the sibling plugin tests use for scrapeIssue/scrapePr.
function stubFetch(response: GhRepoIssue[]) {
  return spyOn(GhClient.prototype, 'fetchRepoOpenIssues').mockResolvedValue(response)
}

describe('GitHubNewIssuesPlugin.runTick', () => {
  it('seeds without emitting on first run (prev === null)', async () => {
    const spy = stubFetch([issue(1), issue(2), issue(3)])
    try {
      const result = await new GitHubNewIssuesPlugin('#proj-leads').runTick(baseConfig(), null)
      expect(result.taggedEvents).toHaveLength(0)
      expect((result.state as NewIssuesPluginState).seen_issue_numbers).toEqual([1, 2, 3])
    } finally { spy.mockRestore() }
  })

  it('emits a oneline announcement for issues new since last tick', async () => {
    const spy = stubFetch([issue(1), issue(2), issue(3)])
    try {
      const prevState: NewIssuesPluginState = { seen_issue_numbers: [1] }
      const result = await new GitHubNewIssuesPlugin('#proj-leads').runTick(baseConfig(), prevState)
      expect(result.taggedEvents).toHaveLength(2)
      expect(result.taggedEvents[0]?.payload).toEqual({
        kind: 'oneline',
        text: 'new issue org/repo#2: Issue 2 — https://github.com/org/repo/issues/2',
      })
      expect(result.taggedEvents[1]?.payload).toEqual({
        kind: 'oneline',
        text: 'new issue org/repo#3: Issue 3 — https://github.com/org/repo/issues/3',
      })
    } finally { spy.mockRestore() }
  })

  it('routes announcements to the project channel by default', async () => {
    const spy = stubFetch([issue(5)])
    try {
      const result = await new GitHubNewIssuesPlugin('#proj-leads').runTick(baseConfig(), { seen_issue_numbers: [] })
      expect(result.taggedEvents[0]?.channels).toEqual(['#proj-leads'])
    } finally { spy.mockRestore() }
  })

  it('honors slice.channels override when set', async () => {
    const spy = stubFetch([issue(5)])
    try {
      const config = baseConfig({ plugins: { 'github-new-issues': { channels: ['#triage', '#leads'] } } })
      const result = await new GitHubNewIssuesPlugin('#proj-leads').runTick(config, { seen_issue_numbers: [] })
      expect(result.taggedEvents[0]?.channels).toEqual(['#triage', '#leads'])
    } finally { spy.mockRestore() }
  })

  it('emits a defensive per-event channel copy — sibling mutation does not leak', async () => {
    const spy = stubFetch([issue(1), issue(2)])
    try {
      const result = await new GitHubNewIssuesPlugin('#proj-leads').runTick(baseConfig(), { seen_issue_numbers: [] })
      result.taggedEvents[0]?.channels.push('#tampered')
      expect(result.taggedEvents[1]?.channels).toEqual(['#proj-leads'])
    } finally { spy.mockRestore() }
  })

  it('includes labels in the announcement when present', async () => {
    const spy = stubFetch([issue(7, { labels: [{ name: 'bug' }, { name: 'priority:high' }] })])
    try {
      const result = await new GitHubNewIssuesPlugin('#proj-leads').runTick(baseConfig(), { seen_issue_numbers: [] })
      const text = (result.taggedEvents[0]?.payload as { kind: 'oneline'; text: string }).text
      expect(text).toBe('new issue org/repo#7: Issue 7 [bug, priority:high] — https://github.com/org/repo/issues/7')
    } finally { spy.mockRestore() }
  })

  it('accumulates seen numbers across ticks', async () => {
    const spy = stubFetch([issue(1), issue(2)])
    try {
      const prevState: NewIssuesPluginState = { seen_issue_numbers: [5] }
      const result = await new GitHubNewIssuesPlugin('#proj-leads').runTick(baseConfig(), prevState)
      expect((result.state as NewIssuesPluginState).seen_issue_numbers).toEqual([1, 2, 5])
    } finally { spy.mockRestore() }
  })

  it('does not re-announce issues already in seen', async () => {
    const spy = stubFetch([issue(1), issue(2)])
    try {
      const prevState: NewIssuesPluginState = { seen_issue_numbers: [1, 2] }
      const result = await new GitHubNewIssuesPlugin('#proj-leads').runTick(baseConfig(), prevState)
      expect(result.taggedEvents).toHaveLength(0)
    } finally { spy.mockRestore() }
  })

  it('uses slice.repo when set, falls back to config.repo otherwise', async () => {
    const spy = spyOn(GhClient.prototype, 'fetchRepoOpenIssues').mockResolvedValue([])
    try {
      const config: OrchestratorConfig = {
        project: 'proj',
        repo: 'org/main',
        plugins: { 'github-new-issues': { repo: 'org/feed-source' } },
      }
      await new GitHubNewIssuesPlugin('#proj-leads').runTick(config, null)
      expect(spy).toHaveBeenCalledWith('org/feed-source')
    } finally { spy.mockRestore() }
  })

  it('throws when neither slice.repo nor config.repo is set', async () => {
    const config: OrchestratorConfig = {
      project: 'proj',
      plugins: { 'github-new-issues': {} },
    }
    await expect(new GitHubNewIssuesPlugin('#proj-leads').runTick(config, null)).rejects.toThrow(/no repo/)
  })

  it('desiredChannels returns empty without slice.channels — orchestrator unions in the project channel', () => {
    const plugin = new GitHubNewIssuesPlugin('#proj-leads')
    expect(plugin.desiredChannels(baseConfig())).toEqual([])
  })

  it('desiredChannels surfaces slice.channels so the orchestrator joins them at boot', () => {
    const plugin = new GitHubNewIssuesPlugin('#proj-leads')
    const config = baseConfig({ plugins: { 'github-new-issues': { channels: ['#triage'] } } })
    expect(plugin.desiredChannels(config)).toEqual(['#triage'])
  })

  it('orders announcements by issue number', async () => {
    const spy = stubFetch([issue(20), issue(5), issue(11)])
    try {
      const result = await new GitHubNewIssuesPlugin('#proj-leads').runTick(baseConfig(), { seen_issue_numbers: [] })
      const numbers = result.taggedEvents.map(e =>
        ((e.payload as { kind: 'oneline'; text: string }).text.match(/#(\d+)/)?.[1])
      )
      expect(numbers).toEqual(['5', '11', '20'])
    } finally { spy.mockRestore() }
  })
})
