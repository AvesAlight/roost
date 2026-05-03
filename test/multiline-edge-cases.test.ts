import { describe, it, expect, beforeAll } from 'bun:test'
import { startErgo, isErgoAvailable, type ErgoContext } from './helpers/ergo.js'
import { startMcp } from './helpers/mcp.js'
import { connectPeer } from './helpers/peer.js'
import { toolText } from './helpers/tool.js'
import { MULTILINE_LINE_BYTES } from '../src/constants.js'

describe.if(isErgoAvailable())('multiline edge cases', () => {
  let ergo: ErgoContext

  beforeAll(async () => {
    ergo = (await startErgo())!
  })

  it('empty lines preserved (consecutive \\n round-trip)', async () => {
    const sender = await startMcp(ergo, 'ml-ec1-s')
    const receiver = await startMcp(ergo, 'ml-ec1-r')
    await sender.client.callTool({ name: 'channel_join', arguments: { channel: '#ml-ec1' } })
    await receiver.client.callTool({ name: 'channel_join', arguments: { channel: '#ml-ec1' } })

    const text = 'hello\n\nworld'
    await sender.client.callTool({ name: 'channel_message', arguments: { channel: '#ml-ec1', text } })

    const n = await receiver.waitForNotification(
      n => n.meta.channel === '#ml-ec1' && n.meta.sender === 'ml-ec1-s',
    )
    expect(n.content).toBe(text)
  })

  it('trailing newline preserved', async () => {
    const sender = await startMcp(ergo, 'ml-ec2-s')
    const receiver = await startMcp(ergo, 'ml-ec2-r')
    await sender.client.callTool({ name: 'channel_join', arguments: { channel: '#ml-ec2' } })
    await receiver.client.callTool({ name: 'channel_join', arguments: { channel: '#ml-ec2' } })

    const text = 'hello\nworld\n'
    await sender.client.callTool({ name: 'channel_message', arguments: { channel: '#ml-ec2', text } })

    const n = await receiver.waitForNotification(
      n => n.meta.channel === '#ml-ec2' && n.meta.sender === 'ml-ec2-s',
    )
    expect(n.content).toBe(text)
  })

  it('message exactly at byte boundary takes fast path (no batch)', async () => {
    const mcp = await startMcp(ergo, 'ml-ec3-s')
    const peer = await connectPeer(ergo, 'ml-ec3-p')
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ml-ec3' } })
    await peer.joinChannel('#ml-ec3')

    const text = 'x'.repeat(MULTILINE_LINE_BYTES) // exactly at threshold — single PRIVMSG
    const result = await mcp.client.callTool({
      name: 'channel_message',
      arguments: { channel: '#ml-ec3', text },
    })
    expect(result.isError).toBeFalsy()
    expect(toolText(result)).not.toContain('batch')

    await peer.waitForMessage('#ml-ec3', m => m.nick === 'ml-ec3-s' && m.text === text)
  })

  it('message one byte over boundary sends as draft/multiline batch', async () => {
    const sender = await startMcp(ergo, 'ml-ec4-s')
    const receiver = await startMcp(ergo, 'ml-ec4-r')
    await sender.client.callTool({ name: 'channel_join', arguments: { channel: '#ml-ec4' } })
    await receiver.client.callTool({ name: 'channel_join', arguments: { channel: '#ml-ec4' } })

    const text = 'x'.repeat(MULTILINE_LINE_BYTES + 1) // one byte over — must split with concat
    const result = await sender.client.callTool({
      name: 'channel_message',
      arguments: { channel: '#ml-ec4', text },
    })
    expect(result.isError).toBeFalsy()
    expect(toolText(result)).toContain('draft/multiline batch')

    const n = await receiver.waitForNotification(
      n => n.meta.channel === '#ml-ec4' && n.meta.sender === 'ml-ec4-s',
    )
    expect(n.content).toBe(text)
  })

  it('exceeding max-lines: tool succeeds and something arrives', async () => {
    // 201 lines > ergo's max-lines=200 (see makeErgoConfig in test/helpers/ergo.ts) — triggers legacy fallback.
    // known: legacy path drops newlines on delivery (client.say pre-splits on \n); see #58
    const sender = await startMcp(ergo, 'ml-ec5-s')
    const receiver = await startMcp(ergo, 'ml-ec5-r')
    await sender.client.callTool({ name: 'channel_join', arguments: { channel: '#ml-ec5' } })
    await receiver.client.callTool({ name: 'channel_join', arguments: { channel: '#ml-ec5' } })

    const text = Array.from({ length: 201 }, (_, i) => `line${i}`).join('\n')
    const result = await sender.client.callTool({
      name: 'channel_message',
      arguments: { channel: '#ml-ec5', text },
    })
    expect(result.isError).toBeFalsy()

    // content check deferred to #57 — assert at minimum that something arrived
    await receiver.waitForNotification(
      n => n.meta.channel === '#ml-ec5' && n.meta.sender === 'ml-ec5-s',
    )
  })

  it('mix of long and short logical lines reassembles correctly', async () => {
    const sender = await startMcp(ergo, 'ml-ec6-s')
    const receiver = await startMcp(ergo, 'ml-ec6-r')
    await sender.client.callTool({ name: 'channel_join', arguments: { channel: '#ml-ec6' } })
    await receiver.client.callTool({ name: 'channel_join', arguments: { channel: '#ml-ec6' } })

    // Two long lines (each needs concat-split) bracketing a short line
    const longA = 'a'.repeat(MULTILINE_LINE_BYTES + 150)
    const shortB = 'short'
    const longC = 'c'.repeat(MULTILINE_LINE_BYTES + 50)
    const text = `${longA}\n${shortB}\n${longC}`

    const result = await sender.client.callTool({
      name: 'channel_message',
      arguments: { channel: '#ml-ec6', text },
    })
    expect(result.isError).toBeFalsy()
    expect(toolText(result)).toContain('draft/multiline batch')

    const n = await receiver.waitForNotification(
      n => n.meta.channel === '#ml-ec6' && n.meta.sender === 'ml-ec6-s',
    )
    expect(n.content).toBe(text)
  })
})
