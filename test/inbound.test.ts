import { describe, it, expect, beforeAll } from 'bun:test'
import { startErgo, isErgoAvailable, type ErgoContext } from './helpers/ergo.js'
import { startMcpInProcess } from './helpers/mcp-inprocess.js'
import { messagePredicate, eventPredicate } from './helpers/mcp-core.js'
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
      messagePredicate({ channel: '#ip-in-chan', content: 'hello channel' }),
    )

    expect(n.content).toBe('hello channel')
    expect(n.meta.event).toBe('message')
    expect(n.meta.sender).toBe('ip-in-peer1')
    expect(n.meta.channel).toBe('#ip-in-chan')
    expect(n.meta.isDirect).toBe('false')
    expect(n.meta.ts).toBeTruthy()
    expect(Number(n.meta.seq)).toBeGreaterThan(0)
  })

  it('peer→DM: isDirect=true, channel=peer nick', async () => {
    const mcp = await startMcpInProcess(ergo, 'ip-in-mcp2')
    const peer = await connectPeer(ergo, 'ip-in-peer2')

    peer.say('ip-in-mcp2', 'hello dm')

    const n = await mcp.waitForNotification(
      messagePredicate({ isDirect: true, content: 'hello dm' }),
    )

    expect(n.meta.event).toBe('message')
    expect(n.meta.sender).toBe('ip-in-peer2')
    expect(n.meta.channel).toBe('ip-in-peer2')
    expect(n.meta.isDirect).toBe('true')
    expect(n.meta.ts).toBeTruthy()
    expect(Number(n.meta.seq)).toBeGreaterThan(0)
  })

  it('peer JOIN: notification with event=join', async () => {
    const mcp = await startMcpInProcess(ergo, 'ip-in-mcp3')
    const peer = await connectPeer(ergo, 'ip-in-peer3')

    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-in-join' } })
    await peer.joinChannel('#ip-in-join')

    const n = await mcp.waitForNotification(
      eventPredicate('join', { sender: 'ip-in-peer3' }),
    )

    expect(n.meta.event).toBe('join')
    expect(n.meta.sender).toBe('ip-in-peer3')
    expect(n.meta.channel).toBe('#ip-in-join')
    expect(n.meta.isDirect).toBe('false')
    expect(n.meta.ts).toBeTruthy()
    expect(Number(n.meta.seq)).toBeGreaterThan(0)
  })

  it('peer PART: notification with event=leave', async () => {
    const mcp = await startMcpInProcess(ergo, 'ip-in-mcp4')
    const peer = await connectPeer(ergo, 'ip-in-peer4')

    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-in-part' } })
    await peer.joinChannel('#ip-in-part')
    await mcp.waitForNotification(eventPredicate('join', { sender: 'ip-in-peer4' }))

    await peer.leaveChannel('#ip-in-part')

    const n = await mcp.waitForNotification(
      eventPredicate('leave', { sender: 'ip-in-peer4' }),
    )

    expect(n.meta.event).toBe('leave')
    expect(n.meta.sender).toBe('ip-in-peer4')
    expect(n.meta.channel).toBe('#ip-in-part')
    expect(n.meta.isDirect).toBe('false')
  })

  it('peer KICK: notification with event=leave, reason contains "kicked"', async () => {
    // kicker joins first to get channel op (+o as channel founder)
    const kicker = await connectPeer(ergo, 'ip-in-kicker')
    await kicker.joinChannel('#ip-in-kick')

    const mcp = await startMcpInProcess(ergo, 'ip-in-mcp5')
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-in-kick' } })

    const kicked = await connectPeer(ergo, 'ip-in-kicked')
    await kicked.joinChannel('#ip-in-kick')
    await mcp.waitForNotification(eventPredicate('join', { sender: 'ip-in-kicked' }))

    kicker.kick('#ip-in-kick', 'ip-in-kicked', 'bye')

    const n = await mcp.waitForNotification(
      eventPredicate('leave', { sender: 'ip-in-kicked' }),
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
    await mcp.waitForNotification(eventPredicate('join', { sender: 'ip-in-peer6' }))

    await peer.changeNick('ip-in-peer6b')

    const n = await mcp.waitForNotification(
      eventPredicate('nick', { sender: 'ip-in-peer6' }),
    )

    expect(n.meta.event).toBe('nick')
    expect(n.meta.sender).toBe('ip-in-peer6')
    expect(n.meta.newNick).toBe('ip-in-peer6b')
    expect(n.meta.channel).toBe('')
    expect(n.meta.isDirect).toBe('false')
  })

  it('self JOIN/LEAVE suppressed: own events not emitted', async () => {
    const mcp = await startMcpInProcess(ergo, 'ip-in-mcp7')
    const peer = await connectPeer(ergo, 'ip-in-peer7')

    // MCP joins — own join must not emit a notification
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-in-self' } })
    // Peer join is our sync fence: any self-join notification would precede this
    await peer.joinChannel('#ip-in-self')
    await mcp.waitForNotification(eventPredicate('join', { sender: 'ip-in-peer7' }))

    expect(mcp.notifications.find(n => n.meta.sender === 'ip-in-mcp7')).toBeUndefined()

    // MCP leaves — own leave must not emit a notification
    await mcp.client.callTool({ name: 'channel_leave', arguments: { channel: '#ip-in-self' } })
    // Use a peer DM as flush fence: any self-leave notification would precede this
    peer.say('ip-in-mcp7', 'ping')
    await mcp.waitForNotification(messagePredicate({ isDirect: true, content: 'ping' }))

    expect(mcp.notifications.find(n => n.meta.sender === 'ip-in-mcp7')).toBeUndefined()
  })

  it('peer NICK: history key renamed — channel_history newNick returns pre-rename DMs', async () => {
    // Local-ring-only: nick-rename re-keying is purely a client-side ring detail.
    // The server-authoritative query path keys by account (when available) and is
    // outside this test's scope.
    const mcp = await startMcpInProcess(ergo, 'ip-in-mcp8', { chathistoryDisabled: true })
    const peer = await connectPeer(ergo, 'ip-in-peer8')

    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-in-nick-hist' } })
    await peer.joinChannel('#ip-in-nick-hist')
    await mcp.waitForNotification(eventPredicate('join', { sender: 'ip-in-peer8' }))

    peer.say('ip-in-mcp8', 'dm before rename')
    await mcp.waitForNotification(messagePredicate({ isDirect: true, content: 'dm before rename' }))

    await peer.changeNick('ip-in-peer8b')
    await mcp.waitForNotification(eventPredicate('nick', { sender: 'ip-in-peer8' }))

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
    await mcp.waitForNotification(eventPredicate('join', { sender: 'ip-in-peer9' }))

    peer.say('ip-in-mcp9', 'dm for unread test')
    await mcp.waitForNotification(messagePredicate({ isDirect: true, content: 'dm for unread test' }))

    await peer.changeNick('ip-in-peer9b')
    await mcp.waitForNotification(eventPredicate('nick', { sender: 'ip-in-peer9' }))

    const cursor = mcp.notifications.length
    const summaryP = mcp.waitForNotification(eventPredicate('unread-summary'), 5000, cursor)
    await mcp.emitUnreadSummary()
    const summary = await summaryP

    expect(summary.content).toContain('ip-in-peer9b (1)')
    expect(summary.content).not.toContain('ip-in-peer9 (')
  })

  // ---- mention="true" attribute (issue #237) --------------------------------

  it('channel message containing own nick carries mention="true"', async () => {
    const mcp = await startMcpInProcess(ergo, 'ip-in-ment1')
    const peer = await connectPeer(ergo, 'ip-in-ment1-peer')
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-in-ment1' } })
    await peer.joinChannel('#ip-in-ment1')

    peer.say('#ip-in-ment1', 'ip-in-ment1: are you there?')
    const n = await mcp.waitForNotification(messagePredicate({ channel: '#ip-in-ment1', content: 'ip-in-ment1: are you there?' }))

    expect(n.meta.mention).toBe('true')
  })

  it('channel message not containing own nick has no mention attribute', async () => {
    const mcp = await startMcpInProcess(ergo, 'ip-in-ment2')
    const peer = await connectPeer(ergo, 'ip-in-ment2-peer')
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-in-ment2' } })
    await peer.joinChannel('#ip-in-ment2')

    peer.say('#ip-in-ment2', 'just chatting')
    const n = await mcp.waitForNotification(messagePredicate({ channel: '#ip-in-ment2', content: 'just chatting' }))

    expect(n.meta.mention).toBeUndefined()
  })

  it('word-boundary: nick as prefix of longer word does not set mention', async () => {
    const mcp = await startMcpInProcess(ergo, 'ip-in-ment3')
    const peer = await connectPeer(ergo, 'ip-in-ment3-peer')
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-in-ment3' } })
    await peer.joinChannel('#ip-in-ment3')

    peer.say('#ip-in-ment3', 'ip-in-ment3x is not the target nick')
    const n = await mcp.waitForNotification(messagePredicate({ channel: '#ip-in-ment3', content: 'ip-in-ment3x is not the target nick' }))

    expect(n.meta.mention).toBeUndefined()
  })

  it('DM always carries mention="true"', async () => {
    const mcp = await startMcpInProcess(ergo, 'ip-in-ment4')
    const peer = await connectPeer(ergo, 'ip-in-ment4-peer')

    peer.say('ip-in-ment4', 'hey there')
    const n = await mcp.waitForNotification(messagePredicate({ isDirect: true, content: 'hey there' }))

    expect(n.meta.mention).toBe('true')
  })

  // ---- seenBy attribute (issue #626) ----------------------------------------

  it('peer→channel message carries seenBy with both nicks', async () => {
    const mcp = await startMcpInProcess(ergo, 'ip-in-seen1')
    const peer = await connectPeer(ergo, 'ip-in-seen1-peer')
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-in-seen1' } })
    await peer.joinChannel('#ip-in-seen1')
    await mcp.waitForNotification(eventPredicate('join', { channel: '#ip-in-seen1', sender: 'ip-in-seen1-peer' }))

    peer.say('#ip-in-seen1', 'seen by test')
    const n = await mcp.waitForNotification(messagePredicate({ channel: '#ip-in-seen1', content: 'seen by test' }))

    expect(n.meta.seenBy).toContain('ip-in-seen1')
    expect(n.meta.seenBy).toContain('ip-in-seen1-peer')
  })

  it('peer→DM has no seenBy attribute', async () => {
    const mcp = await startMcpInProcess(ergo, 'ip-in-seen2')
    const peer = await connectPeer(ergo, 'ip-in-seen2-peer')

    peer.say('ip-in-seen2', 'dm no seenby')
    const n = await mcp.waitForNotification(messagePredicate({ isDirect: true, content: 'dm no seenby' }))

    expect(n.meta.seenBy).toBeUndefined()
  })
})
