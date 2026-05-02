import { describe, it, expect, beforeAll } from 'bun:test'
import { startErgo, isErgoAvailable, type ErgoContext } from './helpers/ergo.js'
import { startMcp } from './helpers/mcp.js'
import { connectPeer } from './helpers/peer.js'

describe.if(isErgoAvailable())('inbound notifications', () => {
  let ergo: ErgoContext

  beforeAll(async () => {
    ergo = (await startErgo())!
  })

  it('peer→channel: notification has correct meta', async () => {
    const mcp = await startMcp(ergo, 'in-mcp1')
    const peer = await connectPeer(ergo, 'in-peer1')

    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#in-chan' } })
    await peer.joinChannel('#in-chan')

    peer.say('#in-chan', 'hello channel')

    const n = await mcp.waitForNotification(
      n => n.meta.channel === '#in-chan' && n.content === 'hello channel',
    )

    expect(n.content).toBe('hello channel')
    expect(n.meta.sender).toBe('in-peer1')
    expect(n.meta.channel).toBe('#in-chan')
    expect(n.meta.isDirect).toBe('false')
    expect(n.meta.source).toBe('roost-irc')
    expect(n.meta.ts).toBeTruthy()
    expect(Number(n.meta.seq)).toBeGreaterThan(0)
  })

  it('peer→DM: isDirect=true, channel=peer nick', async () => {
    const mcp = await startMcp(ergo, 'in-mcp2')
    const peer = await connectPeer(ergo, 'in-peer2')

    peer.say('in-mcp2', 'hello dm')

    const n = await mcp.waitForNotification(
      n => n.meta.isDirect === 'true' && n.content === 'hello dm',
    )

    expect(n.meta.sender).toBe('in-peer2')
    expect(n.meta.channel).toBe('in-peer2')
    expect(n.meta.isDirect).toBe('true')
    expect(n.meta.source).toBe('roost-irc')
    expect(n.meta.ts).toBeTruthy()
    expect(Number(n.meta.seq)).toBeGreaterThan(0)
  })

  it('peer JOIN: notification with event=join', async () => {
    const mcp = await startMcp(ergo, 'in-mcp3')
    const peer = await connectPeer(ergo, 'in-peer3')

    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#in-join' } })
    await peer.joinChannel('#in-join')

    const n = await mcp.waitForNotification(
      n => n.meta.event === 'join' && n.meta.sender === 'in-peer3',
    )

    expect(n.meta.event).toBe('join')
    expect(n.meta.sender).toBe('in-peer3')
    expect(n.meta.channel).toBe('#in-join')
    expect(n.meta.isDirect).toBe('false')
    expect(n.meta.source).toBe('roost-irc')
    expect(n.meta.ts).toBeTruthy()
    expect(Number(n.meta.seq)).toBeGreaterThan(0)
  })

  it('peer PART: notification with event=leave', async () => {
    const mcp = await startMcp(ergo, 'in-mcp4')
    const peer = await connectPeer(ergo, 'in-peer4')

    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#in-part' } })
    await peer.joinChannel('#in-part')
    await mcp.waitForNotification(n => n.meta.event === 'join' && n.meta.sender === 'in-peer4')

    await peer.leaveChannel('#in-part')

    const n = await mcp.waitForNotification(
      n => n.meta.event === 'leave' && n.meta.sender === 'in-peer4',
    )

    expect(n.meta.event).toBe('leave')
    expect(n.meta.sender).toBe('in-peer4')
    expect(n.meta.channel).toBe('#in-part')
    expect(n.meta.isDirect).toBe('false')
    expect(n.meta.source).toBe('roost-irc')
  })

  it('peer KICK: notification with event=leave, reason contains "kicked"', async () => {
    // kicker joins first to get channel op (+o as channel founder)
    const kicker = await connectPeer(ergo, 'in-kicker')
    await kicker.joinChannel('#in-kick')

    const mcp = await startMcp(ergo, 'in-mcp5')
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#in-kick' } })

    const kicked = await connectPeer(ergo, 'in-kicked')
    await kicked.joinChannel('#in-kick')
    await mcp.waitForNotification(n => n.meta.event === 'join' && n.meta.sender === 'in-kicked')

    kicker.kick('#in-kick', 'in-kicked', 'bye')

    const n = await mcp.waitForNotification(
      n => n.meta.event === 'leave' && n.meta.sender === 'in-kicked',
    )

    expect(n.meta.event).toBe('leave')
    expect(n.meta.sender).toBe('in-kicked')
    expect(n.meta.channel).toBe('#in-kick')
    expect(n.meta.reason).toContain('kicked')
  })

  it('peer NICK: notification with event=nick and newNick', async () => {
    const mcp = await startMcp(ergo, 'in-mcp6')
    const peer = await connectPeer(ergo, 'in-peer6')

    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#in-nick' } })
    await peer.joinChannel('#in-nick')
    await mcp.waitForNotification(n => n.meta.event === 'join' && n.meta.sender === 'in-peer6')

    await peer.changeNick('in-peer6b')

    const n = await mcp.waitForNotification(
      n => n.meta.event === 'nick' && n.meta.sender === 'in-peer6',
    )

    expect(n.meta.event).toBe('nick')
    expect(n.meta.sender).toBe('in-peer6')
    expect(n.meta.newNick).toBe('in-peer6b')
    expect(n.meta.isDirect).toBe('false')
    expect(n.meta.source).toBe('roost-irc')
  })

  it('self JOIN/LEAVE suppressed: own events not emitted', async () => {
    const mcp = await startMcp(ergo, 'in-mcp7')
    const peer = await connectPeer(ergo, 'in-peer7')

    // MCP joins — own join must not emit a notification
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#in-self' } })
    // Peer join is our sync fence: any self-join notification would precede this
    await peer.joinChannel('#in-self')
    await mcp.waitForNotification(n => n.meta.event === 'join' && n.meta.sender === 'in-peer7')

    expect(mcp.notifications.find(n => n.meta.sender === 'in-mcp7')).toBeUndefined()

    // MCP leaves — own leave must not emit a notification
    await mcp.client.callTool({ name: 'channel_leave', arguments: { channel: '#in-self' } })
    // Use a peer DM as flush fence: any self-leave notification would precede this
    peer.say('in-mcp7', 'ping')
    await mcp.waitForNotification(n => n.meta.isDirect === 'true' && n.content === 'ping')

    expect(mcp.notifications.find(n => n.meta.sender === 'in-mcp7')).toBeUndefined()
  })
})
