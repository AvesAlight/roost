import { describe, it, expect } from 'bun:test'
import IRC from 'irc-framework'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { RoostIrcClientImpl } from '../src/irc-client-impl.js'
import { createMcpServer } from '../src/irc-server.js'
import { startErgoDedicated, isErgoAvailable, type ErgoContext } from './helpers/ergo.js'
import { wireMcpClient } from './helpers/mcp-core.js'
import { suppressLateRejection } from './helpers/tool.js'
import type { ClientConfig, SystemContent, SystemKind } from '../src/irc-client.js'

interface SystemEvent { kind: SystemKind; content: SystemContent }

function baseConfig(nick: string, extra: Partial<ClientConfig> = {}): ClientConfig {
  return { nick, autoJoin: [], historySize: 10, joinHistoryLines: 0, joinHistoryMinutes: 0, ...extra }
}

function track(client: RoostIrcClientImpl): SystemEvent[] {
  const events: SystemEvent[] = []
  client.on('system', (kind, content) => { events.push({ kind, content }) })
  return events
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

// A raw connection that holds a nick, standing in for the ghost of a dropped client.
// Has a quit() so the test controls when the nick frees up.
async function holdNick(ergo: ErgoContext, nick: string): Promise<{ quit(): void }> {
  const holder = new IRC.Client()
  await suppressLateRejection(new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`holder ${nick} connect timed out`)), 5000)
    holder.on('registered', () => { clearTimeout(timeout); resolve() })
    holder.connect({ host: ergo.host, port: ergo.port, nick, auto_reconnect: false })
  }))
  return { quit: () => holder.quit() }
}

// Counts every transport connect the framework makes, to prove a retry opens one socket.
function countConnects(client: RoostIrcClientImpl): () => number {
  let n = 0
  const irc = (client as unknown as { irc: { on(e: string, h: () => void): void } }).irc
  irc.on('connecting', () => { n++ })
  return () => n
}

