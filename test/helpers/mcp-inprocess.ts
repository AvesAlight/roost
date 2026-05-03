import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterAll } from 'bun:test'
// @ts-expect-error — irc-framework lacks first-class type defs
import IRC from 'irc-framework'
import { createMcpServer } from '../../src/irc-server.js'
import type { ErgoContext } from './ergo.js'
import { sleep } from './tool.js'

export interface ChannelNotification {
  content: string
  meta: Record<string, string>
  cursor: number
}

export interface McpInProcessContext {
  client: Client
  nick: string
  notifications: ChannelNotification[]
  waitForNotification(
    pred: (n: ChannelNotification) => boolean,
    timeoutMs?: number,
    fromCursor?: number,
  ): Promise<ChannelNotification>
}

let instanceCounter = 0

export async function startMcpInProcess(
  ergo: ErgoContext,
  nick?: string,
): Promise<McpInProcessContext> {
  const clientNick = nick ?? `ip-mcp${++instanceCounter}`

  const ircClient = new IRC.Client()
  const { server } = createMcpServer(ircClient, {
    nick: clientNick,
    autoJoin: [],
    historySize: 50,
    joinHistoryLines: 20,
    joinHistoryMinutes: 30,
  })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)

  const notifications: ChannelNotification[] = []
  const waiters: Array<{
    pred: (n: ChannelNotification) => boolean
    resolve: (n: ChannelNotification) => void
    reject: (e: Error) => void
  }> = []

  const client = new Client({ name: 'roost-test-ip', version: '0.0.1' })
  client.fallbackNotificationHandler = async (notification) => {
    if (notification.method !== 'notifications/claude/channel') return
    const params = notification.params as { content: string; meta: Record<string, string> }
    const n: ChannelNotification = {
      content: params.content,
      meta: params.meta,
      cursor: notifications.length + 1,
    }
    notifications.push(n)
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(n)) {
        const w = waiters.splice(i, 1)[0]
        w.resolve(n)
      }
    }
  }

  await client.connect(clientTransport)

  // Connect IRC client to ergo.
  ircClient.requestCap(['draft/multiline', 'labeled-response', 'chathistory'])
  ircClient.connect({
    host: ergo.host,
    port: ergo.port,
    nick: clientNick,
    username: clientNick,
    gecos: clientNick,
    auto_reconnect: false,
  })

  // Poll until IRC has registered (channel_who returns non-error).
  const deadline = Date.now() + 5000
  while (true) {
    const r = await client.callTool({ name: 'channel_who', arguments: { channel: '#_ready' } })
    if (!r.isError) break
    const text = (((r.content as unknown[])[0] ?? {}) as { text?: string }).text ?? ''
    if (!text.includes('not ready')) break
    if (Date.now() > deadline) throw new Error(`startMcpInProcess: IRC not ready within 5s (nick=${clientNick})`)
    await sleep(50)
  }

  afterAll(async () => {
    ircClient.quit()
    await client.close()
  })

  return {
    client,
    nick: clientNick,
    notifications,
    waitForNotification(pred, timeoutMs = 5000, fromCursor = 0) {
      return new Promise((resolve, reject) => {
        for (let i = fromCursor; i < notifications.length; i++) {
          if (pred(notifications[i])) { resolve(notifications[i]); return }
        }
        const timer = setTimeout(() => {
          const idx = waiters.findIndex(w => w.resolve === resolve)
          if (idx !== -1) waiters.splice(idx, 1)
          reject(new Error(`waitForNotification timed out after ${timeoutMs}ms`))
        }, timeoutMs)
        waiters.push({
          pred,
          resolve: (n) => { clearTimeout(timer); resolve(n) },
          reject,
        })
      })
    },
  }
}
