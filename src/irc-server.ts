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
 *   ROOST_IRC_SERVER     IRC server (default: 127.0.0.1; set by bin/roost)
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
import type { RoostIrcClient, ClientConfig, UnreadInfo } from './irc-client.js'
import { startPermbot, type PermbotConfig } from './permbot.js'
import { claimOwnership } from './owner-gate.js'

const SOURCE_NAME = 'roost-irc'

export const NOT_READY_SENTINEL = 'IRC client not ready (still connecting).'
const PASSIVE_SENTINEL = 'roost-irc MCP is passive: a sibling MCP in the same ROOST_DATA_DIR already owns this nick. Tools are disabled in this instance.'

const REPLY_REMINDER = 'Substantive replies should be posted to IRC.'
// 1/7 — midpoint of the 1/5–1/10 range from #136. Random rate avoids the
// pattern-match-and-ignore failure mode of a fixed cadence.
const REMINDER_PROBABILITY = 1 / 7

// Re-export ClientConfig under the legacy name for callers that import McpServerConfig.
export type { ClientConfig as McpServerConfig } from './irc-client.js'

const TOOL_SCHEMAS = [
  {
    name: 'channel_message',
    description: 'Post a message to a channel (e.g., "#roost"). The channel must already be joined. Response includes a trailing \'unread:\' summary listing other channels with pending messages.',
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
    description: "Send a private message (DM) to another nick. Response includes a trailing 'unread:' summary listing other channels with pending messages.",
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
    description: 'Join a channel. Returns when the JOIN is acknowledged and NAMES are received, including the current member list. Recent channel history (up to ROOST_IRC_JOIN_HISTORY_LINES messages within ROOST_IRC_JOIN_HISTORY_MINUTES minutes) is then pushed as historical notifications.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel name including "#".' },
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
    description: 'Return up to N recent messages observed by this MCP for a channel or DM peer (since startup, capped at ROOST_IRC_HISTORY).',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel name (e.g., "#roost") or peer nick for DM history.' },
        limit: { type: 'number', description: 'Max messages to return (default: 20).' },
      },
      required: ['channel'],
    },
  },
  {
    name: 'channel_list',
    description: "List all channels currently joined by this MCP instance. Issues a live WHOIS query to the IRC server on every call for an authoritative result. Response includes a trailing 'unread:' summary listing other channels with pending messages.",
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'channel_ack',
    description: "Mark a channel (or DM peer nick) as read, clearing its unread count. Only needed when you read a channel's messages but have nothing to say in response. Posting any message to a channel (channel_message / direct_message) implicitly acks it. Response includes a trailing 'unread:' summary listing other channels with pending messages.",
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel name (e.g., "#roost") or peer nick for DMs.' },
      },
      required: ['channel'],
    },
  },
]

export interface CreateMcpOptions {
  // Passive MCPs (lost the owner race in claimOwnership) keep the stdio
  // transport up so claude doesn't see a crashed plugin, but every tool
  // call short-circuits with PASSIVE_SENTINEL. No IRC events are wired.
  passive?: boolean
}

