/**
 * irc-server.ts tests via InMemoryTransport. Imports createMcpServer directly
 * so the server runs in the test process and appears in the coverage report.
 */
import { describe, it, expect, beforeAll, spyOn } from 'bun:test'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { startErgo, isErgoAvailable, type ErgoContext } from './helpers/ergo.js'
import { startMcpInProcess } from './helpers/mcp-inprocess.js'
import { startMcp } from './helpers/mcp.js'
import { messagePredicate } from './helpers/mcp-core.js'
import { connectPeer } from './helpers/peer.js'
import { toolText } from './helpers/tool.js'
import { createMcpServer } from '../src/irc-server.js'
import type { RoostIrcClient, ClientConfig } from '../src/irc-client.js'

describe.if(isErgoAvailable())('irc-server MCP tools', () => {
  let ergo: ErgoContext

  beforeAll(async () => {
    ergo = (await startErgo())!
  })

  it('tools/list returns expected tool names', async () => {
    const mcp = await startMcpInProcess(ergo, 'ip-list')
    const { tools } = await mcp.client.listTools()
    const names = tools.map(t => t.name)
    expect(names).toContain('channel_message')
    expect(names).toContain('direct_message')
    expect(names).toContain('channel_join')
    expect(names).toContain('channel_leave')
    expect(names).toContain('channel_who')
    expect(names).toContain('channel_history')
    expect(names).toContain('channel_list')
    expect(names).toContain('channel_ack')
  })

  it('channel_who on unjoined channel returns empty', async () => {
    const mcp = await startMcpInProcess(ergo, 'ip-who1')
    const result = await mcp.client.callTool({ name: 'channel_who', arguments: { channel: '#nonexistent' } })
    expect(result.isError).toBeFalsy()
    expect(toolText(result)).toContain('no users tracked')
  })

  it('channel_join resolves with members; channel_who includes own nick', async () => {
    const mcp = await startMcpInProcess(ergo, 'ip-join1')
    const join = await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-join1' } })
    expect(join.isError).toBeFalsy()
    const text = toolText(join)
    expect(text).toContain('joined #ip-join1')
    expect(text).toContain('members')
    expect(text).toContain('ip-join1')

    const who = await mcp.client.callTool({ name: 'channel_who', arguments: { channel: '#ip-join1' } })
    expect(toolText(who)).toContain('ip-join1')
  })

  it('channel_join with peer in channel returns both nicks in members', async () => {
    const peer = await connectPeer(ergo, 'ip-join2-peer')
    await peer.joinChannel('#ip-join2')
    const mcp = await startMcpInProcess(ergo, 'ip-join2')
    const join = await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-join2' } })
    expect(join.isError).toBeFalsy()
    const text = toolText(join)
    expect(text).toContain('ip-join2')
    expect(text).toContain('ip-join2-peer')
    expect(text).toMatch(/members \(2\)/)
  })

  it('channel_join solo returns just own nick in members', async () => {
    const mcp = await startMcpInProcess(ergo, 'ip-join3')
    const join = await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-join3' } })
    expect(join.isError).toBeFalsy()
    const text = toolText(join)
    expect(text).toContain('members (1)')
    expect(text).toContain('ip-join3')
  })

  it('channel_join duplicate returns immediately', async () => {
    const mcp = await startMcpInProcess(ergo, 'ip-rejoin')
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-rejoin' } })
    const again = await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-rejoin' } })
    expect(again.isError).toBeFalsy()
    expect(toolText(again)).toContain('joined')
  })

  it('channel_list reflects joined channels', async () => {
    const mcp = await startMcpInProcess(ergo, 'ip-clist')
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-clist-a' } })
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-clist-b' } })
    const result = await mcp.client.callTool({ name: 'channel_list', arguments: {} })
    expect(toolText(result)).toContain('#ip-clist-a')
    expect(toolText(result)).toContain('#ip-clist-b')
  })

  it('channel_message sends and peer receives', async () => {
    const mcp = await startMcpInProcess(ergo, 'ip-msg1')
    const peer = await connectPeer(ergo, 'ip-msg1-peer')
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-msg1' } })
    await peer.joinChannel('#ip-msg1')

    const messageSeen = peer.waitForMessage('#ip-msg1', m => m.nick === 'ip-msg1' && m.text === 'hello in-process')
    const result = await mcp.client.callTool({
      name: 'channel_message',
      arguments: { channel: '#ip-msg1', text: 'hello in-process' },
    })
    expect(result.isError).toBeFalsy()
    expect(toolText(result)).toContain('sent to #ip-msg1')
    await messageSeen
  })

  it('inbound channel message arrives as notification', async () => {
    const mcp = await startMcpInProcess(ergo, 'ip-inbound1')
    const peer = await connectPeer(ergo, 'ip-inbound1-peer')
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-inbound1' } })
    await peer.joinChannel('#ip-inbound1')

    peer.say('#ip-inbound1', 'ping from peer')
    const n = await mcp.waitForNotification(
      n => n.meta.channel === '#ip-inbound1' && n.content === 'ping from peer',
    )
    expect(n.meta.sender).toBe('ip-inbound1-peer')
    expect(n.meta.isDirect).toBe('false')
  })

  it('peer join emits membership notification', async () => {
    const mcp = await startMcpInProcess(ergo, 'ip-memb1')
    const peer = await connectPeer(ergo, 'ip-memb1-peer')
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-memb1' } })

    await peer.joinChannel('#ip-memb1')
    const n = await mcp.waitForNotification(
      n => n.meta.event === 'join' && n.meta.sender === 'ip-memb1-peer',
    )
    expect(n.content).toContain('joined')
  })

  it('channel_history returns messages in order', async () => {
    const mcp = await startMcpInProcess(ergo, 'ip-hist1')
    const peer = await connectPeer(ergo, 'ip-hist1-peer')
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-hist1' } })
    await peer.joinChannel('#ip-hist1')

    peer.say('#ip-hist1', 'msg-a')
    await mcp.waitForNotification(n => n.meta.channel === '#ip-hist1' && n.content === 'msg-a')
    peer.say('#ip-hist1', 'msg-b')
    await mcp.waitForNotification(n => n.meta.channel === '#ip-hist1' && n.content === 'msg-b')

    const hist = await mcp.client.callTool({ name: 'channel_history', arguments: { channel: '#ip-hist1' } })
    const text = toolText(hist)
    expect(text.indexOf('msg-a')).toBeLessThan(text.indexOf('msg-b'))
  })

  it('channel_history empty before any messages', async () => {
    const mcp = await startMcpInProcess(ergo, 'ip-hist2')
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-hist2' } })
    const hist = await mcp.client.callTool({ name: 'channel_history', arguments: { channel: '#ip-hist2' } })
    const text = toolText(hist)
    expect(text).toContain('event="no-history"')
    expect(text).toContain('no history')
  })

  it('channel_history returns <channel> XML elements with historical="true"', async () => {
    const mcp = await startMcpInProcess(ergo, 'ip-histshape1')
    const peer = await connectPeer(ergo, 'ip-histshape1-peer')
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-histshape1' } })
    await peer.joinChannel('#ip-histshape1')

    peer.say('#ip-histshape1', 'shape-test-msg')
    await mcp.waitForNotification(n => n.meta.channel === '#ip-histshape1' && n.content === 'shape-test-msg')

    const hist = await mcp.client.callTool({ name: 'channel_history', arguments: { channel: '#ip-histshape1' } })
    const text = toolText(hist)
    expect(text).toMatch(/^<channel /)
    expect(text).toContain('sender="ip-histshape1-peer"')
    expect(text).toContain('channel="#ip-histshape1"')
    expect(text).toContain('isDirect="false"')
    expect(text).toContain('event="message"')
    expect(text).toContain('historical="true"')
    expect(text).toContain('>shape-test-msg<')
    expect(text).not.toContain('mention="true"')
  })

  it('channel_history emits mention="true" for DMs', async () => {
    const mcp = await startMcpInProcess(ergo, 'ip-histshape2')
    const peer = await connectPeer(ergo, 'ip-histshape2-peer')

    peer.say('ip-histshape2', 'hi directly')
    await mcp.waitForNotification(n => n.meta.isDirect === 'true' && n.content === 'hi directly')

    const hist = await mcp.client.callTool({ name: 'channel_history', arguments: { channel: 'ip-histshape2-peer' } })
    const text = toolText(hist)
    expect(text).toContain('isDirect="true"')
    expect(text).toContain('mention="true"')
  })

  it('channel_history emits mention="true" for nick mention in channel', async () => {
    const mcp = await startMcpInProcess(ergo, 'ip-histshape3')
    const peer = await connectPeer(ergo, 'ip-histshape3-peer')
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-histshape3' } })
    await peer.joinChannel('#ip-histshape3')

    peer.say('#ip-histshape3', 'hey ip-histshape3 are you there?')
    await mcp.waitForNotification(messagePredicate({ channel: '#ip-histshape3', mention: true }))

    const hist = await mcp.client.callTool({ name: 'channel_history', arguments: { channel: '#ip-histshape3' } })
    expect(toolText(hist)).toContain('mention="true"')
  })

  it('channel_history XML-escapes special characters in body and attrs', async () => {
    const mcp = await startMcpInProcess(ergo, 'ip-histshape4')
    const peer = await connectPeer(ergo, 'ip-histshape4-peer')
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-histshape4' } })
    await peer.joinChannel('#ip-histshape4')

    peer.say('#ip-histshape4', 'a <b> & "c"')
    await mcp.waitForNotification(n => n.meta.channel === '#ip-histshape4' && n.content.includes('<b>'))

    const hist = await mcp.client.callTool({ name: 'channel_history', arguments: { channel: '#ip-histshape4' } })
    const text = toolText(hist)
    expect(text).toContain('&lt;b&gt;')
    expect(text).toContain('&amp;')
    expect(text).not.toMatch(/<b>/)
  })

  it('channel_history handles multiline message body', async () => {
    const mcp = await startMcpInProcess(ergo, 'ip-histshape5')
    const peer = await connectPeer(ergo, 'ip-histshape5-peer')
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-histshape5' } })
    await peer.joinChannel('#ip-histshape5')

    peer.say('#ip-histshape5', 'line one\nline two')
    await mcp.waitForNotification(n => n.meta.channel === '#ip-histshape5' && n.content.includes('line two'))

    const hist = await mcp.client.callTool({ name: 'channel_history', arguments: { channel: '#ip-histshape5' } })
    const text = toolText(hist)
    expect(text).toContain('line one')
    expect(text).toContain('line two')
    expect(text).toMatch(/historical="true"/)
  })

  // ---- Unread tracking (issue #9) ----------------------------------------

  it('inbound message increments unread; channel_list shows sender+preview', async () => {
    const mcp = await startMcpInProcess(ergo, 'ip-unread1')
    const peer = await connectPeer(ergo, 'ip-unread1-peer')
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-unread1' } })
    await peer.joinChannel('#ip-unread1')

    peer.say('#ip-unread1', 'hello unread world')
    await mcp.waitForNotification(n => n.meta.channel === '#ip-unread1' && n.content === 'hello unread world')

    const list = await mcp.client.callTool({ name: 'channel_list', arguments: {} })
    expect(toolText(list)).toContain('(1)')
    expect(toolText(list)).toContain('ip-unread1-peer')
    expect(toolText(list)).toContain('hello unread world')
  })

  it('channel_message clears unread', async () => {
    const mcp = await startMcpInProcess(ergo, 'ip-unread2')
    const peer = await connectPeer(ergo, 'ip-unread2-peer')
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-unread2' } })
    await peer.joinChannel('#ip-unread2')

    peer.say('#ip-unread2', 'you there?')
    await mcp.waitForNotification(n => n.meta.channel === '#ip-unread2' && n.content === 'you there?')

    await mcp.client.callTool({ name: 'channel_message', arguments: { channel: '#ip-unread2', text: 'yes' } })

    const list = await mcp.client.callTool({ name: 'channel_list', arguments: {} })
    expect(toolText(list)).not.toMatch(/\(\d+\)/)
  })

  it('channel_history clears unread', async () => {
    const mcp = await startMcpInProcess(ergo, 'ip-unread3')
    const peer = await connectPeer(ergo, 'ip-unread3-peer')
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-unread3' } })
    await peer.joinChannel('#ip-unread3')

    peer.say('#ip-unread3', 'did you see this?')
    await mcp.waitForNotification(n => n.meta.channel === '#ip-unread3' && n.content === 'did you see this?')

    await mcp.client.callTool({ name: 'channel_history', arguments: { channel: '#ip-unread3' } })

    const list = await mcp.client.callTool({ name: 'channel_list', arguments: {} })
    expect(toolText(list)).not.toMatch(/\(\d+\)/)
  })

  it('channel_ack clears unread', async () => {
    const mcp = await startMcpInProcess(ergo, 'ip-unread4')
    const peer = await connectPeer(ergo, 'ip-unread4-peer')
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-unread4' } })
    await peer.joinChannel('#ip-unread4')

    peer.say('#ip-unread4', 'ack this')
    await mcp.waitForNotification(n => n.meta.channel === '#ip-unread4' && n.content === 'ack this')

    const ack = await mcp.client.callTool({ name: 'channel_ack', arguments: { channel: '#ip-unread4' } })
    expect(ack.isError).toBeFalsy()

    const list = await mcp.client.callTool({ name: 'channel_list', arguments: {} })
    expect(toolText(list)).not.toMatch(/\(\d+\)/)
  })

  it('channel_leave clears unread', async () => {
    const mcp = await startMcpInProcess(ergo, 'ip-unread9')
    const peer = await connectPeer(ergo, 'ip-unread9-peer')
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-unread9' } })
    await peer.joinChannel('#ip-unread9')

    peer.say('#ip-unread9', 'bye')
    await mcp.waitForNotification(n => n.meta.channel === '#ip-unread9' && n.content === 'bye')

    await mcp.client.callTool({ name: 'channel_leave', arguments: { channel: '#ip-unread9' } })

    // channel_ack on an unrelated channel — no unread suffix means the parted channel was cleared
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-unread9-b' } })
    const ack = await mcp.client.callTool({ name: 'channel_ack', arguments: { channel: '#ip-unread9-b' } })
    expect(toolText(ack)).not.toContain('unread:')
  })

  it('kick clears unread (handleKick path)', async () => {
    // peer joins first to get channel-op status, then MCP client joins
    const peer = await connectPeer(ergo, 'ip-unread10-peer')
    const mcp = await startMcpInProcess(ergo, 'ip-unread10')
    await peer.joinChannel('#ip-unread10')
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-unread10' } })

    peer.say('#ip-unread10', 'watch out')
    await mcp.waitForNotification(n => n.meta.channel === '#ip-unread10' && n.content === 'watch out')

    // peer kicks the MCP client; goes through handleKick not channel_leave
    const kickSeen = peer.waitForKick('#ip-unread10', 'ip-unread10')
    peer.kick('#ip-unread10', 'ip-unread10', 'out you go')
    await kickSeen

    // After the kick echo reaches the peer, the server has already sent KICK to the MCP
    // client's TCP connection. The next event-loop turn (the callTool await) drains it.
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-unread10-b' } })
    const ack = await mcp.client.callTool({ name: 'channel_ack', arguments: { channel: '#ip-unread10-b' } })
    expect(toolText(ack)).not.toContain('unread:')
  })

  it('rejoin after leave resumes unread tracking from zero', async () => {
    const mcp = await startMcpInProcess(ergo, 'ip-unread11')
    const peer = await connectPeer(ergo, 'ip-unread11-peer')
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-unread11' } })
    await peer.joinChannel('#ip-unread11')

    peer.say('#ip-unread11', 'first')
    await mcp.waitForNotification(n => n.meta.channel === '#ip-unread11' && n.content === 'first')

    await mcp.client.callTool({ name: 'channel_leave', arguments: { channel: '#ip-unread11' } })
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-unread11' } })

    peer.say('#ip-unread11', 'after rejoin')
    await mcp.waitForNotification(n => n.meta.channel === '#ip-unread11' && n.content === 'after rejoin')

    const list = await mcp.client.callTool({ name: 'channel_list', arguments: {} })
    // unread count should be 1 (only post-rejoin message), not 2
    expect(toolText(list)).toMatch(/\(1\)/)
  })

  it('channel_ack response includes unread suffix for other channels, omits if none', async () => {
    const mcp = await startMcpInProcess(ergo, 'ip-unread8')
    const peer = await connectPeer(ergo, 'ip-unread8-peer')
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-unread8-a' } })
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-unread8-b' } })
    await peer.joinChannel('#ip-unread8-a')
    await peer.joinChannel('#ip-unread8-b')

    // Message arrives in B while agent reads A
    peer.say('#ip-unread8-b', 'check this out')
    await mcp.waitForNotification(n => n.meta.channel === '#ip-unread8-b' && n.content === 'check this out')

    // Acking A should report B as unread, including the hint
    const ack = await mcp.client.callTool({ name: 'channel_ack', arguments: { channel: '#ip-unread8-a' } })
    expect(toolText(ack)).toContain('acked #ip-unread8-a')
    expect(toolText(ack)).toContain('unread:')
    expect(toolText(ack)).toContain('#ip-unread8-b')
    expect(toolText(ack)).toContain('check this out')
    expect(toolText(ack)).toContain('channel_ack to clear')

    // Acking B clears the last unread — no suffix
    const ack2 = await mcp.client.callTool({ name: 'channel_ack', arguments: { channel: '#ip-unread8-b' } })
    expect(toolText(ack2)).not.toContain('unread:')
  })

  it('emitUnreadSummary emits notification with channel+preview; all-caught-up when none', async () => {
    const mcp = await startMcpInProcess(ergo, 'ip-unread5')
    const peer = await connectPeer(ergo, 'ip-unread5-peer')
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-unread5' } })
    await peer.joinChannel('#ip-unread5')

    // Summary with no unread → all caught up
    mcp.emitUnreadSummary()
    const nClean = await mcp.waitForNotification(n => n.meta.event === 'unread-summary')
    expect(nClean.content).toContain('all caught up')
    const cursor = nClean.cursor

    // Send a message, then trigger summary → should name the channel
    peer.say('#ip-unread5', 'pending message')
    await mcp.waitForNotification(n => n.meta.channel === '#ip-unread5' && n.content === 'pending message')

    mcp.emitUnreadSummary()
    const nDirty = await mcp.waitForNotification(n => n.meta.event === 'unread-summary', 5000, cursor)
    expect(nDirty.content).toContain('#ip-unread5')
    expect(nDirty.content).toContain('ip-unread5-peer')
    expect(nDirty.content).toContain('pending message')
    expect(nDirty.content).toContain('channel_ack to clear')
  })

  it('send reply includes unread nudge for other channels, omits if none', async () => {
    const mcp = await startMcpInProcess(ergo, 'ip-unread7')
    const peer = await connectPeer(ergo, 'ip-unread7-peer')
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-unread7-a' } })
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-unread7-b' } })
    await peer.joinChannel('#ip-unread7-a')
    await peer.joinChannel('#ip-unread7-b')

    // Message arrives in B while agent is "focused" on A
    peer.say('#ip-unread7-b', 'look at this')
    await mcp.waitForNotification(n => n.meta.channel === '#ip-unread7-b' && n.content === 'look at this')

    // Sending to A should report B as unread in the reply
    const reply = await mcp.client.callTool({ name: 'channel_message', arguments: { channel: '#ip-unread7-a', text: 'hi' } })
    expect(toolText(reply)).toContain('sent to #ip-unread7-a')
    expect(toolText(reply)).toContain('#ip-unread7-b')
    expect(toolText(reply)).toContain('unread:')
    expect(toolText(reply)).toContain('look at this')

    // Now send to B — reply should be silent (no other unread)
    const reply2 = await mcp.client.callTool({ name: 'channel_message', arguments: { channel: '#ip-unread7-b', text: 'got it' } })
    expect(toolText(reply2)).not.toContain('unread:')
  })

  // ---- Mention tracking (issue #137) ------------------------------------

  it('mention formats as "(N mention, M total)" with mention preview', async () => {
    const mcp = await startMcpInProcess(ergo, 'ip-ment1')
    const peer = await connectPeer(ergo, 'ip-ment1-peer')
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-ment1' } })
    await peer.joinChannel('#ip-ment1')

    peer.say('#ip-ment1', 'ip-ment1: are you there?')
    await mcp.waitForNotification(n => n.meta.channel === '#ip-ment1' && n.content === 'ip-ment1: are you there?')

    const list = await mcp.client.callTool({ name: 'channel_list', arguments: {} })
    expect(toolText(list)).toContain('1 mention, 1 total')
    expect(toolText(list)).toContain('ip-ment1: are you there?')
  })

  it('non-mention messages keep "(M)" format', async () => {
    const mcp = await startMcpInProcess(ergo, 'ip-ment2')
    const peer = await connectPeer(ergo, 'ip-ment2-peer')
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-ment2' } })
    await peer.joinChannel('#ip-ment2')

    peer.say('#ip-ment2', 'just chatting')
    await mcp.waitForNotification(n => n.meta.channel === '#ip-ment2' && n.content === 'just chatting')

    const list = await mcp.client.callTool({ name: 'channel_list', arguments: {} })
    expect(toolText(list)).toContain('(1)')
    expect(toolText(list)).not.toContain('mention')
  })

  it('mention preview persists when non-mention messages arrive after', async () => {
    const mcp = await startMcpInProcess(ergo, 'ip-ment3')
    const peer = await connectPeer(ergo, 'ip-ment3-peer')
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-ment3' } })
    await peer.joinChannel('#ip-ment3')

    peer.say('#ip-ment3', '@ip-ment3 hey')
    await mcp.waitForNotification(n => n.meta.channel === '#ip-ment3' && n.content === '@ip-ment3 hey')
    peer.say('#ip-ment3', 'side comment')
    await mcp.waitForNotification(n => n.meta.channel === '#ip-ment3' && n.content === 'side comment')

    const list = await mcp.client.callTool({ name: 'channel_list', arguments: {} })
    expect(toolText(list)).toContain('1 mention, 2 total')
    expect(toolText(list)).toContain('@ip-ment3 hey')
  })

  it('word-boundary match: nick embedded in longer word does not count as mention', async () => {
    const mcp = await startMcpInProcess(ergo, 'ip-ment4')
    const peer = await connectPeer(ergo, 'ip-ment4-peer')
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-ment4' } })
    await peer.joinChannel('#ip-ment4')

    // "ip-ment4x" has "ip-ment4" as a prefix with an alphanumeric suffix — no word boundary after "4"
    peer.say('#ip-ment4', 'ip-ment4x is not our nick')
    await mcp.waitForNotification(n => n.meta.channel === '#ip-ment4' && n.content === 'ip-ment4x is not our nick')

    const list = await mcp.client.callTool({ name: 'channel_list', arguments: {} })
    expect(toolText(list)).not.toContain('mention')
  })

  it('channel_ack clears mention count', async () => {
    const mcp = await startMcpInProcess(ergo, 'ip-ment5')
    const peer = await connectPeer(ergo, 'ip-ment5-peer')
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-ment5' } })
    await peer.joinChannel('#ip-ment5')

    peer.say('#ip-ment5', 'ip-ment5: ping')
    await mcp.waitForNotification(n => n.meta.channel === '#ip-ment5' && n.content === 'ip-ment5: ping')

    // Verify mention is tracked
    const list1 = await mcp.client.callTool({ name: 'channel_list', arguments: {} })
    expect(toolText(list1)).toContain('1 mention')

    // Ack clears it — channel_list should no longer show any unread for this channel
    await mcp.client.callTool({ name: 'channel_ack', arguments: { channel: '#ip-ment5' } })
    const list2 = await mcp.client.callTool({ name: 'channel_list', arguments: {} })
    expect(toolText(list2)).not.toContain('mention')
    expect(toolText(list2)).not.toContain('ip-ment5: ping')
  })

  // ---- Reply reminder (issue #136) ---------------------------------------

  it('first inbound channel message triggers a reminder followup notification', async () => {
    const mcp = await startMcpInProcess(ergo, 'ip-rem1')
    const peer = await connectPeer(ergo, 'ip-rem1-peer')
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-rem1' } })
    await peer.joinChannel('#ip-rem1')

    peer.say('#ip-rem1', 'first message')
    const msg = await mcp.waitForNotification(
      n => n.meta.channel === '#ip-rem1' && n.content === 'first message',
    )
    expect(msg.meta.event).toBe('message')

    const reminder = await mcp.waitForNotification(n => n.meta.event === 'reminder')
    expect(reminder.content).toBe('Substantive replies should be posted to IRC.')
    expect(reminder.meta.channel).toBe('#ip-rem1')
    expect(Number(reminder.meta.seq)).toBeGreaterThan(Number(msg.meta.seq))
  })

  it('first inbound DM triggers a reminder followup notification', async () => {
    const mcp = await startMcpInProcess(ergo, 'ip-rem2')
    const peer = await connectPeer(ergo, 'ip-rem2-peer')

    peer.say('ip-rem2', 'dm hello')
    const msg = await mcp.waitForNotification(
      n => n.meta.isDirect === 'true' && n.content === 'dm hello',
    )
    const reminder = await mcp.waitForNotification(n => n.meta.event === 'reminder')
    expect(reminder.content).toBe('Substantive replies should be posted to IRC.')
    expect(reminder.meta.isDirect).toBe('true')
    expect(Number(reminder.meta.seq)).toBeGreaterThan(Number(msg.meta.seq))
  })

  it('historical replay does not emit a reminder, and does not consume the first-message slot', async () => {
    const peer = await connectPeer(ergo, 'ip-rem4-peer')
    const mcp = await startMcpInProcess(ergo, 'ip-rem4')

    await peer.joinChannel('#ip-rem4')
    // Wait on peer's own echo (echo-message cap) — guarantees ergo has stored
    // the message in chathistory before mcp joins. Avoids a wall-clock sleep.
    const echoSeen = peer.waitForMessage('#ip-rem4', m => m.nick === 'ip-rem4-peer' && m.text === 'historical-first')
    peer.say('#ip-rem4', 'historical-first')
    await echoSeen

    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-rem4' } })
    await mcp.waitForNotification(messagePredicate({ historical: true, content: 'historical-first' }))

    peer.say('#ip-rem4', 'live-after-historical')
    const live = await mcp.waitForNotification(
      n => n.meta.channel === '#ip-rem4' && n.content === 'live-after-historical',
    )
    const reminder = await mcp.waitForNotification(n => n.meta.event === 'reminder')
    expect(reminder.content).toBe('Substantive replies should be posted to IRC.')
    expect(Number(reminder.meta.seq)).toBeGreaterThan(Number(live.meta.seq))

    // No reminder fired for the historical message — only one reminder total.
    expect(mcp.notifications.filter(n => n.meta.event === 'reminder')).toHaveLength(1)
  })

  it('subsequent message emits reminder when Math.random() < probability', async () => {
    const mcp = await startMcpInProcess(ergo, 'ip-rem5')
    const peer = await connectPeer(ergo, 'ip-rem5-peer')
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-rem5' } })
    await peer.joinChannel('#ip-rem5')

    peer.say('#ip-rem5', 'first')
    const firstReminder = await mcp.waitForNotification(n => n.meta.event === 'reminder')

    const spy = spyOn(Math, 'random').mockReturnValue(0.01)
    try {
      peer.say('#ip-rem5', 'second-low-rand')
      await mcp.waitForNotification(n => n.meta.channel === '#ip-rem5' && n.content === 'second-low-rand')
      const secondReminder = await mcp.waitForNotification(
        n => n.meta.event === 'reminder',
        5000,
        firstReminder.cursor,
      )
      expect(secondReminder.content).toBe('Substantive replies should be posted to IRC.')
    } finally {
      spy.mockRestore()
    }
  })

  it('subsequent message skips reminder when Math.random() >= probability', async () => {
    const mcp = await startMcpInProcess(ergo, 'ip-rem6')
    const peer = await connectPeer(ergo, 'ip-rem6-peer')
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-rem6' } })
    await peer.joinChannel('#ip-rem6')

    peer.say('#ip-rem6', 'first')
    const firstReminder = await mcp.waitForNotification(n => n.meta.event === 'reminder')

    const spy = spyOn(Math, 'random').mockReturnValue(0.99)
    try {
      peer.say('#ip-rem6', 'second-high-rand')
      const msg = await mcp.waitForNotification(
        n => n.meta.channel === '#ip-rem6' && n.content === 'second-high-rand',
      )
      // Fence: a peer leave generates a membership notification (no reminder).
      // Once the leave arrives, any reminder for second-high-rand would have
      // landed before it.
      await peer.leaveChannel('#ip-rem6')
      const leaveNotif = await mcp.waitForNotification(
        n => n.meta.event === 'leave' && n.meta.sender === 'ip-rem6-peer',
      )
      const laterReminders = mcp.notifications.filter(
        n => n.meta.event === 'reminder' && Number(n.meta.seq) > Number(firstReminder.meta.seq),
      )
      expect(laterReminders).toHaveLength(0)
      expect(msg.content).toBe('second-high-rand')
      expect(Number(leaveNotif.meta.seq)).toBeGreaterThan(Number(msg.meta.seq))
    } finally {
      spy.mockRestore()
    }
  })

  it('historical replay does not count as unread', async () => {
    // The simplest proxy: join a fresh channel (no history), confirm no unread.
    const mcp = await startMcpInProcess(ergo, 'ip-unread6')
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-unread6' } })
    mcp.emitUnreadSummary()
    const n = await mcp.waitForNotification(n => n.meta.event === 'unread-summary')
    expect(n.content).toContain('all caught up')
  })
})

