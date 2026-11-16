import { targetIsDirect, type RoostIrcClient } from '../irc-client.js'
import type { SystemKind, ConnectOpts } from '../irc-client.js'
import type { PluginMessage } from './plugin.js'

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

// One IRC message per channel per tick. Plugins emit uniform `{channels, text}`
// messages; this groups them by individual channel, appending each message's
// text to every channel it targets, in emission order. The dispatcher then
// posts one joined message per channel.
//
// An event routed to {#issue, #linear} shares its text with both channels, and
// each channel sees one message with everything destined for it. Within a
// channel, order follows the order plugins emitted messages (runOneTick
// concatenates all plugins' messages, so cross-plugin merges land here too —
// a GitHub + Linear message to one channel arrive as one message).
//
// Post order across channels is the Map's insertion order — the first message
// that touched a channel claims its slot. Channels are independent audiences, so
// cross-channel order isn't observable as meaningful; insertion order just
// keeps it deterministic.
//
// Empty-text messages are skipped (a blank line is never a useful IRC post).
// Channels are deduped per message via a Set so `[#a, #a]` posts once.
export function groupMessagesByChannel(messages: PluginMessage[]): Map<string, string[]> {
  const byChannel = new Map<string, string[]>()
  for (const msg of messages) {
    if (!msg.text) continue
    const seen = new Set<string>()
    for (const ch of msg.channels) {
      if (seen.has(ch)) continue
      seen.add(ch)
      let bucket = byChannel.get(ch)
      if (!bucket) {
        bucket = []
        byChannel.set(ch, bucket)
      }
      bucket.push(msg.text)
    }
  }
  return byChannel
}

export interface DispatchOutcome {
  // Per channel, the texts that weren't posted, in post order.
  held: Map<string, string[]>
  // say() errors, as "<target>: <error>".
  failures: string[]
  // Channel posts that went out.
  posted: number
}

// Plugin-agnostic. Channels are pre-resolved by the plugin's resolveChannels.
// All messages for a channel in one tick are joined (blank-line separated)
// into one IRC post so a receiving agent sees the full tick's worth of context
// before replying. say() splits a post that exceeds the server's multiline
// limits, which a first-tick backlog dump can.
//
// A post to a channel the client isn't in goes nowhere, and the server says
// nothing. So a channel target that isn't joined is held, not sent. Held
// texts come back in the outcome for the caller to queue. A DM that fails to
// send is reported, not held: there's no membership for it to wait on. say()
// has no delivery ack, so a disconnect mid-post can still drop a message.
export async function dispatchMessages(
  messages: PluginMessage[],
  client: RoostIrcClient
): Promise<DispatchOutcome> {
  const held = new Map<string, string[]>()
  const failures: string[] = []
  let posted = 0
  for (const [target, texts] of groupMessagesByChannel(messages)) {
    if (!targetIsDirect(target) && !client.isJoined(target)) {
      held.set(target, texts)
      continue
    }
    try {
      client.say(target, texts.join('\n\n'))
      posted++
    } catch (e) {
      failures.push(`${target}: ${e}`)
      if (!targetIsDirect(target)) held.set(target, texts)
    }
  }
  return { held, failures, posted }
}