// Wire the MCP server and subscribe to typed IRC events. Does NOT connect to
// any transport or start the IRC connection — the caller does both after
// createMcpServer returns. Call order: createMcpServer → server.connect(transport)
// → ircClient.connect.
export function createMcpServer(client: RoostIrcClient, config: ClientConfig, options: CreateMcpOptions = {}): { server: Server; clearDedupeCache: () => void; emitUnreadSummary: () => Promise<void> } {
  const { nick: NICK, autoJoin: AUTO_JOIN } = config

  // ---- Passive short-circuit ---------------------------------------------
  // Lost the owner race in claimOwnership(). Build a minimal MCP that errors
  // every tool call so claude doesn't see a crashed plugin. No state, no
  // event subscriptions, no IRC client interaction.

  if (options.passive === true) {
    const mcp = new Server(
      { name: SOURCE_NAME, version: '0.0.1' },
      {
        capabilities: { tools: {} },
        instructions: `roost IRC MCP (passive instance for nick "${NICK}"). All tool calls error.`,
      },
    )
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_SCHEMAS }))
    mcp.setRequestHandler(CallToolRequestSchema, async () => ({
      content: [{ type: 'text', text: PASSIVE_SENTINEL }],
      isError: true,
    }))
    return {
      server: mcp,
      clearDedupeCache: () => { /* no-op */ },
      emitUnreadSummary: async () => { /* no-op */ },
    }
  }

  // Per-MCP monotonic receive counter — gives downstream consumers a
  // strictly-monotonic ordering even when two events resolve to the same
  // millisecond timestamp (the original bug behind reassembly).
  let receiveSeq = 0

  // Tracks whether any non-historical inbound message has been emitted in
  // this session — gates the always-attach-on-first-message behavior.
  let firstMessageSeen = false

  // ---- MCP server --------------------------------------------------------

  const mcp = new Server(
    { name: SOURCE_NAME, version: '0.0.1' },
    {
      capabilities: {
        tools: {},
        experimental: { 'claude/channel': {} },
      },
      instructions: `roost IRC MCP. You are connected to IRC as nick "${NICK}". This MCP is a plain IRCv3 client — there is no special pipeline between it and any other component. Every message that arrives in a channel (from another agent, a human, or a bot) reaches you identically, as a normal IRC channel message. Outbound: use channel_message, direct_message, channel_join, channel_leave, channel_who, channel_history, channel_list, channel_ack. channel_message supports multiline — long messages are sent as IRCv3 draft/multiline batches. Inbound: IRC traffic arrives as <channel source="roost-irc"> events with sender, channel, and isDirect attributes. After compaction a special event with event=unread-summary lists channels with pending unread messages — check those channels. channel_message, direct_message, channel_list, and channel_ack responses include a trailing 'unread:' block listing other channels with pending messages. Auto-joined: ${AUTO_JOIN.join(', ') || '(none)'}.`,
    },
  )

  const pushNotification = (content: string, meta: Record<string, string>): Promise<void> => {
    const seq = ++receiveSeq
    return mcp.notification({
      method: 'notifications/claude/channel',
      params: { content, meta: { ...meta, source: SOURCE_NAME, seq: String(seq) } },
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      if (/not connected/i.test(msg)) return
      process.stderr.write(`roost-irc[${NICK}]: pushNotification error: ${msg}\n`)
    })
  }

  const formatUnreadLine = (ch: string, info: UnreadInfo, previewLength = 40): string => {
    const hasMention = info.mentionCount > 0
    const [sender, preview] = hasMention
      ? [info.lastMentionSender, info.lastMentionPreview]
      : [info.lastSender, info.lastPreview]
    const raw = preview.length > previewLength ? preview.slice(0, previewLength - 3) + '...' : preview
    const count = hasMention ? `${info.mentionCount} mention, ${info.count} total` : String(info.count)
    return `${ch} (${count}) ${sender}: "${raw.replaceAll('"', "'")}"`
  }

  const unreadSuffix = (): string => {
    const unread = client.getUnread()
    if (unread.size === 0) return ''
    return '\nunread:\n' + [...unread.entries()].map(([ch, i]) => `  ${formatUnreadLine(ch, i)}`).join('\n')
  }

  // ---- Typed event subscriptions -----------------------------------------

  client.on('message', (msg, meta) => {
    const metaRecord: Record<string, string> = {
      sender: msg.sender,
      channel: msg.channel,
      isDirect: String(msg.isDirect),
      ts: msg.ts,
    }
    if (meta.buffered) {
      metaRecord.buffered = 'true'
      if (meta.chunkCount && meta.chunkCount > 1) metaRecord.chunkCount = String(meta.chunkCount)
    }
    if (meta.historical) metaRecord.historical = 'true'

    pushNotification(msg.text, metaRecord)
    process.stderr.write(
      `roost-irc[${NICK}]: <- ${msg.isDirect ? 'DM from' : `${msg.channel} <`}${msg.sender}> ${msg.text.length > 120 ? msg.text.slice(0, 117) + '...' : msg.text}${meta.buffered ? ` [BUFFERED x${meta.chunkCount}]` : ''}${meta.historical ? ' [HISTORY]' : ''}\n`,
    )

    if (!meta.historical) {
      if (!firstMessageSeen || Math.random() < REMINDER_PROBABILITY) {
        pushNotification(REPLY_REMINDER, {
          event: 'reminder',
          channel: msg.channel,
          sender: '',
          isDirect: String(msg.isDirect),
          ts: msg.ts,
        })
      }
      firstMessageSeen = true
    }
  })

  client.on('membership', (kind, nick, channel, extras) => {
    const ts = new Date().toISOString()
    const meta: Record<string, string> = {
      sender: nick,
      channel,
      isDirect: 'false',
      ts,
      event: kind,
    }
    if (extras.reason) meta.reason = extras.reason
    if (extras.newNick) meta.newNick = extras.newNick
    const summary =
      kind === 'join' ? `${nick} joined ${channel}`
      : kind === 'nick' ? `${nick} is now known as ${extras.newNick}`
      : `${nick} left ${channel}${extras.reason ? ` (${extras.reason})` : ''}`
    pushNotification(summary, meta)
    process.stderr.write(`roost-irc[${NICK}]: <- [${kind}] ${summary}\n`)
  })

  client.on('system', (kind, content) => {
    const ts = new Date().toISOString()
    const text = typeof content === 'string' ? content : JSON.stringify(content)
    pushNotification(text, { event: kind, channel: '', sender: '', isDirect: 'false', ts })
    process.stderr.write(`roost-irc[${NICK}]: [${kind}] ${text}\n`)
  })

  // ---- Tool definitions --------------------------------------------------

  const handleSay = (target: string, text: string, label: string) => {
    const { chunks, mode } = client.say(target, text)
    client.ackUnread(target)
    const suffix = unreadSuffix()
    const note =
      mode === 'multiline' ? ` (sent as draft/multiline batch, ${chunks} lines)`
      : chunks > 1 ? ` (split into ${chunks} chunks for IRC line cap)`
      : ''
    const preview = text.length > 120 ? text.slice(0, 117) + '...' : text
    return { content: [{ type: 'text', text: `${label}: ${preview}${note}${suffix}` }] }
  }

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_SCHEMAS }))

  mcp.setRequestHandler(CallToolRequestSchema, async req => {
    const { name, arguments: args = {} } = req.params

    if (!client.isReady()) {
      return {
        content: [{ type: 'text', text: NOT_READY_SENTINEL }],
        isError: true,
      }
    }

    switch (name) {
      case 'channel_message': {
        const ch = args.channel as string
        const text = args.text as string
        return handleSay(ch, text, `sent to ${ch}`)
      }
      case 'direct_message': {
        const nick = args.nick as string
        const text = args.text as string
        return handleSay(nick, text, `DM to ${nick}`)
      }
      case 'channel_join': {
        const ch = (args.channel as string).toLowerCase()
        const { ok, members } = await client.join(ch)
        if (!ok) return { content: [{ type: 'text', text: `join ${ch} timed out` }], isError: true }
        const membersLine = `\nmembers (${members.length}): ${members.join(', ')}`
        return { content: [{ type: 'text', text: `joined ${ch}${membersLine}` }] }
      }
      case 'channel_leave': {
        const ch = (args.channel as string).toLowerCase()
        const ok = await client.leave(ch)
        return { content: [{ type: 'text', text: ok ? `parted ${ch}` : `part ${ch} timed out` }], isError: !ok }
      }
      case 'channel_who': {
        const ch = args.channel as string
        const users = client.getUsers(ch)
        return { content: [{ type: 'text', text: users.length ? `${ch} (${users.length}): ${users.join(', ')}` : `${ch}: (no users tracked — not joined yet, or NAMES not received)` }] }
      }
      case 'channel_history': {
        const key = args.channel as string
        const limit = (args.limit as number | undefined) ?? 20
        client.ackUnread(key)
        const slice = client.getHistory(key, limit)
        if (slice.length === 0) return { content: [{ type: 'text', text: `no history for ${key} (since this MCP started)` }] }
        const lines = slice.map(m => `[${m.ts}] ${m.isDirect ? `(DM from ${m.sender})` : `${m.channel} <${m.sender}>`} ${m.text}`)
        return { content: [{ type: 'text', text: lines.join('\n') }] }
      }
      case 'channel_list': {
        const channels = await client.whoisChannels()
        if (channels === null) return { content: [{ type: 'text', text: 'whois timed out' }], isError: true }
        if (channels.length === 0) return { content: [{ type: 'text', text: '(no channels joined)' }] }
        const unread = client.getUnread()
        const lines = channels.map(ch => { const info = unread.get(ch); return info ? formatUnreadLine(ch, info, 80) : ch })
        return { content: [{ type: 'text', text: lines.join('\n') }] }
      }
      case 'channel_ack': {
        const ch = args.channel as string
        client.ackUnread(ch)
        const suffix = unreadSuffix()
        return { content: [{ type: 'text', text: `acked ${ch}${suffix}` }] }
      }
      default:
        return {
          content: [{ type: 'text', text: `unknown tool: ${name}` }],
          isError: true,
        }
    }
  })

  const emitUnreadSummary = (): Promise<void> => {
    const entries = [...client.getUnread().entries()]
    let text: string
    if (entries.length === 0) {
      text = '[roost] all caught up — no unread messages'
    } else {
      const lines = entries.map(([ch, info]) => `  ${formatUnreadLine(ch, info)}`)
      text = `[roost] unread activity:\n${lines.join('\n')}`
    }
    process.stderr.write(`roost-irc[${NICK}]: unread summary emitted (${entries.length} channels with unread)\n`)
    return pushNotification(text, { event: 'unread-summary', channel: '', sender: '', isDirect: 'false', ts: new Date().toISOString() })
  }

  return { server: mcp, clearDedupeCache: () => client.clearDedupeCache(), emitUnreadSummary }
}