describe.if(isErgoAvailable())('registration 433 retry (real ergo)', () => {
  it('reconnect after an ergo drop hits 433, retries, then registers and rejoins once the nick frees', async () => {
    const ergo = await startErgoDedicated()
    if (!ergo) return
    const nick = 'nr-reconnect'
    const client = new RoostIrcClientImpl(baseConfig(nick, { nickRetryBaseMs: 100 }))
    const events = track(client)
    let holder: { quit(): void } | null = null
    try {
      const connects = countConnects(client)
      client.connect({ host: ergo.host, port: ergo.port, nick, autoReconnect: true })
      await waitFor(() => client.isReady() || undefined, 5000, 'client never registered')
      expect((await client.join('#nr-chan')).ok).toBe(true)

      // The framework only reconnects a socket that registered more than 5s ago.
      await new Promise<void>(res => setTimeout(res, 6000))

      await ergo.kill()
      await waitFor(() => events.find(e => e.kind === 'disconnected'), 5000, 'no disconnected after ergo kill')
      await ergo.restart()
      // The restarted ergo has no memory of us; this connection plays the ghost that holds the nick.
      // The framework waits at least 2s before reconnecting, so this lands first.
      holder = await holdNick(ergo, nick)

      const retries = await waitFor(() => {
        const r = events.filter(e => e.kind === 'registration-retry')
        return r.length >= 2 ? r : undefined
      }, 20_000, 'no registration-retry events after reconnect hit 433')
      expect(String(retries[0].content)).toContain(`nick '${nick}' in use, retry 1/12`)
      // Baseline taken at the first retry. Anything before it (a slow ergo restart can cost the
      // framework extra refused reconnects) is not ours to count.
      const baseConnects = connects()
      const baseDisconnects = events.filter(e => e.kind === 'disconnected').length
      const baseRetries = events.filter(e => e.kind === 'registration-retry').length
      expect(client.isReady()).toBe(false)
      expect(client.registrationFailure()).toBeNull()

      holder.quit()
      holder = null
      await waitFor(() => events.find(e => e.kind === 'reconnected'), 20_000, 'client did not register after the nick freed')
      expect(client.isReady()).toBe(true)
      expect(client.isJoined('#nr-chan')).toBe(true)

      // Each retry opens exactly one socket after it (so the framework isn't also reconnecting).
      const retriesAfter = events.filter(e => e.kind === 'registration-retry').length - baseRetries + 1
      expect(connects() - baseConnects).toBe(retriesAfter)
      // Our own retry closes are not announced as disconnects.
      expect(events.filter(e => e.kind === 'disconnected').length).toBe(baseDisconnects)
      expect(events.filter(e => e.kind === 'registration-failed').length).toBe(0)
    } finally {
      holder?.quit()
      client.quit()
      await ergo.cleanup()
    }
  }, 60_000)

  it('gives up at the retry limit; tool calls return the reason, not "still connecting"', async () => {
    const ergo = await startErgoDedicated()
    if (!ergo) return
    const nick = 'nr-limit'
    const config = baseConfig(nick, { nickRetryLimit: 2, nickRetryBaseMs: 50 })
    const client = new RoostIrcClientImpl(config)
    const events = track(client)
    const holder = await holdNick(ergo, nick)
    try {
      const { server } = createMcpServer(client, config)
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      await server.connect(serverTransport)
      const handle = await wireMcpClient(clientTransport, 'nr-limit-tool')

      client.connect({ host: ergo.host, port: ergo.port, nick, autoReconnect: true })
      const failed = await waitFor(() => events.find(e => e.kind === 'registration-failed'), 10_000, 'no registration-failed at the limit')
      expect(failed.content).toMatchObject({ code: 433, retries: 2 })
      expect(events.filter(e => e.kind === 'registration-retry').length).toBe(2)

      expect(client.registrationFailure()).toContain('gave up after 2 retries')
      const r = await handle.client.callTool({ name: 'channel_who', arguments: { channel: '#x' } })
      expect(r.isError).toBe(true)
      const text = (((r.content as unknown[])[0] ?? {}) as { text?: string }).text ?? ''
      expect(text).toContain('registration failed')
      expect(text).toContain('433')
      expect(text).not.toContain('still connecting')
      await handle.client.close()
    } finally {
      holder.quit()
      client.quit()
      await ergo.cleanup()
    }
  }, 30_000)

  it('keeps retrying when ergo goes down between a 433 retry and its reconnect', async () => {
    const ergo = await startErgoDedicated()
    if (!ergo) return
    const nick = 'nr-bounce'
    const client = new RoostIrcClientImpl(baseConfig(nick, { nickRetryBaseMs: 300 }))
    const events = track(client)
    const holder = await holdNick(ergo, nick)
    try {
      client.connect({ host: ergo.host, port: ergo.port, nick, autoReconnect: true })
      await waitFor(() => events.find(e => e.kind === 'registration-retry'), 5000, 'no first registration-retry')
      // The retry timer fires into a dead server: no socket opens, so no 433 and no framework reconnect.
      await ergo.kill()
      await waitFor(() => events.filter(e => e.kind === 'registration-retry').length >= 2 || undefined, 10_000,
        'retry did not re-arm after a refused connect')
      // The restarted ergo has no ghost, so the next retry registers.
      await ergo.restart()
      await waitFor(() => client.isReady() || undefined, 20_000, 'client did not register after ergo came back')
      expect(client.registrationFailure()).toBeNull()
    } finally {
      holder.quit()
      client.quit()
      await ergo.cleanup()
    }
  }, 40_000)

  it('a close after giving up does not report the failure twice', async () => {
    const ergo = await startErgoDedicated()
    if (!ergo) return
    const nick = 'nr-once'
    const client = new RoostIrcClientImpl(baseConfig(nick, { nickRetryLimit: 1, nickRetryBaseMs: 50 }))
    const events = track(client)
    const holder = await holdNick(ergo, nick)
    try {
      client.connect({ host: ergo.host, port: ergo.port, nick, autoReconnect: true })
      await waitFor(() => events.find(e => e.kind === 'registration-failed'), 10_000, 'no registration-failed')
      // The socket is still open after giving up; closing it must not fail again or retry.
      client.quit()
      await new Promise<void>(res => setTimeout(res, 500))
      expect(events.filter(e => e.kind === 'registration-failed').length).toBe(1)
      expect(events.filter(e => e.kind === 'registration-retry').length).toBe(1)
    } finally {
      holder.quit()
      client.quit()
      await ergo.cleanup()
    }
  }, 20_000)

  it('432 is not retryable even with autoReconnect', async () => {
    const ergo = await startErgoDedicated()
    if (!ergo) return
    // The helper pins nicklen=32.
    const nick = 'nr-overlong-nick-past-the-server-limit'
    const client = new RoostIrcClientImpl(baseConfig(nick, { nickRetryBaseMs: 50 }))
    const events = track(client)
    try {
      client.connect({ host: ergo.host, port: ergo.port, nick, autoReconnect: true })
      const failed = await waitFor(() => events.find(e => e.kind === 'registration-failed'), 5000, 'no registration-failed for 432')
      expect(failed.content).toMatchObject({ code: 432 })
      await new Promise<void>(res => setTimeout(res, 300))
      expect(events.filter(e => e.kind === 'registration-retry').length).toBe(0)
      expect(client.registrationFailure()).toContain('432')
    } finally {
      client.quit()
      await ergo.cleanup()
    }
  }, 15_000)
})
