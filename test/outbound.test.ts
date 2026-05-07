import { describe, it, expect, beforeAll } from 'bun:test'
import { startErgo, isErgoAvailable, type ErgoContext } from './helpers/ergo.js'
import { startMcpInProcess } from './helpers/mcp-inprocess.js'
import { connectPeer } from './helpers/peer.js'
import { toolText } from './helpers/tool.js'

describe.if(isErgoAvailable())('outbound message tools', () => {
  let ergo: ErgoContext

  beforeAll(async () => {
    ergo = (await startErgo())!
  })

  it('channel_message: MCP send reaches peer', async () => {
    const mcp = await startMcpInProcess(ergo, 'ip-out-mcp1')
    const peer = await connectPeer(ergo, 'ip-out-peer1')

    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-out-msg' } })
    await peer.joinChannel('#ip-out-msg')

    const messageSeen = peer.waitForMessage('#ip-out-msg', m => m.nick === 'ip-out-mcp1' && m.text === 'hello from mcp')
    const result = await mcp.client.callTool({
      name: 'channel_message',
      arguments: { channel: '#ip-out-msg', text: 'hello from mcp' },
    })
    expect(result.isError).toBeFalsy()
    expect(toolText(result)).toContain('sent to #ip-out-msg')

    await messageSeen
  })

  it('direct_message: MCP→peer DM arrives', async () => {
    const mcp = await startMcpInProcess(ergo, 'ip-out-mcp2')
    const peer = await connectPeer(ergo, 'ip-out-peer2')

    // For DMs in irc-framework, event.target === recipient nick, so waitForMessage on own nick.
    const dmSeen = peer.waitForMessage('ip-out-peer2', m => m.nick === 'ip-out-mcp2' && m.text === 'dm from mcp')
    const result = await mcp.client.callTool({
      name: 'direct_message',
      arguments: { nick: 'ip-out-peer2', text: 'dm from mcp' },
    })
    expect(result.isError).toBeFalsy()
    expect(toolText(result)).toContain('DM to ip-out-peer2')

    await dmSeen
  })

  it('direct_message: peer→MCP DM arrives as notification', async () => {
    const mcp = await startMcpInProcess(ergo, 'ip-out-mcp3')
    const peer = await connectPeer(ergo, 'ip-out-peer3')

    peer.say('ip-out-mcp3', 'dm from peer')

    const n = await mcp.waitForNotification(
      n => n.meta.isDirect === 'true' && n.meta.sender === 'ip-out-peer3' && n.content.startsWith('dm from peer'),
    )
    expect(n.content).toContain('dm from peer')
    expect(n.meta.isDirect).toBe('true')
  })

  it('channel_message: long multiline message reassembles to original text', async () => {
    // Peer helper uses plain irc-framework without draft/multiline cap, so ergo degrades
    // to individual PRIVMSGs for non-cap clients — peer cannot reassemble. Use two MCPs
    // (both negotiate draft/multiline) to test the full send+reassembly round-trip.
    const sender = await startMcpInProcess(ergo, 'ip-out-mcp4')
    const receiver = await startMcpInProcess(ergo, 'ip-out-mcp5')

    await Promise.all([
      sender.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-out-ml' } }),
      receiver.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-out-ml' } }),
    ])

    const longText = 'a'.repeat(150) + '\n' + 'b'.repeat(150) + '\n' + 'c'.repeat(50)
    // 352 bytes total, two embedded newlines — forces draft/multiline batch

    const result = await sender.client.callTool({
      name: 'channel_message',
      arguments: { channel: '#ip-out-ml', text: longText },
    })
    expect(result.isError).toBeFalsy()
    expect(toolText(result)).toContain('draft/multiline batch')

    const n = await receiver.waitForNotification(
      n => n.meta.channel === '#ip-out-ml' && n.meta.sender === 'ip-out-mcp4' && !n.meta.event,
    )
    expect(n.content.startsWith(longText)).toBe(true)
  })

  it('channel_join: cache hit — second join returns ok without IRC round-trip', async () => {
    const mcp = await startMcpInProcess(ergo, 'ip-out-cache1')

    const r1 = await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-out-cache' } })
    expect(r1.isError).toBeFalsy()

    const r2 = await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-out-cache' } })
    expect(r2.isError).toBeFalsy()
    expect(toolText(r2)).toContain('joined #ip-out-cache')
  })

  it('channel_history: returns recent messages in order', async () => {
    const mcp = await startMcpInProcess(ergo, 'ip-out-mcp6')
    const peer = await connectPeer(ergo, 'ip-out-peer6')

    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-out-hist' } })
    await peer.joinChannel('#ip-out-hist')

    // Send one at a time, waiting for each notification so the receive buffer
    // doesn't coalesce them into a single event.
    peer.say('#ip-out-hist', 'hist-msg-1')
    await mcp.waitForNotification(n => n.meta.channel === '#ip-out-hist' && n.content.startsWith('hist-msg-1'))

    peer.say('#ip-out-hist', 'hist-msg-2')
    await mcp.waitForNotification(n => n.meta.channel === '#ip-out-hist' && n.content.startsWith('hist-msg-2'))

    peer.say('#ip-out-hist', 'hist-msg-3')
    await mcp.waitForNotification(n => n.meta.channel === '#ip-out-hist' && n.content.startsWith('hist-msg-3'))

    const hist = await mcp.client.callTool({
      name: 'channel_history',
      arguments: { channel: '#ip-out-hist' },
    })
    expect(hist.isError).toBeFalsy()
    const text = toolText(hist)
    const idx1 = text.indexOf('hist-msg-1')
    const idx2 = text.indexOf('hist-msg-2')
    const idx3 = text.indexOf('hist-msg-3')
    expect(idx1).toBeGreaterThanOrEqual(0)
    expect(idx2).toBeGreaterThan(idx1)
    expect(idx3).toBeGreaterThan(idx2)
  })
})
