import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterAll } from 'bun:test'
import { RoostIrcClientImpl } from '../../src/irc-client-impl.js'
import { createMcpServer } from '../../src/irc-server.js'
import type { ErgoContext } from './ergo.js'
import { wireMcpClient, pollUntilIrcReady, type McpHandle, type ChannelNotification } from './mcp-core.js'

export type { ChannelNotification }

export interface McpInProcessContext extends McpHandle {
  waiterCount: () => number
  emitUnreadSummary: () => Promise<void>
}

export interface StartMcpInProcessOptions {
  historySize?: number
  joinHistoryLines?: number
  joinHistoryMinutes?: number
}

let instanceCounter = 0

// In-process variant: holds an explicit RoostIrcClientImpl; teardown calls quit() then
// closes the transport. Contrast with startMcp which relies on the process boundary.
export async function startMcpInProcess(
  ergo: ErgoContext,
  nick?: string,
  options?: StartMcpInProcessOptions,
): Promise<McpInProcessContext> {
  const clientNick = nick ?? `ip-mcp${++instanceCounter}`

  const clientConfig = {
    nick: clientNick,
    autoJoin: [],
    historySize: options?.historySize ?? 50,
    joinHistoryLines: options?.joinHistoryLines ?? 20,
    joinHistoryMinutes: options?.joinHistoryMinutes ?? 30,
  }

  const ircClient = new RoostIrcClientImpl(clientConfig)
  const { server, emitUnreadSummary } = createMcpServer(ircClient, clientConfig)

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)

  const handle = await wireMcpClient(clientTransport, clientNick)

  ircClient.connect({
    host: ergo.host,
    port: ergo.port,
    nick: clientNick,
    autoReconnect: false,
  })

  await pollUntilIrcReady(handle)

  afterAll(async () => {
    ircClient.quit()
    await handle.client.close()
  })

  return { ...handle, emitUnreadSummary }
}
