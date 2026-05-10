// Permbot: queues permission-prompt summaries from the worker's hook,
// DMs them to the operator, and routes the y/n reply back over the unix
// socket. Loaded as a module by irc-server.ts — owns one of the two IRC
// connections held by the MCP process.

import * as fs from 'node:fs'
import * as net from 'node:net'
import * as path from 'node:path'
import type { IrcMessage, RoostIrcClient } from './irc-client.js'
import { CHAT_KEYWORDS, type PermBotKind } from './permbot-socket.js'

// ---- Types ------------------------------------------------------------------

export interface PermbotConfig {
  nick: string
  sockPath: string
  worker: string
  // Defaults to <dirname(sockPath)>/permbot.log when omitted. Pass '/dev/null'
  // in tests to silence file output.
  debugLog?: string
  nudgeAfterMs?: number  // default: 5 minutes; exposed for testing
}

interface PermBotRequest {
  summary?: string
  timeout?: number
  kind?: string
  channel?: string
  replyTarget?: string
}

interface QueueEntry {
  socket: net.Socket
  summary: string
  timeout: number
  kind: PermBotKind
  replyTarget: string  // required on every request
  channel?: string     // set → channel mode (post + accept in-channel); absent → DM mode
}

interface InFlight {
  socket: net.Socket
  timer: ReturnType<typeof setTimeout>
  nudgeTimer: ReturnType<typeof setTimeout>
  kind: PermBotKind
  channel: string | null   // channel the question was posted to (null for DM-style)
  replyTarget: string      // lowercase nick whose messages count as the reply
}

/** For in-channel question replies: only accept bare numeric answers, slash-
 *  separated multi-select combos, or chat-flow keywords. Anything else risks
 *  eating side-conversation. DM replies bypass this check entirely. */
function looksLikeAnswer(text: string): boolean {
  const stripped = text.trim()
  if (/^[\d,/\s]+$/.test(stripped)) return true
  if (CHAT_KEYWORDS.has(stripped.toLowerCase())) return true
  return false
}

// ---- Helpers ----------------------------------------------------------------

function dlog(logPath: string, nick: string, msg: string): void {
  try {
    fs.appendFileSync(logPath, `[${new Date().toTimeString().slice(0, 8)} ${nick}] ${msg}\n`)
  } catch {
    // ignore write failures
  }
}

// ---- Core logic -------------------------------------------------------------

