import { describe, it, expect, spyOn } from 'bun:test'
import { makeClient } from './helpers/offline-client.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- offline client exposes internals
const dispatch = (client: any, command: string, params: string[], extra: object = {}) =>
  client.irc.command_handler.dispatch({ command, params, tags: {}, ...extra })

describe('topic cache (offline)', () => {
  it('a 332 caches the topic and fires no event; unheard channels are unknown', () => {
    const client = makeClient()
    const seen: unknown[] = []
    client.on('topic', (...a: unknown[]) => seen.push(a))
    dispatch(client, '332', ['test-bot', '#T', 'be nice'])
    expect(client.getTopic('#t')).toBe('be nice')
    expect(client.getTopic('#other')).toBeUndefined()
    expect(seen).toEqual([])
  })

  it('a 331 caches "none" as empty string', () => {
    const client = makeClient()
    dispatch(client, '331', ['test-bot', '#t', 'No topic is set'])
    expect(client.getTopic('#t')).toBe('')
  })

  it('a self part forgets the topic', () => {
    const client = makeClient()
    dispatch(client, '332', ['test-bot', '#t', 'x'])
    client.handlePart({ nick: 'test-bot', channel: '#t' })
    expect(client.getTopic('#t')).toBeUndefined()
  })

  it('join with no topic reply resolves after the query times out, topic unknown', async () => {
    const client = makeClient()
    const quiet = spyOn(process.stderr, 'write').mockImplementation(() => true)
    const raw = spyOn(client.irc, 'raw').mockImplementation(() => {})
    spyOn(client.irc, 'join').mockImplementation(() => {})
    try {
      const pending = client.join('#t')
      dispatch(client, 'JOIN', ['#t'], { nick: 'test-bot' })
      client.handleUserlist({ channel: '#t', users: [{ nick: 'test-bot' }] })
      expect(raw.mock.calls.some((c: unknown[]) => c[0] === 'TOPIC')).toBe(true)
      const r = await pending
      expect(r.ok).toBe(true)
      expect(client.getTopic('#t')).toBeUndefined()
    } finally {
      quiet.mockRestore()
    }
  })

  it('NAMES with no pending join (auto-join, rejoin) still asks for the topic', () => {
    const client = makeClient()
    const quiet = spyOn(process.stderr, 'write').mockImplementation(() => true)
    const raw = spyOn(client.irc, 'raw').mockImplementation(() => {})
    try {
      client.handleUserlist({ channel: '#auto', users: [{ nick: 'test-bot' }] })
      expect(raw.mock.calls).toContainEqual(['TOPIC', '#auto'])
      dispatch(client, '331', ['test-bot', '#auto', 'No topic is set'])
      expect(client.getTopic('#auto')).toBe('')
    } finally {
      quiet.mockRestore()
    }
  })
})
