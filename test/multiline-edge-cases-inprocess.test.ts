import { describe, it, expect, beforeAll } from 'bun:test'
import { startErgo, isErgoAvailable, type ErgoContext } from './helpers/ergo.js'
import { startMcpInProcess } from './helpers/mcp-inprocess.js'
import { connectPeer } from './helpers/peer.js'
import { toolText } from './helpers/tool.js'
import { MULTILINE_LINE_BYTES } from '../src/constants.js'

describe.if(isErgoAvailable())('multiline edge cases (in-process)', () => {
  let ergo: ErgoContext

  beforeAll(async () => {
    ergo = (await startErgo())!
  })

  it('empty lines preserved (consecutive \\n round-trip)', async () => {
    const sender = await startMcpInProcess(ergo, 'ip-ml-ec1-s')
    const receiver = await startMcpInProcess(ergo, 'ip-ml-ec1-r')
    await sender.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-ml-ec1' } })
    await receiver.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-ml-ec1' } })

    const text = 'hello\n\nworld'
    await sender.client.callTool({ name: 'channel_message', arguments: { channel: '#ip-ml-ec1', text } })

    const n = await receiver.waitForNotification(
      n => n.meta.channel === '#ip-ml-ec1' && n.meta.sender === 'ip-ml-ec1-s',
    )
    expect(n.content).toBe(text)
  })

  it('trailing newline preserved', async () => {
    const sender = await startMcpInProcess(ergo, 'ip-ml-ec2-s')
    const receiver = await startMcpInProcess(ergo, 'ip-ml-ec2-r')
    await sender.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-ml-ec2' } })
    await receiver.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-ml-ec2' } })

    const text = 'hello\nworld\n'
    await sender.client.callTool({ name: 'channel_message', arguments: { channel: '#ip-ml-ec2', text } })

    const n = await receiver.waitForNotification(
      n => n.meta.channel === '#ip-ml-ec2' && n.meta.sender === 'ip-ml-ec2-s',
    )
    expect(n.content).toBe(text)
  })

  it('message exactly at byte boundary takes fast path (no batch)', async () => {
    const mcp = await startMcpInProcess(ergo, 'ip-ml-ec3-s')
    const peer = await connectPeer(ergo, 'ip-ml-ec3-p')
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-ml-ec3' } })
    await peer.joinChannel('#ip-ml-ec3')

    const text = 'x'.repeat(MULTILINE_LINE_BYTES) // exactly at threshold — single PRIVMSG
    const result = await mcp.client.callTool({
      name: 'channel_message',
      arguments: { channel: '#ip-ml-ec3', text },
    })
    expect(result.isError).toBeFalsy()
    expect(toolText(result)).not.toContain('batch')

    await peer.waitForMessage('#ip-ml-ec3', m => m.nick === 'ip-ml-ec3-s' && m.text === text)
  })

  it('message one byte over boundary sends as draft/multiline batch', async () => {
    const sender = await startMcpInProcess(ergo, 'ip-ml-ec4-s')
    const receiver = await startMcpInProcess(ergo, 'ip-ml-ec4-r')
    await sender.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-ml-ec4' } })
    await receiver.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-ml-ec4' } })

    const text = 'x'.repeat(MULTILINE_LINE_BYTES + 1) // one byte over — must split with concat
    const result = await sender.client.callTool({
      name: 'channel_message',
      arguments: { channel: '#ip-ml-ec4', text },
    })
    expect(result.isError).toBeFalsy()
    expect(toolText(result)).toContain('draft/multiline batch')

    const n = await receiver.waitForNotification(
      n => n.meta.channel === '#ip-ml-ec4' && n.meta.sender === 'ip-ml-ec4-s',
    )
    expect(n.content).toBe(text)
  })

})
