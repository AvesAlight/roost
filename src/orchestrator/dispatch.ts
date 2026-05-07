import type { RoostIrcClient } from '../irc-client.js'
import type { OrchestratorEvent } from './diff.js'
import { shouldPush } from './diff.js'
import { formatEvent, formatCommentHeader, eventChannels } from './format.js'
import type { SystemKind, ConnectOpts } from '../irc-client.js'

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

// Note: say() is a synchronous socket write with no delivery ack. A mid-tick
// disconnect will drop in-flight events silently; autoReconnect handles the
// connection but the current tick's events are lost (same risk as Python).
export async function dispatchEventsIrc(
  events: OrchestratorEvent[],
  client: RoostIrcClient,
  defaultChannel: string
): Promise<void> {
  const failures: string[] = []
  for (const ev of events) {
    if (!shouldPush(ev)) continue
    const targets = eventChannels(ev, defaultChannel)
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
    // De-dup targets, preserve order
    const seen = new Set<string>()
    for (const target of targets) {
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
