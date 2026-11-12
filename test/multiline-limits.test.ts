import { describe, it, expect, beforeAll } from 'bun:test'
import { startErgo, isErgoAvailable, type ErgoContext } from './helpers/ergo.js'
import { startMcpInProcess } from './helpers/mcp-inprocess.js'
import { messagePredicate } from './helpers/mcp-core.js'

// ergo rejects a draft/multiline batch over max-bytes (16384) or max-lines (200)
// whole, delivering nothing. say() must split such text into batches that fit.
describe.if(isErgoAvailable())('multiline server limits', () => {
  let ergo: ErgoContext

  beforeAll(async () => {
    ergo = (await startErgo())!
  })

  async function sendAndCollect(id: string, text: string): Promise<string[]> {
    const sender = await startMcpInProcess(ergo, `ml-lim-${id}-s`)
    const receiver = await startMcpInProcess(ergo, `ml-lim-${id}-r`)
    await Promise.all([
      sender.client.callTool({ name: 'channel_join', arguments: { channel: `#ml-lim-${id}` } }),
      receiver.client.callTool({ name: 'channel_join', arguments: { channel: `#ml-lim-${id}` } }),
    ])
    await sender.client.callTool({ name: 'channel_message', arguments: { channel: `#ml-lim-${id}`, text } })

    // Batches arrive in order, so the last line of the text marks the final one.
    const lastLine = text.slice(text.lastIndexOf('\n') + 1)
    await receiver.waitForNotification(
      n => n.content.endsWith(lastLine) && messagePredicate({ channel: `#ml-lim-${id}`, sender: `ml-lim-${id}-s` })(n),
      8000,
    )
    return receiver.notifications
      .filter(messagePredicate({ channel: `#ml-lim-${id}`, sender: `ml-lim-${id}-s` }))
      .map(n => n.content)
  }

  it('delivers text over max-bytes, complete and in order', async () => {
    // 70 lines x ~290 bytes = ~20KB, well under 200 lines.
    const text = Array.from({ length: 70 }, (_, i) => `line ${i} ` + 'x'.repeat(280)).join('\n')
    expect(text.length).toBeGreaterThan(16384)
    expect((await sendAndCollect('bytes', text)).join('\n')).toBe(text)
  }, 15000)

  it('delivers text over max-lines, complete and in order', async () => {
    // 250 short lines, ~1KB total, so only the line cap is exceeded.
    const text = Array.from({ length: 250 }, (_, i) => `l${i}`).join('\n')
    expect((await sendAndCollect('lines', text)).join('\n')).toBe(text)
  }, 15000)
})
