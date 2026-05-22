import { describe, it, expect, spyOn } from 'bun:test'
import { GitHubNewPrsPlugin, type NewPrsPluginState } from '../new-prs-plugin.js'
import { GhClient, type GhRepoPr } from '../github-api.js'
import type { OrchestratorConfig } from '../../../config.js'
import { stubRateLimit } from './gh-test-helpers.js'

function pr(n: number, overrides: Partial<GhRepoPr> = {}): GhRepoPr {
  return {
    number: n,
    title: `PR ${n}`,
    html_url: `https://github.com/org/repo/pull/${n}`,
    labels: [],
    user: { login: 'external-user' },
    ...overrides,
  }
}

function baseConfig(overrides: Partial<OrchestratorConfig> = {}): OrchestratorConfig {
  return {
    project: 'proj',
    repo: 'org/repo',
    plugins: { 'github-new-prs': { watched: [{ repo: 'org/repo' }] } },
    ...overrides,
  }
}

function stubFetch(response: GhRepoPr[]) {
  return spyOn(GhClient.prototype, 'fetchRepoOpenPrs').mockResolvedValue(response)
}

function prevState(numbers: number[], repo = 'org/repo'): NewPrsPluginState {
  return { repos: { [repo]: numbers } }
}

describe('GitHubNewPrsPlugin.runTick', () => {
  stubRateLimit()

  it('seeds without emitting on first run (prev === null)', async () => {
    const spy = stubFetch([pr(1), pr(2), pr(3)])
    try {
      const result = await new GitHubNewPrsPlugin('#proj-leads').runTick(baseConfig(), null)
      expect(result.taggedEvents).toHaveLength(0)
      expect((result.state as NewPrsPluginState).repos['org/repo']).toEqual([1, 2, 3])
    } finally { spy.mockRestore() }
  })

  it('emits a oneline announcement for PRs new since last tick', async () => {
    const spy = stubFetch([pr(1), pr(2), pr(3)])
    try {
      const result = await new GitHubNewPrsPlugin('#proj-leads').runTick(baseConfig(), prevState([1]))
      expect(result.taggedEvents).toHaveLength(2)
      expect(result.taggedEvents[0]?.payload).toEqual({
        kind: 'oneline',
        text: 'new PR org/repo#2: PR 2 — https://github.com/org/repo/pull/2',
      })
      expect(result.taggedEvents[1]?.payload).toEqual({
        kind: 'oneline',
        text: 'new PR org/repo#3: PR 3 — https://github.com/org/repo/pull/3',
      })
    } finally { spy.mockRestore() }
  })

  it('routes announcements to the project channel by default', async () => {
    const spy = stubFetch([pr(5)])
    try {
      const result = await new GitHubNewPrsPlugin('#proj-leads').runTick(baseConfig(), prevState([]))
      expect(result.taggedEvents[0]?.channels).toEqual(['#proj-leads'])
    } finally { spy.mockRestore() }
  })

  it('honors entry.channels override when set', async () => {
    const spy = stubFetch([pr(5)])
    try {
      const config = baseConfig({ plugins: { 'github-new-prs': { watched: [{ repo: 'org/repo', channels: ['#triage', '#leads'] }] } } })
      const result = await new GitHubNewPrsPlugin('#proj-leads').runTick(config, prevState([]))
      expect(result.taggedEvents[0]?.channels).toEqual(['#triage', '#leads'])
    } finally { spy.mockRestore() }
  })

  it('emits a defensive per-event channel copy — sibling mutation does not leak', async () => {
    const spy = stubFetch([pr(1), pr(2)])
    try {
      const result = await new GitHubNewPrsPlugin('#proj-leads').runTick(baseConfig(), prevState([]))
      result.taggedEvents[0]?.channels.push('#tampered')
      expect(result.taggedEvents[1]?.channels).toEqual(['#proj-leads'])
    } finally { spy.mockRestore() }
  })

  it('includes labels in the announcement when present', async () => {
    const spy = stubFetch([pr(7, { labels: [{ name: 'enhancement' }, { name: 'good first issue' }] })])
    try {
      const result = await new GitHubNewPrsPlugin('#proj-leads').runTick(baseConfig(), prevState([]))
      const text = (result.taggedEvents[0]?.payload as { kind: 'oneline'; text: string }).text
      expect(text).toBe('new PR org/repo#7: PR 7 [enhancement, good first issue] — https://github.com/org/repo/pull/7')
    } finally { spy.mockRestore() }
  })

  it('accumulates seen numbers across ticks', async () => {
    const spy = stubFetch([pr(1), pr(2)])
    try {
      const result = await new GitHubNewPrsPlugin('#proj-leads').runTick(baseConfig(), prevState([5]))
      expect((result.state as NewPrsPluginState).repos['org/repo']).toEqual([1, 2, 5])
    } finally { spy.mockRestore() }
  })

  it('does not re-announce PRs already in seen', async () => {
    const spy = stubFetch([pr(1), pr(2)])
    try {
      const result = await new GitHubNewPrsPlugin('#proj-leads').runTick(baseConfig(), prevState([1, 2]))
      expect(result.taggedEvents).toHaveLength(0)
    } finally { spy.mockRestore() }
  })

  it('no-ops when watched list is empty', async () => {
    const config: OrchestratorConfig = {
      project: 'proj',
      plugins: { 'github-new-prs': { watched: [] } },
    }
    const result = await new GitHubNewPrsPlugin('#proj-leads').runTick(config, null)
    expect(result.taggedEvents).toHaveLength(0)
  })

  it('no-ops when watched is absent', async () => {
    const config: OrchestratorConfig = {
      project: 'proj',
      plugins: { 'github-new-prs': {} },
    }
    const result = await new GitHubNewPrsPlugin('#proj-leads').runTick(config, null)
    expect(result.taggedEvents).toHaveLength(0)
  })

  it('orders announcements by PR number', async () => {
    const spy = stubFetch([pr(20), pr(5), pr(11)])
    try {
      const result = await new GitHubNewPrsPlugin('#proj-leads').runTick(baseConfig(), prevState([]))
      const numbers = result.taggedEvents.map(e =>
        ((e.payload as { kind: 'oneline'; text: string }).text.match(/#(\d+)/)?.[1])
      )
      expect(numbers).toEqual(['5', '11', '20'])
    } finally { spy.mockRestore() }
  })

  it('desiredChannels returns empty when no entry has channels', () => {
    const plugin = new GitHubNewPrsPlugin('#proj-leads')
    expect(plugin.desiredChannels(baseConfig())).toEqual([])
  })

  it('desiredChannels unions channels across all watched entries', () => {
    const plugin = new GitHubNewPrsPlugin('#proj-leads')
    const config = baseConfig({
      plugins: {
        'github-new-prs': {
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
    const spy = spyOn(GhClient.prototype, 'fetchRepoOpenPrs').mockImplementation(async (repo: string) => {
      calls.push(repo)
      return repo === 'org/a' ? [pr(1)] : [pr(2)]
    })
    try {
      const config: OrchestratorConfig = {
        project: 'proj',
        plugins: {
          'github-new-prs': {
            watched: [
              { repo: 'org/a' },
              { repo: 'org/b' },
            ],
          },
        },
      }
      const result = await new GitHubNewPrsPlugin('#proj-leads').runTick(config, { repos: { 'org/a': [], 'org/b': [] } })
      expect(calls).toEqual(['org/a', 'org/b'])
      expect(result.taggedEvents).toHaveLength(2)
      expect((result.taggedEvents[0]?.payload as { text: string }).text).toContain('org/a#1')
      expect((result.taggedEvents[1]?.payload as { text: string }).text).toContain('org/b#2')
    } finally { spy.mockRestore() }
  })

  it('seeds a new repo entry without emitting when added to an existing config', async () => {
    const spy = spyOn(GhClient.prototype, 'fetchRepoOpenPrs').mockImplementation(async (repo: string) => {
      return repo === 'org/a' ? [pr(1)] : [pr(10), pr(11)]
    })
    try {
      const config: OrchestratorConfig = {
        project: 'proj',
        plugins: {
          'github-new-prs': {
            watched: [
              { repo: 'org/a' },
              { repo: 'org/new' },
            ],
          },
        },
      }
      const result = await new GitHubNewPrsPlugin('#proj-leads').runTick(config, { repos: { 'org/a': [] } })
      const texts = result.taggedEvents.map(e => (e.payload as { text: string }).text)
      expect(texts.every(t => t.includes('org/a'))).toBe(true)
      expect(texts.some(t => t.includes('org/new'))).toBe(false)
      expect((result.state as NewPrsPluginState).repos['org/new']).toEqual([10, 11])
    } finally { spy.mockRestore() }
  })

  it('carries forward removed-entry state — remove-then-readd does not replay history', async () => {
    const spy = spyOn(GhClient.prototype, 'fetchRepoOpenPrs').mockResolvedValue([pr(5)])
    try {
      const config = baseConfig()
      const result = await new GitHubNewPrsPlugin('#proj-leads').runTick(
        config,
        { repos: { 'org/repo': [], 'org/gone': [10, 11] } },
      )
      const state = result.state as NewPrsPluginState
      expect(state.repos['org/gone']).toEqual([10, 11])
    } finally { spy.mockRestore() }
  })

  it('suppresses PRs authored by agent_logins', async () => {
    const spy = stubFetch([
      pr(1, { user: { login: 'roost-agent' } }),
      pr(2, { user: { login: 'external-user' } }),
      pr(3, { user: { login: 'another-agent' } }),
    ])
    try {
      const config = baseConfig({ agent_logins: ['roost-agent', 'another-agent'] })
      const result = await new GitHubNewPrsPlugin('#proj-leads').runTick(config, prevState([]))
      expect(result.taggedEvents).toHaveLength(1)
      expect((result.taggedEvents[0]?.payload as { text: string }).text).toContain('org/repo#2')
    } finally { spy.mockRestore() }
  })

  it('seeds agent PR numbers into state even when suppressed — prevents replay on agent_logins change', async () => {
    const spy = stubFetch([
      pr(1, { user: { login: 'roost-agent' } }),
      pr(2, { user: { login: 'external-user' } }),
    ])
    try {
      const config = baseConfig({ agent_logins: ['roost-agent'] })
      const result = await new GitHubNewPrsPlugin('#proj-leads').runTick(config, prevState([]))
      // Both numbers seeded, only #2 announced.
      expect((result.state as NewPrsPluginState).repos['org/repo']).toEqual([1, 2])
      expect(result.taggedEvents).toHaveLength(1)
    } finally { spy.mockRestore() }
  })

  it('announces PRs with no user login (author unknown) — conservative default', async () => {
    const spy = stubFetch([pr(1, { user: undefined })])
    try {
      const config = baseConfig({ agent_logins: ['roost-agent'] })
      const result = await new GitHubNewPrsPlugin('#proj-leads').runTick(config, prevState([]))
      expect(result.taggedEvents).toHaveLength(1)
    } finally { spy.mockRestore() }
  })

  it('treats old flat state format as null and re-seeds', async () => {
    const spy = stubFetch([pr(1), pr(2)])
    try {
      const oldState = { seen_pr_numbers: [1, 2, 3] }
      const result = await new GitHubNewPrsPlugin('#proj-leads').runTick(baseConfig(), oldState)
      expect(result.taggedEvents).toHaveLength(0)
      expect((result.state as NewPrsPluginState).repos['org/repo']).toEqual([1, 2])
    } finally { spy.mockRestore() }
  })
})
