import type { RoostIrcClient } from '../irc-client.js'
import { shouldPush } from './diff.js'
import { formatEvent, formatCommentHeader } from './format.js'
import type { SystemKind, ConnectOpts } from '../irc-client.js'
import type { TaggedEvent } from './plugin.js'

const MULTILINE_COMMENT_KINDS = new Set([
  'pr_review_comment',
  'pr_conversation_comment',
  'issue_comment',
  'pr_review_submitted',
])

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

// Plugin-agnostic dispatch. Channels are pre-resolved by the plugin; we just
// format and write. say() is a synchronous socket write with no delivery ack —
// a mid-tick disconnect drops in-flight events silently.
export async function dispatchTaggedEvents(
  taggedEvents: TaggedEvent[],
  client: RoostIrcClient
): Promise<void> {
  const failures: string[] = []
  for (const { event: ev, channels } of taggedEvents) {
    if (!shouldPush(ev)) continue
    const kind = ev.kind
    const isComment = MULTILINE_COMMENT_KINDS.has(kind)
    let text = ''
    let header = ''
    let body = ''
    let url = ''
    if (isComment) {
      header = formatCommentHeader(ev)
      const commentEv = ev as { body?: string; comment_url?: string; review_url?: string; url?: string }
      body = commentEv.body ?? ''
      url = commentEv.comment_url ?? commentEv.review_url ?? commentEv.url ?? ''
    } else {
      text = formatEvent(ev)
    }
    const seen = new Set<string>()
    for (const target of channels) {
      if (seen.has(target)) continue
      seen.add(target)
      try {
        if (isComment) {
          client.say(target, [header, body, url].join('\n'))
        } else {
          client.say(target, text)
        }
      } catch (e) {
        failures.push(`${ev.kind} -> ${target}: ${e}`)
      }
    }
  }
  if (failures.length) throw new Error(failures.join('; '))
}
