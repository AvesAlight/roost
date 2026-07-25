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

// Normalized channel-set key for batch grouping. Sorted so order drift in a
// plugin's resolveChannels call doesn't split a batch that should merge —
// the audience is the set of channels, not their iteration order.
function channelSetKey(channels: string[]): string {
  return [...channels].sort().join('\0')
}

// Collapse consecutive `multiline`-payload events that share a channel set
// into one `multiline_batch` event, rendered by the dispatcher as a single
// IRC message. A singleton run stays `multiline` (no behavior change for the
// common one-comment case). Only consecutive runs merge — an intervening
// `oneline` event breaks the run, preserving ordering vs lifecycle/CI events.
// Channel-set (not per-PR) granularity is deliberate: every comment landing in
// one channel in one tick is that channel's audience context, so merging
// across PRs/issues that share a channel is the intended behavior, with
// headers disambiguating the source.
export function batchConsecutiveMultiline(events: TaggedEvent[]): TaggedEvent[] {
  const out: TaggedEvent[] = []
  let run: TaggedEvent[] = []
  let runKey: string | null = null

  const flush = () => {
    if (run.length === 0) return
    if (run.length === 1) {
      out.push(run[0]!)
    } else {
      const blocks: MultilineBlock[] = run.map(e => {
        const p = e.payload as { header: string; body: string; url: string }
        return { header: p.header, body: p.body, url: p.url }
      })
      out.push({ channels: run[0]!.channels, payload: { kind: 'multiline_batch', blocks } })
    }
    run = []
    runKey = null
  }

  for (const ev of events) {
    if (ev.payload.kind === 'multiline') {
      const key = channelSetKey(ev.channels)
      if (runKey !== null && key === runKey) {
        run.push(ev)
      } else {
        flush()
        run = [ev]
        runKey = key
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
