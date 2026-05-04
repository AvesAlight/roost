import { describe, it, expect, beforeAll } from 'bun:test'
import { startErgo, startErgoDedicated, isErgoAvailable, type ErgoContext } from './helpers/ergo.js'
import { startMcp } from './helpers/mcp.js'

describe.if(isErgoAvailable())('reconnect, ordering, and nick collision', () => {
  let ergo: ErgoContext

  beforeAll(async () => {
    ergo = (await startErgo())!
  })

  it('kill + restart ergo → MCP auto-reconnects; irc_ready flips false then true', async () => {
    const dedicated = await startErgoDedicated()
    if (!dedicated) return

    try {
      const mcp = await startMcp(dedicated, 'reconnect-mcp')

      // Confirm ready
      let r = await mcp.client.callTool({ name: 'channel_who', arguments: { channel: '#_ready' } })
      expect(r.isError).toBeFalsy()

      // irc-framework only schedules auto_reconnect if registered_ms_ago > 5000.
      // Wait 6s so the connection is "safely registered" before we kill it.
      await new Promise<void>(res => setTimeout(res, 6000))

      // Kill ergo — socket close fires, irc_ready goes false
      await dedicated.kill()

      const notReadyDeadline = Date.now() + 5000
      while (true) {
        r = await mcp.client.callTool({ name: 'channel_who', arguments: { channel: '#_ready' } })
        if (r.isError) break
        if (Date.now() > notReadyDeadline) throw new Error('MCP did not go not-ready after ergo kill')
        await new Promise<void>(res => setTimeout(res, 100))
      }
      const notReadyText = (((r.content as unknown[])[0] ?? {}) as { text?: string }).text ?? ''
      expect(notReadyText).toContain('not ready')

      // Restart ergo on the same port — MCP auto_reconnect kicks in
      await dedicated.restart()

      const readyDeadline = Date.now() + 15000
      while (true) {
        r = await mcp.client.callTool({ name: 'channel_who', arguments: { channel: '#_ready' } })
        if (!r.isError) break
        if (Date.now() > readyDeadline) throw new Error('MCP did not reconnect within 15s')
        await new Promise<void>(res => setTimeout(res, 200))
      }
      expect(r.isError).toBeFalsy()
    } finally {
      await dedicated.cleanup()
    }
  }, 30_000)
})
