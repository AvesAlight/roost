#!/usr/bin/env bun

import * as fs from 'node:fs'
import * as net from 'node:net'
import * as path from 'node:path'
import type { IrcMessage, RoostIrcClient } from './irc-client.js'

// ---- Types ------------------------------------------------------------------

export interface PermbotConfig {
  nick: string
  sockPath: string
  target: string
  worker: string
  debugLog: string
  parentPid: number | null
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
  let ppidTimer: ReturnType<typeof setInterval> | null = null

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
    if (ppidTimer !== null) clearInterval(ppidTimer)
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
      log('IRC connection lost, shutting down')
      stop()
    } else if (kind === 'cap-missing') {
      log('cap-missing (ignored)')
    }
  })

  // ---- Parent-PID polling --------------------------------------------------

  if (config.parentPid !== null) {
    const ppid = config.parentPid
    ppidTimer = setInterval(() => {
      try {
        process.kill(ppid, 0)
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code === 'ESRCH') {
          log(`parent ${ppid} gone, shutting down`)
          stop()
        }
      }
    }, 1000)
    ppidTimer.unref?.()
  }

  return { stop, ready }
}

// ---- Entrypoint -------------------------------------------------------------

if (import.meta.main) {
  const env = (k: string, def?: string): string | undefined => process.env[k] ?? def
  const required = (k: string): string => {
    const v = process.env[k]
    if (!v) { process.stderr.write(`roost-permbot: FATAL: ${k} required\n`); process.exit(2) }
    return v
  }

  const NICK     = required('ROOST_PERM_NICK')
  const SOCK     = required('ROOST_PERM_SOCK')
  const TARGET   = required('ROOST_PERM_TARGET')
  const HOST     = env('ROOST_PERM_HOST', '127.0.0.1')!
  const PORT     = Number(env('ROOST_PERM_PORT', '6667'))
  const WORKER   = env('ROOST_PERM_WORKER') ?? NICK.replace(/^permbot-/, '')
  const LOG      = env('ROOST_PERM_DEBUG_LOG') ?? path.join(path.dirname(SOCK), 'permbot.log')
  const _ppid    = env('ROOST_PERM_PARENT_PID', '')
  const PPID     = _ppid && /^\d+$/.test(_ppid) ? Number(_ppid) : null

  const { RoostIrcClientImpl } = await import('./irc-client-impl.js')
  const client = new RoostIrcClientImpl({
    nick: NICK,
    autoJoin: [],
    historySize: 0,
    joinHistoryLines: 0,
    joinHistoryMinutes: 0,
  })

  const config: PermbotConfig = {
    nick: NICK, sockPath: SOCK, target: TARGET,
    worker: WORKER, debugLog: LOG, parentPid: PPID,
  }

  const { stop } = startPermbot(config, client)
  client.connect({ host: HOST, port: PORT, nick: NICK, username: NICK, gecos: 'roost-permbot' })

  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}
