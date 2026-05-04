/**
 * irc-server.ts tests via InMemoryTransport. Imports createMcpServer directly
 * so the server runs in the test process and appears in the coverage report.
 */
import { describe, it, expect, beforeAll } from 'bun:test'
import { startErgo, isErgoAvailable, type ErgoContext } from './helpers/ergo.js'
import { startMcpInProcess } from './helpers/mcp-inprocess.js'
import { startMcp } from './helpers/mcp.js'
import { connectPeer } from './helpers/peer.js'
import { toolText } from './helpers/tool.js'

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

  it('channel_join resolves; channel_who includes own nick', async () => {
    const mcp = await startMcpInProcess(ergo, 'ip-join1')
    const join = await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-join1' } })
    expect(join.isError).toBeFalsy()
    expect(toolText(join)).toBe('joined #ip-join1')

    const who = await mcp.client.callTool({ name: 'channel_who', arguments: { channel: '#ip-join1' } })
    expect(toolText(who)).toContain('ip-join1')
  })

  it('channel_join duplicate returns immediately', async () => {
    const mcp = await startMcpInProcess(ergo, 'ip-rejoin')
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-rejoin' } })
    const again = await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-rejoin' } })
    expect(again.isError).toBeFalsy()
    expect(toolText(again)).toContain('already in')
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

    const result = await mcp.client.callTool({
      name: 'channel_message',
      arguments: { channel: '#ip-msg1', text: 'hello in-process' },
    })
    expect(result.isError).toBeFalsy()
    expect(toolText(result)).toContain('sent to #ip-msg1')
    await peer.waitForMessage('#ip-msg1', m => m.nick === 'ip-msg1' && m.text === 'hello in-process')
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
    expect(toolText(hist)).toContain('no history')
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

    const result = await mcp.client.callTool({ name: 'channel_leave', arguments: { channel: '#leave-test' } })
    expect(result.isError).toBeFalsy()
    expect(toolText(result)).toBe('parted #leave-test')

    await peer.waitForPart('#leave-test', 'leave-test-mcp')
  })
})
