import { describe, it, expect } from 'bun:test'
import { batchConsecutiveMultiline, dispatchTaggedEvents } from '../dispatch.js'
import type { TaggedEvent, TaggedEventPayload } from '../plugin.js'
import type { RoostIrcClient } from '../../irc-client.js'

// Build a `multiline` TaggedEvent for tests. Single channel by default.
function ml(channels: string[], header: string, body = '', url = 'u'): TaggedEvent {
  return {
    channels,
    payload: { kind: 'multiline', header, body, url } as TaggedEventPayload,
  }
}

function oneline(channels: string[], text: string): TaggedEvent {
  return { channels, payload: { kind: 'oneline', text } as TaggedEventPayload }
}

// Capture say() calls with a minimal RoostIrcClient stub.
function captureClient(): { client: RoostIrcClient; sent: Array<{ target: string; text: string }> } {
  const sent: Array<{ target: string; text: string }> = []
  const client = {
    say(target: string, text: string) {
      sent.push({ target, text })
      return { chunks: 1, mode: 'single' as const }
    },
  } as unknown as RoostIrcClient
  return { client, sent }
}

describe('batchConsecutiveMultiline', () => {
  it('merges consecutive multilines with the same channel set into one batch', () => {
    const events = [
      ml(['#a'], 'h1', 'b1', 'u1'),
      ml(['#a'], 'h2', 'b2', 'u2'),
      ml(['#a'], 'h3', 'b3', 'u3'),
    ]
    const out = batchConsecutiveMultiline(events)
    expect(out).toHaveLength(1)
    expect(out[0]!.payload.kind).toBe('multiline_batch')
    if (out[0]!.payload.kind === 'multiline_batch') {
      expect(out[0]!.payload.blocks).toEqual([
        { header: 'h1', body: 'b1', url: 'u1' },
        { header: 'h2', body: 'b2', url: 'u2' },
        { header: 'h3', body: 'b3', url: 'u3' },
      ])
      expect(out[0]!.channels).toEqual(['#a'])
    }
  })

  it('wraps a singleton multiline run as a one-block batch', () => {
    const events = [ml(['#a'], 'h1', 'b1', 'u1')]
    const out = batchConsecutiveMultiline(events)
    expect(out).toHaveLength(1)
    expect(out[0]!.payload.kind).toBe('multiline_batch')
    if (out[0]!.payload.kind === 'multiline_batch') {
      expect(out[0]!.payload.blocks).toEqual([{ header: 'h1', body: 'b1', url: 'u1' }])
      expect(out[0]!.channels).toEqual(['#a'])
    }
  })

  it('compares channel sets as a sorted set, not array order', () => {
    const events = [ml(['#a', '#b'], 'h1'), ml(['#b', '#a'], 'h2')]
    const out = batchConsecutiveMultiline(events)
    expect(out).toHaveLength(1)
    expect(out[0]!.payload.kind).toBe('multiline_batch')
  })

  it('splits runs when channel sets differ', () => {
    const events = [ml(['#a'], 'h1'), ml(['#b'], 'h2'), ml(['#a'], 'h3')]
    const out = batchConsecutiveMultiline(events)
    expect(out).toHaveLength(3)
    expect(out.every(e => e.payload.kind === 'multiline_batch')).toBe(true)
  })

  it('breaks the run when an oneline event intervenes', () => {
    const events = [ml(['#a'], 'h1'), oneline(['#a'], 'CI: ok'), ml(['#a'], 'h2')]
    const out = batchConsecutiveMultiline(events)
    expect(out).toHaveLength(3)
    // The two multilines are NOT merged across the intervening oneline.
    expect(out[0]!.payload.kind).toBe('multiline_batch')
    expect(out[1]!.payload.kind).toBe('oneline')
    expect(out[2]!.payload.kind).toBe('multiline_batch')
  })

  it('merges cross-PR comments that share a channel set, headers disambiguating', () => {
    const events = [
      ml(['#proj'], 'PR org/r#5 comment by alice:'),
      ml(['#proj'], 'PR org/r#6 comment by bob:'),
    ]
    const out = batchConsecutiveMultiline(events)
    expect(out).toHaveLength(1)
    if (out[0]!.payload.kind === 'multiline_batch') {
      expect(out[0]!.payload.blocks.map(b => b.header)).toEqual([
        'PR org/r#5 comment by alice:',
        'PR org/r#6 comment by bob:',
      ])
    }
  })

  it('passes oneline events through untouched', () => {
    const events = [oneline(['#a'], 'x'), oneline(['#b'], 'y')]
    expect(batchConsecutiveMultiline(events)).toEqual(events)
  })

  it('handles an empty list', () => {
    expect(batchConsecutiveMultiline([])).toEqual([])
  })
})

describe('dispatchTaggedEvents batching', () => {
  it('renders a multiline_batch as one say per target, blocks joined by a blank line', async () => {
    const events = [
      ml(['#a', '#b'], 'h1', 'b1', 'u1'),
      ml(['#b', '#a'], 'h2', 'b2', 'u2'),
    ]
    const { client, sent } = captureClient()
    await dispatchTaggedEvents(events, client)
    // One message per target (order preserved from the first event's channels).
    expect(sent).toEqual([
      { target: '#a', text: 'h1\nb1\nu1\n\nh2\nb2\nu2' },
      { target: '#b', text: 'h1\nb1\nu1\n\nh2\nb2\nu2' },
    ])
  })

  it('acceptance: N comments on one PR in one tick arrive as a single IRC message', async () => {
    // A realistic diffPr output for one PR: two review comments, a review
    // (empty summary body), and a conversation comment — all route to the same
    // channel. One say() per target; blocks joined by a blank line.
    const blocks = [
      ['PR org/r#1 comment by alice at src/a.ts:12:', 'fix this', 'https://gh/c1'],
      ['PR org/r#1 comment by alice at src/b.ts:4:', 'also this', 'https://gh/c2'],
      ['PR org/r#1 review by alice (COMMENT):', '', 'https://gh/r1'],
      ['PR org/r#1 comment by bob:', 'lgtm', 'https://gh/c3'],
    ]
    const events = blocks.map(([h, b, u]) => ml(['#issue-5'], h, b, u))
    const { client, sent } = captureClient()
    await dispatchTaggedEvents(events, client)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.target).toBe('#issue-5')
    expect(sent[0]!.text).toBe(blocks.map(b => b.join('\n')).join('\n\n'))
  })

  it('does not batch when channels differ', async () => {
    const events = [ml(['#a'], 'h1', 'b1', 'u1'), ml(['#b'], 'h2', 'b2', 'u2')]
    const { client, sent } = captureClient()
    await dispatchTaggedEvents(events, client)
    expect(sent).toEqual([
      { target: '#a', text: 'h1\nb1\nu1' },
      { target: '#b', text: 'h2\nb2\nu2' },
    ])
  })

  it('preserves oneline rendering for oneline events', async () => {
    const events = [oneline(['#a'], 'PR org/r#1 CI: PENDING → SUCCESS (abc123)')]
    const { client, sent } = captureClient()
    await dispatchTaggedEvents(events, client)
    expect(sent).toEqual([{ target: '#a', text: 'PR org/r#1 CI: PENDING → SUCCESS (abc123)' }])
  })
})
