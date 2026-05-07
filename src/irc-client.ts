// Pure types — typed seam between the IRC client layer and the MCP layer.

import type { IrcMessage } from './irc-lib.js'
export type { IrcMessage }

export interface UnreadInfo {
  count: number
  lastSender: string
  lastPreview: string
  mentionCount: number
  lastMentionSender: string
  lastMentionPreview: string
}

export interface ClientConfig {
  nick: string
  autoJoin: string[]
  historySize: number
  joinHistoryLines: number
  joinHistoryMinutes: number
  whoisTimeoutMs?: number
}

// Extras attached to inbound message events (buffered = reassembled multiline batch).
export interface MessageMeta {
  buffered?: boolean
  chunkCount?: number
  historical?: boolean
}

// Extras on membership events from join/part/kick/quit/nick.
export interface MembershipExtras {
  reason?: string
  newNick?: string
}

export interface ConnectOpts {
  host: string
  port: number
  nick: string
  username?: string
  gecos?: string
  autoReconnect?: boolean
  autoReconnectMaxRetries?: number
}

export type SystemKind = 'disconnected' | 'reconnected' | 'cap-missing' | 'registered' | 'registration-failed'
// string for disconnected/reconnected/cap-missing; { nick } for registered; { code } for registration-failed
export type SystemContent = string | { code?: number; nick?: string }

export interface RoostIrcClient {
  // Fire-and-forget: MCP starts serving before IRC connects (returns isError until isReady()).
  // Use isReady() + on('system') to track connection state.
  connect(opts: ConnectOpts): void
  isReady(): boolean

  join(channel: string): Promise<boolean>
  leave(channel: string): Promise<boolean>
  // Synchronous socket write — no protocol-level delivery ack for PRIVMSG.
  say(target: string, text: string): { chunks: number; mode: 'single' | 'multiline' }
  quit(): void
  whoisChannels(): Promise<string[] | null>

  // Served from local cache — no network round-trip. Note: on a freshly-joined channel
  // these lag the join ack; NAMES (getUsers) and chathistory (getHistory) arrive via
  // events after join() resolves.
  getHistory(key: string, limit?: number): IrcMessage[]
  getUsers(channel: string): string[]
  // Incremented on every non-historical inbound message; tool handlers read this to build the unread suffix.
  getUnread(): ReadonlyMap<string, UnreadInfo>
  ackUnread(key: string): void

  clearDedupeCache(): void

  // Returns true if the local cache shows we are currently in the channel.
  isJoined(channel: string): boolean

  on(event: 'message',    handler: (msg: IrcMessage, meta: MessageMeta) => void): void
  on(event: 'membership', handler: (kind: 'join' | 'leave' | 'nick', nick: string, channel: string, extras: MembershipExtras) => void): void
  on(event: 'system',     handler: (kind: SystemKind, content: SystemContent) => void): void
}
