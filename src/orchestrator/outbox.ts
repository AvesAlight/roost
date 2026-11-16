import type { OutboxEntry } from './config.js'
import type { PluginMessage } from './plugin.js'

// Per-channel cap. A channel that stays unjoinable for days would otherwise
// grow the outbox without bound. The oldest entries go first.
export const OUTBOX_MAX_PER_CHANNEL = 200

// Turns the outbox into messages to retry this tick, ahead of fresh ones so
// per-channel order holds. Entries for channels the dispatcher no longer wants
// (unwatched) are dropped: nobody is listening there.
export function outboxMessages(
  outbox: OutboxEntry[],
  desired: ReadonlySet<string>,
): { messages: PluginMessage[]; kept: OutboxEntry[]; dropped: OutboxEntry[] } {
  const want = new Set([...desired].map(c => c.toLowerCase()))
  const kept: OutboxEntry[] = []
  const dropped: OutboxEntry[] = []
  for (const e of outbox) (want.has(e.channel.toLowerCase()) ? kept : dropped).push(e)
  return { messages: kept.map(e => ({ channels: [e.channel], text: e.text })), kept, dropped }
}

// Builds the next outbox from what dispatch held back. `held` lists each
// channel's texts in post order: retried outbox entries first, then fresh
// texts. Retried entries keep their original queued_at.
export function nextOutbox(
  kept: OutboxEntry[],
  held: ReadonlyMap<string, string[]>,
  now: string,
  maxPerChannel = OUTBOX_MAX_PER_CHANNEL,
): { entries: OutboxEntry[]; overflow: Map<string, number> } {
  const keptByChannel = new Map<string, OutboxEntry[]>()
  for (const e of kept) {
    const list = keptByChannel.get(e.channel) ?? []
    list.push(e)
    keptByChannel.set(e.channel, list)
  }
  const entries: OutboxEntry[] = []
  const overflow = new Map<string, number>()
  for (const [channel, texts] of held) {
    const old = keptByChannel.get(channel) ?? []
    const all = texts.map((text, i) => ({ channel, text, queued_at: old[i]?.queued_at ?? now }))
    const excess = all.length - maxPerChannel
    if (excess > 0) overflow.set(channel, excess)
    entries.push(...(excess > 0 ? all.slice(excess) : all))
  }
  return { entries, overflow }
}
