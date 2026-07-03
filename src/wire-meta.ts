// Wire shape of `notifications/claude/channel` meta records emitted by the MCP.
//
// The wire is `Record<string, string>` over JSON-RPC. This union is the
// internal contract: every variant declares its own `event` discriminator and
// which attrs apply, so adding a new `event` value is a compile error at every
// emit site and every consumer that narrows on `event`. `SystemKind` and
// `MembershipKind` are imported from irc-client.ts — the source of truth for
// those literals lives there, not duplicated here.
//
// Why string values: JSON-RPC serializes everything to strings on the wire,
// so booleans render as the literal `'true'` and numbers as decimal strings.
// Optional flags (e.g. `buffered?: 'true'`) are present-or-absent rather than
// `'true' | 'false'` — keeps the wire compact and matches existing consumers.

import type { SystemKind, MembershipKind } from './irc-client.js'

export interface WireMessageMeta {
  event: 'message'
  sender: string
  channel: string
  isDirect: 'true' | 'false'
  ts: string
  buffered?: 'true'
  chunkCount?: string
  historical?: 'true'
  mention?: 'true'
  seenBy?: string
}

export interface WireReminderMeta {
  event: 'reminder'
  sender: string
  channel: string
  isDirect: 'true' | 'false'
  ts: string
}

export interface WireMembershipMeta {
  event: MembershipKind
  sender: string
  channel: string
  isDirect: 'false'
  ts: string
  reason?: string
  newNick?: string
}

export interface WireSystemMeta {
  event: SystemKind
  sender: string
  channel: string
  isDirect: 'false'
  ts: string
}

export interface WireUnreadSummaryMeta {
  event: 'unread-summary'
  sender: string
  channel: string
  isDirect: 'false'
  ts: string
}

export type WireMeta =
  | WireMessageMeta
  | WireReminderMeta
  | WireMembershipMeta
  | WireSystemMeta
  | WireUnreadSummaryMeta

// What consumers see on the wire — input shape plus the `seq` assigned by
// the MCP's monotonic counter. Intersection distributes over the union.
export type WireMetaWithSeq = WireMeta & { seq: string }
