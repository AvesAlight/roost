import { describe, it, expect, beforeAll } from 'bun:test'
import { startErgo, isErgoAvailable, type ErgoContext } from './helpers/ergo.js'
import { startMcpInProcess } from './helpers/mcp-inprocess.js'
import { connectPeer } from './helpers/peer.js'

describe.if(isErgoAvailable())('inbound notifications (in-process)', () => {
  let ergo: ErgoContext

  beforeAll(async () => {
    ergo = (await startErgo())!
  })

  it('peer→channel: notification has correct meta', async () => {
    const mcp = await startMcpInProcess(ergo, 'ip-in-mcp1')
    const peer = await connectPeer(ergo, 'ip-in-peer1')

    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-in-chan' } })
    await peer.joinChannel('#ip-in-chan')

    peer.say('#ip-in-chan', 'hello channel')

    const n = await mcp.waitForNotification(
      n => n.meta.channel === '#ip-in-chan' && n.content === 'hello channel',
    )

    expect(n.content).toBe('hello channel')
    expect(n.meta.sender).toBe('ip-in-peer1')
    expect(n.meta.channel).toBe('#ip-in-chan')
    expect(n.meta.isDirect).toBe('false')
    expect(n.meta.source).toBe('roost-irc')
    expect(n.meta.ts).toBeTruthy()
    expect(Number(n.meta.seq)).toBeGreaterThan(0)
  })
})
