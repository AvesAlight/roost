#!/usr/bin/env bun
/**
 * roost IRC channel MCP — v0
 *
 * Wraps an IRC client (irc-framework). Incoming IRC traffic — channel
 * messages and DMs — is emitted into the host Claude session as
 * `notifications/claude/channel` events. Outbound actions are exposed
 * as MCP tools: channel_join, channel_leave, channel_message,
 * direct_message, channel_history, channel_who.
 *
 * Identity is per-MCP-instance: the agent's nick is configured at
 * spawn time via env vars. Multiple Claude sessions on one machine
 * each get their own MCP subprocess and therefore their own nick.
 *
 * Configuration (env vars):
 *   ROOST_IRC_SERVER     IRC server (default: 127.0.0.1)
 *   ROOST_IRC_PORT       IRC port   (default: 6667)
 *   ROOST_IRC_NICK       Nick       (REQUIRED, no default)
 *   ROOST_IRC_REALNAME   Realname   (default: same as nick)
 *   ROOST_IRC_CHANNELS   Comma-separated auto-join list (default: none)
 *   ROOST_IRC_HISTORY              Per-channel history buffer size (default: 50)
 *   ROOST_IRC_JOIN_HISTORY_LINES   Max historical messages emitted on join (default: 20)
 *   ROOST_IRC_JOIN_HISTORY_MINUTES Time window for join history in minutes (default: 30)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
// @ts-expect-error — irc-framework lacks first-class type defs
import IRC from 'irc-framework'
import { MULTILINE_LINE_BYTES } from './constants.js'
import {
  IrcMessage,
  splitLineForMultiline,
  newBatchId,
  reassembleMultilineBatch,
} from './irc-lib.js'

const SOURCE_NAME = 'roost-irc'
const CAP_CHATHISTORY = 'chathistory'

export interface McpServerConfig {
  nick: string
  autoJoin: string[]
  historySize: number
  joinHistoryLines: number
  joinHistoryMinutes: number
}

// Wire the MCP server and IRC event handlers. Does NOT connect to any
// transport or start the IRC connection — the caller does both after
// createMcpServer returns. Call order: createMcpServer → server.connect(transport)
// → ircClient.requestCap/connect.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createMcpServer(ircClient: any, config: McpServerConfig): { server: Server; clearDedupeCache: () => void; emitUnreadSummary: () => void } {
  const { nick: NICK, autoJoin: AUTO_JOIN, historySize: HISTORY_SIZE,
    joinHistoryLines: JOIN_HISTORY_LINES, joinHistoryMinutes: JOIN_HISTORY_MINUTES } = config

  // ---- IRC client wiring -------------------------------------------------

  let irc_ready = false
  let hasRegistered = false
  const join_resolvers = new Map<string, Array<(ok: boolean) => void>>()

  // Max lines per draft/multiline batch, from the cap value
  // (`draft/multiline=max-bytes=16384,max-lines=200`). Pre-negotiation
  // placeholder; overwritten on registration.
  let multilineMaxLines = 100

  // Per-channel ring buffer of recent messages — gives us
  // channel_history without needing a bouncer.
  const history: Map<string, IrcMessage[]> = new Map()
  const pushHistory = (key: string, msg: IrcMessage) => {
    const buf = history.get(key) ?? []
    buf.push(msg)
    while (buf.length > HISTORY_SIZE) buf.shift()
    history.set(key, buf)
  }

  interface UnreadInfo {
    count: number
    lastSender: string
    lastPreview: string
  }
  const unread: Map<string, UnreadInfo> = new Map()

  const formatUnreadLine = (ch: string, info: UnreadInfo, previewLength = 40): string => {
    const raw = info.lastPreview.length > previewLength
      ? info.lastPreview.slice(0, previewLength - 3) + '...'
      : info.lastPreview
    return `${ch} (${info.count}) ${info.lastSender}: "${raw.replaceAll('"', "'")}"`
  }

  const unreadSuffix = (): string => {
    if (unread.size === 0) return ''
    return '\nunread:\n' + [...unread.entries()].map(([ch, i]) => `  ${formatUnreadLine(ch, i)}`).join('\n')
  }

  // ---- Replay dedupe (issue #44) -----------------------------------------

  // Per-channel seen-fingerprint sets. Each channel's set is capped at
  // HISTORY_SIZE; eviction uses Set insertion order (oldest first).
  const seenFingerprints = new Map<string, Set<string>>()

  const msgFingerprint = (msg: IrcMessage): string =>
    `${msg.sender}|${msg.ts}|${msg.text}`

  const addFingerprint = (msg: IrcMessage) => {
    let set = seenFingerprints.get(msg.channel)
    if (!set) {
      set = new Set()
      seenFingerprints.set(msg.channel, set)
    }
    const fp = msgFingerprint(msg)
    if (set.has(fp)) return
    set.add(fp)
    while (set.size > HISTORY_SIZE) set.delete(set.values().next().value!)
  }

  const hasFingerprint = (msg: IrcMessage): boolean =>
    seenFingerprints.get(msg.channel)?.has(msgFingerprint(msg)) ?? false

  // ---- Send-side splitting -----------------------------------------------
  //
  // Outbound long messages are sent as a draft/multiline batch:
  // `BATCH +<id> draft/multiline <target>` followed by tagged PRIVMSGs
  // and `BATCH -<id>`. The receiving MCP listens for
  // `batch end draft/multiline` and emits a single channel event.
  // Lossless: explicit \n's round-trip via the draft/multiline-concat tag.

  // Per-MCP monotonic receive counter — gives downstream consumers a
  // strictly-monotonic ordering even when two events resolve to the same
  // millisecond timestamp (the original bug behind reassembly).
  let receiveSeq = 0

  // ---- Per-channel user tracking -----------------------------------------
  //
  // irc-framework's client.channel(name).users is populated lazily and was
  // observed empty at runtime (probed 2026-04-28). We track our own
  // per-channel user set keyed by channel name, populated from the
  // userlist event (RPL_NAMREPLY after we JOIN) and kept current via
  // JOIN / PART / KICK / QUIT / NICK events. channel_who reads from this
  // directly; membership-change events also push channel notifications
  // so agents on the channel see comings and goings in real time.
  const channelUsers: Map<string, Set<string>> = new Map()
  const ensureChannelSet = (channel: string): Set<string> => {
    let set = channelUsers.get(channel)
    if (!set) {
      set = new Set()
      channelUsers.set(channel, set)
    }
    return set
  }

  const sendMultiline = (target: string, text: string): { chunks: number; mode: 'single' | 'multiline' } => {
    // Single-line, single-chunk fast path: no batch overhead.
    if (text.length <= MULTILINE_LINE_BYTES && !text.includes('\n')) {
      ircClient.say(target, text)
      return { chunks: 1, mode: 'single' }
    }

    const id = newBatchId()
    // Logical lines split on the source text's own newlines. An empty
    // logical line (consecutive \n's) is preserved as a zero-length PRIVMSG
    // body — receiver re-joins with \n separators, restoring the blank.
    const logicalLines = text.split('\n')
    const wireLines: Array<{ body: string; concat: boolean }> = []
    for (const line of logicalLines) {
      const chunks = splitLineForMultiline(line)
      chunks.forEach((chunk, idx) => {
        // Continuation chunks of one logical line concat onto the previous;
        // the first chunk of each logical line takes the default \n join.
        wireLines.push({ body: chunk, concat: idx > 0 })
      })
    }

    if (wireLines.length > multilineMaxLines) {
      process.stderr.write(
        `roost-irc[${NICK}]: multiline target=${target} would emit ${wireLines.length} lines, exceeds server max ${multilineMaxLines}; sending anyway\n`,
      )
    }

    ircClient.raw('BATCH', `+${id}`, 'draft/multiline', target)
    for (const { body, concat } of wireLines) {
      // Construct the wire line ourselves: irc-framework's IrcMessage
      // serializer drops the trailing-param `:` marker for empty bodies,
      // which the multiline spec explicitly permits — empty lines map to
      // empty paragraphs and must round-trip.
      //
      // Tag name is `draft/multiline-concat` — NO `+` prefix, even
      // though IRCv3 reserves `+` for client-only tags. Ergo's
      // caps/constants.go calls it `draft/multiline-concat` flat; with
      // a `+` prefix it'd be treated as an unrelated client tag, get
      // stripped on relay, and the receiver would default-newline-join
      // continuation chunks (verified 2026-04-28).
      const tagStr = concat
        ? `batch=${id};draft/multiline-concat`
        : `batch=${id}`
      ircClient.connection.write(`@${tagStr} PRIVMSG ${target} :${body}`)
    }
    ircClient.raw('BATCH', `-${id}`)
    process.stderr.write(
      `roost-irc[${NICK}]: multiline outbound to ${target} as batch ${id} (${wireLines.length} lines, ${text.length} bytes)\n`,
    )
    return { chunks: wireLines.length, mode: 'multiline' }
  }

  // Helper: format an inbound IRC message as a channel-event payload.
  const emitChannelEvent = (
    msg: IrcMessage,
    extras: { buffered?: boolean; chunkCount?: number; historical?: boolean } = {},
  ) => {
    addFingerprint(msg)
    if (!extras.historical) {
      const prev = unread.get(msg.channel)
      unread.set(msg.channel, { count: (prev?.count ?? 0) + 1, lastSender: msg.sender, lastPreview: msg.text })
    }
    const seq = ++receiveSeq
    const meta: Record<string, string> = {
      sender: msg.sender,
      channel: msg.channel,
      isDirect: String(msg.isDirect),
      ts: msg.ts,
      seq: String(seq),
      source: SOURCE_NAME,
    }
    if (extras.buffered) {
      meta.buffered = 'true'
      if (extras.chunkCount && extras.chunkCount > 1) {
        meta.chunkCount = String(extras.chunkCount)
      }
    }
    if (extras.historical) {
      meta.historical = 'true'
    }
    mcp.notification({
      method: 'notifications/claude/channel',
      params: { content: msg.text, meta },
    }).catch(() => { /* transport closed during teardown */ })
    process.stderr.write(
      `roost-irc[${NICK}]: <- ${msg.isDirect ? 'DM from' : `${msg.channel} <`}${msg.sender}> ${msg.text.length > 120 ? msg.text.slice(0, 117) + '...' : msg.text}${extras.buffered ? ` [BUFFERED x${extras.chunkCount}]` : ''}${extras.historical ? ' [HISTORY]' : ''}\n`,
    )
  }

  // Emit a JOIN/LEAVE/NICK membership event into the host session as a
  // channel notification. event="join" / event="leave" / event="nick"
  // distinguishes from regular messages. Content is a short
  // human-readable summary; meta carries structured fields.
  const emitMembershipEvent = (
    kind: 'join' | 'leave' | 'nick',
    nick: string,
    channel: string,
    extras: { reason?: string; newNick?: string } = {},
  ) => {
    const ts = new Date().toISOString()
    const seq = ++receiveSeq
    const meta: Record<string, string> = {
      sender: nick,
      channel,
      isDirect: 'false',
      ts,
      seq: String(seq),
      source: SOURCE_NAME,
      event: kind,
    }
    if (extras.reason) meta.reason = extras.reason
    if (extras.newNick) meta.newNick = extras.newNick
    const summary =
      kind === 'join' ? `${nick} joined ${channel}`
      : kind === 'nick' ? `${nick} is now known as ${extras.newNick}`
      : `${nick} left ${channel}${extras.reason ? ` (${extras.reason})` : ''}`
    mcp.notification({
      method: 'notifications/claude/channel',
      params: { content: summary, meta },
    }).catch(() => { /* transport closed during teardown */ })
    process.stderr.write(`roost-irc[${NICK}]: <- [${kind}] ${summary}\n`)
  }

  // Emit a synthetic system event (e.g. disconnected, reconnected) as a
  // channel notification. Not scoped to a channel — channel/sender are empty.
  const emitSystemEvent = (event: 'disconnected' | 'reconnected', content: string) => {
    const ts = new Date().toISOString()
    const seq = ++receiveSeq
    mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content,
        meta: { source: SOURCE_NAME, event, channel: '', sender: '', isDirect: 'false', ts, seq: String(seq) },
      },
    }).catch(() => { /* transport closed during teardown */ })
    process.stderr.write(`roost-irc[${NICK}]: [${event}] ${content}\n`)
  }

  // ---- MCP server --------------------------------------------------------

  const mcp = new Server(
    { name: SOURCE_NAME, version: '0.0.1' },
    {
      capabilities: {
        tools: {},
        experimental: { 'claude/channel': {} },
      },
      instructions: `roost IRC MCP. You are connected to IRC as nick "${NICK}". Outbound: use channel_message, direct_message, channel_join, channel_leave, channel_who, channel_history, channel_list, channel_ack. Inbound: IRC traffic arrives as <channel source="roost-irc"> events with sender, channel, and isDirect attributes. After compaction a special event with event=unread-summary lists channels with pending unread messages — check those channels. Auto-joined: ${AUTO_JOIN.join(', ') || '(none)'}.`,
    },
  )

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'channel_message',
        description:
          'Post a message to a channel (e.g., "#roost"). The channel must already be joined.',
        inputSchema: {
          type: 'object',
          properties: {
            channel: { type: 'string', description: 'Channel name including the leading "#".' },
            text: { type: 'string', description: 'Message text.' },
          },
          required: ['channel', 'text'],
        },
      },
      {
        name: 'direct_message',
        description: 'Send a private message (DM) to another nick.',
        inputSchema: {
          type: 'object',
          properties: {
            nick: { type: 'string', description: 'Recipient nick.' },
            text: { type: 'string', description: 'Message text.' },
          },
          required: ['nick', 'text'],
        },
      },
      {
        name: 'channel_join',
        description: 'Join a channel. Returns when the JOIN is acknowledged. Recent channel history (up to ROOST_IRC_JOIN_HISTORY_LINES messages within ROOST_IRC_JOIN_HISTORY_MINUTES minutes) is then pushed as historical notifications.',
        inputSchema: {
          type: 'object',
          properties: {
            channel: { type: 'string', description: 'Channel name including "#".' },
            force: { type: 'boolean', description: 'Force JOIN even if cache says already joined. Use to recover a wedged cache without restarting the MCP.' },
          },
          required: ['channel'],
        },
      },
      {
        name: 'channel_leave',
        description: 'Leave (PART) a channel.',
        inputSchema: {
          type: 'object',
          properties: {
            channel: { type: 'string', description: 'Channel name including "#".' },
          },
          required: ['channel'],
        },
      },
      {
        name: 'channel_who',
        description: 'List nicks currently present in a channel. Served from a local cache (no network round-trip); the cache is kept current via JOIN/PART/KICK/QUIT events.',
        inputSchema: {
          type: 'object',
          properties: {
            channel: { type: 'string', description: 'Channel name including "#".' },
          },
          required: ['channel'],
        },
      },
      {
        name: 'channel_history',
        description:
          'Return up to N recent messages observed by this MCP for a channel or DM peer (since startup, capped at ROOST_IRC_HISTORY).',
        inputSchema: {
          type: 'object',
          properties: {
            channel: {
              type: 'string',
              description:
                'Channel name (e.g., "#roost") or peer nick for DM history.',
            },
            limit: {
              type: 'number',
              description: 'Max messages to return (default: 20).',
            },
          },
          required: ['channel'],
        },
      },
      {
        name: 'channel_list',
        description: 'List all channels currently joined by this MCP instance. Served from a local cache (no network round-trip); the cache is kept current via JOIN/PART/KICK/QUIT events.',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
      {
        name: 'channel_ack',
        description: 'Mark a channel (or DM peer nick) as read, clearing its unread count. Use after reviewing a channel\'s activity to signal you\'ve addressed it.',
        inputSchema: {
          type: 'object',
          properties: {
            channel: { type: 'string', description: 'Channel name (e.g., "#roost") or peer nick for DMs.' },
          },
          required: ['channel'],
        },
      },
    ],
  }))

  mcp.setRequestHandler(CallToolRequestSchema, async req => {
    const { name, arguments: args = {} } = req.params

    if (!irc_ready) {
      return {
        content: [{ type: 'text', text: 'IRC client not ready (still connecting).' }],
        isError: true,
      }
    }

    switch (name) {
      case 'channel_message': {
        const channel = String(args.channel ?? '')
        const text = String(args.text ?? '')
        const { chunks, mode } = sendMultiline(channel, text)
        unread.delete(channel)
        const suffix = unreadSuffix()
        const note =
          mode === 'multiline' ? ` (sent as draft/multiline batch, ${chunks} lines)`
          : chunks > 1 ? ` (split into ${chunks} chunks for IRC line cap)`
          : ''
        const preview = text.length > 120 ? text.slice(0, 117) + '...' : text
        return { content: [{ type: 'text', text: `sent to ${channel}: ${preview}${note}${suffix}` }] }
      }
      case 'direct_message': {
        const nick = String(args.nick ?? '')
        const text = String(args.text ?? '')
        const { chunks, mode } = sendMultiline(nick, text)
        unread.delete(nick)
        const suffix = unreadSuffix()
        const note =
          mode === 'multiline' ? ` (sent as draft/multiline batch, ${chunks} lines)`
          : chunks > 1 ? ` (split into ${chunks} chunks for IRC line cap)`
          : ''
        const preview = text.length > 120 ? text.slice(0, 117) + '...' : text
        return { content: [{ type: 'text', text: `DM to ${nick}: ${preview}${note}${suffix}` }] }
      }
      case 'channel_join': {
        const channel = String(args.channel ?? '').toLowerCase()
        if (!args.force && channelUsers.has(channel)) {
          return { content: [{ type: 'text', text: `already in ${channel}` }] }
        }
        const ok = await new Promise<boolean>((resolve) => {
          const list = join_resolvers.get(channel) ?? []
          list.push(resolve)
          join_resolvers.set(channel, list)
          ircClient.join(channel)
          // Time out after 5s.
          setTimeout(() => resolve(false), 5000).unref?.()
        })
        return {
          content: [
            { type: 'text', text: ok ? `joined ${channel}` : `join ${channel} timed out` },
          ],
          isError: !ok,
        }
      }
      case 'channel_leave': {
        const channel = String(args.channel ?? '')
        ircClient.part(channel)
        return { content: [{ type: 'text', text: `parted ${channel}` }] }
      }
      case 'channel_who': {
        const channel = String(args.channel ?? '')
        const set = channelUsers.get(channel)
        const users = set ? [...set].sort() : []
        return {
          content: [
            {
              type: 'text',
              text: users.length
                ? `${channel} (${users.length}): ${users.join(', ')}`
                : `${channel}: (no users tracked — not joined yet, or NAMES not received)`,
            },
          ],
        }
      }
      case 'channel_history': {
        const key = String(args.channel ?? '')
        const limit = Number(args.limit ?? 20)
        unread.delete(key)
        const buf = history.get(key) ?? []
        const slice = buf.slice(-limit)
        if (slice.length === 0) {
          return {
            content: [
              { type: 'text', text: `no history for ${key} (since this MCP started)` },
            ],
          }
        }
        const lines = slice.map(
          m =>
            `[${m.ts}] ${m.isDirect ? `(DM from ${m.sender})` : `${m.channel} <${m.sender}>`} ${m.text}`,
        )
        return { content: [{ type: 'text', text: lines.join('\n') }] }
      }
      case 'channel_list': {
        const channels = [...channelUsers.keys()].sort()
        if (channels.length === 0) {
          return { content: [{ type: 'text', text: '(no channels joined)' }] }
        }
        const lines = channels.map(ch => {
          const info = unread.get(ch)
          return info ? formatUnreadLine(ch, info, 80) : ch
        })
        return { content: [{ type: 'text', text: lines.join('\n') }] }
      }
      case 'channel_ack': {
        const channel = String(args.channel ?? '')
        unread.delete(channel)
        return { content: [{ type: 'text', text: `acked ${channel}` }] }
      }
      default:
        return {
          content: [{ type: 'text', text: `unknown tool: ${name}` }],
          isError: true,
        }
    }
  })

  // ---- IRC event handlers ------------------------------------------------

  ircClient.on('registered', () => {
    irc_ready = true
    process.stderr.write(`roost-irc[${NICK}]: registered with the IRC server\n`)
    // After registration, the cap.enabled set is final. Inspect it for
    // draft/multiline and parse the limits from the cap value.
    const enabled = ircClient.network?.cap?.enabled ?? []
    const available: Map<string, string> = ircClient.network?.cap?.available ?? new Map()
    if (enabled.includes('draft/multiline')) {
      const val = available.get('draft/multiline') || ''
      // val format: "max-bytes=16384,max-lines=200"
      for (const kv of val.split(',')) {
        const [k, v] = kv.split('=')
        const n = Number(v)
        if (!Number.isFinite(n) || n <= 0) continue
        if (k === 'max-lines') multilineMaxLines = n
      }
      process.stderr.write(
        `roost-irc[${NICK}]: draft/multiline enabled (max-lines=${multilineMaxLines})\n`,
      )
    } else {
      process.stderr.write(
        `roost-irc[${NICK}]: draft/multiline NOT enabled (server caps: ${enabled.join(',') || '(none)'}) — exiting, server must support draft/multiline\n`,
      )
      process.exit(1)
    }
    process.stderr.write(
      enabled.includes(CAP_CHATHISTORY)
        ? `roost-irc[${NICK}]: chathistory cap active — will replay up to ${JOIN_HISTORY_LINES} msgs / ${JOIN_HISTORY_MINUTES}min on join\n`
        : `roost-irc[${NICK}]: chathistory cap NOT active — no history replay on join\n`,
    )

    if (hasRegistered) {
      // Reconnect: snapshot channels we were in, clear stale cache, rejoin all.
      // Two JOINs for the same channel (e.g. a concurrent channel_join call) are
      // idempotent on ergo — benign if it races.
      const snapshot = [...channelUsers.keys()].sort()
      channelUsers.clear()
      const content = snapshot.length > 0
        ? `[roost] reconnected to IRC — rejoining: ${snapshot.join(', ')}`
        : '[roost] reconnected to IRC'
      emitSystemEvent('reconnected', content)
      for (const ch of snapshot) {
        ircClient.join(ch)
        process.stderr.write(`roost-irc[${NICK}]: reconnect-rejoining ${ch}\n`)
      }
      return
    }

    hasRegistered = true
    for (const ch of AUTO_JOIN) {
      ircClient.join(ch)
      process.stderr.write(`roost-irc[${NICK}]: auto-joining ${ch}\n`)
    }
  })

  ircClient.on('join', (event: { nick: string; channel: string }) => {
    if (event.nick === NICK) {
      process.stderr.write(`roost-irc[${NICK}]: joined ${event.channel}\n`)
      // Reset our user set for this channel — userlist (NAMES) will populate it.
      channelUsers.set(event.channel, new Set([NICK]))
      const list = join_resolvers.get(event.channel)
      if (list?.length) {
        for (const r of list) r(true)
        join_resolvers.delete(event.channel)
      }
      return
    }
    ensureChannelSet(event.channel).add(event.nick)
    emitMembershipEvent('join', event.nick, event.channel)
  })

  // userlist fires after RPL_NAMREPLY/ENDOFNAMES (post-JOIN). Replace the
  // channel's user set with the authoritative server-side membership.
  ircClient.on(
    'userlist',
    (event: { channel: string; users: Array<{ nick: string }> }) => {
      const set = new Set<string>()
      for (const u of event.users ?? []) {
        if (u?.nick) set.add(u.nick)
      }
      set.add(NICK) // we're definitely there
      channelUsers.set(event.channel, set)
      process.stderr.write(
        `roost-irc[${NICK}]: userlist for ${event.channel}: ${set.size} nicks (${[...set].sort().join(', ')})\n`,
      )
    },
  )

  ircClient.on(
    'part',
    (event: { nick: string; channel: string; message?: string }) => {
      if (event.nick === NICK) {
        channelUsers.delete(event.channel)
        return
      }
      channelUsers.get(event.channel)?.delete(event.nick)
      emitMembershipEvent('leave', event.nick, event.channel, {
        reason: event.message ? `parted: ${event.message}` : 'parted',
      })
    },
  )

  // irc-framework KICK shape: event.nick = kicker, event.kicked = victim,
  // event.channel, event.message (kick reason). We emit a leave for the
  // kicked user.
  ircClient.on(
    'kick',
    (event: {
      nick?: string
      kicked: string
      channel: string
      message?: string
    }) => {
      const victim = event.kicked
      if (victim === NICK) {
        channelUsers.delete(event.channel)
        return
      }
      channelUsers.get(event.channel)?.delete(victim)
      emitMembershipEvent('leave', victim, event.channel, {
        reason: `kicked${event.message ? ': ' + event.message : ''}`,
      })
    },
  )

  // QUIT has no channel scope — remove the nick from every channel we
  // track and emit a leave for each one.
  ircClient.on('quit', (event: { nick: string; message?: string }) => {
    if (event.nick === NICK) {
      channelUsers.clear()
      return
    }
    for (const [chan, set] of channelUsers) {
      if (set.delete(event.nick)) {
        emitMembershipEvent('leave', event.nick, chan, {
          reason: event.message ? `quit: ${event.message}` : 'quit',
        })
      }
    }
  })

  // NICK change — rename in every channel set, then emit a single
  // nick-change event scoped to the first shared channel (one event is
  // enough; the change is global to that user).
  ircClient.on('nick', (event: { nick: string; new_nick: string }) => {
    if (event.nick === NICK) return // our own nick change — uninteresting to us
    let firstChan: string | null = null
    for (const [chan, set] of channelUsers) {
      if (set.delete(event.nick)) {
        set.add(event.new_nick)
        if (!firstChan) firstChan = chan
      }
    }
    if (firstChan) {
      emitMembershipEvent('nick', event.nick, firstChan, { newNick: event.new_nick })
    }
  })

  ircClient.on('message', (event: {
    nick: string
    target: string
    message: string
    type: 'privmsg' | 'notice' | 'action' | string
    batch?: { id: string; type: string; params: string[] }
    tags?: Record<string, string>
  }) => {
    if (event.nick === NICK) return // don't loop our own messages back
    // draft/multiline and chathistory batch members are handled in their
    // respective batch-end handlers below — skip here to avoid double-emit.
    if (event.batch?.type === 'draft/multiline') return
    if (event.batch?.type === CAP_CHATHISTORY) return
    const isDirect = event.target === NICK
    const channel = isDirect ? event.nick : event.target
    // Use server-time tag when available (server-time cap) so the fingerprint
    // matches what ergo records and replays in chathistory batches.
    const ts = event.tags?.['time'] ?? new Date().toISOString()

    const msg: IrcMessage = { channel, sender: event.nick, text: event.message, ts, isDirect }
    pushHistory(channel, msg)
    emitChannelEvent(msg)
  })

  // Reassemble a draft/multiline batch into a single channel event.
  ircClient.on(
    'batch end draft/multiline',
    (event: {
      id: string
      params: string[]
      commands: Array<{
        command: string
        params: string[]
        nick: string
        tags: Record<string, unknown>
        getServerTime?: () => number | undefined
      }>
    }) => {
      const target = event.params[0]
      if (!target) return
      const cmds = event.commands.filter(c => c.command === 'PRIVMSG')
      if (cmds.length === 0) return
      const sender = cmds[0].nick
      if (sender === NICK) return

      const text = reassembleMultilineBatch(cmds)
      const isDirect = target === NICK
      const channel = isDirect ? sender : target
      const serverTimeMs = cmds[0].getServerTime?.()
      const ts = (serverTimeMs ? new Date(serverTimeMs) : new Date()).toISOString()
      const msg: IrcMessage = { channel, sender, text, ts, isDirect }
      pushHistory(channel, msg)
      emitChannelEvent(msg, { buffered: cmds.length > 1, chunkCount: cmds.length })
    },
  )

  // Emit chathistory backfill as individual channel events marked historical=true.
  ircClient.on(
    'batch end chathistory',
    (event: {
      id: string
      params: string[]
      commands: Array<{
        command: string
        params: string[]
        nick: string
        tags: Record<string, unknown>
        getServerTime?: () => number | undefined
      }>
    }) => {
      const target = event.params[0]
      if (!target) return
      const cutoffMs = JOIN_HISTORY_MINUTES > 0 ? Date.now() - JOIN_HISTORY_MINUTES * 60_000 : 0
      const batch: IrcMessage[] = []
      for (const c of event.commands) {
        if (c.command !== 'PRIVMSG') continue
        const sender = c.nick
        if (!sender || sender === NICK) continue
        const text = c.params[c.params.length - 1] ?? ''
        const isDirect = target === NICK
        const channel = isDirect ? sender : target
        const serverTimeMs = c.getServerTime?.()
        if (cutoffMs > 0 && serverTimeMs !== undefined && serverTimeMs < cutoffMs) continue
        const ts = (serverTimeMs ? new Date(serverTimeMs) : new Date()).toISOString()
        batch.push({ channel, sender, text, ts, isDirect })
      }
      // Take the most-recent N (ergo sends oldest-first).
      const limited = JOIN_HISTORY_LINES > 0 ? batch.slice(-JOIN_HISTORY_LINES) : batch
      for (const msg of limited) {
        if (hasFingerprint(msg)) {
          process.stderr.write(`roost-irc[${NICK}]: chathistory dedup skip ${msg.sender}@${msg.channel} ${msg.ts}\n`)
          continue
        }
        pushHistory(msg.channel, msg)
        emitChannelEvent(msg, { historical: true })
      }
    },
  )

  ircClient.on('socket close', () => {
    process.stderr.write(`roost-irc[${NICK}]: socket closed\n`)
    irc_ready = false
    emitSystemEvent('disconnected', '[roost] disconnected from IRC — channel state may be stale until reconnect')
  })

  ircClient.on('socket error', (err: Error) => {
    process.stderr.write(`roost-irc[${NICK}]: socket error: ${err.message}\n`)
  })

  const emitUnreadSummary = () => {
    const entries = [...unread.entries()]
    const seq = ++receiveSeq
    let text: string
    if (entries.length === 0) {
      text = '[roost] all caught up — no unread messages'
    } else {
      const lines = entries.map(([ch, info]) => `  ${formatUnreadLine(ch, info)}`)
      text = `[roost] unread activity:\n${lines.join('\n')}`
    }
    mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content: text,
        meta: { source: SOURCE_NAME, event: 'unread-summary', channel: '', sender: '', isDirect: 'false', ts: new Date().toISOString(), seq: String(seq) },
      },
    }).catch(() => { /* transport closed during teardown */ })
    process.stderr.write(`roost-irc[${NICK}]: unread summary emitted (${entries.length} channels with unread)\n`)
  }

  return { server: mcp, clearDedupeCache: () => seenFingerprints.clear(), emitUnreadSummary }
}

