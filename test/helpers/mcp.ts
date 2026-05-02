import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { join } from 'node:path'
import { afterAll } from 'bun:test'
import type { ErgoContext } from './ergo.js'
import { sleep } from './tool.js'

const ROOST_ROOT = join(import.meta.dirname, '..', '..')

export interface ChannelNotification {
  content: string
  meta: Record<string, string>
}

export interface McpContext {
  client: Client
  nick: string
  notifications: ChannelNotification[]
  waitForNotification(
    pred: (n: ChannelNotification) => boolean,
    timeoutMs?: number,
  ): Promise<ChannelNotification>
}

let instanceCounter = 0

export async function startMcp(ergo: ErgoContext, nick?: string): Promise<McpContext> {
  const clientNick = nick ?? `mcp${++instanceCounter}`

  const transport = new StdioClientTransport({
    command: 'bun',
    args: ['run', join(ROOST_ROOT, 'src', 'irc-server.ts')],
    env: {
      ...process.env,
      ROOST_IRC_SERVER: ergo.host,
      ROOST_IRC_PORT: String(ergo.port),
      ROOST_IRC_NICK: clientNick,
    },
    stderr: 'inherit',
  })

  const notifications: ChannelNotification[] = []
  const waiters: Array<{
    pred: (n: ChannelNotification) => boolean
    resolve: (n: ChannelNotification) => void
    reject: (e: Error) => void
  }> = []

  const client = new Client({ name: 'roost-test', version: '0.0.1' })

  client.fallbackNotificationHandler = async (notification) => {
    if (notification.method !== 'notifications/claude/channel') return
    const params = notification.params as { content: string; meta: Record<string, string> }
    const n: ChannelNotification = { content: params.content, meta: params.meta }
    notifications.push(n)
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(n)) {
        const w = waiters.splice(i, 1)[0]
        w.resolve(n)
      }
    }
  }

  await client.connect(transport)

  // Poll until the IRC client has registered — tools return isError before that.
  const deadline = Date.now() + 5000
  while (true) {
    const r = await client.callTool({ name: 'channel_who', arguments: { channel: '#_ready' } })
    if (!r.isError) break
    const text = (((r.content as unknown[])[0] ?? {}) as { text?: string }).text ?? ''
    if (!text.includes('not ready')) break // unexpected error — don't loop forever
    if (Date.now() > deadline) throw new Error(`startMcp: IRC not ready within 5s (nick=${clientNick})`)
    await sleep(50)
  }

  afterAll(async () => {
    await client.close()
  })

  return {
    client,
    nick: clientNick,
    notifications,
    waitForNotification(pred, timeoutMs = 5000) {
      return new Promise((resolve, reject) => {
        const existing = notifications.find(pred)
        if (existing) { resolve(existing); return }

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
