import { describe, it, expect, spyOn } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeClient } from './helpers/offline-client.js'
import { startErgoDedicated, isErgoAvailable } from './helpers/ergo.js'
import { RoostIrcClientImpl } from '../src/irc-client-impl.js'
import { connectAndWait } from '../src/orchestrator/dispatch.js'
import { deliver, joinDesired } from '../src/orchestrator.js'
import { loadOutbox } from '../src/orchestrator/config.js'

function quietStderr() {
  return spyOn(process.stderr, 'write').mockImplementation(() => true)
}

// A rejected JOIN has to fail join() right away with the server's reason.
// Before, every rejection looked like a 5s timeout and nothing was logged.
describe('join rejection numerics (offline)', () => {
  const cases: Array<{ name: string; params: string[]; expectReason: string }> = [
    { name: '405 (mapped to irc error)', params: ['test-bot', '#full', 'You have joined too many channels'], expectReason: '405' },
    { name: '474 (mapped to irc error)', params: ['test-bot', '#full', 'Cannot join channel (+b)'], expectReason: '474' },
    { name: '403 (unmapped numeric)', params: ['test-bot', '#full', 'No such channel'], expectReason: '403' },
  ]
  for (const c of cases) {
    it(`${c.name} resolves join() with ok:false and the reason, and logs it`, async () => {
      const client = makeClient()
      const write = quietStderr()
      try {
        const pending = client.join('#Full')
        client.irc.command_handler.dispatch({ command: c.expectReason, params: c.params, tags: {} })
        const started = Date.now()
        const r = await pending
        expect(Date.now() - started).toBeLessThan(1000)
        expect(r.ok).toBe(false)
        expect(r.reason).toContain(c.expectReason)
        const logged = write.mock.calls.map(x => String(x[0])).join('')
        expect(logged).toContain(`join #full rejected: ${c.expectReason}`)
      } finally {
        write.mockRestore()
      }
    })
  }
})

describe.if(isErgoAvailable())('channel limit (real ergo, max-channels-per-client: 2)', () => {
  it('third join fails fast with 405; a message for it is queued, not lost', async () => {
    const ergo = await startErgoDedicated({ maxChannelsPerClient: 2 })
    if (!ergo) return
    const stateDir = await mkdtemp(join(tmpdir(), 'roost-outbox-'))
    const write = quietStderr()
    const client = new RoostIrcClientImpl({ nick: 'limit-bot', autoJoin: [], historySize: 0, joinHistoryLines: 0, joinHistoryMinutes: 0 })
    try {
      await connectAndWait(client, { host: ergo.host, port: ergo.port, nick: 'limit-bot' }, [])
      const desired = new Set(['#lim-a', '#lim-b', '#lim-c'])

      const started = Date.now()
      const failed = await joinDesired(client, desired)
      expect(Date.now() - started).toBeLessThan(4000)
      expect([...failed.keys()]).toEqual(['#lim-c'])
      expect(failed.get('#lim-c')).toContain('405')

      const logs: string[] = []
      const d = await deliver(stateDir, client, [
        { channels: ['#lim-a'], text: 'to a' },
        { channels: ['#lim-c'], text: 'to c' },
      ], desired, l => logs.push(l))
      expect(d.posted).toBe(1)
      expect(d.held).toBe(1)
      expect((await loadOutbox(stateDir)).map(e => [e.channel, e.text])).toEqual([['#lim-c', 'to c']])
    } finally {
      write.mockRestore()
      client.quit()
      await ergo.cleanup()
      await rm(stateDir, { recursive: true, force: true })
    }
  }, 20_000)
})
