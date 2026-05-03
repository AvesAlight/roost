/**
 * In-process tests for irc-server.ts via InMemoryTransport.
 * Imports createMcpServer directly so the server runs in the test process
 * and appears in the coverage report.
 */
import { describe, it, expect, beforeAll } from 'bun:test'
import { startErgo, isErgoAvailable, type ErgoContext } from './helpers/ergo.js'
import { startMcpInProcess } from './helpers/mcp-inprocess.js'
import { connectPeer } from './helpers/peer.js'
import { toolText } from './helpers/tool.js'

describe.if(isErgoAvailable())('irc-server in-process (InMemoryTransport)', () => {
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
})
