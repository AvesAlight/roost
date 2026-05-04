import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { startErgo, isErgoAvailable, type ErgoContext } from './helpers/ergo.js'
import { startMcp } from './helpers/mcp.js'
import { connectPeer } from './helpers/peer.js'
import { toolText, sleep } from './helpers/tool.js'

describe.if(isErgoAvailable())('chathistory backfill', () => {
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
    await mcp.waitForNotification(n => n.content === 'dedup-reset-msg' && n.meta.channel === '#hist-dedup3')

    // Verify dedupe works before reset: part+rejoin → no duplicate
    await mcp.client.callTool({ name: 'channel_leave', arguments: { channel: '#hist-dedup3' } })
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#hist-dedup3' } })
    await sleep(500)
    expect(mcp.notifications.filter(n => n.content === 'dedup-reset-msg' && n.meta.historical === 'true')).toHaveLength(0)

    // Simulate compaction: send SIGUSR1 via the pidfile
    const pidPath = `${dataDir}/mcp.pid`
    const pid = parseInt((await Bun.file(pidPath).text()).trim(), 10)
    process.kill(pid, 'SIGUSR1')
    await sleep(100)

    // Part+rejoin after reset → message replays as historical
    await mcp.client.callTool({ name: 'channel_leave', arguments: { channel: '#hist-dedup3' } })
    await mcp.client.callTool({ name: 'channel_join', arguments: { channel: '#hist-dedup3' } })
    await mcp.waitForNotification(n => n.content === 'dedup-reset-msg' && n.meta.historical === 'true', 5000)
  })
})
