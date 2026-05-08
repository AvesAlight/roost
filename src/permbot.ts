// Permbot: queues permission-prompt summaries from the worker's hook,
// DMs them to the operator, and routes the y/n reply back over the unix
// socket. Loaded as a module by irc-server.ts — owns one of the two IRC
// connections held by the MCP process.

import * as fs from 'node:fs'
import * as net from 'node:net'
import type { IrcMessage, RoostIrcClient } from './irc-client.js'

// ---- Types ------------------------------------------------------------------

export interface PermbotConfig {
  nick: string
  sockPath: string
  target: string
  worker: string
  debugLog: string
  nudgeAfterMs?: number  // default: 5 minutes; exposed for testing
}

interface QueueEntry {
  socket: net.Socket
  summary: string
  timeout: number
}

interface InFlight {
  socket: net.Socket
  timer: ReturnType<typeof setTimeout>
  nudgeTimer: ReturnType<typeof setTimeout>
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
  const { nick, sockPath, target, worker, debugLog } = config
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
    const lines = [
      `[${worker}] permission requested:`,
      ...entry.summary.split('\n').map(l => l.trimEnd()).filter(l => l.trim()),
      'reply y/n',
    ]
    client.say(target, lines.join('\n'))
    log(`in-flight to ${target} (${lines.length} lines, timeout ${entry.timeout}s)`)

    const timer = setTimeout(() => {
      log('in-flight timed out')
      inFlight = null
      respond(entry.socket, { timeout: true })
      // drain queue: next request can now be dispatched
      maybeDispatch()
    }, entry.timeout * 1000)
    timer.unref?.()

    const nudgeTimer = setTimeout(() => {
      if (inFlight === null) return  // already resolved before nudge fired
      log('nudge: 5min elapsed without reply')
      const nudgeLines = [
        `[${worker}] permission prompt still pending (5min elapsed):`,
        ...entry.summary.split('\n').map(l => l.trimEnd()).filter(l => l.trim()),
        `reply y/n — or: \`roost tail ${worker}\` to see context, \`roost send ${worker} y\` to unblock`,
      ]
      client.say(target, nudgeLines.join('\n'))
    }, nudgeAfterMs)
    nudgeTimer.unref?.()

    inFlight = { socket: entry.socket, timer, nudgeTimer }
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
      let req: { summary?: unknown; timeout?: unknown }
      try {
        req = JSON.parse(line) as { summary?: unknown; timeout?: unknown }
      } catch (e) {
        log(`bad request json: ${e}`)
        respond(socket, { error: `bad request json: ${e}` })
        return
      }
      const summary = typeof req.summary === 'string' ? req.summary : '(no summary)'
      const timeout = Number(req.timeout) > 0 ? Number(req.timeout) : 30
      log(`queued request: ${JSON.stringify(req)}`)
      queue.push({ socket, summary, timeout })
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
    if (!msg.isDirect || msg.sender.toLowerCase() !== target.toLowerCase()) return
    const body = msg.text.trim()
    log(`reply from ${msg.sender}: ${JSON.stringify(body)}`)
    if (inFlight !== null) {
      clearTimeout(inFlight.timer)
      clearTimeout(inFlight.nudgeTimer)
      const s = inFlight.socket
      inFlight = null
      respond(s, { reply: body })
      maybeDispatch()
    } else {
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
