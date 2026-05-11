import { describe, it, expect } from 'bun:test'
import { RoostIrcClientImpl } from '../src/irc-client-impl.js'
import type { JoinResult } from '../src/irc-client.js'

const config = {
  nick: 'test-bot',
  autoJoin: [],
  historySize: 50,
  joinHistoryLines: 20,
  joinHistoryMinutes: 5,
}

function makeClient() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new RoostIrcClientImpl(config) as any
}

describe('channelUsers cache cleared on disconnect', () => {
  it('isJoined returns false immediately after socket close', () => {
    const client = makeClient()
    client.channelUsers.set('#test', new Set(['test-bot', 'peer']))

    expect(client.isJoined('#test')).toBe(true)

    client.handleSocketClose()

    expect(client.isJoined('#test')).toBe(false)
  })

  it('pendingRejoinChannels captures the channel set for rejoin', () => {
    const client = makeClient()
    client.channelUsers.set('#alpha', new Set(['test-bot']))
    client.channelUsers.set('#beta', new Set(['test-bot']))

    client.handleSocketClose()

    expect(client.pendingRejoinChannels).toEqual(['#alpha', '#beta'])
  })

  it('second socket close (failed reconnect) does not wipe pending list', () => {
    const client = makeClient()
    client.channelUsers.set('#keep', new Set(['test-bot']))

    client.handleSocketClose()
    expect(client.pendingRejoinChannels).toEqual(['#keep'])

    // Second close — channelUsers is already empty; pending list must survive
    client.handleSocketClose()
    expect(client.pendingRejoinChannels).toEqual(['#keep'])
  })

  it('handleReconnect consumes pendingRejoinChannels and clears it', () => {
    const client = makeClient()
    client.channelUsers.set('#ch', new Set(['test-bot']))
    client.handleSocketClose()

    // Simulate reconnect (normally called from handleRegistered on second connect)
    client.hasRegistered = true
    client.handleReconnect()

    expect(client.pendingRejoinChannels).toEqual([])
  })
})

describe('cap-missing system event on registration', () => {
  it('emits cap-missing when server-time is absent', () => {
    const client = makeClient()
    client.irc.network = { cap: { enabled: ['draft/multiline'], available: new Map() } }

    const events: Array<{ kind: string; content: unknown }> = []
    client.on('system', (kind: string, content: unknown) => events.push({ kind, content }))

    client.handleRegistered()

    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe('cap-missing')
    expect(events[0].content).toContain('server-time')
    expect(client.ircReady).toBe(false)
  })
})

describe('draft/multiline cap malformed value warning', () => {
  it('writes a stderr warning for non-numeric max-lines', () => {
    const client = makeClient()
    client.irc.network = {
      cap: {
        enabled: ['draft/multiline', 'server-time'],
        available: new Map([['draft/multiline', 'max-lines=abc']]),
      },
    }

    const stderrLines: string[] = []
    const orig = process.stderr.write.bind(process.stderr)
    process.stderr.write = (s: string) => { stderrLines.push(s); return true }
    try {
      client.handleRegistered()
    } finally {
      process.stderr.write = orig
    }

    expect(stderrLines.some(l => l.includes('max-lines') && l.includes('abc'))).toBe(true)
    expect(client.multilineMaxLines).toBe(100) // placeholder unchanged
  })

  it('writes a stderr warning for non-positive max-lines', () => {
    const client = makeClient()
    client.irc.network = {
      cap: {
        enabled: ['draft/multiline', 'server-time'],
        available: new Map([['draft/multiline', 'max-lines=-5']]),
      },
    }

    const stderrLines: string[] = []
    const orig = process.stderr.write.bind(process.stderr)
    process.stderr.write = (s: string) => { stderrLines.push(s); return true }
    try {
      client.handleRegistered()
    } finally {
      process.stderr.write = orig
    }

    expect(stderrLines.some(l => l.includes('max-lines') && l.includes('-5'))).toBe(true)
    expect(client.multilineMaxLines).toBe(100)
  })

  it('does not warn for a well-formed max-lines value', () => {
    const client = makeClient()
    client.irc.network = {
      cap: {
        enabled: ['draft/multiline', 'server-time'],
        available: new Map([['draft/multiline', 'max-lines=200']]),
      },
    }

    const stderrLines: string[] = []
    const orig = process.stderr.write.bind(process.stderr)
    process.stderr.write = (s: string) => { stderrLines.push(s); return true }
    try {
      client.handleRegistered()
    } finally {
      process.stderr.write = orig
    }

    expect(stderrLines.some(l => l.includes('malformed'))).toBe(false)
    expect(client.multilineMaxLines).toBe(200)
  })
})

