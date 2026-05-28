import { describe, it, expect, afterEach } from 'bun:test'
import { suppressLateRejection } from './helpers/tool.js'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { startPermbot } from '../src/permbot.js'
import type { IrcMessage, MessageMeta, RoostIrcClient, SystemKind, SystemContent, UnreadInfo } from '../src/irc-client.js'

function tmpLog(): string {
  return path.join(os.tmpdir(), `permbot-log-test-${process.pid}-${Math.random().toString(36).slice(2)}.log`)
}

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
    chathistoryLatest: async () => null,
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

  function replyChannel(senderNick: string, channel: string, text: string): void {
    const msg: IrcMessage = { channel: channel.toLowerCase(), sender: senderNick, text, ts: new Date().toISOString(), isDirect: false }
    for (const h of messageHandlers) h(msg, {})
  }

  function emitSystem(kind: SystemKind, content: SystemContent = ''): void {
    for (const h of systemHandlers) h(kind, content)
  }

  return { client, said, quitted: () => quitted, replyDm, replyChannel, emitSystem }
}

// ---- Socket helpers ---------------------------------------------------------

function tmpSock(): string {
  return path.join(os.tmpdir(), `permbot-test-${process.pid}-${Math.random().toString(36).slice(2)}.sock`)
}

/** Send a request JSON line to the permbot socket and collect the response line. */
function socketRoundtrip(sockPath: string, req: object): Promise<object> {
  return suppressLateRejection(new Promise((resolve, reject) => {
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
  }))
}

/** Open a socket connection, send a request, and return the socket (response pending). */
function socketSend(sockPath: string, req: object): Promise<{ sock: net.Socket; response: Promise<object> }> {
  return suppressLateRejection(new Promise((resolve, reject) => {
    const sock = net.createConnection(sockPath)
    let buf = ''
    const response = suppressLateRejection(new Promise<object>((res, rej) => {
      sock.on('data', (d) => {
        buf += d.toString('utf8')
        if (buf.includes('\n')) {
          const line = buf.split('\n')[0]
          try { res(JSON.parse(line)) } catch (e) { rej(e) }
        }
      })
      sock.on('error', rej)
    }))
    sock.on('connect', () => {
      sock.write(JSON.stringify(req) + '\n')
      resolve({ sock, response })
    })
    sock.on('error', reject)
  }))
}

const stops: Array<() => void> = []
afterEach(() => { for (const s of stops) { try { s() } catch { /* ignore */ } }; stops.length = 0 })

// ---- Tests ------------------------------------------------------------------

