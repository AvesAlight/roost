import { describe, it, expect, beforeAll } from 'bun:test'
import { startErgo, isErgoAvailable, type ErgoContext } from './helpers/ergo.js'
import { startMcp } from './helpers/mcp.js'
import { connectPeer } from './helpers/peer.js'
import { toolText } from './helpers/tool.js'

describe.if(isErgoAvailable())('outbound message tools', () => {
  let ergo: ErgoContext

  beforeAll(async () => {
    ergo = (await startErgo())!
  })

  it('channel_message: MCP send reaches peer', async () => {
    const mcp = await startMcp(ergo, 'out-mcp1')
    const peer = await connectPeer(ergo, 'out-peer1')

    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#out-msg' } })
    await peer.joinChannel('#out-msg')

    const result = await mcp.client.callTool({
      name: 'channel_message',
      arguments: { channel: '#out-msg', text: 'hello from mcp' },
    })
    expect(result.isError).toBeFalsy()
    expect(toolText(result)).toContain('sent to #out-msg')

    await peer.waitForMessage('#out-msg', m => m.nick === 'out-mcp1' && m.text === 'hello from mcp')
  })

  it('direct_message: MCP→peer DM arrives', async () => {
    const mcp = await startMcp(ergo, 'out-mcp2')
    const peer = await connectPeer(ergo, 'out-peer2')

    const result = await mcp.client.callTool({
      name: 'direct_message',
      arguments: { nick: 'out-peer2', text: 'dm from mcp' },
    })
    expect(result.isError).toBeFalsy()
    expect(toolText(result)).toContain('DM to out-peer2')

    // For DMs in irc-framework, event.target === recipient nick, so waitForMessage on own nick.
    await peer.waitForMessage('out-peer2', m => m.nick === 'out-mcp2' && m.text === 'dm from mcp')
  })

  it('direct_message: peer→MCP DM arrives as notification', async () => {
    const mcp = await startMcp(ergo, 'out-mcp3')
    const peer = await connectPeer(ergo, 'out-peer3')

    peer.say('out-mcp3', 'dm from peer')

    const n = await mcp.waitForNotification(
      n => n.meta.isDirect === 'true' && n.meta.sender === 'out-peer3' && n.content === 'dm from peer',
    )
    expect(n.content).toBe('dm from peer')
    expect(n.meta.isDirect).toBe('true')
  })

  it('channel_message: long multiline message reassembles to original text', async () => {
    // Peer helper uses plain irc-framework without draft/multiline cap, so ergo degrades
    // to individual PRIVMSGs for non-cap clients — peer cannot reassemble. Use two MCPs
    // (both negotiate draft/multiline) to test the full send+reassembly round-trip.
    const sender = await startMcp(ergo, 'out-mcp4')
    const receiver = await startMcp(ergo, 'out-mcp5')

    await sender.client.callTool({ name: 'channel_join', arguments: { channel: '#out-ml' } })
    await receiver.client.callTool({ name: 'channel_join', arguments: { channel: '#out-ml' } })

    const longText = 'a'.repeat(150) + '\n' + 'b'.repeat(150) + '\n' + 'c'.repeat(50)
    // 352 bytes total, two embedded newlines — forces draft/multiline batch

    const result = await sender.client.callTool({
      name: 'channel_message',
      arguments: { channel: '#out-ml', text: longText },
    })
    expect(result.isError).toBeFalsy()
    expect(toolText(result)).toContain('draft/multiline batch')

    const n = await receiver.waitForNotification(
      n => n.meta.channel === '#out-ml' && n.meta.sender === 'out-mcp4',
    )
    expect(n.content).toBe(longText)
  })

  it('channel_history: returns recent messages in order', async () => {
    const mcp = await startMcp(ergo, 'out-mcp6')
    const peer = await connectPeer(ergo, 'out-peer6')

    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#out-hist' } })
    await peer.joinChannel('#out-hist')

    // Send one at a time, waiting for each notification so the receive buffer
    // doesn't coalesce them into a single event.
    peer.say('#out-hist', 'hist-msg-1')
    await mcp.waitForNotification(n => n.meta.channel === '#out-hist' && n.content === 'hist-msg-1')

    peer.say('#out-hist', 'hist-msg-2')
    await mcp.waitForNotification(n => n.meta.channel === '#out-hist' && n.content === 'hist-msg-2')

    peer.say('#out-hist', 'hist-msg-3')
    await mcp.waitForNotification(n => n.meta.channel === '#out-hist' && n.content === 'hist-msg-3')

    const hist = await mcp.client.callTool({
      name: 'channel_history',
      arguments: { channel: '#out-hist' },
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
