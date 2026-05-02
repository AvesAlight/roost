import { describe, it, expect, beforeAll } from 'bun:test'
import { startErgo, type ErgoContext } from './helpers/ergo.js'
import { startMcp } from './helpers/mcp.js'
import { connectPeer } from './helpers/peer.js'

let ergo: ErgoContext

describe('test helpers', () => {
  beforeAll(async () => {
    ergo = await startErgo()
    if (!ergo) return
  })

  it('ergo starts and is reachable', async () => {
    if (!ergo) { console.log('skipped — ergo not found'); return }
    expect(ergo.port).toBeGreaterThan(0)
  })

  it('peer can connect and join a channel', async () => {
    if (!ergo) { console.log('skipped — ergo not found'); return }
    const peer = await connectPeer(ergo, 'smoke-peer1')
    await peer.joinChannel('#smoke')
    expect(peer.nick).toBe('smoke-peer1')
  })

  it('mcp can connect and receives channel notifications', async () => {
    if (!ergo) { console.log('skipped — ergo not found'); return }
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
