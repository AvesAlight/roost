import type { RoostIrcClient } from '../irc-client.js'
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

// Plugin-agnostic. Channels are pre-resolved by the plugin's resolveChannels —
// trust the input. say() has no delivery ack; a mid-tick disconnect silently
// drops in-flight messages. All messages for a channel in one tick are joined
// (blank-line separated) into a single IRC post so a receiving agent sees the
// full tick's worth of context before replying.
export async function dispatchMessages(
  messages: PluginMessage[],
  client: RoostIrcClient
): Promise<void> {
  const failures: string[] = []
  for (const [target, texts] of groupMessagesByChannel(messages)) {
    try {
      client.say(target, texts.join('\n\n'))
    } catch (e) {
      failures.push(`${target}: ${e}`)
    }
  }
  if (failures.length) throw new Error(failures.join('; '))
}