describe('permbot queue dispatch', () => {
  it('dispatches request immediately and returns operator reply', async () => {
    const sockPath = tmpSock()
    const { client, said, replyDm } = makeMockClient()
    const { stop, ready } = startPermbot(
      { nick: 'permbot-test', sockPath, worker: 'test', debugLog: '/dev/null' },
      client,
    )
    stops.push(stop)
    await ready

    const respPromise = socketRoundtrip(sockPath, { summary: 'Read /foo', timeout: 5, kind: 'permission', replyTarget: 'operator' })
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
      { nick: 'permbot-test', sockPath, worker: 'test', debugLog: '/dev/null' },
      client,
    )
    stops.push(stop)
    await ready

    const resp = await socketRoundtrip(sockPath, { summary: 'Bash rm -rf', timeout: 0.05, kind: 'permission', replyTarget: 'operator' })
    expect(resp).toEqual({ timeout: true })
  })

  it('queues second request while first is in-flight', async () => {
    const sockPath = tmpSock()
    const { client, said, replyDm } = makeMockClient()
    const { stop, ready } = startPermbot(
      { nick: 'permbot-test', sockPath, worker: 'test', debugLog: '/dev/null' },
      client,
    )
    stops.push(stop)
    await ready

    const { response: resp1 } = await socketSend(sockPath, { summary: 'first', timeout: 5, kind: 'permission', replyTarget: 'operator' })
    await new Promise(r => setTimeout(r, 20))

    const { response: resp2 } = await socketSend(sockPath, { summary: 'second', timeout: 5, kind: 'permission', replyTarget: 'operator' })
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
      { nick: 'permbot-test', sockPath, worker: 'test', debugLog: '/dev/null', nudgeAfterMs: 50 },
      client,
    )
    stops.push(stop)
    await ready

    socketRoundtrip(sockPath, { summary: 'Read /secret', timeout: 5, kind: 'permission', replyTarget: 'operator' }).catch(() => {})
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
      { nick: 'permbot-test', sockPath, worker: 'test', debugLog: '/dev/null', nudgeAfterMs: 80 },
      client,
    )
    stops.push(stop)
    await ready

    const respPromise = socketRoundtrip(sockPath, { summary: 'Bash ls', timeout: 5, kind: 'permission', replyTarget: 'operator' })
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
      { nick: 'permbot-test', sockPath, worker: 'test', debugLog: '/dev/null' },
      client,
    )
    stops.push(stop)
    await ready

    const { response: resp1 } = await socketSend(sockPath, { summary: 'req1', timeout: 30, kind: 'permission', replyTarget: 'operator' })
    const { response: resp2 } = await socketSend(sockPath, { summary: 'req2', timeout: 30, kind: 'permission', replyTarget: 'operator' })
    await new Promise(r => setTimeout(r, 30))

    stop()

    const [r1, r2] = await Promise.all([resp1, resp2])
    expect((r1 as { error?: string }).error).toBe('daemon shutting down')
    expect((r2 as { error?: string }).error).toBe('daemon shutting down')
    expect(fs.existsSync(sockPath)).toBe(false)
  })
})

