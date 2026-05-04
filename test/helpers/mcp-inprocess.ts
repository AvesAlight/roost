import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterAll } from 'bun:test'
// @ts-expect-error — irc-framework lacks first-class type defs
import IRC from 'irc-framework'
import { createMcpServer } from '../../src/irc-server.js'
import type { ErgoContext } from './ergo.js'
import { wireMcpClient, pollUntilIrcReady, type McpHandle, type ChannelNotification } from './mcp-core.js'

export type { ChannelNotification }

export interface McpInProcessContext extends McpHandle {
  waiterCount: () => number
  emitUnreadSummary: () => void
}

export interface StartMcpInProcessOptions {
  historySize?: number
  joinHistoryLines?: number
  joinHistoryMinutes?: number
}

let instanceCounter = 0

export async function startMcpInProcess(
  ergo: ErgoContext,
  nick?: string,
  options?: StartMcpInProcessOptions,
): Promise<McpInProcessContext> {
  const clientNick = nick ?? `ip-mcp${++instanceCounter}`

  const ircClient = new IRC.Client()
  const { server, emitUnreadSummary } = createMcpServer(ircClient, {
    nick: clientNick,
    autoJoin: [],
    historySize: options?.historySize ?? 50,
    joinHistoryLines: options?.joinHistoryLines ?? 20,
    joinHistoryMinutes: options?.joinHistoryMinutes ?? 30,
  })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)

  const handle = await wireMcpClient(clientTransport, clientNick, 'roost-test-ip')

  ircClient.requestCap(['draft/multiline', 'labeled-response', 'chathistory'])
  ircClient.connect({
    host: ergo.host,
    port: ergo.port,
    nick: clientNick,
    username: clientNick,
    gecos: clientNick,
    auto_reconnect: false,
  })

  await pollUntilIrcReady(handle)

  afterAll(async () => {
    ircClient.quit()
    await handle.client.close()
  })

  return { ...handle, emitUnreadSummary }
}