export function startPermbot(
  config: PermbotConfig,
  client: RoostIrcClient,
): { stop: () => void; ready: Promise<void> } {
  const { nick, sockPath, worker } = config
  const debugLog = config.debugLog ?? path.join(path.dirname(sockPath), 'permbot.log')
  const nudgeAfterMs = config.nudgeAfterMs ?? 5 * 60 * 1000
  const log = (msg: string) => dlog(debugLog, nick, msg)

  const queue: QueueEntry[] = []
  let inFlight: InFlight | null = null
  let shuttingDown = false

  function respond(socket: net.Socket, payload: object): void {
    try { socket.write(JSON.stringify(payload) + '\n') } catch { /* ignore */ }
    socket.destroy()
  }

  function maybeDispatch(): void {
    if (inFlight !== null || queue.length === 0 || shuttingDown) return
    const entry = queue.shift()!
    const { kind, replyTarget } = entry
    const postTarget = entry.channel ?? replyTarget
    const replyTargetLc = replyTarget.toLowerCase()
    const summaryLines = entry.summary.split('\n').map(l => l.trimEnd()).filter(l => l.trim())

    const lines = [
      `[${worker}] ${kind === 'question' ? 'question:' : 'permission requested:'}`,
      ...summaryLines,
      ...(kind === 'question' ? [] : ['reply y/n']),
    ]
    client.say(postTarget, lines.join('\n'))
    log(`in-flight to ${postTarget} (kind: ${kind}, replyTarget: ${replyTargetLc}, ${lines.length} lines, timeout ${entry.timeout}s)`)

    const timer = setTimeout(() => {
      log('in-flight timed out')
      inFlight = null
      respond(entry.socket, { timeout: true })
      maybeDispatch()
    }, entry.timeout * 1000)
    timer.unref?.()

    const nudgeTimer = setTimeout(() => {
      if (inFlight === null) return
      log('nudge: 5min elapsed without reply')
      const nudgeLines = kind === 'question'
        ? [
            `[${worker}] question still pending (5min elapsed):`,
            ...summaryLines,
          ]
        : [
            `[${worker}] permission prompt still pending (5min elapsed):`,
            ...summaryLines,
            `reply y/n — or: \`roost tail ${worker}\` to see context, \`roost send ${worker} y\` to unblock`,
          ]
      client.say(postTarget, nudgeLines.join('\n'))
    }, nudgeAfterMs)
    nudgeTimer.unref?.()

    inFlight = { socket: entry.socket, timer, nudgeTimer, kind, channel: entry.channel ?? null, replyTarget: replyTargetLc }
  }

  function stop(): void {
    if (shuttingDown) return
    shuttingDown = true
    log('shutdown: closing sockets')
    if (inFlight !== null) {
      clearTimeout(inFlight.timer)
      clearTimeout(inFlight.nudgeTimer)
      respond(inFlight.socket, { error: 'daemon shutting down' })
      inFlight = null
    }
    for (const e of queue) respond(e.socket, { error: 'daemon shutting down' })
    queue.length = 0
    try { client.quit() } catch { /* ignore */ }
    server.close()
    try { fs.unlinkSync(sockPath) } catch { /* ignore */ }
    log('done')
  }

  // ---- Unix socket server --------------------------------------------------

  try { fs.unlinkSync(sockPath) } catch { /* ignore stale socket */ }
  const server = net.createServer((socket) => {
    log('client accepted')
    let buf = ''
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      const nl = buf.indexOf('\n')
      if (nl === -1) return
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      let req: PermBotRequest
      try {
        req = JSON.parse(line) as PermBotRequest
      } catch (e) {
        log(`bad request json: ${e}`)
        respond(socket, { error: `bad request json: ${e}` })
        return
      }
      const summary = typeof req.summary === 'string' ? req.summary : '(no summary)'
      const timeout = Number(req.timeout) > 0 ? Number(req.timeout) : 30
      const channel = typeof req.channel === 'string' && req.channel ? req.channel.toLowerCase() : undefined
      const replyTarget = req.replyTarget ?? null
      if (!replyTarget) {
        log('request missing replyTarget — rejected')
        respond(socket, { error: 'replyTarget is required' })
        return
      }
      if (req.kind !== 'permission' && req.kind !== 'question') {
        log('request missing valid kind — rejected')
        respond(socket, { error: 'kind must be "permission" or "question"' })
        return
      }
      const kind: PermBotKind = req.kind

      log(`queued request: kind=${kind} replyTarget=${replyTarget} ${JSON.stringify(req)}`)
      queue.push({ socket, summary, timeout, kind, replyTarget, channel })
      maybeDispatch()
    })
    socket.on('error', (e) => log(`client socket error: ${e}`))
  })

  const ready = new Promise<void>((resolve) => {
    server.listen(sockPath, () => {
      try { fs.chmodSync(sockPath, 0o600) } catch { /* ignore */ }
      log(`listening on ${sockPath}`)
      resolve()
    })
  })

  // ---- IRC event handlers --------------------------------------------------

  client.on('message', (msg: IrcMessage) => {
    const body = msg.text.trim()
    const senderLower = msg.sender.toLowerCase()

    if (inFlight !== null) {
      const isDmFromTarget = msg.isDirect && senderLower === inFlight.replyTarget
      const isChannelReply = !msg.isDirect
        && inFlight.channel !== null
        && msg.channel.toLowerCase() === inFlight.channel
        && senderLower === inFlight.replyTarget

      if (isDmFromTarget || isChannelReply) {
        // For in-channel question replies, only accept bare numeric answers or
        // chat keywords. DM replies are unambiguous and bypass this check.
        if (isChannelReply && inFlight.kind === 'question' && !looksLikeAnswer(body)) {
          log(`ignoring in-channel message from ${msg.sender} (not answer-shaped): ${JSON.stringify(body)}`)
          return
        }
        log(`reply from ${msg.sender} (${msg.isDirect ? 'DM' : 'channel'}): ${JSON.stringify(body)}`)
        clearTimeout(inFlight.timer)
        clearTimeout(inFlight.nudgeTimer)
        const s = inFlight.socket
        inFlight = null
        respond(s, { reply: body })
        maybeDispatch()
        return
      }
    }

    // Unsolicited DM when nothing is in-flight — let the sender know
    if (msg.isDirect) {
      log(`unsolicited DM from ${msg.sender}: ${JSON.stringify(body)}`)
      client.say(msg.sender, 'late — request already timed out (no in-flight prompt)')
    }
  })

  client.on('system', (kind) => {
    if (kind === 'registered') {
      log('registered with IRC')
    } else if (kind === 'registration-failed') {
      log('FATAL nick registration failure, shutting down')
      stop()
    } else if (kind === 'disconnected') {
      // Tear down on disconnect. The hook's askDaemon detects the missing
      // socket and falls back to a transient-DM + emit('ask'), so the
      // worker degrades cleanly. Owner-gate eliminates the collision-driven
      // disconnect that motivated #188; if a real network drop becomes a
      // recurring failure mode, add auto-reconnect as a followup.
      log('IRC connection lost, shutting down')
      stop()
    } else if (kind === 'cap-missing') {
      log('cap-missing (ignored)')
    }
  })

  return { stop, ready }
}
