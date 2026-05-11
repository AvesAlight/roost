import { describe, it, expect, beforeAll } from 'bun:test'
import { startErgo, startErgoDedicated, isErgoAvailable, type ErgoContext } from './helpers/ergo.js'
import { startMcpInProcess } from './helpers/mcp-inprocess.js'
import { startMcp } from './helpers/mcp.js'
import { connectPeer } from './helpers/peer.js'
import { messagePredicate, eventPredicate, type ChannelNotification } from './helpers/mcp-core.js'

describe.if(isErgoAvailable())('reconnect, ordering, and nick collision', () => {
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
      peers.map(p => mcp.waitForNotification(eventPredicate('join', { sender: p.nick }))),
    )

    // Send all messages simultaneously — each peer→channel pair gets its own
    // recv buffer, so N messages → N separate flush timers → N notifications
    peers.forEach((p, i) => p.say('#ip-seq-test', `seq-msg-${i}`))

    let cursor = 0
    const notifs: ChannelNotification[] = []
    for (let i = 0; i < N; i++) {
      const n = await mcp.waitForNotification(
        n => n.meta.event === 'message' && n.meta.channel === '#ip-seq-test' && n.content.startsWith('seq-msg-'),
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

// Subprocess-only: tests binary reconnect behavior after ergo process death.
describe.if(isErgoAvailable())('reconnect (subprocess)', () => {
  it('kill + restart ergo → MCP auto-reconnects; irc_ready flips false then true', async () => {
    const dedicated = await startErgoDedicated()
    if (!dedicated) return

    try {
      const mcp = await startMcp(dedicated, 'reconnect-mcp')

      // Confirm ready
      let r = await mcp.client.callTool({ name: 'channel_who', arguments: { channel: '#_ready' } })
      expect(r.isError).toBeFalsy()

      // irc-framework only schedules auto_reconnect if registered_ms_ago > 5000.
      // Wait 6s so the connection is "safely registered" before we kill it.
      await new Promise<void>(res => setTimeout(res, 6000))

      // Kill ergo — socket close fires, irc_ready goes false
      await dedicated.kill()

      const notReadyDeadline = Date.now() + 5000
      while (true) {
        r = await mcp.client.callTool({ name: 'channel_who', arguments: { channel: '#_ready' } })
        if (r.isError) break
        if (Date.now() > notReadyDeadline) throw new Error('MCP did not go not-ready after ergo kill')
        await new Promise<void>(res => setTimeout(res, 100))
      }
      const notReadyText = (((r.content as unknown[])[0] ?? {}) as { text?: string }).text ?? ''
      expect(notReadyText).toContain('not ready')

      // Restart ergo on the same port — MCP auto_reconnect kicks in
      await dedicated.restart()

      const readyDeadline = Date.now() + 15000
      while (true) {
        r = await mcp.client.callTool({ name: 'channel_who', arguments: { channel: '#_ready' } })
        if (!r.isError) break
        if (Date.now() > readyDeadline) throw new Error('MCP did not reconnect within 15s')
        await new Promise<void>(res => setTimeout(res, 200))
      }
      expect(r.isError).toBeFalsy()
    } finally {
      await dedicated.cleanup()
    }
  }, 30_000)

  it('kill + restart → disconnected then reconnected notification; channels auto-rejoined', async () => {
    const dedicated = await startErgoDedicated()
    if (!dedicated) return

    try {
      const mcp = await startMcp(dedicated, 'rc-notif-mcp')

      // Join a channel before the disruption
      await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#rc-notif-ch' } })

      // Wait 6s so irc-framework will schedule auto_reconnect after the kill
      await new Promise<void>(res => setTimeout(res, 6000))

      // Kill ergo — expect a disconnected notification
      const disconnPromise = mcp.waitForNotification(eventPredicate('disconnected'), 8000)
      await dedicated.kill()
      const disconnNotif = await disconnPromise
      expect(disconnNotif.content).toContain('disconnected from IRC')

      // Restart ergo — expect a reconnected notification listing the channel
      await dedicated.restart()
      const reconnNotif = await mcp.waitForNotification(eventPredicate('reconnected'), 15000)
      expect(reconnNotif.content).toContain('reconnected to IRC')
      expect(reconnNotif.content).toContain('#rc-notif-ch')

      // Verify the channel is actually re-joined: a new peer can message it and MCP receives it
      const peer = await connectPeer(dedicated, 'rc-notif-peer')
      await peer.joinChannel('#rc-notif-ch')
      peer.say('#rc-notif-ch', 'post-reconnect-hello')
      const msgNotif = await mcp.waitForNotification(
        messagePredicate({ channel: '#rc-notif-ch', content: 'post-reconnect-hello' }),
        10000,
      )
      expect(msgNotif.content).toBe('post-reconnect-hello')
    } finally {
      await dedicated.cleanup()
    }
  }, 50_000)
})
