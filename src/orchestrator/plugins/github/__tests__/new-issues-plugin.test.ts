import { describe, it, expect, spyOn } from 'bun:test'
import { GitHubNewIssuesPlugin, type NewIssuesPluginState } from '../new-issues-plugin.js'
import { GhClient, type GhRepoIssue } from '../github-api.js'
import type { OrchestratorConfig } from '../../../config.js'
import { stubRateLimit } from './gh-test-helpers.js'

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
    plugins: { 'github-new-issues': { watched: [{ repo: 'org/repo' }] } },
    ...overrides,
  }
}

// Plugin owns its GhClient; intercept fetch at the prototype seam — same shape
// the sibling plugin tests use for fetchPrsBatch/fetchIssuesBatch.
function stubFetch(response: GhRepoIssue[]) {
  return spyOn(GhClient.prototype, 'fetchRepoOpenIssues').mockResolvedValue(response)
}

function prevState(numbers: number[], repo = 'org/repo'): NewIssuesPluginState {
  return { repos: { [repo]: numbers } }
}

describe('GitHubNewIssuesPlugin.runTick', () => {
  stubRateLimit()

  it('seeds without emitting on first run (prev === null)', async () => {
    const spy = stubFetch([issue(1), issue(2), issue(3)])
    try {
      const result = await new GitHubNewIssuesPlugin('#proj-leads').runTick(baseConfig(), null)
      expect(result.taggedEvents).toHaveLength(0)
      expect((result.state as NewIssuesPluginState).repos['org/repo']).toEqual([1, 2, 3])
    } finally { spy.mockRestore() }
  })

  it('emits a oneline announcement for issues new since last tick', async () => {
    const spy = stubFetch([issue(1), issue(2), issue(3)])
    try {
      const result = await new GitHubNewIssuesPlugin('#proj-leads').runTick(baseConfig(), prevState([1]))
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
      const result = await new GitHubNewIssuesPlugin('#proj-leads').runTick(baseConfig(), prevState([]))
      expect(result.taggedEvents[0]?.channels).toEqual(['#proj-leads'])
    } finally { spy.mockRestore() }
  })

  it('honors entry.channels override when set', async () => {
    const spy = stubFetch([issue(5)])
    try {
      const config = baseConfig({ plugins: { 'github-new-issues': { watched: [{ repo: 'org/repo', channels: ['#triage', '#leads'] }] } } })
      const result = await new GitHubNewIssuesPlugin('#proj-leads').runTick(config, prevState([]))
      expect(result.taggedEvents[0]?.channels).toEqual(['#triage', '#leads'])
    } finally { spy.mockRestore() }
  })

  it('emits a defensive per-event channel copy — sibling mutation does not leak', async () => {
    const spy = stubFetch([issue(1), issue(2)])
    try {
      const result = await new GitHubNewIssuesPlugin('#proj-leads').runTick(baseConfig(), prevState([]))
      result.taggedEvents[0]?.channels.push('#tampered')
      expect(result.taggedEvents[1]?.channels).toEqual(['#proj-leads'])
    } finally { spy.mockRestore() }
  })

  it('includes labels in the announcement when present', async () => {
    const spy = stubFetch([issue(7, { labels: [{ name: 'bug' }, { name: 'priority:high' }] })])
    try {
      const result = await new GitHubNewIssuesPlugin('#proj-leads').runTick(baseConfig(), prevState([]))
      const text = (result.taggedEvents[0]?.payload as { kind: 'oneline'; text: string }).text
      expect(text).toBe('new issue org/repo#7: Issue 7 [bug, priority:high] — https://github.com/org/repo/issues/7')
    } finally { spy.mockRestore() }
  })

  it('accumulates seen numbers across ticks', async () => {
    const spy = stubFetch([issue(1), issue(2)])
    try {
      const result = await new GitHubNewIssuesPlugin('#proj-leads').runTick(baseConfig(), prevState([5]))
      expect((result.state as NewIssuesPluginState).repos['org/repo']).toEqual([1, 2, 5])
    } finally { spy.mockRestore() }
  })

  it('does not re-announce issues already in seen', async () => {
    const spy = stubFetch([issue(1), issue(2)])
    try {
      const result = await new GitHubNewIssuesPlugin('#proj-leads').runTick(baseConfig(), prevState([1, 2]))
      expect(result.taggedEvents).toHaveLength(0)
    } finally { spy.mockRestore() }
  })

  it('no-ops when watched list is empty — matches commits-plugin empty-list semantics', async () => {
    const config: OrchestratorConfig = {
      project: 'proj',
      plugins: { 'github-new-issues': { watched: [] } },
    }
    const result = await new GitHubNewIssuesPlugin('#proj-leads').runTick(config, null)
    expect(result.taggedEvents).toHaveLength(0)
  })

  it('no-ops when watched is absent', async () => {
    const config: OrchestratorConfig = {
      project: 'proj',
      plugins: { 'github-new-issues': {} },
    }
    const result = await new GitHubNewIssuesPlugin('#proj-leads').runTick(config, null)
    expect(result.taggedEvents).toHaveLength(0)
  })

  it('orders announcements by issue number', async () => {
    const spy = stubFetch([issue(20), issue(5), issue(11)])
    try {
      const result = await new GitHubNewIssuesPlugin('#proj-leads').runTick(baseConfig(), prevState([]))
      const numbers = result.taggedEvents.map(e =>
        ((e.payload as { kind: 'oneline'; text: string }).text.match(/#(\d+)/)?.[1])
      )
      expect(numbers).toEqual(['5', '11', '20'])
    } finally { spy.mockRestore() }
  })

  it('desiredChannels returns empty when no entry has channels', () => {
    const plugin = new GitHubNewIssuesPlugin('#proj-leads')
    expect(plugin.desiredChannels(baseConfig())).toEqual([])
  })

  it('desiredChannels unions channels across all watched entries', () => {
    const plugin = new GitHubNewIssuesPlugin('#proj-leads')
    const config = baseConfig({
      plugins: {
        'github-new-issues': {
          watched: [
            { repo: 'org/repo', channels: ['#triage'] },
            { repo: 'org/other', channels: ['#triage', '#leads'] },
          ],
        },
      },
    })
    expect(plugin.desiredChannels(config)).toEqual(['#triage', '#leads'])
  })

  it('polls each watched repo independently', async () => {
    const calls: string[] = []
    const spy = spyOn(GhClient.prototype, 'fetchRepoOpenIssues').mockImplementation(async (repo: string) => {
      calls.push(repo)
      return repo === 'org/a' ? [issue(1)] : [issue(2)]
    })
    try {
      const config: OrchestratorConfig = {
        project: 'proj',
        plugins: {
          'github-new-issues': {
            watched: [
              { repo: 'org/a' },
              { repo: 'org/b' },
            ],
          },
        },
      }
      const result = await new GitHubNewIssuesPlugin('#proj-leads').runTick(config, { repos: { 'org/a': [], 'org/b': [] } })
      expect(calls).toEqual(['org/a', 'org/b'])
      expect(result.taggedEvents).toHaveLength(2)
      expect((result.taggedEvents[0]?.payload as { text: string }).text).toContain('org/a#1')
      expect((result.taggedEvents[1]?.payload as { text: string }).text).toContain('org/b#2')
    } finally { spy.mockRestore() }
  })

  it('seeds a new repo entry without emitting when added to an existing config', async () => {
    const spy = spyOn(GhClient.prototype, 'fetchRepoOpenIssues').mockImplementation(async (repo: string) => {
      return repo === 'org/a' ? [issue(1)] : [issue(10), issue(11)]
    })
    try {
      const config: OrchestratorConfig = {
        project: 'proj',
        plugins: {
          'github-new-issues': {
            watched: [
              { repo: 'org/a' },
              { repo: 'org/new' },
            ],
          },
        },
      }
      // prev state only has org/a — org/new is brand new
      const result = await new GitHubNewIssuesPlugin('#proj-leads').runTick(config, { repos: { 'org/a': [] } })
      // org/a should emit (prev known, issue 1 is new)
      // org/new should NOT emit (first observation)
      const texts = result.taggedEvents.map(e => (e.payload as { text: string }).text)
      expect(texts.every(t => t.includes('org/a'))).toBe(true)
      expect(texts.some(t => t.includes('org/new'))).toBe(false)
      // org/new numbers should be seeded into state
      expect((result.state as NewIssuesPluginState).repos['org/new']).toEqual([10, 11])
    } finally { spy.mockRestore() }
  })

  it('carries forward removed-entry state — remove-then-readd does not replay history', async () => {
    const spy = spyOn(GhClient.prototype, 'fetchRepoOpenIssues').mockResolvedValue([issue(5)])
    try {
      // org/gone is no longer in watched, but was in prev state
      const config = baseConfig()
      const result = await new GitHubNewIssuesPlugin('#proj-leads').runTick(
        config,
        { repos: { 'org/repo': [], 'org/gone': [10, 11] } },
      )
      const state = result.state as NewIssuesPluginState
      // org/gone watermarks carried forward even though not in watched
      expect(state.repos['org/gone']).toEqual([10, 11])
    } finally { spy.mockRestore() }
  })

  it('treats old flat state format as null and re-seeds', async () => {
    const spy = stubFetch([issue(1), issue(2)])
    try {
      const oldState = { seen_issue_numbers: [1, 2, 3] }
      const result = await new GitHubNewIssuesPlugin('#proj-leads').runTick(baseConfig(), oldState)
      // Re-seeded: no events emitted
      expect(result.taggedEvents).toHaveLength(0)
      expect((result.state as NewIssuesPluginState).repos['org/repo']).toEqual([1, 2])
    } finally { spy.mockRestore() }
  })
})
