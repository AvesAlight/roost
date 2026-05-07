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
import type { RoostIrcClient, ClientConfig, UnreadInfo } from './irc-client.js'

const SOURCE_NAME = 'roost-irc'

// Re-export ClientConfig under the legacy name for callers that import McpServerConfig.
export type { ClientConfig as McpServerConfig } from './irc-client.js'

const TOOL_SCHEMAS = [
  {
    name: 'channel_message',
    description: 'Post a message to a channel (e.g., "#roost"). The channel must already be joined.',
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
    description: 'List all channels currently joined by this MCP instance. Issues a live WHOIS query to the IRC server on every call for an authoritative result.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'channel_ack',
    description: "Mark a channel (or DM peer nick) as read, clearing its unread count. Only needed when you read a channel's messages but have nothing to say in response. Posting any message to a channel (channel_message / direct_message) implicitly acks it.",
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel name (e.g., "#roost") or peer nick for DMs.' },
      },
      required: ['channel'],
    },
  },
]

// Wire the MCP server and subscribe to typed IRC events. Does NOT connect to
// any transport or start the IRC connection — the caller does both after
// createMcpServer returns. Call order: createMcpServer → server.connect(transport)
// → ircClient.connect.
export function createMcpServer(client: RoostIrcClient, config: ClientConfig): { server: Server; clearDedupeCache: () => void; emitUnreadSummary: () => void } {
  const { nick: NICK, autoJoin: AUTO_JOIN } = config

  // Per-MCP monotonic receive counter — gives downstream consumers a
  // strictly-monotonic ordering even when two events resolve to the same
  // millisecond timestamp (the original bug behind reassembly).
  let receiveSeq = 0

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

  const pushNotification = (content: string, meta: Record<string, string>) => {
    const seq = ++receiveSeq
    mcp.notification({
      method: 'notifications/claude/channel',
      params: { content, meta: { ...meta, source: SOURCE_NAME, seq: String(seq) } },
    }).catch(() => { /* transport closed during teardown */ })
  }

  const formatUnreadLine = (ch: string, info: UnreadInfo, previewLength = 40): string => {
    const raw = info.lastPreview.length > previewLength
      ? info.lastPreview.slice(0, previewLength - 3) + '...'
      : info.lastPreview
    return `${ch} (${info.count}) ${info.lastSender}: "${raw.replaceAll('"', "'")}"`
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
        content: [{ type: 'text', text: 'IRC client not ready (still connecting).' }],
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
        const ok = await client.join(ch)
        return { content: [{ type: 'text', text: ok ? `joined ${ch}` : `join ${ch} timed out` }], isError: !ok }
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
        return { content: [{ type: 'text', text: `acked ${ch}` }] }
      }
      default:
        return {
          content: [{ type: 'text', text: `unknown tool: ${name}` }],
          isError: true,
        }
    }
  })

  const emitUnreadSummary = () => {
    const entries = [...client.getUnread().entries()]
    let text: string
    if (entries.length === 0) {
      text = '[roost] all caught up — no unread messages'
    } else {
      const lines = entries.map(([ch, info]) => `  ${formatUnreadLine(ch, info)}`)
      text = `[roost] unread activity:\n${lines.join('\n')}`
    }
    pushNotification(text, { event: 'unread-summary', channel: '', sender: '', isDirect: 'false', ts: new Date().toISOString() })
    process.stderr.write(`roost-irc[${NICK}]: unread summary emitted (${entries.length} channels with unread)\n`)
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

  // Spawn permbot as our child when the side-daemon is requested. Permbot's
  // lifecycle then rides this MCP's lifecycle: when claude exits, we exit
  // (stdio EOF), permbot detects ppid change and exits. No external pidfiles,
  // no stale-reap on next spawn.
  const PERM_SOCK = process.env['ROOST_PERM_SOCK'] ?? ''
  const PERM_TARGET = process.env['ROOST_PERM_TARGET'] ?? ''
  let permbotProc: import('bun').Subprocess | null = null
  if (PERM_SOCK && PERM_TARGET) {
    const permbotPath = new URL('./permbot.ts', import.meta.url).pathname
    // ROOST_PERM_SOCK / ROOST_PERM_TARGET are already in process.env (set by
    // bin/roost via tmux -e). ROOST_PERM_WORKER and ROOST_PERM_DEBUG_LOG
    // default sensibly inside permbot.ts (worker = nick minus 'permbot-',
    // log = dirname(sock)/permbot.log). Only ROOST_PERM_NICK needs explicit
    // setting — the prefix convention lives in one place: here.
    // stdout=ignore: MCP owns parent stdout for JSON-RPC protocol; permbot
    // writes there would corrupt it. stderr=inherit lets permbot logs surface
    // alongside MCP logs in the tmux pane.
    permbotProc = Bun.spawn([process.execPath, permbotPath], {
      env: { ...process.env, ROOST_PERM_NICK: `permbot-${NICK}` } as Record<string, string>,
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'inherit',
    })
    process.stderr.write(`roost-irc[${NICK}]: spawned permbot child (pid ${permbotProc.pid})\n`)
  }

  const killPermbot = () => {
    if (permbotProc && permbotProc.exitCode === null) {
      try { permbotProc.kill('SIGTERM') } catch { /* ignore */ }
    }
  }
  process.on('exit', killPermbot)
  process.on('SIGINT', () => { killPermbot(); process.exit(130) })
  process.on('SIGTERM', () => { killPermbot(); process.exit(143) })

  const clientConfig: ClientConfig = {
    nick: NICK,
    autoJoin: AUTO_JOIN,
    historySize: numericEnv('ROOST_IRC_HISTORY', 50),
    joinHistoryLines: numericEnv('ROOST_IRC_JOIN_HISTORY_LINES', 20),
    joinHistoryMinutes: numericEnv('ROOST_IRC_JOIN_HISTORY_MINUTES', 30),
  }

  const ircClient = new RoostIrcClientImpl(clientConfig)
  const { server: mcp, clearDedupeCache, emitUnreadSummary } = createMcpServer(ircClient, clientConfig)

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
