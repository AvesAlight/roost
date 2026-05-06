// Types-only seam between the IRC client layer and the MCP layer (R1).
// No runtime code — implementation lives in R2.

import type { IrcMessage } from './irc-lib.js'
export type { IrcMessage }

export interface UnreadInfo {
  count: number
  lastSender: string
  lastPreview: string
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
  auto_reconnect?: boolean
  auto_reconnect_max_retries?: number
}

export interface RoostIrcClient {
  connect(opts: ConnectOpts): void
  isReady(): boolean

  join(channel: string, force?: boolean): Promise<boolean>
  leave(channel: string): Promise<boolean>
  say(target: string, text: string): { chunks: number; mode: 'single' | 'multiline' }
  whoisChannels(nick?: string): Promise<string[] | false>

  getHistory(key: string, limit?: number): IrcMessage[]
  getUsers(channel: string): string[]
  getUnread(): Map<string, UnreadInfo>
  ackUnread(key: string): void

  clearDedupeCache(): void

  on(event: 'message',    handler: (msg: IrcMessage, meta: MessageMeta) => void): void
  on(event: 'membership', handler: (kind: 'join' | 'leave' | 'nick', nick: string, channel: string, extras: MembershipExtras) => void): void
  on(event: 'system',     handler: (kind: 'disconnected' | 'reconnected', content: string) => void): void
}
