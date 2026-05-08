import { describe, it, expect } from 'bun:test'
import { BasePlugin, type PluginTickResult } from '../plugin.js'
import { GitHubPlugin } from '../github-plugin.js'
import type { OrchestratorConfig } from '../config.js'
import { resolveRepoEntry } from '../config.js'

class TestPlugin extends BasePlugin {
  readonly name = 'test'
  desiredChannels(): string[] { return [] }
  async runTick(): Promise<PluginTickResult> {
    return { state: null, taggedEvents: [], channels: [] }
  }
  resolve(autoDetected: string[], entryChannels: string[]): string[] {
    return this.resolveChannels(autoDetected, entryChannels)
  }
}

describe('BasePlugin.resolveChannels', () => {
  const p = new TestPlugin('#proj')

  it('unions auto-detected and entry channels with dedupe', () => {
    expect(p.resolve(['#issue-14'], ['#issue-7', '#issue-14'])).toEqual(['#issue-14', '#issue-7'])
  })

  it('returns auto-detected when entry channels empty', () => {
    expect(p.resolve(['#issue-25'], [])).toEqual(['#issue-25'])
  })

  it('returns entry channels when auto-detected empty', () => {
    expect(p.resolve([], ['#side-channel'])).toEqual(['#side-channel'])
  })

  it('falls back to default channel when both empty', () => {
    expect(p.resolve([], [])).toEqual(['#proj'])
  })
})

describe('resolveRepoEntry', () => {
  it('returns repo, number, and channels (defaulting channels to [])', () => {
    expect(resolveRepoEntry({ number: 5 }, 'org/repo')).toEqual({ repo: 'org/repo', number: 5, channels: [] })
  })

  it('honors entry-specific repo override', () => {
    expect(resolveRepoEntry({ repo: 'other/repo', number: 5 }, 'org/repo')).toEqual({ repo: 'other/repo', number: 5, channels: [] })
  })

  it('passes channels through', () => {
    expect(resolveRepoEntry({ number: 5, channels: ['#a', '#b'] }, 'org/repo')).toEqual({ repo: 'org/repo', number: 5, channels: ['#a', '#b'] })
  })

  it('throws when no repo available', () => {
    expect(() => resolveRepoEntry({ number: 5 })).toThrow(/missing repo/)
  })
})

describe('GitHubPlugin.desiredChannels', () => {
  it('includes #issue-N for each watched PR and issue', () => {
    const cfg: OrchestratorConfig = {
      repo: 'org/repo',
      watched_prs: [{ number: 25 }],
      watched_issues: [{ number: 14 }],
    }
    const chans = new GitHubPlugin('#proj').desiredChannels(cfg).sort()
    expect(chans).toEqual(['#issue-14', '#issue-25'])
  })

  it('unions entry-attached channels into the desired set', () => {
    const cfg: OrchestratorConfig = {
      repo: 'org/repo',
      watched_prs: [{ number: 25, channels: ['#extra'] }],
      watched_issues: [{ number: 14, channels: ['#extra', '#more'] }],
    }
    const chans = new GitHubPlugin('#proj').desiredChannels(cfg).sort()
    expect(chans).toEqual(['#extra', '#issue-14', '#issue-25', '#more'])
  })

  it('returns empty when no watches configured', () => {
    expect(new GitHubPlugin('#proj').desiredChannels({})).toEqual([])
  })
})