// Subprocess smoke tests: verify the binary wiring (StdioClientTransport + spawned process).
describe.if(isErgoAvailable())('irc-server MCP tools (subprocess)', () => {
  let ergo: ErgoContext

  beforeAll(async () => {
    ergo = (await startErgo())!
  })

  it('tools/list returns correct schemas', async () => {
    const mcp = await startMcp(ergo, 'list-test-mcp')
    const { tools } = await mcp.client.listTools()

    const byName = Object.fromEntries(
      tools.map(t => [t.name, (t.inputSchema as unknown as { required?: string[] }).required]),
    )

    expect(byName['channel_message']).toEqual(expect.arrayContaining(['channel', 'text']))
    expect(byName['direct_message']).toEqual(expect.arrayContaining(['nick', 'text']))
    expect(byName['channel_join']).toEqual(['channel'])
    expect(byName['channel_leave']).toEqual(['channel'])
    expect(byName['channel_who']).toEqual(['channel'])
    expect(byName['channel_history']).toEqual(['channel'])
    expect(tools.map(t => t.name)).toContain('channel_list')
    expect(byName['channel_list']).toEqual([])
    expect(byName['channel_ack']).toEqual(['channel'])
  })

  it('channel_join resolves on ack; channel_who includes own nick', async () => {
    const mcp = await startMcp(ergo, 'join-test-mcp')

    const join = await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#join-test' } })
    expect(join.isError).toBeFalsy()

    const who = await mcp.client.callTool({ name: 'channel_who', arguments: { channel: '#join-test' } })
    expect(toolText(who)).toContain('join-test-mcp')
  })

  it('channel_who reflects peer join and leave', async () => {
    const mcp = await startMcp(ergo, 'who-test-mcp')
    const peer = await connectPeer(ergo, 'who-test-peer')

    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#who-test' } })
    await peer.joinChannel('#who-test')
    await mcp.waitForNotification(n => n.meta.event === 'join' && n.meta.sender === 'who-test-peer')

    const whoBefore = await mcp.client.callTool({ name: 'channel_who', arguments: { channel: '#who-test' } })
    expect(((whoBefore.content as unknown[])[0] as { type: 'text'; text: string }).text).toContain('who-test-peer')

    await peer.leaveChannel('#who-test')
    await mcp.waitForNotification(n => n.meta.event === 'leave' && n.meta.sender === 'who-test-peer')

    const whoAfter = await mcp.client.callTool({ name: 'channel_who', arguments: { channel: '#who-test' } })
    expect(((whoAfter.content as unknown[])[0] as { type: 'text'; text: string }).text).not.toContain('who-test-peer')
  })

  it('channel_list returns joined channels', async () => {
    const mcp = await startMcp(ergo, 'list-chan-mcp')

    await Promise.all([
      mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#list-test-a' } }),
      mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#list-test-b' } }),
    ])

    const result = await mcp.client.callTool({ name: 'channel_list', arguments: {} })
    expect(result.isError).toBeFalsy()
    const text = toolText(result)
    expect(text).toContain('#list-test-a')
    expect(text).toContain('#list-test-b')

    await mcp.client.callTool({ name: 'channel_leave', arguments: { channel: '#list-test-a' } })
    const after = await mcp.client.callTool({ name: 'channel_list', arguments: {} })
    expect(toolText(after)).not.toContain('#list-test-a')
    expect(toolText(after)).toContain('#list-test-b')
  })

  it('channel_join on already-joined channel returns success immediately', async () => {
    const mcp = await startMcp(ergo, 'rejoin-test-mcp')

    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#rejoin-test' } })
    const result = await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#rejoin-test' } })

    expect(result.isError).toBeFalsy()
  })

  it('channel_leave parts cleanly', async () => {
    const mcp = await startMcp(ergo, 'leave-test-mcp')
    const peer = await connectPeer(ergo, 'leave-test-peer')

    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#leave-test' } })
    await peer.joinChannel('#leave-test')

    const partSeen = peer.waitForPart('#leave-test', 'leave-test-mcp')
    const result = await mcp.client.callTool({ name: 'channel_leave', arguments: { channel: '#leave-test' } })
    expect(result.isError).toBeFalsy()
    expect(toolText(result)).toBe('parted #leave-test')

    await partSeen
  })
})

