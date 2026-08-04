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