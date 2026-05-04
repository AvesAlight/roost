import { describe, it, expect, beforeAll } from 'bun:test'
import { startErgo, isErgoAvailable, type ErgoContext } from './helpers/ergo.js'
import { startMcpInProcess } from './helpers/mcp-inprocess.js'
import { connectPeer } from './helpers/peer.js'
import { sleep } from './helpers/tool.js'

describe.if(isErgoAvailable())('chathistory backfill (in-process)', () => {
  let ergo: ErgoContext

  beforeAll(async () => {
    ergo = (await startErgo())!
  })

  it('pre-join messages arrive as historical notifications in seq order', async () => {
    const peer = await connectPeer(ergo, 'ip-hist-peer1')
    const mcp = await startMcpInProcess(ergo, 'ip-hist-mcp1')

    await peer.joinChannel('#ip-hist-backfill1')
    peer.say('#ip-hist-backfill1', 'before-join-1')
    peer.say('#ip-hist-backfill1', 'before-join-2')
    peer.say('#ip-hist-backfill1', 'before-join-3')
    await sleep(200)

    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-hist-backfill1' } })

    const [n1, n2, n3] = await Promise.all([
      mcp.waitForNotification(n => n.meta.historical === 'true' && n.content === 'before-join-1'),
      mcp.waitForNotification(n => n.meta.historical === 'true' && n.content === 'before-join-2'),
      mcp.waitForNotification(n => n.meta.historical === 'true' && n.content === 'before-join-3'),
    ])

    expect(n1.meta.channel).toBe('#ip-hist-backfill1')
    expect(Number(n2.meta.seq)).toBeGreaterThan(Number(n1.meta.seq))
    expect(Number(n3.meta.seq)).toBeGreaterThan(Number(n2.meta.seq))
  })

  it('messages sent while parted arrive as historical on rejoin', async () => {
    const peer = await connectPeer(ergo, 'ip-hist-peer2')
    const mcp = await startMcpInProcess(ergo, 'ip-hist-mcp2')

    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-hist-backfill2' } })
    await peer.joinChannel('#ip-hist-backfill2')
    await mcp.client.callTool({ name: 'channel_leave', arguments: { channel: '#ip-hist-backfill2' } })

    peer.say('#ip-hist-backfill2', 'while-parted-1')
    peer.say('#ip-hist-backfill2', 'while-parted-2')
    await sleep(200)

    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-hist-backfill2' } })

    const [n1, n2] = await Promise.all([
      mcp.waitForNotification(n => n.meta.historical === 'true' && n.content === 'while-parted-1'),
      mcp.waitForNotification(n => n.meta.historical === 'true' && n.content === 'while-parted-2'),
    ])

    expect(Number(n2.meta.seq)).toBeGreaterThan(Number(n1.meta.seq))
  })

  it('ROOST_IRC_JOIN_HISTORY_LINES caps how many historical messages are emitted', async () => {
    const peer = await connectPeer(ergo, 'ip-hist-peer-limit')
    // Only replay last 2 messages, even though 4 exist.
    const mcp = await startMcpInProcess(ergo, 'ip-hist-mcp-limit', { joinHistoryLines: 2 })

    await peer.joinChannel('#ip-hist-limit')
    peer.say('#ip-hist-limit', 'limit-one')
    peer.say('#ip-hist-limit', 'limit-two')
    peer.say('#ip-hist-limit', 'limit-three')
    peer.say('#ip-hist-limit', 'limit-four')
    await sleep(200)

    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-hist-limit' } })

    await mcp.waitForNotification(n => n.meta.historical === 'true' && n.content === 'limit-three')
    await mcp.waitForNotification(n => n.meta.historical === 'true' && n.content === 'limit-four')

    // Earlier messages are outside the limit and must not appear.
    const all = mcp.notifications.filter(n => n.meta.historical === 'true' && n.meta.channel === '#ip-hist-limit')
    expect(all.some(n => n.content === 'limit-one')).toBe(false)
    expect(all.some(n => n.content === 'limit-two')).toBe(false)
  })

  it('channel_history includes backfilled messages in order', async () => {
    const peer = await connectPeer(ergo, 'ip-hist-peer3')
    const mcp = await startMcpInProcess(ergo, 'ip-hist-mcp3')

    await peer.joinChannel('#ip-hist-order3')
    peer.say('#ip-hist-order3', 'order-one')
    peer.say('#ip-hist-order3', 'order-two')
    await sleep(200)

    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-hist-order3' } })
    await mcp.waitForNotification(n => n.meta.historical === 'true' && n.content === 'order-two')

    const hist = await mcp.client.callTool({
      name: 'channel_history',
      arguments: { channel: '#ip-hist-order3' },
    })
    expect(hist.isError).toBeFalsy()
    const text = (((hist.content as unknown[])[0] ?? {}) as { text?: string }).text ?? ''
    const idx1 = text.indexOf('order-one')
    const idx2 = text.indexOf('order-two')
    expect(idx1).toBeGreaterThanOrEqual(0)
    expect(idx2).toBeGreaterThan(idx1)
  })

  it('live messages are not re-emitted as historical on part+rejoin', async () => {
    const peer = await connectPeer(ergo, 'ip-dedup-peer1')
    const mcp = await startMcpInProcess(ergo, 'ip-dedup-mcp1')

    await peer.joinChannel('#ip-hist-dedup1')
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-hist-dedup1' } })

    // Receive message live — MCP adds it to seen-set
    peer.say('#ip-hist-dedup1', 'dedup-live-msg')
    await mcp.waitForNotification(n => n.content === 'dedup-live-msg' && n.meta.channel === '#ip-hist-dedup1')

    // Part and rejoin — ergo replays chathistory including dedup-live-msg
    await mcp.client.callTool({ name: 'channel_leave', arguments: { channel: '#ip-hist-dedup1' } })
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-hist-dedup1' } })
    await sleep(500)

    // The message must not arrive again as historical
    const dupes = mcp.notifications.filter(
      n => n.content === 'dedup-live-msg' && n.meta.historical === 'true',
    )
    expect(dupes).toHaveLength(0)
  })

  it('historical messages are not re-emitted on subsequent rejoin', async () => {
    const peer = await connectPeer(ergo, 'ip-dedup-peer2')
    const mcp = await startMcpInProcess(ergo, 'ip-dedup-mcp2')

    // Send before MCP joins
    await peer.joinChannel('#ip-hist-dedup2')
    peer.say('#ip-hist-dedup2', 'dedup-hist-msg')
    await sleep(200)

    // First join — received as historical, added to seen-set
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-hist-dedup2' } })
    await mcp.waitForNotification(n => n.meta.historical === 'true' && n.content === 'dedup-hist-msg')

    // Part and rejoin — chathistory would replay it again without dedupe
    await mcp.client.callTool({ name: 'channel_leave', arguments: { channel: '#ip-hist-dedup2' } })
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-hist-dedup2' } })
    await sleep(500)

    const all = mcp.notifications.filter(n => n.content === 'dedup-hist-msg')
    expect(all).toHaveLength(1)
  })
})
