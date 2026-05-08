import { describe, it, expect } from 'bun:test'
import { BasePlugin, type PluginTickResult } from '../plugin.js'
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
