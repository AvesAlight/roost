import { describe, it, expect, beforeAll } from 'bun:test'
import { startErgo, isErgoAvailable, type ErgoContext } from './helpers/ergo.js'
import { startMcp } from './helpers/mcp.js'
import { connectPeer } from './helpers/peer.js'

describe.if(isErgoAvailable())('test helpers', () => {
  let ergo: ErgoContext

  beforeAll(async () => {
    ergo = (await startErgo())!
  })

  it('ergo starts and is reachable', async () => {
    expect(ergo.port).toBeGreaterThan(0)
  })

  it('peer can connect and join a channel', async () => {
    const peer = await connectPeer(ergo, 'smoke-peer1')
    await peer.joinChannel('#smoke')
    expect(peer.nick).toBe('smoke-peer1')
  })

  it('mcp can connect and receives channel notifications', async () => {
    const mcp = await startMcp(ergo, 'smoke-mcp1')
    const peer = await connectPeer(ergo, 'smoke-peer2')

    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#smoke-mcp' } })
    await peer.joinChannel('#smoke-mcp')

    peer.say('#smoke-mcp', 'hello from peer')
    const n = await mcp.waitForNotification(
      (n) => n.meta.channel === '#smoke-mcp' && n.content.includes('hello from peer'),
    )
    expect(n.meta.sender).toBe('smoke-peer2')
  })
})
