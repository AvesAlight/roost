// Wire shape of `notifications/claude/channel` meta records emitted by the MCP.
//
// The wire is `Record<string, string>` over JSON-RPC. These types are the
// internal contract for the emit side: adding a new `event` value is a
// compile-time error at every emit site, and the union forces every variant
// to declare which attrs apply to it. Consumers (tests, the host harness)
// can narrow by `event` for type-safe access to variant-specific attrs.
//
// Why string values: JSON-RPC serializes everything to strings on the wire,
// so booleans render as the literal `'true'` and numbers as decimal strings.
// Optional flags (e.g. `buffered?: 'true'`) are present-or-absent rather than
// `'true' | 'false'` — keeps the wire compact and matches existing consumers.

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
}

export interface WireReminderMeta {
  event: 'reminder'
  sender: string
  channel: string
  isDirect: 'true' | 'false'
  ts: string
}

export interface WireMembershipMeta {
  event: 'join' | 'leave' | 'nick'
  sender: string
  channel: string
  isDirect: 'false'
  ts: string
  reason?: string
  newNick?: string
}

export interface WireSystemMeta {
  event: 'disconnected' | 'reconnected' | 'cap-missing' | 'registered' | 'registration-failed'
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