// ---- Entrypoint (only runs when executed directly) ----------------------

if (import.meta.main) {
  const { RoostIrcClientImpl } = await import('./irc-client-impl.js')

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

  // Owner gate: nested claudes (e.g. `claude -p ...` from a Bash tool call)
  // inherit ROOST_DATA_DIR via tmux env and would otherwise spawn a duplicate
  // MCP that collides with the owner's IRC nick. First MCP to start wins;
  // later starters detect the mismatch and stay passive.
  const DATA_DIR = process.env['ROOST_DATA_DIR'] ?? ''
  const SESSION_ID = process.env['CLAUDE_CODE_SESSION_ID'] ?? ''
  const ownership = (DATA_DIR && SESSION_ID) ? claimOwnership(DATA_DIR, SESSION_ID) : 'owner'

  const clientConfig: ClientConfig = {
    nick: NICK,
    autoJoin: AUTO_JOIN,
    historySize: numericEnv('ROOST_IRC_HISTORY', 50),
    joinHistoryLines: numericEnv('ROOST_IRC_JOIN_HISTORY_LINES', 20),
    joinHistoryMinutes: numericEnv('ROOST_IRC_JOIN_HISTORY_MINUTES', 30),
  }

  if (ownership === 'passive') {
    process.stderr.write(`roost-irc[${NICK}]: passive — owner.session held by sibling MCP, skipping IRC connect / permbot / pidfile\n`)
    const ircClient = new RoostIrcClientImpl(clientConfig)
    const { server: mcp } = createMcpServer(ircClient, clientConfig, { passive: true })
    await mcp.connect(new StdioServerTransport())
    process.stderr.write(`roost-irc[${NICK}]: passive MCP transport up at ${new Date().toISOString()}\n`)
  } else {
    await runOwnerMcp({ NICK, REALNAME, SERVER, PORT, DATA_DIR, clientConfig, RoostIrcClientImpl })
  }
}

