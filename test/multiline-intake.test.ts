import { describe, it, expect } from 'bun:test'
import type { SystemContent } from '../src/irc-client.js'
import { makeClient } from './helpers/offline-client.js'

// Drives command_handler.dispatch directly with the wire shape captured from a real
// ergo chathistory replay — no socket/ergo needed, the constructor wires it eagerly.
describe('nested multiline batch intake', () => {
  it('reassembles a nested draft/multiline batch replayed inside a chathistory batch', () => {
    const client = makeClient()
    const dispatch = client.irc.command_handler.dispatch.bind(client.irc.command_handler)

    dispatch({ command: 'BATCH', params: ['+1', 'chathistory', '#chan'], tags: {} })
    dispatch({
      command: 'BATCH',
      params: ['+2', 'draft/multiline', '#chan'],
      tags: { batch: '1', time: '2026-01-01T00:00:00.000Z', msgid: 'abc' },
      nick: 'peer', prefix: 'peer!u@h', ident: 'u', hostname: 'h',
    })
    dispatch({ command: 'PRIVMSG', params: ['#chan', 'line one'], tags: { batch: '2' }, nick: 'peer' })
    dispatch({ command: 'PRIVMSG', params: ['#chan', 'line two'], tags: { batch: '2' }, nick: 'peer' })

    let captured: unknown
    client.irc.command_handler.once('batch end chathistory', (e: { commands: unknown[] }) => { captured = e.commands })
    dispatch({ command: 'BATCH', params: ['-2'], tags: { batch: '1' } })
    dispatch({ command: 'BATCH', params: ['-1'], tags: {} })

    const commands = captured as Array<{ command: string; params: string[]; nick: string }>
    expect(commands).toHaveLength(1)
    expect(commands[0].command).toBe('PRIVMSG')
    expect(commands[0].params[commands[0].params.length - 1]).toBe('line one\nline two')
    expect(commands[0].nick).toBe('peer')
  })

  it('degrades to a dropped nested batch plus a system notice, not a crash, when intake itself throws', () => {
    const client = makeClient()
    const systemEvents: Array<[string, SystemContent]> = []
    client.on('system', (kind: string, content: SystemContent) => systemEvents.push([kind, content]))
    const dispatch = client.irc.command_handler.dispatch.bind(client.irc.command_handler)

    dispatch({ command: 'BATCH', params: ['+1', 'chathistory', '#chan'], tags: {} })

    // A 'time' getter that throws simulates a future irc-framework shape mismatch.
    const poisonedTags: Record<string, unknown> = { batch: '1' }
    Object.defineProperty(poisonedTags, 'time', { get() { throw new Error('forced probe failure') } })
    dispatch({ command: 'BATCH', params: ['+2', 'draft/multiline', '#chan'], tags: poisonedTags, nick: 'peer' })
    dispatch({ command: 'PRIVMSG', params: ['#chan', 'line one'], tags: { batch: '2' }, nick: 'peer' })

    expect(() => dispatch({ command: 'BATCH', params: ['-2'], tags: { batch: '1' } })).not.toThrow()
    expect(systemEvents.some(([kind]) => kind === 'multiline-intake-degraded')).toBe(true)

    // The handler itself must still work for later, unrelated traffic.
    expect(() => dispatch({ command: 'PING', params: ['x'], tags: {} })).not.toThrow()
  })

  it('delivers a plain message exactly once when a downstream handler throws', () => {
    const client = makeClient()
    const dispatch = client.irc.command_handler.dispatch.bind(client.irc.command_handler)

    let calls = 0
    client.irc.command_handler.on('privmsg', () => {
      calls++
      throw new Error('downstream handler boom')
    })

    expect(() => dispatch({ command: 'PRIVMSG', params: ['#chan', 'hello'], tags: {}, nick: 'peer' })).toThrow('downstream handler boom')
    expect(calls).toBe(1)
  })
})
