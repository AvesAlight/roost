import { describe, it, expect } from 'bun:test'
import { runOneTick } from '../../orchestrator.js'
import type { Plugin } from '../plugin.js'
import type { OrchestratorConfig } from '../config.js'

// runOneTick passes config straight through to plugins and reads no config
// fields itself, so a minimal stub satisfies it.
const config = { project: 'proj' } as unknown as OrchestratorConfig

function stubPlugin(name: string, runTick: Plugin['runTick']): Plugin {
  return { name, desiredChannels: () => [], runTick } as unknown as Plugin
}

// seed: true → prev=null (no state file read); dryRun: true → no state written.
// stateDir is never touched, so any path is safe to pass.
const opts = { seed: true, dryRun: true }

describe('runOneTick — per-plugin error isolation', () => {
  it("one plugin's throw does not sink sibling messages (tick stays alive, crash logged)", async () => {
    const logs: string[] = []
    const log = (msg: string) => logs.push(msg)
    const fineA = stubPlugin('fine-a', async () => ({
      state: { a: 1 },
      messages: [{ channels: ['#a'], text: 'a-survived' }],
      channels: ['#a'],
    }))
    const boom = stubPlugin('boom', async () => { throw new Error('kaboom') })
    const fineB = stubPlugin('fine-b', async () => ({
      state: { b: 2 },
      messages: [{ channels: ['#b'], text: 'b-survived' }],
      channels: ['#b'],
    }))

    const result = await runOneTick('/unused', config, [fineA, boom, fineB], opts, log)

    // Both siblings' messages survive, in plugin order; boom's crash is logged,
    // not propagated. Pre-isolation, the Promise.all rejected and the daemon's
    // outer catch dropped every plugin's messages for the tick.
    expect(result.messages.map(m => m.text)).toEqual(['a-survived', 'b-survived'])
    expect(result.channels).toEqual(['#a', '#b'])
    expect(logs.some(l => l.includes('plugin boom tick crashed') && l.includes('kaboom'))).toBe(true)
  })

  it('survives every plugin throwing (no rejection, empty dispatch, each crash logged)', async () => {
    const logs: string[] = []
    const log = (msg: string) => logs.push(msg)
    const boom1 = stubPlugin('boom1', async () => { throw new Error('one') })
    const boom2 = stubPlugin('boom2', async () => { throw new Error('two') })

    const result = await runOneTick('/unused', config, [boom1, boom2], opts, log)

    expect(result.messages).toEqual([])
    expect(result.channels).toEqual([])
    expect(logs.some(l => l.includes('plugin boom1 tick crashed') && l.includes('one'))).toBe(true)
    expect(logs.some(l => l.includes('plugin boom2 tick crashed') && l.includes('two'))).toBe(true)
  })
})
describe('runOneTick — per-plugin poll interval', () => {
  const T = 60_000
  function counting(name: string) {
    const calls = { n: 0 }
    const plugin = stubPlugin(name, async () => {
      calls.n++
      return { state: { n: calls.n }, messages: [{ channels: [`#${name}`], text: `${name}-${calls.n}` }], channels: [`#${name}-dyn`] }
    })
    return { plugin, calls }
  }
  const cfg = (plugins: Record<string, unknown>) => ({ project: 'proj', plugins }) as unknown as OrchestratorConfig
  const quiet = () => {}

  it('a plugin with no interval runs every tick (global fallback)', async () => {
    const a = counting('a')
    const schedule = new Map()
    for (let i = 0; i < 3; i++) await runOneTick('/unused', cfg({ a: {} }), [a.plugin], opts, quiet, schedule, i * T)
    expect(a.calls.n).toBe(3)
  })

  it('an override of 2x the tick runs every other tick while a sibling still runs every tick', async () => {
    const slow = counting('slow')
    const fast = counting('fast')
    const config = cfg({ slow: { interval_seconds: 120 }, fast: {} })
    const schedule = new Map()
    const texts: string[][] = []
    for (let i = 0; i < 4; i++) {
      const r = await runOneTick('/unused', config, [slow.plugin, fast.plugin], opts, quiet, schedule, i * T)
      texts.push(r.messages.map(m => m.text))
    }
    expect(slow.calls.n).toBe(2)
    expect(fast.calls.n).toBe(4)
    expect(texts).toEqual([['slow-1', 'fast-1'], ['fast-2'], ['slow-2', 'fast-3'], ['fast-4']])
  })

  it('a skipped plugin keeps its channels so reconcile does not part them', async () => {
    const slow = counting('slow')
    const config = cfg({ slow: { interval_seconds: 120 } })
    const schedule = new Map()
    await runOneTick('/unused', config, [slow.plugin], opts, quiet, schedule, 0)
    const r = await runOneTick('/unused', config, [slow.plugin], opts, quiet, schedule, T)
    expect(slow.calls.n).toBe(1)
    expect(r.channels).toEqual(['#slow-dyn'])
  })

  it('a bad interval falls back to every tick and logs it', async () => {
    const a = counting('a')
    const logs: string[] = []
    const schedule = new Map()
    for (let i = 0; i < 2; i++) await runOneTick('/unused', cfg({ a: { interval_seconds: 'soon' } }), [a.plugin], opts, m => logs.push(m), schedule, i * T)
    expect(a.calls.n).toBe(2)
    expect(logs.some(l => l.includes('plugins.a.interval_seconds'))).toBe(true)
  })

  it('a crash keeps the last good channels so reconcile does not part them', async () => {
    let n = 0
    const flaky = stubPlugin('flaky', async () => {
      n++
      if (n === 2) throw new Error('x')
      return { state: {}, messages: [], channels: ['#flaky-dyn'] }
    })
    const schedule = new Map()
    await runOneTick('/unused', cfg({}), [flaky], opts, quiet, schedule, 0)
    const r = await runOneTick('/unused', cfg({}), [flaky], opts, quiet, schedule, T)
    expect(n).toBe(2)
    expect(r.channels).toEqual(['#flaky-dyn'])
  })

  it('a crash counts as a run so a failing plugin is not retried early', async () => {
    let n = 0
    const boom = stubPlugin('boom', async () => { n++; throw new Error('x') })
    const config = cfg({ boom: { interval_seconds: 120 } })
    const schedule = new Map()
    await runOneTick('/unused', config, [boom], opts, quiet, schedule, 0)
    await runOneTick('/unused', config, [boom], opts, quiet, schedule, T)
    expect(n).toBe(1)
  })

  it('without a schedule every plugin runs (one-shot modes)', async () => {
    const slow = counting('slow')
    const config = cfg({ slow: { interval_seconds: 120 } })
    await runOneTick('/unused', config, [slow.plugin], opts, quiet)
    await runOneTick('/unused', config, [slow.plugin], opts, quiet)
    expect(slow.calls.n).toBe(2)
  })
})
