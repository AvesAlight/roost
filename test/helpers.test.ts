import { describe, it, expect, beforeAll } from 'bun:test'
import { startErgo, isErgoAvailable, type ErgoContext } from './helpers/ergo.js'
import { startMcp } from './helpers/mcp.js'
import { startMcpInProcess } from './helpers/mcp-inprocess.js'
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

  it('waitForNotification removes waiter on timeout', async () => {
    const mcp = await startMcpInProcess(ergo, 'waiter-timeout-mcp')
    await expect(mcp.waitForNotification(() => false, 50)).rejects.toThrow('timed out')
    expect(mcp.waiterCount()).toBe(0)
  })

  it('waitForMessage removes waiter on timeout — issue #172 regression', async () => {
    const peer = await connectPeer(ergo, 'wfm-timeout-peer')
    await peer.joinChannel('#wfm-timeout')
    await expect(peer.waitForMessage('#wfm-timeout', () => false, 50)).rejects.toThrow('timed out')
    expect(peer.pendingWaiterCount).toBe(0)
  })

  it('waitForMessage removes waiter on success', async () => {
    const sender = await connectPeer(ergo, 'wfm-success-sender')
    const receiver = await connectPeer(ergo, 'wfm-success-receiver')
    await sender.joinChannel('#wfm-success')
    await receiver.joinChannel('#wfm-success')
    const msgP = receiver.waitForMessage('#wfm-success', m => m.text === 'wfm-probe')
    sender.say('#wfm-success', 'wfm-probe')
    await msgP
    expect(receiver.pendingWaiterCount).toBe(0)
  })

  it('waitForNotification removes waiter on success', async () => {
    const mcp = await startMcpInProcess(ergo, 'waiter-success-mcp')
    const peer = await connectPeer(ergo, 'waiter-success-peer')

    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#waiter-cleanup' } })
    await peer.joinChannel('#waiter-cleanup')

    const notifP = mcp.waitForNotification(
      n => n.meta.channel === '#waiter-cleanup' && n.content.includes('cleanup-probe'),
    )
    peer.say('#waiter-cleanup', 'cleanup-probe')
    await notifP
    expect(mcp.waiterCount()).toBe(0)
  })
})
