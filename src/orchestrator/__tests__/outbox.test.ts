import { describe, it, expect, afterEach } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { outboxMessages, nextOutbox } from '../outbox.js'
import { loadOutbox, writeOutbox, type OutboxEntry } from '../config.js'
import { deliver } from '../../orchestrator.js'
import type { RoostIrcClient } from '../../irc-client.js'

const entry = (channel: string, text: string, queued_at = '2026-01-01T00:00:00.000Z'): OutboxEntry => ({ channel, text, queued_at })

describe('outboxMessages', () => {
  it('keeps entries for desired channels, in order, and drops the rest', () => {
    const r = outboxMessages([entry('#a', '1'), entry('#gone', 'x'), entry('#A', '2')], new Set(['#a']))
    expect(r.messages).toEqual([{ channels: ['#a'], text: '1' }, { channels: ['#A'], text: '2' }])
    expect(r.dropped.map(e => e.channel)).toEqual(['#gone'])
  })
})

describe('nextOutbox', () => {
  it('keeps the original queued_at for retried entries and stamps fresh ones', () => {
    const kept = [entry('#a', 'old', 'T0')]
    const r = nextOutbox(kept, new Map([['#a', ['old', 'new']]]), 'T1')
    expect(r.entries).toEqual([entry('#a', 'old', 'T0'), entry('#a', 'new', 'T1')])
    expect(r.overflow.size).toBe(0)
  })

  it('drops the oldest past the per-channel cap and reports how many', () => {
    const r = nextOutbox([], new Map([['#a', ['1', '2', '3']]]), 'T', 2)
    expect(r.entries.map(e => e.text)).toEqual(['2', '3'])
    expect(r.overflow.get('#a')).toBe(1)
  })
})

describe('deliver', () => {
  let dir: string
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }) })

  function fakeClient(joined: Set<string>) {
    const sent: Array<{ target: string; text: string }> = []
    const client = {
      isJoined: (ch: string) => joined.has(ch),
      say(target: string, text: string) { sent.push({ target, text }); return { chunks: 1, mode: 'single' as const } },
    } as unknown as RoostIrcClient
    return { client, sent }
  }

  it('queues events for an unjoined channel, then posts them in order once it joins', async () => {
    dir = await mkdtemp(join(tmpdir(), 'roost-deliver-'))
    const joined = new Set(['#a'])
    const { client, sent } = fakeClient(joined)
    const desired = new Set(['#a', '#b'])
    const log = () => {}

    const first = await deliver(dir, client, [
      { channels: ['#a', '#b'], text: 'e1' },
      { channels: ['#b'], text: 'e2' },
    ], desired, log)
    expect(first).toEqual({ posted: 1, held: 2, failures: [] })
    expect(sent).toEqual([{ target: '#a', text: 'e1' }])
    expect((await loadOutbox(dir)).map(e => e.text)).toEqual(['e1', 'e2'])

    joined.add('#b')
    sent.length = 0
    const second = await deliver(dir, client, [{ channels: ['#b'], text: 'e3' }], desired, log)
    expect(second).toEqual({ posted: 1, held: 0, failures: [] })
    expect(sent).toEqual([{ target: '#b', text: 'e1\n\ne2\n\ne3' }])
    expect(await loadOutbox(dir)).toEqual([])
  })

  it('drops queued events for a channel that is no longer watched', async () => {
    dir = await mkdtemp(join(tmpdir(), 'roost-deliver-'))
    await writeOutbox(dir, [entry('#gone', 'stale')])
    const { client, sent } = fakeClient(new Set(['#a']))
    const logs: string[] = []
    await deliver(dir, client, [], new Set(['#a']), l => logs.push(l))
    expect(sent).toEqual([])
    expect(await loadOutbox(dir)).toEqual([])
    expect(logs.some(l => l.includes('outbox drop #gone'))).toBe(true)
  })
})
