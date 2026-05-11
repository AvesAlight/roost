import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { startErgo, isErgoAvailable, type ErgoContext } from './helpers/ergo.js'
import { startMcpInProcess } from './helpers/mcp-inprocess.js'
import { startMcp } from './helpers/mcp.js'
import { messagePredicate } from './helpers/mcp-core.js'
import { connectPeer } from './helpers/peer.js'
import { toolText, sleep } from './helpers/tool.js'

describe.if(isErgoAvailable())('chathistory backfill', () => {
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
      mcp.waitForNotification(messagePredicate({ historical: true, content: 'before-join-1' })),
      mcp.waitForNotification(messagePredicate({ historical: true, content: 'before-join-2' })),
      mcp.waitForNotification(messagePredicate({ historical: true, content: 'before-join-3' })),
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
      mcp.waitForNotification(messagePredicate({ historical: true, content: 'while-parted-1' })),
      mcp.waitForNotification(messagePredicate({ historical: true, content: 'while-parted-2' })),
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

    await mcp.waitForNotification(messagePredicate({ historical: true, content: 'limit-three' }))
    await mcp.waitForNotification(messagePredicate({ historical: true, content: 'limit-four' }))

    // Earlier messages are outside the limit and must not appear.
    const all = mcp.notifications.filter(messagePredicate({ historical: true, channel: '#ip-hist-limit' }))
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
    await mcp.waitForNotification(messagePredicate({ historical: true, content: 'order-two' }))

    const hist = await mcp.client.callTool({
      name: 'channel_history',
      arguments: { channel: '#ip-hist-order3' },
    })
    expect(hist.isError).toBeFalsy()
    const text = toolText(hist)
    const idx1 = text.indexOf('order-one')
    const idx2 = text.indexOf('order-two')
    expect(idx1).toBeGreaterThanOrEqual(0)
    expect(idx2).toBeGreaterThan(idx1)
  })

  it('own-nick messages sent before join appear as historical on join', async () => {
    const peer = await connectPeer(ergo, 'ip-own-peer1')
    const mcp = await startMcpInProcess(ergo, 'ip-own-mcp1')

    // MCP joins, sends a message, then parts
    await peer.joinChannel('#ip-hist-own1')
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-hist-own1' } })
    await mcp.client.callTool({ name: 'channel_message', arguments: { channel: '#ip-hist-own1', text: 'own-msg-before-part' } })
    await sleep(100)
    await mcp.client.callTool({ name: 'channel_leave', arguments: { channel: '#ip-hist-own1' } })

    // Rejoin — own message must appear in chathistory backfill
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-hist-own1' } })
    await mcp.waitForNotification(messagePredicate({ historical: true, content: 'own-msg-before-part' }))
  })

  it('own-nick messages sent while joined do not produce live notifications', async () => {
    const peer = await connectPeer(ergo, 'ip-own-peer2')
    const mcp = await startMcpInProcess(ergo, 'ip-own-mcp2')

    await peer.joinChannel('#ip-hist-own2')
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-hist-own2' } })
    await mcp.client.callTool({ name: 'channel_message', arguments: { channel: '#ip-hist-own2', text: 'own-live-msg' } })
    await sleep(200)

    // Tests the no-echo protocol guarantee (ergo doesn't echo without echo-message cap); to cover the line 508 guard directly, echo-message would need to be negotiated.
    // Must not arrive as a live notification
    const live = mcp.notifications.filter(messagePredicate({ content: 'own-live-msg', historical: false }))
    expect(live).toHaveLength(0)
  })

  it('live messages are not re-emitted as historical on part+rejoin', async () => {
    const peer = await connectPeer(ergo, 'ip-dedup-peer1')
    const mcp = await startMcpInProcess(ergo, 'ip-dedup-mcp1')

    await peer.joinChannel('#ip-hist-dedup1')
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-hist-dedup1' } })

    // Receive message live — MCP adds it to seen-set
    peer.say('#ip-hist-dedup1', 'dedup-live-msg')
    await mcp.waitForNotification(messagePredicate({ content: 'dedup-live-msg', channel: '#ip-hist-dedup1' }))

    // Part and rejoin — ergo replays chathistory including dedup-live-msg
    await mcp.client.callTool({ name: 'channel_leave', arguments: { channel: '#ip-hist-dedup1' } })
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-hist-dedup1' } })
    await sleep(500)

    // The message must not arrive again as historical
    const dupes = mcp.notifications.filter(messagePredicate({ content: 'dedup-live-msg', historical: true }))
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
    await mcp.waitForNotification(messagePredicate({ historical: true, content: 'dedup-hist-msg' }))

    // Part and rejoin — chathistory would replay it again without dedupe
    await mcp.client.callTool({ name: 'channel_leave', arguments: { channel: '#ip-hist-dedup2' } })
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#ip-hist-dedup2' } })
    await sleep(500)

    const all = mcp.notifications.filter(n => n.content === 'dedup-hist-msg')
    expect(all).toHaveLength(1)
  })
})

// Subprocess-only: requires process.kill on subprocess pid via pidfile.
describe.if(isErgoAvailable())('chathistory backfill (subprocess)', () => {
  let ergo: ErgoContext
  const tmpDirs: string[] = []

  beforeAll(async () => {
    ergo = (await startErgo())!
  })

  afterAll(() => {
    for (const d of tmpDirs) {
      try { rmSync(d, { recursive: true }) } catch {}
    }
  })

  it('SIGUSR1 clears seen-set so messages backfill after compaction reset', async () => {
    const dataDir = mkdtempSync(`${tmpdir()}/roost-test-`)
    tmpDirs.push(dataDir)

    const peer = await connectPeer(ergo, 'dedup-peer3')
    const mcp = await startMcp(ergo, 'dedup-mcp3', { ROOST_DATA_DIR: dataDir })

    await peer.joinChannel('#hist-dedup3')
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#hist-dedup3' } })

    peer.say('#hist-dedup3', 'dedup-reset-msg')
    await mcp.waitForNotification(messagePredicate({ content: 'dedup-reset-msg', channel: '#hist-dedup3' }))

    // Verify dedupe works before reset: part+rejoin → no duplicate
    await mcp.client.callTool({ name: 'channel_leave', arguments: { channel: '#hist-dedup3' } })
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#hist-dedup3' } })
    await sleep(500)
    expect(mcp.notifications.filter(messagePredicate({ content: 'dedup-reset-msg', historical: true }))).toHaveLength(0)

    // Simulate compaction: send SIGUSR1 via the pidfile
    const pidPath = `${dataDir}/mcp.pid`
    const pid = parseInt((await Bun.file(pidPath).text()).trim(), 10)
    process.kill(pid, 'SIGUSR1')
    await sleep(100)

    // Part+rejoin after reset → message replays as historical
    await mcp.client.callTool({ name: 'channel_leave', arguments: { channel: '#hist-dedup3' } })
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#hist-dedup3' } })
    await mcp.waitForNotification(messagePredicate({ content: 'dedup-reset-msg', historical: true }), 5000)
  })
})