// ---- Entrypoint (only runs when executed directly) ----------------------

if (import.meta.main) {
  const env = (k: string, def?: string) => process.env[k] ?? def
  const numericEnv = (k: string, def: number) => Number(env(k, String(def)))
  const required = (k: string): string => {
    const v = process.env[k]
    if (!v) {
      process.stderr.write(`roost-irc: FATAL: ${k} is required\n`)
      process.exit(2)
    }
    return v
  }

  const SERVER = env('ROOST_IRC_SERVER', '127.0.0.1')!
  const PORT = numericEnv('ROOST_IRC_PORT', 6667)
  const NICK = required('ROOST_IRC_NICK')
  const REALNAME = env('ROOST_IRC_REALNAME', NICK)!
  const AUTO_JOIN = (env('ROOST_IRC_CHANNELS', '') || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)

  // Write our PID so the PreCompact hook can signal us. Only when ROOST_DATA_DIR
  // is set — that's always true for sessions spawned by bin/roost.
  const DATA_DIR = process.env['ROOST_DATA_DIR'] ?? ''
  if (DATA_DIR) {
    try {
      await Bun.write(`${DATA_DIR}/mcp.pid`, String(process.pid))
    } catch (e) {
      process.stderr.write(`roost-irc[${NICK}]: warn: could not write pidfile: ${e}\n`)
    }
  }

  const ircClient = new IRC.Client()
  const { server: mcp, clearDedupeCache, emitUnreadSummary } = createMcpServer(ircClient, {
    nick: NICK,
    autoJoin: AUTO_JOIN,
    historySize: numericEnv('ROOST_IRC_HISTORY', 50),
    joinHistoryLines: numericEnv('ROOST_IRC_JOIN_HISTORY_LINES', 20),
    joinHistoryMinutes: numericEnv('ROOST_IRC_JOIN_HISTORY_MINUTES', 30),
  })

  // SIGUSR1: PreCompact hook fires this to clear the seen-set. Next backfill
  // after reconnect re-delivers messages compacted out of the agent's context.
  process.on('SIGUSR1', () => {
    clearDedupeCache()
    process.stderr.write(`roost-irc[${NICK}]: SIGUSR1 — seen-set cleared (compaction reset)\n`)
  })

  process.on('SIGUSR2', emitUnreadSummary)

  await mcp.connect(new StdioServerTransport())
  process.stderr.write(`roost-irc[${NICK}]: MCP transport up at ${new Date().toISOString()}\n`)

  // Ask the server for the IRCv3 caps we need beyond irc-framework's
  // defaults. labeled-response isn't strictly required for multiline, but
  // it pairs well with future features (await-able send confirmations).
  // server-time: ergo stamps every message with @time; we use this timestamp
  // in replay-dedupe fingerprints so live-message and chathistory-replay
  // fingerprints match (both keyed on server time, not client-arrival time).
  ircClient.requestCap(['draft/multiline', 'labeled-response', CAP_CHATHISTORY, 'server-time'])
  ircClient.connect({
    host: SERVER,
    port: PORT,
    nick: NICK,
    username: NICK,
    gecos: REALNAME,
    auto_reconnect: true,
    auto_reconnect_max_retries: 10,
  })
  process.stderr.write(`roost-irc[${NICK}]: connecting to ${SERVER}:${PORT}...\n`)
}
