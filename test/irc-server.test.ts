import { describe, it, expect, beforeAll } from 'bun:test'
import { startErgo, isErgoAvailable, type ErgoContext } from './helpers/ergo.js'
import { startMcp } from './helpers/mcp.js'
import { connectPeer } from './helpers/peer.js'
import { toolText } from './helpers/tool.js'

describe.if(isErgoAvailable())('irc-server MCP tools', () => {
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

    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#list-test-a' } })
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#list-test-b' } })

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
