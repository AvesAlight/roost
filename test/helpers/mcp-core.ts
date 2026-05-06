import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { sleep } from './tool.js'

export interface ChannelNotification {
  content: string
  meta: Record<string, string>
  /** Pass as `fromCursor` on the next call to skip past this notification. */
  cursor: number
}

export interface McpHandle {
  client: Client
  nick: string
  notifications: ChannelNotification[]
  waitForNotification(
    pred: (n: ChannelNotification) => boolean,
    timeoutMs?: number,
    fromCursor?: number,
  ): Promise<ChannelNotification>
}

/**
 * Connect an MCP client to `transport`, install a notifications/claude/channel
 * handler that records into `notifications` and wakes any matching waiters,
 * and return a handle. Caller is responsible for teardown (afterAll, etc.) and
 * for any IRC-side connection bring-up.
 */
export async function wireMcpClient(
  transport: Transport,
  nick: string,
): Promise<McpHandle & { waiterCount: () => number }> {
  const notifications: ChannelNotification[] = []
  const waiters: Array<{
    pred: (n: ChannelNotification) => boolean
    resolve: (n: ChannelNotification) => void
  }> = []

  const client = new Client({ name: 'roost-test', version: '0.0.1' })

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

  await client.connect(transport)

  return {
    client,
    nick,
    notifications,
    waiterCount: () => waiters.length,
    waitForNotification(pred, timeoutMs = 5000, fromCursor = 0) {
      return new Promise((resolve, reject) => {
        for (let i = fromCursor; i < notifications.length; i++) {
          if (pred(notifications[i])) { resolve(notifications[i]); return }
        }
        const wrappedResolve = (n: ChannelNotification) => { clearTimeout(timer); resolve(n) }
        const timer = setTimeout(() => {
          const idx = waiters.findIndex(w => w.resolve === wrappedResolve)
          if (idx !== -1) waiters.splice(idx, 1)
          reject(new Error(`waitForNotification timed out after ${timeoutMs}ms`))
        }, timeoutMs)
        waiters.push({ pred, resolve: wrappedResolve })
      })
    },
  }
}

/**
 * Poll `channel_who` until the MCP's IRC client has registered. Throws if not
 * ready within `deadlineMs`. Returns immediately on the first non-error tool
 * call (or on a non-`not ready` error, which is treated as "ready enough" —
 * caller's tool call surfaced something we don't recognize as the not-ready
 * sentinel and shouldn't loop forever).
 */
export async function pollUntilIrcReady(handle: McpHandle, deadlineMs = 5000): Promise<void> {
  const deadline = Date.now() + deadlineMs
  while (true) {
    const r = await handle.client.callTool({ name: 'channel_who', arguments: { channel: '#_ready' } })
    if (!r.isError) return
    const text = (((r.content as unknown[])[0] ?? {}) as { text?: string }).text ?? ''
    if (!text.includes('not ready')) return
    if (Date.now() > deadline) throw new Error(`IRC not ready within ${deadlineMs / 1000}s (nick=${handle.nick})`)
    await sleep(50)
  }
}
