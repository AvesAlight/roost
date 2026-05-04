import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { join } from 'node:path'
import { afterAll } from 'bun:test'
import type { ErgoContext } from './ergo.js'
import { wireMcpClient, pollUntilIrcReady, type McpHandle } from './mcp-core.js'

export type { ChannelNotification, McpHandle as McpContext } from './mcp-core.js'

const ROOST_ROOT = join(import.meta.dirname, '..', '..')

let instanceCounter = 0

export async function startMcp(ergo: ErgoContext, nick?: string, extraEnv?: Record<string, string>): Promise<McpHandle> {
  const clientNick = nick ?? `mcp${++instanceCounter}`

  const transport = new StdioClientTransport({
    command: 'bun',
    args: ['run', join(ROOST_ROOT, 'src', 'irc-server.ts')],
    env: {
      ...process.env,
      ROOST_IRC_SERVER: ergo.host,
      ROOST_IRC_PORT: String(ergo.port),
      ROOST_IRC_NICK: clientNick,
      ...extraEnv,
    },
    stderr: 'inherit',
  })

  const handle = await wireMcpClient(transport, clientNick)

  afterAll(async () => {
    // close() sends stdin EOF then SIGTERM (2s grace each) — terminates subprocess even if IRC reconnect timers are live
    await handle.client.close()
  })

  await pollUntilIrcReady(handle)
  return handle
}