describe('permbot ask-question channel routing', () => {
  it('posts to channel (not DM) when channel is set', async () => {
    const sockPath = tmpSock()
    const { client, said, replyChannel } = makeMockClient()
    const { stop, ready } = startPermbot(
      { nick: 'permbot-test', sockPath, worker: 'test', debugLog: '/dev/null' },
      client,
    )
    stops.push(stop)
    await ready

    const respPromise = socketRoundtrip(sockPath, { summary: 'Which framework?\n  1. React\n  2. Vue\nReply: number or option label', timeout: 5, kind: 'question', channel: '#ask-channel', replyTarget: 'operator' })
    await new Promise(r => setTimeout(r, 20))

    // Should post to channel, not DM target
    expect(said.some(m => m.target === '#ask-channel')).toBe(true)
    expect(said.some(m => m.target === 'operator')).toBe(false)
    // Message should include "question:" label (not "permission requested:")
    expect(said.some(m => m.text.includes('question:'))).toBe(true)
    expect(said.some(m => m.text.includes('Which framework?'))).toBe(true)
    // Should NOT append 'reply y/n' for questions
    expect(said.every(m => !m.text.includes('reply y/n'))).toBe(true)

    replyChannel('operator', '#ask-channel', '1')
    const resp = await respPromise
    expect(resp).toEqual({ reply: '1' })
  })

  it('accepts DM reply from replyTarget when question posted to channel', async () => {
    const sockPath = tmpSock()
    const { client, replyDm } = makeMockClient()
    const { stop, ready } = startPermbot(
      { nick: 'permbot-test', sockPath, worker: 'test', debugLog: '/dev/null' },
      client,
    )
    stops.push(stop)
    await ready

    const respPromise = socketRoundtrip(sockPath, { summary: 'Pick one\n  1. A\n  2. B\nReply: number or option label', timeout: 5, kind: 'question', channel: '#ask-channel', replyTarget: 'operator' })
    await new Promise(r => setTimeout(r, 20))

    // Reply via DM (not channel) — should also be accepted
    replyDm('operator', '2')
    const resp = await respPromise
    expect(resp).toEqual({ reply: '2' })
  })

  it('ignores channel messages from other nicks', async () => {
    const sockPath = tmpSock()
    const { client, said, replyChannel } = makeMockClient()
    const { stop, ready } = startPermbot(
      { nick: 'permbot-test', sockPath, worker: 'test', debugLog: '/dev/null' },
      client,
    )
    stops.push(stop)
    await ready

    const respPromise = socketRoundtrip(sockPath, { summary: 'Which?', timeout: 0.2, kind: 'question', channel: '#ask-channel', replyTarget: 'operator' })
    await new Promise(r => setTimeout(r, 20))

    // Message from a different nick should not resolve the request
    replyChannel('someone-else', '#ask-channel', '1')
    await new Promise(r => setTimeout(r, 50))
    expect(said.some(m => m.target === 'someone-else')).toBe(false)

    // Times out since operator never replied
    const resp = await respPromise
    expect(resp).toEqual({ timeout: true })
  })

  it('uses replyTarget instead of config.target for channel questions', async () => {
    const sockPath = tmpSock()
    const { client, replyChannel } = makeMockClient()
    const { stop, ready } = startPermbot(
      { nick: 'permbot-test', sockPath, worker: 'test', debugLog: '/dev/null' },
      client,
    )
    stops.push(stop)
    await ready

    const respPromise = socketRoundtrip(sockPath, { summary: 'Q', timeout: 5, kind: 'question', channel: '#ch', replyTarget: 'custom-target' })
    await new Promise(r => setTimeout(r, 20))

    // Reply from config-target should be ignored; custom-target's numeric reply should count
    replyChannel('config-target', '#ch', '1')
    await new Promise(r => setTimeout(r, 20))

    replyChannel('custom-target', '#ch', '2')
    const resp = await respPromise
    expect(resp).toEqual({ reply: '2' })
  })

  it('ignores non-answer-shaped in-channel messages from replyTarget', async () => {
    const sockPath = tmpSock()
    const { client, replyChannel } = makeMockClient()
    const { stop, ready } = startPermbot(
      { nick: 'permbot-test', sockPath, worker: 'test', debugLog: '/dev/null' },
      client,
    )
    stops.push(stop)
    await ready

    const respPromise = socketRoundtrip(sockPath, { summary: 'Pick?', timeout: 5, kind: 'question', channel: '#ch', replyTarget: 'operator' })
    await new Promise(r => setTimeout(r, 20))

    // Conversational message should be ignored even though it's from replyTarget
    replyChannel('operator', '#ch', 'lead, what do you think of option 1?')
    await new Promise(r => setTimeout(r, 20))

    // Numeric reply should now be accepted
    replyChannel('operator', '#ch', '1')
    const resp = await respPromise
    expect(resp).toEqual({ reply: '1' })
  })

  it('accepts chat keyword in-channel and passes it through', async () => {
    const sockPath = tmpSock()
    const { client, replyChannel } = makeMockClient()
    const { stop, ready } = startPermbot(
      { nick: 'permbot-test', sockPath, worker: 'test', debugLog: '/dev/null' },
      client,
    )
    stops.push(stop)
    await ready

    const respPromise = socketRoundtrip(sockPath, { summary: 'Pick?', timeout: 5, kind: 'question', channel: '#ch', replyTarget: 'operator' })
    await new Promise(r => setTimeout(r, 20))

    replyChannel('operator', '#ch', 'chat')
    const resp = await respPromise
    expect(resp).toEqual({ reply: 'chat' })
  })
})

