import { describe, it, expect, afterEach } from 'bun:test'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { startPermbot } from '../src/permbot.js'
import type { IrcMessage, MessageMeta, RoostIrcClient, SystemKind, SystemContent, UnreadInfo } from '../src/irc-client.js'

// ---- Mock client ------------------------------------------------------------

function makeMockClient() {
  const messageHandlers: Array<(msg: IrcMessage, meta: MessageMeta) => void> = []
  const systemHandlers: Array<(kind: SystemKind, content: SystemContent) => void> = []
  const said: Array<{ target: string; text: string }> = []
  let quitted = false

  const client: RoostIrcClient = {
    connect: () => {},
    isReady: () => true,
    join: async () => ({ ok: true, members: [] }),
    leave: async () => true,
    say: (target, text) => { said.push({ target, text }); return { chunks: 1, mode: 'single' } },
    quit: () => { quitted = true },
    whoisChannels: async () => [],
    getHistory: () => [],
    getUsers: () => [],
    getUnread: () => new Map<string, UnreadInfo>(),
    ackUnread: () => {},
    clearDedupeCache: () => {},
    isJoined: () => false,
    on: (event, handler) => {
      if (event === 'message') messageHandlers.push(handler as (msg: IrcMessage, meta: MessageMeta) => void)
      if (event === 'system') systemHandlers.push(handler as (kind: SystemKind, content: SystemContent) => void)
    },
  }

  function replyDm(senderNick: string, text: string): void {
    const msg: IrcMessage = { channel: senderNick.toLowerCase(), sender: senderNick, text, ts: new Date().toISOString(), isDirect: true }
    for (const h of messageHandlers) h(msg, {})
  }

  function emitSystem(kind: SystemKind, content: SystemContent = ''): void {
    for (const h of systemHandlers) h(kind, content)
  }

  return { client, said, quitted: () => quitted, replyDm, emitSystem }
}

// ---- Socket helpers ---------------------------------------------------------

function tmpSock(): string {
  return path.join(os.tmpdir(), `permbot-test-${process.pid}-${Math.random().toString(36).slice(2)}.sock`)
}

/** Send a request JSON line to the permbot socket and collect the response line. */
function socketRoundtrip(sockPath: string, req: object): Promise<object> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(sockPath)
    let buf = ''
    sock.on('connect', () => sock.write(JSON.stringify(req) + '\n'))
    sock.on('data', (d) => {
      buf += d.toString('utf8')
      if (buf.includes('\n')) {
        const line = buf.split('\n')[0]
        try { resolve(JSON.parse(line)) } catch (e) { reject(e) }
        sock.destroy()
      }
    })
    sock.on('error', reject)
  })
}

/** Open a socket connection, send a request, and return the socket (response pending). */
function socketSend(sockPath: string, req: object): Promise<{ sock: net.Socket; response: Promise<object> }> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(sockPath)
    let buf = ''
    const response = new Promise<object>((res, rej) => {
      sock.on('data', (d) => {
        buf += d.toString('utf8')
        if (buf.includes('\n')) {
          const line = buf.split('\n')[0]
          try { res(JSON.parse(line)) } catch (e) { rej(e) }
        }
      })
      sock.on('error', rej)
    })
    sock.on('connect', () => {
      sock.write(JSON.stringify(req) + '\n')
      resolve({ sock, response })
    })
    sock.on('error', reject)
  })
}

const stops: Array<() => void> = []
afterEach(() => { for (const s of stops) { try { s() } catch { /* ignore */ } }; stops.length = 0 })

// ---- Tests ------------------------------------------------------------------

