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
  /** Suppress the chathistory cap request — forces the local-ring fallback path. Test hook. */
  chathistoryDisabled?: boolean
  /** Timeout for mid-session CHATHISTORY queries before falling back to the local ring. Default 2000ms. */
  chathistoryQueryTimeoutMs?: number
  /** Window we expect a chathistory auto-replay batch within after self-JOIN.
   *  chathistoryLatest awaits this before issuing its query so the auto-replay
   *  isn't stolen off the resolver queue. Default 500ms (tuned for loopback ergo;
   *  raise for higher-latency remote daemons). */
  pendingJoinReplayMs?: number
}

// Extras attached to inbound message events (buffered = reassembled multiline batch).
export interface MessageMeta {
  buffered?: boolean
  chunkCount?: number
  historical?: boolean
  mention?: boolean
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

// The 'lifecycle' kinds (ping/pong/reconnecting/cap-*) are forensic — the permbot
// listens to them and appends to its on-disk log so an operator can confirm post-hoc
// that PING/PONG handshakes are healthy and a disconnect was followed by a reconnect
// attempt. Without these, a permbot that drops at ~60s into a session leaves no trail
// to distinguish "missed PONG" from "cap-negotiation race" from "real network drop".
// Other consumers (the worker MCP) only need the registered/disconnected/reconnected
// signals and can ignore the lifecycle kinds.
export type SystemKind =
  | 'disconnected' | 'reconnected' | 'cap-missing' | 'registered' | 'registration-failed'
  | 'ping' | 'pong' | 'reconnecting' | 'cap-ack' | 'cap-nak' | 'cap-ls'
// string for disconnected/reconnected/cap-missing/ping/pong/reconnecting/cap-*;
// { nick } for registered; { code, nick, reason } for registration-failed
// (reason is the server's text for the numeric, e.g. "Erroneous nickname").
export type SystemContent = string | { code?: number; nick?: string; reason?: string }

export type MembershipKind = 'join' | 'leave' | 'nick'

export interface JoinResult {
  ok: boolean
  members: string[]
}

export interface RoostIrcClient {
  // Fire-and-forget: MCP starts serving before IRC connects (returns isError until isReady()).
  // Use isReady() + on('system') to track connection state.
  connect(opts: ConnectOpts): void
  isReady(): boolean

  join(channel: string): Promise<JoinResult>
  leave(channel: string): Promise<boolean>
  // Synchronous socket write — no protocol-level delivery ack for PRIVMSG.
  say(target: string, text: string): { chunks: number; mode: 'single' | 'multiline' }
  quit(): void
  whoisChannels(): Promise<string[] | null>

  // Served from local cache — no network round-trip.
  getHistory(key: string, limit?: number): IrcMessage[]

  // Server-authoritative history via IRCv3 CHATHISTORY LATEST. Returns null when the
  // server didn't advertise the chathistory cap (caller falls back to getHistory) or
  // when the query times out. Includes the requester's own outbound messages and
  // pre-startup activity; the local ring does not.
  chathistoryLatest(target: string, limit: number): Promise<IrcMessage[] | null>
  getUsers(channel: string): string[]
  // Incremented on every non-historical inbound message; tool handlers read this to build the unread suffix.
  getUnread(): ReadonlyMap<string, UnreadInfo>
  ackUnread(key: string): void

  clearDedupeCache(): void

  // Returns true if the local cache shows we are currently in the channel.
  isJoined(channel: string): boolean

  on(event: 'message',    handler: (msg: IrcMessage, meta: MessageMeta) => void): void
  on(event: 'membership', handler: (kind: MembershipKind, nick: string, channel: string, extras: MembershipExtras) => void): void
  on(event: 'system',     handler: (kind: SystemKind, content: SystemContent) => void): void
}