// Owner path: pidfile + worker IRC + (optional) in-process permbot.
// Extracted from the if-block to keep the entrypoint flat — the passive
// branch returns early; this is the rest.
async function runOwnerMcp(args: {
  NICK: string
  REALNAME: string
  SERVER: string
  PORT: number
  DATA_DIR: string
  clientConfig: ClientConfig
  RoostIrcClientImpl: typeof import('./irc-client-impl.js').RoostIrcClientImpl
}): Promise<void> {
  const { NICK, REALNAME, SERVER, PORT, DATA_DIR, clientConfig, RoostIrcClientImpl } = args

  if (DATA_DIR) {
    try {
      await Bun.write(`${DATA_DIR}/mcp.pid`, String(process.pid))
    } catch (e) {
      process.stderr.write(`roost-irc[${NICK}]: warn: could not write pidfile: ${e}\n`)
    }
  }

  const ircClient = new RoostIrcClientImpl(clientConfig)
  const { server: mcp, clearDedupeCache, emitUnreadSummary } = createMcpServer(ircClient, clientConfig)

  // Permbot runs in-process when --perm-irc is on. Same MCP, second IRC
  // connection on nick `permbot-${NICK}`. Lifecycle = MCP lifecycle, so a
  // crashed nested-claude spawn can no longer kick the worker's permbot
  // off via nick collision (#188). The hook stays a separate process and
  // talks to us over the unix socket as before.
  const PERM_SOCK = process.env['ROOST_PERM_SOCK'] ?? ''
  const PERM_TARGET = process.env['ROOST_PERM_TARGET'] ?? ''
  let permbotStop: (() => void) | null = null
  if (PERM_SOCK && PERM_TARGET) {
    const permbotNick = `permbot-${NICK}`
    const permbotClient = new RoostIrcClientImpl({
      nick: permbotNick,
      autoJoin: [],
      historySize: 0,
      joinHistoryLines: 0,
      joinHistoryMinutes: 0,
    })
    const permbotConfig: PermbotConfig = {
      nick: permbotNick,
      sockPath: PERM_SOCK,
      target: PERM_TARGET,
      worker: NICK,
    }
    const { stop } = startPermbot(permbotConfig, permbotClient)
    permbotStop = stop
    permbotClient.connect({
      host: SERVER,
      port: PORT,
      nick: permbotNick,
      username: permbotNick,
      gecos: 'roost-permbot',
    })
    process.stderr.write(`roost-irc[${NICK}]: started in-process permbot (nick ${permbotNick}, sock ${PERM_SOCK})\n`)
  }

  const shutdown = (code: number) => {
    try { permbotStop?.() } catch { /* ignore */ }
    process.exit(code)
  }
  process.on('SIGINT', () => shutdown(130))
  process.on('SIGTERM', () => shutdown(143))

  // SIGUSR1: PreCompact hook fires this to clear the seen-set. Next backfill
  // after reconnect re-delivers messages compacted out of the agent's context.
  process.on('SIGUSR1', () => {
    clearDedupeCache()
    process.stderr.write(`roost-irc[${NICK}]: SIGUSR1 — seen-set cleared (compaction reset)\n`)
  })

  process.on('SIGUSR2', emitUnreadSummary)

  await mcp.connect(new StdioServerTransport())
  process.stderr.write(`roost-irc[${NICK}]: MCP transport up at ${new Date().toISOString()}\n`)

  ircClient.connect({
    host: SERVER,
    port: PORT,
    nick: NICK,
    username: NICK,
    gecos: REALNAME,
    autoReconnect: true,
    autoReconnectMaxRetries: 10,
  })
  process.stderr.write(`roost-irc[${NICK}]: connecting to ${SERVER}:${PORT}...\n`)
}