describe('permbot registration failure (fail loud + fail closed)', () => {
  it('on registration-failed: fails in-flight, queued, and future requests with the unreachable cause; keeps the socket', async () => {
    const sockPath = tmpSock()
    const logFile = tmpLog()
    const { client, emitSystem } = makeMockClient()
    const { stop, ready } = startPermbot(
      { nick: 'permbot-test', sockPath, worker: 'wkr', debugLog: logFile },
      client,
    )
    stops.push(stop)
    await ready

    const { response: inflight } = await socketSend(sockPath, { summary: 'Read /x', timeout: 30, kind: 'permission', replyTarget: 'operator' })
    const { response: queued } = await socketSend(sockPath, { summary: 'Read /y', timeout: 30, kind: 'permission', replyTarget: 'operator' })
    await new Promise(r => setTimeout(r, 30))

    // The permbot's IRC nick is rejected at registration (e.g. exceeds nicklen).
    const longNick = 'permbot-this-is-a-very-long-worker-nick-indeed'
    emitSystem('registration-failed', { code: 432, nick: longNick, reason: 'Erroneous nickname' })

    const [r1, r2] = await Promise.all([inflight, queued]) as Array<{ error?: string; unreachable?: boolean }>
    for (const r of [r1, r2]) {
      expect(r.unreachable).toBe(true)
      expect(r.error).toContain('permbot unreachable')
      expect(r.error).toContain('432')
      expect(r.error).toContain('nicklen')
      expect(r.error).toContain(`(${longNick.length} chars)`)
      expect(r.error).toContain('respawn')
    }

    // A request arriving AFTER the failure is rejected immediately, not queued.
    const post = await socketRoundtrip(sockPath, { summary: 'Read /z', timeout: 30, kind: 'permission', replyTarget: 'operator' }) as { unreachable?: boolean }
    expect(post.unreachable).toBe(true)

    // We did NOT stop()/unlink — the socket stays up so the cause keeps reaching the hook.
    expect(fs.existsSync(sockPath)).toBe(true)

    const logContent = fs.readFileSync(logFile, 'utf8')
    try {
      expect(logContent).toMatch(/FATAL permbot unreachable/)
      expect(logContent).toMatch(/raise limits\.nicklen/)
    } finally {
      try { fs.unlinkSync(logFile) } catch { /* ignore */ }
    }
  })
})

describe('permbot lifecycle logging', () => {
  it('writes lifecycle milestones to debugLog so operator grep contract holds', async () => {
    // Issue #578 acceptance: `grep -E 'PING|PONG|reconnect|CAP|registered' permbot.log`
    // must surface the full handshake/reconnect lifecycle. Lock the contract via the
    // mock so a future SystemKind rename or handler tweak can't silently break it.
    const sockPath = tmpSock()
    const logFile = tmpLog()
    const { client, emitSystem } = makeMockClient()
    const { stop, ready } = startPermbot(
      { nick: 'permbot-test', sockPath, worker: 'wkr', debugLog: logFile },
      client,
    )
    stops.push(stop)
    await ready

    emitSystem('registered', { nick: 'wkr-permbot' })
    emitSystem('cap-ls', 'CAP LS: server-time,draft/multiline')
    emitSystem('cap-ack', 'CAP ACK: server-time,draft/multiline')
    emitSystem('cap-nak', 'CAP NAK: invalid-cap')
    emitSystem('ping', 'PING received foo, PONG sent')
    emitSystem('pong', 'PONG received bar')
    emitSystem('reconnecting', 'reconnect attempt 1/10 in 2000ms')
    emitSystem('disconnected', '[roost] disconnected from IRC')
    emitSystem('reconnected', '[roost] reconnected to IRC')

    const content = fs.readFileSync(logFile, 'utf8')
    try {
      expect(content).toMatch(/registered with IRC/)
      expect(content).toMatch(/PING received/)
      expect(content).toMatch(/PONG received/)
      expect(content).toMatch(/CAP LS:/)
      expect(content).toMatch(/CAP ACK:/)
      expect(content).toMatch(/CAP NAK:/)
      expect(content).toMatch(/reconnect attempt/)
      expect(content).toMatch(/IRC connection lost/)
      expect(content).toMatch(/IRC reconnected/)
    } finally {
      try { fs.unlinkSync(logFile) } catch { /* ignore */ }
    }
  })
})
