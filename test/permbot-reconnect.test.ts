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

function tmpSock(): string {
  return path.join(os.tmpdir(), `permbot-recon-${process.pid}-${Math.random().toString(36).slice(2)}.sock`)
}

function socketRoundtrip(sockPath: string, req: object): Promise<object> {
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

describe.if(isErgoAvailable())('permbot IRC drop mid-session', () => {
  it('kill + restart ergo → permbot reconnects, socket survives, lifecycle hits permbot.log', async () => {
    const dedicated = await startErgoDedicated()
    if (!dedicated) return

    const logFile = path.join(os.tmpdir(), `permbot-recon-${process.pid}-${Math.random().toString(36).slice(2)}.log`)
    const sockPath = tmpSock()
    const events: Array<{ kind: SystemKind; content: SystemContent }> = []
    let stopPermbot: (() => void) | null = null

    try {
      const client = new RoostIrcClientImpl({
        nick: 'permbot-recon',
        autoJoin: [],
        historySize: 0,
        joinHistoryLines: 0,
        joinHistoryMinutes: 0,
      })
      client.on('system', (kind, content) => { events.push({ kind, content }) })

      const { stop, ready } = startPermbot(
        { nick: 'permbot-recon', sockPath, worker: 'wkr', debugLog: logFile },
        client,
      )
      stopPermbot = stop
      await ready

      client.connect({
        host: dedicated.host,
        port: dedicated.port,
        nick: 'permbot-recon',
        username: 'permbot-recon',
        gecos: 'permbot',
        autoReconnect: true,
        autoReconnectMaxRetries: 10,
      })

      await waitFor(() => events.find(e => e.kind === 'registered'), 5000, 'permbot did not register within 5s')

      // irc-framework only schedules auto_reconnect if registered_ms_ago > 5000.
      await new Promise<void>(res => setTimeout(res, 6000))

      // Drop and bring back the server.
      const eventsAtKill = events.length
      await dedicated.kill()
      await waitFor(() => events.slice(eventsAtKill).find(e => e.kind === 'disconnected'), 5000, 'permbot did not observe disconnect')

      await dedicated.restart()
      await waitFor(() => events.find(e => e.kind === 'reconnected'), 15000, 'permbot did not reconnect within 15s')

      // Daemon stayed up — the unix socket is still listening; new requests are answerable.
      expect(fs.existsSync(sockPath)).toBe(true)
      const resp = await Promise.race([
        socketRoundtrip(sockPath, { summary: 'post-reconnect', timeout: 0.1, kind: 'permission', replyTarget: 'operator' }),
        new Promise<object>((_, rej) => setTimeout(() => rej(new Error('socket roundtrip stalled')), 3000).unref?.()),
      ])
      // No operator replies, so we expect a clean timeout — proves the socket+queue path is intact.
      expect(resp).toEqual({ timeout: true })

      // permbot.log carries the forensic milestones an operator greps for. CAP
      // negotiation fires on both initial connect and reconnect, so this asserts
      // the grep-contract slice that's observable without waiting for the 30s
      // PING tick. (PING/PONG line shape is locked by the mock-based unit test
      // in permbot.test.ts → 'permbot lifecycle logging'.)
      const logContent = fs.readFileSync(logFile, 'utf8')
      expect(logContent).toMatch(/registered with IRC/)
      expect(logContent).toMatch(/IRC connection lost/)
      expect(logContent).toMatch(/IRC reconnected/)
      expect(logContent).toMatch(/CAP LS:/)
      expect(logContent).toMatch(/CAP ACK:/)
    } finally {
      try { stopPermbot?.() } catch { /* ignore */ }
      try { fs.unlinkSync(logFile) } catch { /* ignore */ }
      try { fs.unlinkSync(sockPath) } catch { /* ignore */ }
      await dedicated.cleanup()
    }
  }, 40_000)
})
