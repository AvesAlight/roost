import { describe, it, expect } from 'bun:test'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { startPermbot } from '../src/permbot.js'
import { RoostIrcClientImpl } from '../src/irc-client-impl.js'
import { startErgoDedicated, isErgoAvailable } from './helpers/ergo.js'
import { suppressLateRejection } from './helpers/tool.js'
import type { SystemContent, SystemKind } from '../src/irc-client.js'

// The ergo test helper pins nicklen=32, so a nick longer than that is rejected
// at registration with 432 — the exact failure mode that wedged the live
// reviewers. 43 chars here.
const OVERLONG_NICK = 'permbot-overlong-worker-nick-past-the-limit'

function tmp(ext: string): string {
  return path.join(os.tmpdir(), `permbot-regfail-${process.pid}-${Math.random().toString(36).slice(2)}.${ext}`)
}

function socketRoundtrip(sockPath: string, req: object): Promise<Record<string, unknown>> {
  return suppressLateRejection(new Promise((resolve, reject) => {
    const sock = net.createConnection(sockPath)
    let buf = ''
    sock.on('connect', () => sock.write(JSON.stringify(req) + '\n'))
    sock.on('data', (d) => {
      buf += d.toString('utf8')
      if (buf.includes('\n')) {
        try { resolve(JSON.parse(buf.split('\n')[0])) } catch (e) { reject(e) }
        sock.destroy()
      }
    })
    sock.on('error', reject)
  }))
}

async function waitFor<T>(predicate: () => T | undefined, deadlineMs: number, errMsg: string): Promise<T> {
  const start = Date.now()
  while (true) {
    const v = predicate()
    if (v !== undefined) return v
    if (Date.now() - start > deadlineMs) throw new Error(errMsg)
    await new Promise<void>(res => setTimeout(res, 50))
  }
}

describe.if(isErgoAvailable())('permbot IRC registration failure (real ergo, 432)', () => {
  it('over-long nick → 432 → registration-failed{code,nick,reason} → unreachable deny + greppable nicklen hint', async () => {
    const dedicated = await startErgoDedicated()
    if (!dedicated) return

    const logFile = tmp('log')
    const sockPath = tmp('sock')
    const events: Array<{ kind: SystemKind; content: SystemContent }> = []
    let stopPermbot: (() => void) | null = null

    try {
      const client = new RoostIrcClientImpl({
        nick: OVERLONG_NICK, autoJoin: [], historySize: 0, joinHistoryLines: 0, joinHistoryMinutes: 0,
      })
      client.on('system', (kind, content) => { events.push({ kind, content }) })

      const { stop, ready } = startPermbot(
        { nick: OVERLONG_NICK, sockPath, worker: 'wkr', debugLog: logFile },
        client,
      )
      stopPermbot = stop
      await ready

      client.connect({
        host: dedicated.host,
        port: dedicated.port,
        nick: OVERLONG_NICK,
        username: OVERLONG_NICK,
        gecos: 'permbot',
        autoReconnect: false,
      })

      // The load-bearing assertion: irc-framework remaps 432 to the named event
      // 'nick invalid' (never a bare '432'), and our client must translate that
      // into a registration-failed system event. If this regresses, the whole
      // fail-loud chain goes silent again.
      const failed = await waitFor(
        () => events.find(e => e.kind === 'registration-failed'),
        8000,
        'registration-failed never fired on a real 432 — event-name regression in irc-client-impl',
      )
      const detail = failed.content as { code?: number; nick?: string; reason?: string }
      expect(detail.code).toBe(432)
      expect(detail.nick).toBe(OVERLONG_NICK)
      expect(typeof detail.reason).toBe('string')  // ergo's 432 text, e.g. "Erroneous nickname"
      // It never reached 001, so no 'registered' — proves we caught a true
      // registration failure, not a post-registration nick rejection.
      expect(events.find(e => e.kind === 'registered')).toBeUndefined()

      // The permbot now fails closed: any request gets the unreachable cause
      // immediately instead of queuing against a dead IRC link for 570s.
      const resp = await Promise.race([
        socketRoundtrip(sockPath, { summary: 'Read /x', timeout: 30, kind: 'permission', replyTarget: 'operator' }),
        new Promise<Record<string, unknown>>((_, rej) => setTimeout(() => rej(new Error('socket roundtrip stalled')), 3000).unref?.()),
      ])
      expect(resp.unreachable).toBe(true)
      expect(String(resp.error)).toContain('432')
      expect(String(resp.error)).toContain('nicklen')

      // Greppable forensic line on disk (stderr gets the same line live).
      const logContent = fs.readFileSync(logFile, 'utf8')
      expect(logContent).toMatch(/FATAL permbot unreachable/)
      expect(logContent).toMatch(/raise limits\.nicklen/)
    } finally {
      try { stopPermbot?.() } catch { /* ignore */ }
      try { fs.unlinkSync(logFile) } catch { /* ignore */ }
      try { fs.unlinkSync(sockPath) } catch { /* ignore */ }
      await dedicated.cleanup()
    }
  }, 20_000)
})
