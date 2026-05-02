import { describe, it, expect, beforeAll } from 'bun:test'
import { startErgo, type ErgoContext } from './helpers/ergo.js'
import { startMcp } from './helpers/mcp.js'
import { connectPeer } from './helpers/peer.js'

let ergo: ErgoContext | null

describe('irc-server MCP tools', () => {
  beforeAll(async () => {
    ergo = await startErgo()
  })

  it('tools/list returns 6 tools with correct schemas', async () => {
    if (!ergo) { console.log('skipped — ergo not found'); return }
    const mcp = await startMcp(ergo, 'list-test-mcp')
    const { tools } = await mcp.client.listTools()

    expect(tools).toHaveLength(6)
    const byName = Object.fromEntries(
      tools.map(t => [t.name, (t.inputSchema as unknown as { required?: string[] }).required]),
    )

    expect(byName['channel_message']).toEqual(expect.arrayContaining(['channel', 'text']))
    expect(byName['direct_message']).toEqual(expect.arrayContaining(['nick', 'text']))
    expect(byName['channel_join']).toEqual(['channel'])
    expect(byName['channel_leave']).toEqual(['channel'])
    expect(byName['channel_who']).toEqual(['channel'])
    expect(byName['channel_history']).toEqual(['channel'])
  })

  it('channel_join resolves on ack; channel_who includes own nick', async () => {
    if (!ergo) { console.log('skipped — ergo not found'); return }
    const mcp = await startMcp(ergo, 'join-test-mcp')

    const join = await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#join-test' } })
    expect(join.isError).toBeFalsy()

    const who = await mcp.client.callTool({ name: 'channel_who', arguments: { channel: '#join-test' } })
    expect((who.content[0] as { type: 'text'; text: string }).text).toContain('join-test-mcp')
  })

  it('channel_who reflects peer join and leave', async () => {
    if (!ergo) { console.log('skipped — ergo not found'); return }
    const mcp = await startMcp(ergo, 'who-test-mcp')
    const peer = await connectPeer(ergo, 'who-test-peer')

    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#who-test' } })
    await peer.joinChannel('#who-test')
    await mcp.waitForNotification(n => n.meta.event === 'join' && n.meta.sender === 'who-test-peer')

    const whoBefore = await mcp.client.callTool({ name: 'channel_who', arguments: { channel: '#who-test' } })
    expect((whoBefore.content[0] as { type: 'text'; text: string }).text).toContain('who-test-peer')

    await peer.leaveChannel('#who-test')
    await mcp.waitForNotification(n => n.meta.event === 'leave' && n.meta.sender === 'who-test-peer')

    const whoAfter = await mcp.client.callTool({ name: 'channel_who', arguments: { channel: '#who-test' } })
    expect((whoAfter.content[0] as { type: 'text'; text: string }).text).not.toContain('who-test-peer')
  })

  it('channel_leave parts cleanly', async () => {
    if (!ergo) { console.log('skipped — ergo not found'); return }
    const mcp = await startMcp(ergo, 'leave-test-mcp')
    const peer = await connectPeer(ergo, 'leave-test-peer')

    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#leave-test' } })
    await peer.joinChannel('#leave-test')

    const result = await mcp.client.callTool({ name: 'channel_leave', arguments: { channel: '#leave-test' } })
    expect(result.isError).toBeFalsy()
    expect((result.content[0] as { type: 'text'; text: string }).text).toBe('parted #leave-test')

    await peer.waitForPart('#leave-test', 'leave-test-mcp')
  })
})