// Minimal stub — createMcpServer only needs on() at setup and getUnread() for emitUnreadSummary.
function makeStubClient(): RoostIrcClient {
  return {
    connect: () => {},
    isReady: () => false,
    join: async () => ({ ok: false, members: [] }),
    leave: async () => false,
    say: () => ({ chunks: 0, mode: 'single' as const }),
    quit: () => {},
    whoisChannels: async () => null,
    getHistory: () => [],
    getUsers: () => [],
    getUnread: () => new Map(),
    ackUnread: () => {},
    clearDedupeCache: () => {},
    isJoined: () => false,
    // Cast required: overloaded on() signature doesn't unify with a single no-op arrow.
    on: (() => {}) as unknown as RoostIrcClient['on'],
  }
}

const stubConfig: ClientConfig = {
  nick: 'test-nick',
  autoJoin: [],
  historySize: 10,
  joinHistoryLines: 5,
  joinHistoryMinutes: 5,
}

describe('pushNotification error handling', () => {
  it('silently suppresses Not connected (transport teardown)', async () => {
    const { emitUnreadSummary } = createMcpServer(makeStubClient(), stubConfig)

    const stderrSpy = spyOn(process.stderr, 'write').mockImplementation((() => true) as typeof process.stderr.write)
    try {
      await emitUnreadSummary()
      const errorCalls = stderrSpy.mock.calls.filter(([s]) => typeof s === 'string' && s.includes('pushNotification error'))
      expect(errorCalls).toHaveLength(0)
    } finally {
      stderrSpy.mockRestore()
    }
  })

  it('logs unexpected errors to stderr', async () => {
    const { server, emitUnreadSummary } = createMcpServer(makeStubClient(), stubConfig)
    const [, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)

    const notifSpy = spyOn(server, 'notification').mockRejectedValue(new Error('kaboom unexpected'))
    const stderrSpy = spyOn(process.stderr, 'write').mockImplementation((() => true) as typeof process.stderr.write)
    try {
      await emitUnreadSummary()
      const errorCalls = stderrSpy.mock.calls.filter(([s]) => typeof s === 'string' && s.includes('kaboom unexpected'))
      expect(errorCalls).toHaveLength(1)
    } finally {
      notifSpy.mockRestore()
      stderrSpy.mockRestore()
      await server.close()
    }
  })
})
