import { describe, it, expect, beforeAll } from 'bun:test'
import { startErgo, isErgoAvailable, type ErgoContext } from './helpers/ergo.js'
import { startMcpInProcess } from './helpers/mcp-inprocess.js'
import { connectPeer } from './helpers/peer.js'
import { toolText } from './helpers/tool.js'

describe.if(isErgoAvailable())('inbound notifications', () => {
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

  it('peer→DM: isDirect=true, channel=peer nick', async () => {
    const mcp = await startMcpInProcess(ergo, 'ip-in-mcp2')
    const peer = await connectPeer(ergo, 'ip-in-peer2')

    peer.say('ip-in-mcp2', 'hello dm')

    const n = await mcp.waitForNotification(
      n => n.meta.isDirect === 'true' && n.content === 'hello dm',
    )

    expect(n.meta.sender).toBe('ip-in-peer2')
    expect(n.meta.channel).toBe('ip-in-peer2')
    expect(n.meta.isDirect).toBe('true')
    expect(n.meta.source).toBe('roost-irc')
    expect(n.meta.ts).toBeTruthy()
    expect(Number(n.meta.seq)).toBeGreaterThan(0)
  })

  it('peer JOIN: notification with event=join', async () => {
    const mcp = await startMcpInProcess(ergo, 'ip-in-mcp3')
    const peer = await connectPeer(ergo, 'ip-in-peer3')

    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-in-join' } })
    await peer.joinChannel('#ip-in-join')

    const n = await mcp.waitForNotification(
      n => n.meta.event === 'join' && n.meta.sender === 'ip-in-peer3',
    )

    expect(n.meta.event).toBe('join')
    expect(n.meta.sender).toBe('ip-in-peer3')
    expect(n.meta.channel).toBe('#ip-in-join')
    expect(n.meta.isDirect).toBe('false')
    expect(n.meta.source).toBe('roost-irc')
    expect(n.meta.ts).toBeTruthy()
    expect(Number(n.meta.seq)).toBeGreaterThan(0)
  })

  it('peer PART: notification with event=leave', async () => {
    const mcp = await startMcpInProcess(ergo, 'ip-in-mcp4')
    const peer = await connectPeer(ergo, 'ip-in-peer4')

    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-in-part' } })
    await peer.joinChannel('#ip-in-part')
    await mcp.waitForNotification(n => n.meta.event === 'join' && n.meta.sender === 'ip-in-peer4')

    await peer.leaveChannel('#ip-in-part')

    const n = await mcp.waitForNotification(
      n => n.meta.event === 'leave' && n.meta.sender === 'ip-in-peer4',
    )

    expect(n.meta.event).toBe('leave')
    expect(n.meta.sender).toBe('ip-in-peer4')
    expect(n.meta.channel).toBe('#ip-in-part')
    expect(n.meta.isDirect).toBe('false')
    expect(n.meta.source).toBe('roost-irc')
  })

  it('peer KICK: notification with event=leave, reason contains "kicked"', async () => {
    // kicker joins first to get channel op (+o as channel founder)
    const kicker = await connectPeer(ergo, 'ip-in-kicker')
    await kicker.joinChannel('#ip-in-kick')

    const mcp = await startMcpInProcess(ergo, 'ip-in-mcp5')
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-in-kick' } })

    const kicked = await connectPeer(ergo, 'ip-in-kicked')
    await kicked.joinChannel('#ip-in-kick')
    await mcp.waitForNotification(n => n.meta.event === 'join' && n.meta.sender === 'ip-in-kicked')

    kicker.kick('#ip-in-kick', 'ip-in-kicked', 'bye')

    const n = await mcp.waitForNotification(
      n => n.meta.event === 'leave' && n.meta.sender === 'ip-in-kicked',
    )

    expect(n.meta.event).toBe('leave')
    expect(n.meta.sender).toBe('ip-in-kicked')
    expect(n.meta.channel).toBe('#ip-in-kick')
    expect(n.meta.reason).toContain('kicked')
  })

  it('peer NICK: notification with event=nick and newNick', async () => {
    const mcp = await startMcpInProcess(ergo, 'ip-in-mcp6')
    const peer = await connectPeer(ergo, 'ip-in-peer6')

    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-in-nick' } })
    await peer.joinChannel('#ip-in-nick')
    await mcp.waitForNotification(n => n.meta.event === 'join' && n.meta.sender === 'ip-in-peer6')

    await peer.changeNick('ip-in-peer6b')

    const n = await mcp.waitForNotification(
      n => n.meta.event === 'nick' && n.meta.sender === 'ip-in-peer6',
    )

    expect(n.meta.event).toBe('nick')
    expect(n.meta.sender).toBe('ip-in-peer6')
    expect(n.meta.newNick).toBe('ip-in-peer6b')
    expect(n.meta.channel).toBe('')
    expect(n.meta.isDirect).toBe('false')
    expect(n.meta.source).toBe('roost-irc')
  })

  it('self JOIN/LEAVE suppressed: own events not emitted', async () => {
    const mcp = await startMcpInProcess(ergo, 'ip-in-mcp7')
    const peer = await connectPeer(ergo, 'ip-in-peer7')

    // MCP joins — own join must not emit a notification
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-in-self' } })
    // Peer join is our sync fence: any self-join notification would precede this
    await peer.joinChannel('#ip-in-self')
    await mcp.waitForNotification(n => n.meta.event === 'join' && n.meta.sender === 'ip-in-peer7')

    expect(mcp.notifications.find(n => n.meta.sender === 'ip-in-mcp7')).toBeUndefined()

    // MCP leaves — own leave must not emit a notification
    await mcp.client.callTool({ name: 'channel_leave', arguments: { channel: '#ip-in-self' } })
    // Use a peer DM as flush fence: any self-leave notification would precede this
    peer.say('ip-in-mcp7', 'ping')
    await mcp.waitForNotification(n => n.meta.isDirect === 'true' && n.content === 'ping')

    expect(mcp.notifications.find(n => n.meta.sender === 'ip-in-mcp7')).toBeUndefined()
  })

  it('peer NICK: history key renamed — channel_history newNick returns pre-rename DMs', async () => {
    const mcp = await startMcpInProcess(ergo, 'ip-in-mcp8')
    const peer = await connectPeer(ergo, 'ip-in-peer8')

    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-in-nick-hist' } })
    await peer.joinChannel('#ip-in-nick-hist')
    await mcp.waitForNotification(n => n.meta.event === 'join' && n.meta.sender === 'ip-in-peer8')

    peer.say('ip-in-mcp8', 'dm before rename')
    await mcp.waitForNotification(n => n.meta.isDirect === 'true' && n.content === 'dm before rename')

    await peer.changeNick('ip-in-peer8b')
    await mcp.waitForNotification(n => n.meta.event === 'nick' && n.meta.sender === 'ip-in-peer8')

    const histNew = await mcp.client.callTool({ name: 'channel_history', arguments: { channel: 'ip-in-peer8b' } })
    const histOld = await mcp.client.callTool({ name: 'channel_history', arguments: { channel: 'ip-in-peer8' } })

    expect(toolText(histNew)).toContain('dm before rename')
    expect(toolText(histOld)).toContain('no history for ip-in-peer8')
  })

  it('peer NICK: unread key renamed — emitUnreadSummary shows newNick', async () => {
    const mcp = await startMcpInProcess(ergo, 'ip-in-mcp9')
    const peer = await connectPeer(ergo, 'ip-in-peer9')

    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-in-nick-unread' } })
    await peer.joinChannel('#ip-in-nick-unread')
    await mcp.waitForNotification(n => n.meta.event === 'join' && n.meta.sender === 'ip-in-peer9')

    peer.say('ip-in-mcp9', 'dm for unread test')
    await mcp.waitForNotification(n => n.meta.isDirect === 'true' && n.content === 'dm for unread test')

    await peer.changeNick('ip-in-peer9b')
    await mcp.waitForNotification(n => n.meta.event === 'nick' && n.meta.sender === 'ip-in-peer9')

    const cursor = mcp.notifications.length
    const summaryP = mcp.waitForNotification(n => n.meta.event === 'unread-summary', 5000, cursor)
    await mcp.emitUnreadSummary()
    const summary = await summaryP

    expect(summary.content).toContain('ip-in-peer9b (1)')
    expect(summary.content).not.toContain('ip-in-peer9 (')
  })
})
