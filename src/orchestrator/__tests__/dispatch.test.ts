import { describe, it, expect } from 'bun:test'
import { groupMessagesByChannel, dispatchMessages } from '../dispatch.js'
import type { PluginMessage } from '../plugin.js'
import type { RoostIrcClient } from '../../irc-client.js'

function msg(channels: string[], text: string): PluginMessage {
  return { channels, text }
}

// Capture say() calls with a minimal RoostIrcClient stub.
function captureClient(joined?: Set<string>): { client: RoostIrcClient; sent: Array<{ target: string; text: string }> } {
  const sent: Array<{ target: string; text: string }> = []
  const client = {
    isJoined: (ch: string) => joined?.has(ch) ?? true,
    say(target: string, text: string) {
      sent.push({ target, text })
      return { chunks: 1, mode: 'single' as const }
    },
  } as unknown as RoostIrcClient
  return { client, sent }
}

describe('groupMessagesByChannel', () => {
  it('groups all messages for one channel into a single bucket, in emission order', () => {
    const messages = [
      msg(['#a'], 'one'),
      msg(['#a'], 'two'),
      msg(['#a'], 'three'),
    ]
    const out = groupMessagesByChannel(messages)
    expect([...out.entries()]).toEqual([['#a', ['one', 'two', 'three']]])
  })

  it('delivers a multi-channel message to every channel it targets', () => {
    const out = groupMessagesByChannel([msg(['#a', '#b'], 'shared')])
    expect(out.get('#a')).toEqual(['shared'])
    expect(out.get('#b')).toEqual(['shared'])
  })

  it('merges messages into per-channel buckets regardless of intervening other-channel messages', () => {
    // #a's two messages stay in one bucket even with an intervening #b message.
    const messages = [
      msg(['#a'], 'a1'),
      msg(['#b'], 'b1'),
      msg(['#a'], 'a2'),
    ]
    const out = groupMessagesByChannel(messages)
    expect(out.get('#a')).toEqual(['a1', 'a2'])
    expect(out.get('#b')).toEqual(['b1'])
  })

  it('merges a multi-channel message into each target channel alongside channel-only messages', () => {
    // {#a,#b} and {#a} share channel #a — both land in #a's bucket.
    const messages = [
      msg(['#a', '#b'], 'both'),
      msg(['#a'], 'a-only'),
    ]
    const out = groupMessagesByChannel(messages)
    expect(out.get('#a')).toEqual(['both', 'a-only'])
    expect(out.get('#b')).toEqual(['both'])
  })

  it('preserves within-channel order as emission order across plugins', () => {
    // runOneTick concatenates all plugins' messages; cross-plugin merges land
    // here. A GitHub then a Linear message to #a arrive in that order.
    const messages = [
      msg(['#a'], 'github-comment'),
      msg(['#a'], 'linear-comment'),
    ]
    const out = groupMessagesByChannel(messages)
    expect(out.get('#a')).toEqual(['github-comment', 'linear-comment'])
  })

  it('skips empty-text messages (no blank-line posts)', () => {
    const out = groupMessagesByChannel([
      msg(['#a'], ''),
      msg(['#a'], 'real'),
    ])
    expect(out.get('#a')).toEqual(['real'])
  })

  it('drops a channel entirely when its only message is empty', () => {
    expect(groupMessagesByChannel([msg(['#a'], '')]).has('#a')).toBe(false)
  })

  it('dedups channels within a single message so [#a, #a] posts once', () => {
    const out = groupMessagesByChannel([msg(['#a', '#a'], 'x')])
    expect(out.get('#a')).toEqual(['x'])
  })

  it('insertion-orders channels by first message that touched them', () => {
    const out = groupMessagesByChannel([
      msg(['#z'], '1'),
      msg(['#a'], '2'),
      msg(['#z'], '3'),
    ])
    expect([...out.keys()]).toEqual(['#z', '#a'])
  })

  it('handles an empty list', () => {
    expect([...groupMessagesByChannel([]).entries()]).toEqual([])
  })
})