describe('permbot queue dispatch', () => {
  it('dispatches request immediately and returns operator reply', async () => {
    const sockPath = tmpSock()
    const { client, said, replyDm } = makeMockClient()
    const { stop, ready } = startPermbot(
      { nick: 'permbot-test', sockPath, target: 'operator', worker: 'test', debugLog: '/dev/null' },
      client,
    )
    stops.push(stop)
    await ready

    const respPromise = socketRoundtrip(sockPath, { summary: 'Read /foo', timeout: 5 })
    // give the socket handler a tick to enqueue and dispatch
    await new Promise(r => setTimeout(r, 20))
    expect(said.length).toBeGreaterThan(0)
    expect(said.some(m => m.text.includes('Read /foo') && m.text.includes('reply y/n'))).toBe(true)

    replyDm('operator', 'y')
    const resp = await respPromise
    expect(resp).toEqual({ reply: 'y' })
  })

  it('responds with {timeout: true} when in-flight deadline passes', async () => {
    const sockPath = tmpSock()
    const { client } = makeMockClient()
    const { stop, ready } = startPermbot(
      { nick: 'permbot-test', sockPath, target: 'operator', worker: 'test', debugLog: '/dev/null' },
      client,
    )
    stops.push(stop)
    await ready

    const resp = await socketRoundtrip(sockPath, { summary: 'Bash rm -rf', timeout: 0.05 })
    expect(resp).toEqual({ timeout: true })
  })

  it('queues second request while first is in-flight', async () => {
    const sockPath = tmpSock()
    const { client, said, replyDm } = makeMockClient()
    const { stop, ready } = startPermbot(
      { nick: 'permbot-test', sockPath, target: 'operator', worker: 'test', debugLog: '/dev/null' },
      client,
    )
    stops.push(stop)
    await ready

    const { response: resp1 } = await socketSend(sockPath, { summary: 'first', timeout: 5 })
    await new Promise(r => setTimeout(r, 20))

    const { response: resp2 } = await socketSend(sockPath, { summary: 'second', timeout: 5 })
    await new Promise(r => setTimeout(r, 20))

    // only first should have been dispatched so far
    expect(said.filter(m => m.text.includes('first')).length).toBeGreaterThan(0)
    expect(said.filter(m => m.text.includes('second')).length).toBe(0)

    replyDm('operator', 'y')
    expect(await resp1).toEqual({ reply: 'y' })

    // second is now dispatched
    await new Promise(r => setTimeout(r, 20))
    expect(said.filter(m => m.text.includes('second')).length).toBeGreaterThan(0)

    replyDm('operator', 'n')
    expect(await resp2).toEqual({ reply: 'n' })
  })

  it('sends nudge DM after nudgeAfterMs with no reply', async () => {
    const sockPath = tmpSock()
    const { client, said } = makeMockClient()
    const { stop, ready } = startPermbot(
      { nick: 'permbot-test', sockPath, target: 'operator', worker: 'test', debugLog: '/dev/null', nudgeAfterMs: 50 },
      client,
    )
    stops.push(stop)
    await ready

    socketRoundtrip(sockPath, { summary: 'Read /secret', timeout: 5 }).catch(() => {})
    await new Promise(r => setTimeout(r, 20))
    expect(said.some(m => m.text.includes('Read /secret'))).toBe(true)
    // nudge not yet fired
    expect(said.some(m => m.text.includes('still pending'))).toBe(false)

    await new Promise(r => setTimeout(r, 80))
    expect(said.some(m => m.text.includes('still pending'))).toBe(true)
    expect(said.some(m => m.text.includes('roost tail'))).toBe(true)
  })

  it('nudge does not fire after reply already received', async () => {
    const sockPath = tmpSock()
    const { client, said, replyDm } = makeMockClient()
    const { stop, ready } = startPermbot(
      { nick: 'permbot-test', sockPath, target: 'operator', worker: 'test', debugLog: '/dev/null', nudgeAfterMs: 80 },
      client,
    )
    stops.push(stop)
    await ready

    const respPromise = socketRoundtrip(sockPath, { summary: 'Bash ls', timeout: 5 })
    await new Promise(r => setTimeout(r, 20))
    replyDm('operator', 'y')
    await respPromise

    // wait past nudge window
    await new Promise(r => setTimeout(r, 120))
    expect(said.some(m => m.text.includes('still pending'))).toBe(false)
  })

  it('drains queue with error on shutdown', async () => {
    const sockPath = tmpSock()
    const { client } = makeMockClient()
    const { stop, ready } = startPermbot(
      { nick: 'permbot-test', sockPath, target: 'operator', worker: 'test', debugLog: '/dev/null' },
      client,
    )
    stops.push(stop)
    await ready

    const { response: resp1 } = await socketSend(sockPath, { summary: 'req1', timeout: 30 })
    const { response: resp2 } = await socketSend(sockPath, { summary: 'req2', timeout: 30 })
    await new Promise(r => setTimeout(r, 30))

    stop()

    const [r1, r2] = await Promise.all([resp1, resp2])
    expect((r1 as { error?: string }).error).toBe('daemon shutting down')
    expect((r2 as { error?: string }).error).toBe('daemon shutting down')
    expect(fs.existsSync(sockPath)).toBe(false)
  })
})
