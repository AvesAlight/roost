import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { NOT_READY_SENTINEL } from '../../src/irc-server.js'
import type { MembershipKind, SystemKind } from '../../src/irc-client.js'
import type {
  WireMeta,
  WireMessageMeta,
  WireReminderMeta,
  WireMembershipMeta,
  WireSystemMeta,
  WireUnreadSummaryMeta,
} from '../../src/wire-meta.js'
import { sleep, suppressLateRejection } from './tool.js'

let nextWaiterId = 0

export type ChannelNotificationMeta = WireMeta & { seq: string }
export type MessageNotificationMeta = WireMessageMeta & { seq: string }

export interface ChannelNotification {
  content: string
  meta: ChannelNotificationMeta
  /** Pass as `fromCursor` on the next call to skip past this notification. */
  cursor: number
}

export type MessageNotification = ChannelNotification & { meta: MessageNotificationMeta }

// Match-by-fields against an `event="message"` wire notification. Each field
// is optional and ignored if undefined; if set, all must match. An empty
// `MessageMatch` ({}) matches any message notification — useful as a
// wait-for-any-message form. Centralizing this avoids the per-site inline
// predicate pattern that bit #246: a wire-shape change is a one-file edit
// here, and the helper enforces the positive `event === 'message'`
// discriminator.
export interface MessageMatch {
  channel?: string
  sender?: string
  content?: string
  isDirect?: boolean
  mention?: boolean
  historical?: boolean
}

function isMessageNotification(n: ChannelNotification): n is MessageNotification {
  return n.meta.event === 'message'
}

function matchesMessage(n: ChannelNotification, m: MessageMatch): n is MessageNotification {
  if (!isMessageNotification(n)) return false
  // Bind the narrowed meta to its concrete variant. Direct field reads through
  // `n.meta` after a discriminant check work locally on TS6/macOS but fail on
  // TS6/linux for the `WireMeta & { seq }` intersection — the union still
  // surfaces in later reads. The explicit-typed local locks the narrowing.
  const meta: MessageNotificationMeta = n.meta
  if (m.channel !== undefined && meta.channel !== m.channel) return false
  if (m.sender !== undefined && meta.sender !== m.sender) return false
  if (m.content !== undefined && n.content !== m.content) return false
  if (m.isDirect !== undefined && (meta.isDirect === 'true') !== m.isDirect) return false
  if (m.mention !== undefined && (meta.mention === 'true') !== m.mention) return false
  if (m.historical !== undefined && (meta.historical === 'true') !== m.historical) return false
  return true
}

/** Type-predicate factory for `waitForNotification`. The narrowed result has
 *  `meta: WireMessageMeta & { seq: string }`. `messagePredicate({})` matches
 *  any message notification — useful as a wait-for-any-message form. */
export function messagePredicate(m: MessageMatch = {}): (n: ChannelNotification) => n is MessageNotification {
  return (n): n is MessageNotification => matchesMessage(n, m)
}

/** Fail-fast assertion: throws on mismatch, narrows `n` to MessageNotification on success. */
export function assertChannelMessage(
  n: ChannelNotification,
  m: MessageMatch,
): asserts n is MessageNotification {
  if (matchesMessage(n, m)) return
  const got = {
    event: n.meta.event,
    channel: n.meta.channel,
    sender: n.meta.sender,
    content: n.content,
    isDirect: n.meta.isDirect,
  }
  throw new Error(
    `channel message mismatch\n  expected: ${JSON.stringify(m)}\n  got: ${JSON.stringify(got)}`,
  )
}

// Generic event-narrowing helpers for non-message events (membership, reminder,
// system, unread-summary). `eventPredicate('join', { sender: 'x' })` narrows
// awaited notifications to the matching variant; `expectEvent(n, 'leave')`
// asserts an already-held notification and narrows it.
//
// The mapping is explicit (rather than `Extract<>`) because variants with a
// union-typed `event` field (WireMembershipMeta, WireSystemMeta) aren't
// assignable to `{event: 'join'}` and would `Extract` to `never`.
export type EventVariantMeta<E extends WireMeta['event']> =
  E extends 'message' ? WireMessageMeta & { event: 'message' }
  : E extends 'reminder' ? WireReminderMeta & { event: 'reminder' }
  : E extends MembershipKind ? WireMembershipMeta & { event: E }
  : E extends 'unread-summary' ? WireUnreadSummaryMeta & { event: 'unread-summary' }
  : E extends SystemKind ? WireSystemMeta & { event: E }
  : never
export type EventNotification<E extends WireMeta['event']> =
  ChannelNotification & { meta: EventVariantMeta<E> & { seq: string } }

export function eventPredicate<E extends WireMeta['event']>(
  event: E,
  opts: Partial<Omit<EventVariantMeta<E>, 'event' | 'seq'>> = {},
): (n: ChannelNotification) => n is EventNotification<E> {
  return (n): n is EventNotification<E> => {
    if (n.meta.event !== event) return false
    const meta = n.meta as unknown as Record<string, string | undefined>
    for (const [k, v] of Object.entries(opts as Record<string, string | undefined>)) {
      if (v === undefined) continue
      if (meta[k] !== v) return false
    }
    return true
  }
}

export function expectEvent<E extends WireMeta['event']>(
  n: ChannelNotification,
  event: E,
): asserts n is EventNotification<E> {
  if (n.meta.event !== event) {
    throw new Error(`expected event="${event}", got event="${n.meta.event}"`)
  }
}

export interface McpHandle {
  client: Client
  nick: string
  notifications: ChannelNotification[]
  // Type-predicate overload: a narrowing predicate (e.g. from `messagePredicate`)
  // propagates the narrowed type through to the awaited result.
  waitForNotification<T extends ChannelNotification>(
    pred: (n: ChannelNotification) => n is T,
    timeoutMs?: number,
    fromCursor?: number,
  ): Promise<T>
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
    id: number
    pred: (n: ChannelNotification) => boolean
    resolve: (n: ChannelNotification) => void
  }> = []

  const client = new Client({ name: 'roost-test', version: '0.0.1' })

  client.fallbackNotificationHandler = async (notification) => {
    if (notification.method !== 'notifications/claude/channel') return
    const params = notification.params as { content: string; meta: ChannelNotificationMeta }
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
    waitForNotification: ((
      pred: (n: ChannelNotification) => boolean,
      timeoutMs = 15000,
      fromCursor = 0,
    ) => suppressLateRejection(new Promise<ChannelNotification>((resolve, reject) => {
      for (let i = fromCursor; i < notifications.length; i++) {
        if (pred(notifications[i])) { resolve(notifications[i]); return }
      }
      const waiterId = nextWaiterId++
      const wrappedResolve = (n: ChannelNotification) => { clearTimeout(timer); resolve(n) }
      const timer = setTimeout(() => {
        const idx = waiters.findIndex(w => w.id === waiterId)
        if (idx !== -1) waiters.splice(idx, 1)
        reject(new Error(`waitForNotification timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      waiters.push({ id: waiterId, pred, resolve: wrappedResolve })
    }))) as McpHandle['waitForNotification'],
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
    if (!text.includes(NOT_READY_SENTINEL)) return
    if (Date.now() > deadline) throw new Error(`IRC not ready within ${deadlineMs / 1000}s (nick=${handle.nick})`)
    await sleep(50)
  }
}