describe('dispatchMessages', () => {
  it('posts one message per channel, texts joined by a blank line', async () => {
    const messages = [
      msg(['#a', '#b'], 'h1\nb1\nu1'),
      msg(['#b', '#a'], 'h2\nb2\nu2'),
    ]
    const { client, sent } = captureClient()
    await dispatchMessages(messages, client)
    // One message per channel; #a first (insertion order from the first message).
    expect(sent).toEqual([
      { target: '#a', text: 'h1\nb1\nu1\n\nh2\nb2\nu2' },
      { target: '#b', text: 'h1\nb1\nu1\n\nh2\nb2\nu2' },
    ])
  })

  it('acceptance: N comments on one PR in one tick arrive as a single IRC message', async () => {
    // A realistic one-PR tick: two review comments, a review (empty body), and a
    // conversation comment — all route to the same channel. One say() per channel.
    const blocks = [
      'PR org/r#1 comment by alice at src/a.ts:12:\nfix this\nhttps://gh/c1',
      'PR org/r#1 comment by alice at src/b.ts:4:\nalso this\nhttps://gh/c2',
      'PR org/r#1 review by alice (COMMENT):\n\nhttps://gh/r1',
      'PR org/r#1 comment by bob:\nlgtm\nhttps://gh/c3',
    ]
    const messages = blocks.map(t => msg(['#issue-1'], t))
    const { client, sent } = captureClient()
    await dispatchMessages(messages, client)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.target).toBe('#issue-1')
    expect(sent[0]!.text).toBe(blocks.join('\n\n'))
  })

  it('posts separate messages when channels differ', async () => {
    const messages = [msg(['#a'], 'x'), msg(['#b'], 'y')]
    const { client, sent } = captureClient()
    await dispatchMessages(messages, client)
    expect(sent).toEqual([
      { target: '#a', text: 'x' },
      { target: '#b', text: 'y' },
    ])
  })

  it('merges cross-PR comments that share a channel into one message', async () => {
    // Two PRs routing to one leads channel merge into one message (headers
    // disambiguate).
    const messages = [
      msg(['#proj'], 'PR org/r#5 comment by alice:\nbody1\nu1'),
      msg(['#proj'], 'PR org/r#6 comment by bob:\nbody2\nu2'),
    ]
    const { client, sent } = captureClient()
    await dispatchMessages(messages, client)
    expect(sent).toEqual([
      { target: '#proj', text: 'PR org/r#5 comment by alice:\nbody1\nu1\n\nPR org/r#6 comment by bob:\nbody2\nu2' },
    ])
  })

  it('does not post anything for an empty-text message', async () => {
    const { client, sent } = captureClient()
    await dispatchMessages([msg(['#a'], '')], client)
    expect(sent).toEqual([])
  })

  it('holds texts for a channel the client is not in instead of posting into the void', async () => {
    const { client, sent } = captureClient(new Set(['#a']))
    const out = await dispatchMessages([msg(['#a', '#b'], 'x'), msg(['#b'], 'y')], client)
    expect(sent).toEqual([{ target: '#a', text: 'x' }])
    expect([...out.held.entries()]).toEqual([['#b', ['x', 'y']]])
    expect(out.posted).toBe(1)
    expect(out.failures).toEqual([])
  })

  it('does not gate nick (DM) targets on channel membership', async () => {
    const { client, sent } = captureClient(new Set())
    const out = await dispatchMessages([msg(['some-nick'], 'hi')], client)
    expect(sent).toEqual([{ target: 'some-nick', text: 'hi' }])
    expect(out.held.size).toBe(0)
  })

  it('holds texts when say() throws and reports the failure', async () => {
    const client = {
      isJoined: () => true,
      say() { throw new Error('not connected') },
    } as unknown as RoostIrcClient
    const out = await dispatchMessages([msg(['#a'], 'x')], client)
    expect([...out.held.entries()]).toEqual([['#a', ['x']]])
    expect(out.failures).toEqual(['#a: Error: not connected'])
  })

  it('reports a failed DM without holding it (a nick has no membership to wait on)', async () => {
    const client = {
      isJoined: () => true,
      say() { throw new Error('not connected') },
    } as unknown as RoostIrcClient
    const out = await dispatchMessages([msg(['some-nick'], 'x')], client)
    expect(out.held.size).toBe(0)
    expect(out.failures).toEqual(['some-nick: Error: not connected'])
  })
})
