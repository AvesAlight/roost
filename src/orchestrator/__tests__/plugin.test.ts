import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import {
  BasePlugin,
  type PluginTickResult,
  type TaggedEvent,
  registerPlugin,
  unregisterPlugin,
  getPluginFactory,
} from '../plugin.js'
import { resolveRepoEntry, type OrchestratorConfig } from '../config.js'
import { dispatchTaggedEvents } from '../dispatch.js'
import type { RoostIrcClient } from '../../irc-client.js'

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

// End-to-end seam test: a stub plugin defines its own event kind and config
// slice, registers via the registry, and ticks through dispatch. Proves the
// three seams compose — registry, plugin-owned events, plugin config slice —
// without leaning on the GH plugins.

interface StubPluginConfig {
  rooms?: string[]
}

interface StubPluginState {
  ticks: number
}

class StubPlugin extends BasePlugin {
  readonly name = 'stub'

  desiredChannels(config: OrchestratorConfig): string[] {
    return this.pluginConfig<StubPluginConfig>(config)?.rooms ?? []
  }

  async runTick(config: OrchestratorConfig, prevState: unknown): Promise<PluginTickResult> {
    const slice = this.pluginConfig<StubPluginConfig>(config) ?? {}
    const prev = (prevState as StubPluginState | null) ?? { ticks: 0 }
    const rooms = slice.rooms ?? []
    const taggedEvents: TaggedEvent[] = rooms.length
      ? [{
          channels: this.resolveChannels(rooms, []),
          // Plugin-owned event kind, never seen at the orchestrator level.
          payload: { kind: 'oneline', text: `[stub_pulse] tick=${prev.ticks + 1}` },
        }]
      : []
    return { state: { ticks: prev.ticks + 1 }, taggedEvents, channels: rooms }
  }
}

describe('registry + plugin-owned events + per-plugin config (end-to-end)', () => {
  // registerPlugin throws on duplicate, so register the stub once for the
  // whole describe block and clean up after.
  beforeAll(() => {
    registerPlugin('stub', (defaultChannel) => new StubPlugin(defaultChannel))
  })
  afterAll(() => {
    unregisterPlugin('stub')
  })

  it('builds a stub plugin from config, ticks, and dispatches to its channels', async () => {
    const factory = getPluginFactory('stub')
    expect(factory).toBeTypeOf('function')
    const plugin = factory!('#default-leads', () => {})

    const config: OrchestratorConfig = {
      project: 'demo',
      plugins: { stub: { rooms: ['#demo-alpha', '#demo-beta'] } },
    }

    expect(plugin.desiredChannels(config).sort()).toEqual(['#demo-alpha', '#demo-beta'])

    const result = await plugin.runTick(config, null)
    expect((result.state as StubPluginState).ticks).toBe(1)
    expect(result.taggedEvents).toHaveLength(1)
    expect(result.taggedEvents[0]?.channels.sort()).toEqual(['#demo-alpha', '#demo-beta'])
    expect(result.taggedEvents[0]?.payload).toEqual({ kind: 'oneline', text: '[stub_pulse] tick=1' })

    // Real dispatch path: prove the orchestrator pipeline doesn't care about
    // the stub's event kind — it just writes channels × payload.
    const sent: Array<{ target: string; text: string }> = []
    const client = {
      say: (target: string, text: string) => {
        sent.push({ target, text })
        return { chunks: 1, mode: 'single' as const }
      },
    } as unknown as RoostIrcClient
    await dispatchTaggedEvents(result.taggedEvents, client)
    expect(sent.sort((a, b) => a.target.localeCompare(b.target))).toEqual([
      { target: '#demo-alpha', text: '[stub_pulse] tick=1' },
      { target: '#demo-beta', text: '[stub_pulse] tick=1' },
    ])
  })

  it('passes prevState through under the plugin name slice across ticks', async () => {
    const plugin = getPluginFactory('stub')!('#default-leads', () => {})
    const config: OrchestratorConfig = { plugins: { stub: { rooms: ['#room'] } } }

    const t1 = await plugin.runTick(config, null)
    const t2 = await plugin.runTick(config, t1.state)
    expect((t2.state as StubPluginState).ticks).toBe(2)
    expect(t2.taggedEvents[0]?.payload).toEqual({ kind: 'oneline', text: '[stub_pulse] tick=2' })
  })

  it('built-ins register via side-effect import of registry.ts', async () => {
    await import('../registry.js')
    expect(getPluginFactory('github-prs')).toBeTypeOf('function')
    expect(getPluginFactory('github-issues')).toBeTypeOf('function')
  })

  // The plugin's `name` field is the slot key for state.plugins[name]; the
  // registry key is the slot key for config.plugins[name]. If these drift,
  // state silently disappears across ticks. These assertions are the cheap
  // guard against that drift.
  it('couples class name to registry key for the stub plugin', () => {
    expect(getPluginFactory('stub')!('#x', () => {}).name).toBe('stub')
  })

  it('couples class name to registry key for both built-ins', async () => {
    await import('../registry.js')
    expect(getPluginFactory('github-prs')!('#x', () => {}).name).toBe('github-prs')
    expect(getPluginFactory('github-issues')!('#x', () => {}).name).toBe('github-issues')
  })
})

describe('registerPlugin collision guard', () => {
  it('throws when a name is registered twice', () => {
    registerPlugin('collide', (dc) => new StubPlugin(dc))
    try {
      expect(() => registerPlugin('collide', (dc) => new StubPlugin(dc))).toThrow(/already registered: collide/)
    } finally {
      unregisterPlugin('collide')
    }
  })

  it('rejects an external attempt to shadow a built-in name', async () => {
    await import('../registry.js')
    expect(() => registerPlugin('github-prs', (dc) => new StubPlugin(dc))).toThrow(/already registered: github-prs/)
  })

  it('unregisterPlugin returns true when present, false when absent', () => {
    registerPlugin('ephemeral', (dc) => new StubPlugin(dc))
    expect(unregisterPlugin('ephemeral')).toBe(true)
    expect(unregisterPlugin('ephemeral')).toBe(false)
  })
})
