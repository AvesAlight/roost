import { describe, it, expect, beforeAll } from 'bun:test'
import { startErgo, isErgoAvailable, type ErgoContext } from './helpers/ergo.js'
import { startMcp } from './helpers/mcp.js'
import { connectPeer } from './helpers/peer.js'
import { toolText, sleep } from './helpers/tool.js'

describe.if(isErgoAvailable())('chathistory backfill', () => {
  let ergo: ErgoContext

  beforeAll(async () => {
    ergo = (await startErgo())!
  })

  it('pre-join messages arrive as historical notifications in seq order', async () => {
    const peer = await connectPeer(ergo, 'hist-peer1')
    const mcp = await startMcp(ergo, 'hist-mcp1')

    await peer.joinChannel('#hist-backfill1')
    peer.say('#hist-backfill1', 'before-join-1')
    peer.say('#hist-backfill1', 'before-join-2')
    peer.say('#hist-backfill1', 'before-join-3')
    await sleep(200)

    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#hist-backfill1' } })

    const [n1, n2, n3] = await Promise.all([
      mcp.waitForNotification(n => n.meta.historical === 'true' && n.content === 'before-join-1'),
      mcp.waitForNotification(n => n.meta.historical === 'true' && n.content === 'before-join-2'),
      mcp.waitForNotification(n => n.meta.historical === 'true' && n.content === 'before-join-3'),
    ])

    expect(n1.meta.channel).toBe('#hist-backfill1')
    expect(Number(n2.meta.seq)).toBeGreaterThan(Number(n1.meta.seq))
    expect(Number(n3.meta.seq)).toBeGreaterThan(Number(n2.meta.seq))
  })

  it('messages sent while parted arrive as historical on rejoin', async () => {
    const peer = await connectPeer(ergo, 'hist-peer2')
    const mcp = await startMcp(ergo, 'hist-mcp2')

    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#hist-backfill2' } })
    await peer.joinChannel('#hist-backfill2')
    await mcp.client.callTool({ name: 'channel_leave', arguments: { channel: '#hist-backfill2' } })

    peer.say('#hist-backfill2', 'while-parted-1')
    peer.say('#hist-backfill2', 'while-parted-2')
    await sleep(200)

    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#hist-backfill2' } })

    const [n1, n2] = await Promise.all([
      mcp.waitForNotification(n => n.meta.historical === 'true' && n.content === 'while-parted-1'),
      mcp.waitForNotification(n => n.meta.historical === 'true' && n.content === 'while-parted-2'),
    ])

    expect(Number(n2.meta.seq)).toBeGreaterThan(Number(n1.meta.seq))
  })

  it('channel_history includes backfilled messages in order', async () => {
    const peer = await connectPeer(ergo, 'hist-peer3')
    const mcp = await startMcp(ergo, 'hist-mcp3')

    await peer.joinChannel('#hist-order3')
    peer.say('#hist-order3', 'order-one')
    peer.say('#hist-order3', 'order-two')
    await sleep(200)

    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#hist-order3' } })
    await mcp.waitForNotification(n => n.meta.historical === 'true' && n.content === 'order-two')

    const hist = await mcp.client.callTool({
      name: 'channel_history',
      arguments: { channel: '#hist-order3' },
    })
    expect(hist.isError).toBeFalsy()
    const text = toolText(hist)
    const idx1 = text.indexOf('order-one')
    const idx2 = text.indexOf('order-two')
    expect(idx1).toBeGreaterThanOrEqual(0)
    expect(idx2).toBeGreaterThan(idx1)
  })
})