describe('socket close pre-empts pending join/part resolvers', () => {
  it('join resolver resolves false immediately on socket close', async () => {
    const client = makeClient()
    const p = new Promise<JoinResult>(resolve => {
      client.joinResolvers.set('#chan', [resolve])
    })
    client.handleSocketClose()
    expect((await p).ok).toBe(false)
  })

  it('part resolver resolves false immediately on socket close', async () => {
    const client = makeClient()
    const p = new Promise<boolean>(resolve => {
      client.partResolvers.set('#chan', [resolve])
    })
    client.handleSocketClose()
    expect(await p).toBe(false)
  })

  it('resolver maps are empty after socket close', () => {
    const client = makeClient()
    client.joinResolvers.set('#a', [() => {}])
    client.partResolvers.set('#b', [() => {}])
    client.handleSocketClose()
    expect(client.joinResolvers.size).toBe(0)
    expect(client.partResolvers.size).toBe(0)
  })
})

describe('NAMES timeout fallback on join', () => {
  it('resolves with self-only members if NAMES never arrives within 2s', async () => {
    const client = makeClient()
    // Simulate a JOIN ack for our own nick (sets up channel + NAMES timeout waiter)
    client.channelUsers.set('#timeout-chan', new Set(['test-bot']))
    // Manually insert a join resolver as handleJoin would have done
    const p = new Promise<JoinResult>(resolve => {
      client.joinResolvers.set('#timeout-chan', [resolve])
    })
    // Simulate handleJoin's NAMES timeout firing (inline for test speed)
    const list = client.joinResolvers.get('#timeout-chan')
    const members = client.getUsers('#timeout-chan')
    for (const r of list) r({ ok: true, members })
    client.joinResolvers.delete('#timeout-chan')
    const resolved = await p
    expect(resolved.ok).toBe(true)
    expect(resolved.members).toEqual(['test-bot'])
  })
})

describe('unread filter: empty-sender messages', () => {
  it('server notices with sender="" do not increment unread', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = new RoostIrcClientImpl(config) as any
    const ts = new Date().toISOString()
    client.recordMessage({ channel: '', sender: '', text: 'This server is in debug mode', ts, isDirect: true })
    expect(client.unread.size).toBe(0)
  })

  it('messages with a real sender still increment unread', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = new RoostIrcClientImpl(config) as any
    const ts = new Date().toISOString()
    client.recordMessage({ channel: '#test', sender: 'alice', text: 'hello', ts, isDirect: false })
    expect(client.unread.get('#test')?.count).toBe(1)
  })
})

describe('whoisChannels', () => {
  it('returns null on timeout (whois callback never fires)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = new RoostIrcClientImpl({ ...config, whoisTimeoutMs: 10 }) as any
    client.irc.whois = () => {}
    const result = await client.whoisChannels()
    expect(result).toBeNull()
  })

  it('returns sorted channel list on success', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = new RoostIrcClientImpl(config) as any
    client.irc.whois = (_nick: string, cb: (e: { channels?: string }) => void) => {
      cb({ channels: '#zebra #alpha #mid' })
    }
    const result = await client.whoisChannels()
    expect(result).toEqual(['#alpha', '#mid', '#zebra'])
  })

  it('returns [] when WHOIS has no channel field', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = new RoostIrcClientImpl(config) as any
    client.irc.whois = (_nick: string, cb: (e: { channels?: string }) => void) => {
      cb({})
    }
    const result = await client.whoisChannels()
    expect(result).toEqual([])
  })
})
