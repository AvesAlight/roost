import type { RoostIrcClient } from '../irc-client.js'
import type { SystemKind, ConnectOpts } from '../irc-client.js'
import type { TaggedEvent, TaggedEventPayload, MultilineBlock } from './plugin.js'

export async function waitForReady(
  client: RoostIrcClient,
  timeoutMs = 10_000
): Promise<void> {
  if (client.isReady()) return
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('IRC connection timed out'))
    }, timeoutMs)
    client.on('system', (kind: SystemKind) => {
      if (kind === 'registered') {
        clearTimeout(timer)
        resolve()
      } else if (kind === 'registration-failed') {
        clearTimeout(timer)
        reject(new Error('IRC registration failed'))
      }
    })
  })
}

export async function connectAndWait(
  client: RoostIrcClient,
  opts: ConnectOpts,
  channels: string[]
): Promise<void> {
  client.connect(opts)
  await waitForReady(client)
  await Promise.all(channels.map(ch => client.join(ch)))
}

// Normalized channel-set key for batch grouping. `.sort()` so order drift in
// a plugin's resolveChannels call doesn't split a batch that should merge —
// the audience is the set of channels, not their iteration order. `\0` joins
// the sorted names so `['#ab']` and `['#a', '#b']` can't collide (NUL can't
// appear in an IRC channel name). The full set — not just the first channel —
// keys the batch because a batch can target several channels (an issue channel
// plus a Linear channel).
function channelSetKey(channels: string[]): string {
  return [...channels].sort().join('\0')
}

// Collapse consecutive `multiline`-payload events that share a channel set
// into one `multiline_batch` event, rendered by the dispatcher as a single
// IRC message. Every comment event — including a singleton — becomes a
// `multiline_batch` (a one-block batch renders byte-identically to a
// `multiline` payload, so there is no separate single-comment path). Only
// consecutive runs merge — an intervening `oneline` event breaks the run,
// preserving ordering vs lifecycle/CI events. Channel-set (not per-PR)
// granularity is deliberate: every comment landing in one channel in one tick
// is that channel's audience context, so merging across PRs/issues that share
// a channel is the intended behavior, with headers disambiguating the source.
export function batchConsecutiveMultiline(events: TaggedEvent[]): TaggedEvent[] {
  const out: TaggedEvent[] = []
  // Channels are captured from the first event of a run and stored on the
  // batch object, rather than re-indexed into the run later.
  let batch: { channels: string[]; blocks: MultilineBlock[]; key: string } | null = null

  const flush = () => {
    if (!batch) return
    out.push({ channels: batch.channels, payload: { kind: 'multiline_batch', blocks: batch.blocks } })
    batch = null
  }

  for (const ev of events) {
    if (ev.payload.kind === 'multiline') {
      const block = { header: ev.payload.header, body: ev.payload.body, url: ev.payload.url }
      const key = channelSetKey(ev.channels)
      if (batch && batch.key === key) {
        batch.blocks.push(block)
      } else {
        flush()
        batch = { channels: ev.channels, blocks: [block], key }
      }
    } else {
      flush()
      out.push(ev)
    }
  }
  flush()
  return out
}

// Render a multiline_batch payload as one IRC message: blocks joined by a
// blank line, each block header/body/url on its own line.
function renderBatch(blocks: MultilineBlock[]): string {
  return blocks.map(b => [b.header, b.body, b.url].join('\n')).join('\n\n')
}

// Plugin-agnostic, payload-shape-aware. Channels are pre-resolved by the
// plugin's resolveChannels — trust the input. say() has no delivery ack; a
// mid-tick disconnect silently drops in-flight events. Consecutive multiline
// events to the same channel set are batched into one message so a receiving
// agent sees every comment before replying to any of them.
export async function dispatchTaggedEvents(
  taggedEvents: TaggedEvent[],
  client: RoostIrcClient
): Promise<void> {
  const failures: string[] = []
  for (const { channels, payload } of batchConsecutiveMultiline(taggedEvents)) {
    for (const target of channels) {
      try {
        const text = renderPayload(payload)
        client.say(target, text)
      } catch (e) {
        failures.push(`${payload.kind} -> ${target}: ${e}`)
      }
    }
  }
  if (failures.length) throw new Error(failures.join('; '))
}

function renderPayload(payload: TaggedEventPayload): string {
  switch (payload.kind) {
    case 'oneline':
      return payload.text
    case 'multiline':
      return [payload.header, payload.body, payload.url].join('\n')
    case 'multiline_batch':
      return renderBatch(payload.blocks)
    default: {
      // Exhaustiveness guard — a new payload variant must add a case above,
      // rather than silently fall through to a default renderer.
      const _exhaustive: never = payload
      throw new Error(`unhandled TaggedEventPayload kind: ${(_exhaustive as { kind: string }).kind}`)
    }
  }
}
