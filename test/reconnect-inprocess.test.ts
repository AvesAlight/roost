import { describe, it, expect, beforeAll } from 'bun:test'
import { startErgo, isErgoAvailable, type ErgoContext } from './helpers/ergo.js'
import { startMcpInProcess } from './helpers/mcp-inprocess.js'
import { connectPeer } from './helpers/peer.js'
import type { ChannelNotification } from './helpers/mcp-core.js'

describe.if(isErgoAvailable())('reconnect, ordering, and nick collision (in-process)', () => {
  let ergo: ErgoContext

  beforeAll(async () => {
    ergo = (await startErgo())!
  })

  it('burst of N messages from different peers → seq strictly monotonic', async () => {
    const N = 5
    const mcp = await startMcpInProcess(ergo, 'ip-seq-mcp')
    const peers = await Promise.all(
      Array.from({ length: N }, (_, i) => connectPeer(ergo, `ip-seq-peer-${i}`)),
    )

    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-seq-test' } })
    await Promise.all(peers.map(p => p.joinChannel('#ip-seq-test')))

    // Drain join notifications so they don't interfere with message collection
    await Promise.all(
      peers.map(p => mcp.waitForNotification(n => n.meta.event === 'join' && n.meta.sender === p.nick)),
    )

    // Send all messages simultaneously — each peer→channel pair gets its own
    // recv buffer, so N messages → N separate flush timers → N notifications
    peers.forEach((p, i) => p.say('#ip-seq-test', `seq-msg-${i}`))

    let cursor = 0
    const notifs: ChannelNotification[] = []
    for (let i = 0; i < N; i++) {
      const n = await mcp.waitForNotification(
        n => n.meta.channel === '#ip-seq-test' && n.content.startsWith('seq-msg-'),
        5000,
        cursor,
      )
      cursor = n.cursor
      notifs.push(n)
    }

    const seqs = notifs.map(n => Number(n.meta.seq))
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1])
    }
  }, 15_000)

  it('two MCPs with same nick → second fails cleanly; first unaffected', async () => {
    // Observed: ergo refuses nick collision with 433 ERR_NICKNAMEINUSE.
    // irc-framework auto_reconnects but always gets 433. startMcpInProcess's 5s
    // readiness poll expires and throws.
    const mcp1 = await startMcpInProcess(ergo, 'ip-collision-mcp')

    await expect(startMcpInProcess(ergo, 'ip-collision-mcp')).rejects.toThrow('IRC not ready within 5s')

    // First MCP is unaffected by the collision attempt
    const r = await mcp1.client.callTool({ name: 'channel_who', arguments: { channel: '#_ready' } })
    expect(r.isError).toBeFalsy()
  }, 15_000)
})
