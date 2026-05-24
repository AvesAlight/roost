import { describe, it, expect, beforeAll } from 'bun:test'
import { startErgo, isErgoAvailable, type ErgoContext } from './helpers/ergo.js'
import { startMcpInProcess } from './helpers/mcp-inprocess.js'
import { startMcp } from './helpers/mcp.js'
import { messagePredicate } from './helpers/mcp-core.js'
import { connectPeer } from './helpers/peer.js'
import { toolText } from './helpers/tool.js'
import { MULTILINE_LINE_BYTES } from '../src/constants.js'

describe.if(isErgoAvailable())('multiline edge cases', () => {
  let ergo: ErgoContext

  beforeAll(async () => {
    ergo = (await startErgo())!
  })

  it('empty lines preserved (consecutive \\n round-trip)', async () => {
    const sender = await startMcpInProcess(ergo, 'ip-ml-ec1-s')
    const receiver = await startMcpInProcess(ergo, 'ip-ml-ec1-r')
    await Promise.all([
      sender.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-ml-ec1' } }),
      receiver.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-ml-ec1' } }),
    ])

    const text = 'hello\n\nworld'
    await sender.client.callTool({ name: 'channel_message', arguments: { channel: '#ip-ml-ec1', text } })

    const n = await receiver.waitForNotification(
      messagePredicate({ channel: '#ip-ml-ec1', sender: 'ip-ml-ec1-s' }),
    )
    expect(n.content).toBe(text)
  })

  it('trailing newline preserved', async () => {
    const sender = await startMcpInProcess(ergo, 'ip-ml-ec2-s')
    const receiver = await startMcpInProcess(ergo, 'ip-ml-ec2-r')
    await Promise.all([
      sender.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-ml-ec2' } }),
      receiver.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-ml-ec2' } }),
    ])

    const text = 'hello\nworld\n'
    await sender.client.callTool({ name: 'channel_message', arguments: { channel: '#ip-ml-ec2', text } })

    const n = await receiver.waitForNotification(
      messagePredicate({ channel: '#ip-ml-ec2', sender: 'ip-ml-ec2-s' }),
    )
    expect(n.content).toBe(text)
  })

  it('message exactly at byte boundary takes fast path (no batch)', async () => {
    const mcp = await startMcpInProcess(ergo, 'ip-ml-ec3-s')
    const peer = await connectPeer(ergo, 'ip-ml-ec3-p')
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-ml-ec3' } })
    await peer.joinChannel('#ip-ml-ec3')

    const text = 'x'.repeat(MULTILINE_LINE_BYTES) // exactly at threshold — single PRIVMSG
    const messageSeen = peer.waitForMessage('#ip-ml-ec3', m => m.nick === 'ip-ml-ec3-s' && m.text === text)
    const result = await mcp.client.callTool({
      name: 'channel_message',
      arguments: { channel: '#ip-ml-ec3', text },
    })
    expect(result.isError).toBeFalsy()

    await messageSeen
  })

  it('message one byte over boundary sends as draft/multiline batch', async () => {
    const sender = await startMcpInProcess(ergo, 'ip-ml-ec4-s')
    const receiver = await startMcpInProcess(ergo, 'ip-ml-ec4-r')
    await Promise.all([
      sender.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-ml-ec4' } }),
      receiver.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-ml-ec4' } }),
    ])

    const text = 'x'.repeat(MULTILINE_LINE_BYTES + 1) // one byte over — must split with concat
    const result = await sender.client.callTool({
      name: 'channel_message',
      arguments: { channel: '#ip-ml-ec4', text },
    })
    expect(result.isError).toBeFalsy()

    const n = await receiver.waitForNotification(
      messagePredicate({ channel: '#ip-ml-ec4', sender: 'ip-ml-ec4-s' }),
    )
    expect(n.content).toBe(text)
  })
})

// Subprocess-only: these time out intermittently under the in-process harness
// (timing-sensitive boundary cases). Tracked in #83.
describe.if(isErgoAvailable())('multiline edge cases (subprocess)', () => {
  let ergo: ErgoContext

  beforeAll(async () => {
    ergo = (await startErgo())!
  })

  it('exceeding max-lines: tool succeeds', async () => {
    // 201 lines > ergo's max-lines=200 (see makeErgoConfig in test/helpers/ergo.ts).
    // Server emits a stderr warning and sends as a multiline batch anyway; ergo drops the batch.
    const sender = await startMcp(ergo, 'ml-ec5-s')
    const receiver = await startMcp(ergo, 'ml-ec5-r')
    await Promise.all([
      sender.client.callTool({ name: 'channel_join', arguments: { channel: '#ml-ec5' } }),
      receiver.client.callTool({ name: 'channel_join', arguments: { channel: '#ml-ec5' } }),
    ])

    const text = Array.from({ length: 201 }, (_, i) => `line${i}`).join('\n')
    const result = await sender.client.callTool({
      name: 'channel_message',
      arguments: { channel: '#ml-ec5', text },
    })
    expect(result.isError).toBeFalsy()
    void receiver // joined to ensure ergo sees a recipient; delivery not guaranteed when batch exceeds max-lines
  })

  it('mix of long and short logical lines reassembles correctly', async () => {
    const sender = await startMcp(ergo, 'ml-ec6-s')
    const receiver = await startMcp(ergo, 'ml-ec6-r')
    await Promise.all([
      sender.client.callTool({ name: 'channel_join', arguments: { channel: '#ml-ec6' } }),
      receiver.client.callTool({ name: 'channel_join', arguments: { channel: '#ml-ec6' } }),
    ])

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

    const n = await receiver.waitForNotification(
      messagePredicate({ channel: '#ml-ec6', sender: 'ml-ec6-s' }),
    )
    expect(n.content).toBe(text)
  })
})
