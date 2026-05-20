import { describe, it, expect, spyOn } from 'bun:test'
import { GitHubCommitsPlugin, type CommitsPluginState } from '../commits-plugin.js'
import { GhClient, type GhCommit } from '../github-api.js'
import type { OrchestratorConfig } from '../../../config.js'
import { stubRateLimit } from './gh-test-helpers.js'

function commit(sha: string, subject: string): GhCommit {
  return {
    sha,
    html_url: `https://github.com/org/repo/commit/${sha}`,
    commit: { message: subject },
  }
}

function baseConfig(watched: unknown[]): OrchestratorConfig {
  return {
    project: 'proj',
    repo: 'org/repo',
    plugins: { 'github-commits': { watched } },
  }
}

// Args-aware stub so a single mock can serve multi-entry tests.
function stubFetch(
  by: (repo: string, branch: string, path: string | undefined) => GhCommit[]
) {
  return spyOn(GhClient.prototype, 'fetchRepoCommits').mockImplementation(
    async (repo: string, branch: string, path?: string) => by(repo, branch, path)
  )
}

function onelineText(payload: { kind: 'oneline'; text: string } | unknown): string {
  return (payload as { kind: 'oneline'; text: string }).text
}

describe('GitHubCommitsPlugin.runTick', () => {
  stubRateLimit()

  it('seeds without emitting on first run and records the head sha per entry', async () => {
    const spy = stubFetch(() => [commit('aaa1111', 'bump 1'), commit('bbb2222', 'bump 0')])
    try {
      const config = baseConfig([
        { repo: 'AvesAlight/homebrew-tap', branch: 'main', path: 'Formula/roost.rb' },
      ])
      const result = await new GitHubCommitsPlugin('#proj-leads').runTick(config, null)
      expect(result.taggedEvents).toHaveLength(0)
      const state = result.state as CommitsPluginState
      expect(state.commits['AvesAlight/homebrew-tap@main:Formula/roost.rb']).toEqual({ last_sha: 'aaa1111' })
    } finally { spy.mockRestore() }
  })

  it('emits a oneline per commit newer than last_sha in chronological order', async () => {
    const spy = stubFetch(() => [
      commit('ccc3333', 'bump 0.6.5'),
      commit('bbb2222', 'bump 0.6.4'),
      commit('aaa1111', 'bump 0.6.3'),
    ])
    try {
      const config = baseConfig([{ repo: 'AvesAlight/homebrew-tap' }])
      const prev: CommitsPluginState = { commits: { 'AvesAlight/homebrew-tap@main': { last_sha: 'aaa1111' } } }
      const result = await new GitHubCommitsPlugin('#proj-leads').runTick(config, prev)
      expect(result.taggedEvents).toHaveLength(2)
      expect(onelineText(result.taggedEvents[0]?.payload)).toBe(
        'commit AvesAlight/homebrew-tap@main bbb2222: bump 0.6.4 — https://github.com/org/repo/commit/bbb2222'
      )
      expect(onelineText(result.taggedEvents[1]?.payload)).toBe(
        'commit AvesAlight/homebrew-tap@main ccc3333: bump 0.6.5 — https://github.com/org/repo/commit/ccc3333'
      )
    } finally { spy.mockRestore() }
  })

  it('updates last_sha to the freshest commit after announcing', async () => {
    const spy = stubFetch(() => [
      commit('ccc3333', 'bump 0.6.5'),
      commit('bbb2222', 'bump 0.6.4'),
      commit('aaa1111', 'bump 0.6.3'),
    ])
    try {
      const config = baseConfig([{ repo: 'AvesAlight/homebrew-tap' }])
      const prev: CommitsPluginState = { commits: { 'AvesAlight/homebrew-tap@main': { last_sha: 'aaa1111' } } }
      const result = await new GitHubCommitsPlugin('#proj-leads').runTick(config, prev)
      const state = result.state as CommitsPluginState
      expect(state.commits['AvesAlight/homebrew-tap@main']).toEqual({ last_sha: 'ccc3333' })
    } finally { spy.mockRestore() }
  })

  it('routes to entry.channels when set, falls back to projectChannel otherwise', async () => {
    const spy = stubFetch(() => [commit('ccc3333', 'new'), commit('aaa1111', 'old')])
    try {
      const config = baseConfig([
        { repo: 'AvesAlight/homebrew-tap', channels: ['#release', '#leads'] },
      ])
      const prev: CommitsPluginState = { commits: { 'AvesAlight/homebrew-tap@main': { last_sha: 'aaa1111' } } }
      const result = await new GitHubCommitsPlugin('#proj-leads').runTick(config, prev)
      expect(result.taggedEvents[0]?.channels).toEqual(['#release', '#leads'])

      const defaultConfig = baseConfig([{ repo: 'AvesAlight/homebrew-tap' }])
      const result2 = await new GitHubCommitsPlugin('#proj-leads').runTick(defaultConfig, prev)
      expect(result2.taggedEvents[0]?.channels).toEqual(['#proj-leads'])
    } finally { spy.mockRestore() }
  })

  it('passes the path filter through to the gh api', async () => {
    const spy = stubFetch(() => [])
    try {
      const config = baseConfig([
        { repo: 'AvesAlight/homebrew-tap', branch: 'main', path: 'Formula/roost.rb' },
      ])
      await new GitHubCommitsPlugin('#proj-leads').runTick(config, null)
      expect(spy).toHaveBeenCalledWith('AvesAlight/homebrew-tap', 'main', 'Formula/roost.rb', 20)
    } finally { spy.mockRestore() }
  })

  it('multi-entry same repo with different paths keep independent last_sha', async () => {
    const spy = stubFetch((_repo, _branch, path) =>
      path === 'Formula/roost.rb'
        ? [commit('rrr2222', 'roost bump'), commit('rrr1111', 'old roost')]
        : [commit('zzz2222', 'tng bump'), commit('zzz1111', 'old tng')]
    )
    try {
      const config = baseConfig([
        { repo: 'AvesAlight/homebrew-tap', path: 'Formula/roost.rb' },
        { repo: 'AvesAlight/homebrew-tap', path: 'Formula/tng.rb' },
      ])
      const prev: CommitsPluginState = {
        commits: {
          'AvesAlight/homebrew-tap@main:Formula/roost.rb': { last_sha: 'rrr1111' },
          'AvesAlight/homebrew-tap@main:Formula/tng.rb': { last_sha: 'zzz1111' },
        },
      }
      const result = await new GitHubCommitsPlugin('#proj-leads').runTick(config, prev)
      const state = result.state as CommitsPluginState
      expect(state.commits['AvesAlight/homebrew-tap@main:Formula/roost.rb']).toEqual({ last_sha: 'rrr2222' })
      expect(state.commits['AvesAlight/homebrew-tap@main:Formula/tng.rb']).toEqual({ last_sha: 'zzz2222' })
      expect(result.taggedEvents).toHaveLength(2)
    } finally { spy.mockRestore() }
  })

  it('state key omits the trailing colon when path is empty', async () => {
    const spy = stubFetch(() => [commit('aaa1111', 'head')])
    try {
      const config = baseConfig([{ repo: 'AvesAlight/homebrew-tap', branch: 'main' }])
      const result = await new GitHubCommitsPlugin('#proj-leads').runTick(config, null)
      const state = result.state as CommitsPluginState
      expect(Object.keys(state.commits)).toEqual(['AvesAlight/homebrew-tap@main'])
    } finally { spy.mockRestore() }
  })

  it('logs WARN and emits all when page is full and watermark missing (no irc event)', async () => {
    const page = Array.from({ length: 20 }, (_, i) => commit(`new${i}`, `msg ${i}`))
    const spy = stubFetch(() => page)
    const logs: string[] = []
    try {
      const config = baseConfig([{ repo: 'AvesAlight/homebrew-tap' }])
      const prev: CommitsPluginState = { commits: { 'AvesAlight/homebrew-tap@main': { last_sha: 'gone000' } } }
      const plugin = new GitHubCommitsPlugin('#proj-leads', (msg) => { logs.push(msg) })
      const result = await plugin.runTick(config, prev)
      // All 20 announced (watermark missing => emit everything in the page).
      expect(result.taggedEvents).toHaveLength(20)
      // WARN line logged exactly once for this entry; no IRC event for it.
      const warnLines = logs.filter(l => l.includes('watermark') && l.includes('not in page'))
      expect(warnLines).toHaveLength(1)
      expect(warnLines[0]).toContain('AvesAlight/homebrew-tap@main')
      expect(warnLines[0]).toContain('cap=20')
    } finally { spy.mockRestore() }
  })

  it('does not warn when page is short and watermark missing (genuine history rewrite)', async () => {
    const spy = stubFetch(() => [commit('new1111', 'rewritten head')])
    const logs: string[] = []
    try {
      const config = baseConfig([{ repo: 'AvesAlight/homebrew-tap' }])
      const prev: CommitsPluginState = { commits: { 'AvesAlight/homebrew-tap@main': { last_sha: 'gone000' } } }
      const plugin = new GitHubCommitsPlugin('#proj-leads', (msg) => { logs.push(msg) })
      const result = await plugin.runTick(config, prev)
      expect(result.taggedEvents).toHaveLength(1)
      const warnLines = logs.filter(l => l.includes('watermark'))
      expect(warnLines).toHaveLength(0)
    } finally { spy.mockRestore() }
  })

  it('empty watched → no gh calls and no events', async () => {
    const spy = stubFetch(() => [commit('aaa1111', 'should not be fetched')])
    try {
      const config: OrchestratorConfig = {
        project: 'proj',
        repo: 'org/repo',
        plugins: { 'github-commits': { watched: [] } },
      }
      const result = await new GitHubCommitsPlugin('#proj-leads').runTick(config, null)
      expect(spy).not.toHaveBeenCalled()
      expect(result.taggedEvents).toHaveLength(0)
      expect(result.channels).toEqual([])
    } finally { spy.mockRestore() }
  })

  it('accumulates last_sha across ticks without losing other entries', async () => {
    const spy = stubFetch((_repo, _branch, path) =>
      path === 'Formula/roost.rb'
        ? [commit('rrr2222', 'roost bump'), commit('rrr1111', 'old')]
        : []
    )
    try {
      const config = baseConfig([{ repo: 'AvesAlight/homebrew-tap', path: 'Formula/roost.rb' }])
      const prev: CommitsPluginState = {
        commits: {
          'AvesAlight/homebrew-tap@main:Formula/roost.rb': { last_sha: 'rrr1111' },
          // Stale entry from a config the operator removed; we shouldn't drop it.
          'AvesAlight/homebrew-tap@main:Formula/stale.rb': { last_sha: 'sss0000' },
        },
      }
      const result = await new GitHubCommitsPlugin('#proj-leads').runTick(config, prev)
      const state = result.state as CommitsPluginState
      expect(state.commits['AvesAlight/homebrew-tap@main:Formula/roost.rb']).toEqual({ last_sha: 'rrr2222' })
      expect(state.commits['AvesAlight/homebrew-tap@main:Formula/stale.rb']).toEqual({ last_sha: 'sss0000' })
    } finally { spy.mockRestore() }
  })

  it('seeds a newly-added entry (prev exists, key absent) without emitting', async () => {
    const spy = stubFetch(() => [commit('aaa1111', 'head')])
    try {
      const config = baseConfig([{ repo: 'AvesAlight/homebrew-tap' }])
      const prev: CommitsPluginState = { commits: {} }
      const result = await new GitHubCommitsPlugin('#proj-leads').runTick(config, prev)
      expect(result.taggedEvents).toHaveLength(0)
      const state = result.state as CommitsPluginState
      expect(state.commits['AvesAlight/homebrew-tap@main']).toEqual({ last_sha: 'aaa1111' })
    } finally { spy.mockRestore() }
  })

  it('desiredChannels surfaces every entry.channels so orchestrator joins them at boot', () => {
    const config = baseConfig([
      { repo: 'AvesAlight/homebrew-tap', channels: ['#release'] },
      { repo: 'AvesAlight/other-tap', channels: ['#leads'] },
    ])
    const plugin = new GitHubCommitsPlugin('#proj-leads')
    expect(plugin.desiredChannels(config).sort()).toEqual(['#leads', '#release'])
  })

  it('formats commit with [path] suffix when path is set', async () => {
    const spy = stubFetch(() => [commit('ccc3333', 'roost 0.6.4'), commit('aaa1111', 'old')])
    try {
      const config = baseConfig([
        { repo: 'AvesAlight/homebrew-tap', path: 'Formula/roost.rb' },
      ])
      const prev: CommitsPluginState = { commits: { 'AvesAlight/homebrew-tap@main:Formula/roost.rb': { last_sha: 'aaa1111' } } }
      const result = await new GitHubCommitsPlugin('#proj-leads').runTick(config, prev)
      expect(onelineText(result.taggedEvents[0]?.payload)).toBe(
        'commit AvesAlight/homebrew-tap@main [Formula/roost.rb] ccc3333: roost 0.6.4 — https://github.com/org/repo/commit/ccc3333'
      )
    } finally { spy.mockRestore() }
  })
})
