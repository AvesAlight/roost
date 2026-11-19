import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { startErgoDedicated, isErgoAvailable, type ErgoLifecycle } from './helpers/ergo.js'

// `roost spawn` asks the ircd for its NICKLEN before it starts a session. A
// nick over the limit is rejected at registration and the agent sits "still
// connecting" with nothing on screen, so the wrapper has to refuse it up front.
//
// The ergo test helper pins nicklen=32. A PATH shim stands in for tmux: its
// has-session always succeeds, so a spawn that gets past the nick check ends
// at "session already exists" (exit 3) without launching claude, and any
// new-session call is recorded.

const ROOST = path.resolve(import.meta.dir, '..', 'bin', 'roost')
const NICKLEN = 32

let shimDir = ''
let tmuxLog = ''
let cwd = ''

beforeAll(() => {
  shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-nicklen-shim-'))
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-nicklen-cwd-'))
  tmuxLog = path.join(shimDir, 'tmux.log')
  fs.writeFileSync(path.join(shimDir, 'tmux'),
    `#!/bin/sh\necho "$@" >> "${tmuxLog}"\n[ "$1" = has-session ] && exit 0\nexit 0\n`, { mode: 0o755 })
})

afterAll(() => {
  fs.rmSync(shimDir, { recursive: true, force: true })
  fs.rmSync(cwd, { recursive: true, force: true })
})

interface SpawnResult { rc: number; out: string; elapsedMs: number; tmuxCalls: string }

async function spawnRoost(port: number, nick: string, extra: string[] = []): Promise<SpawnResult> {
  fs.rmSync(tmuxLog, { force: true })
  const started = Date.now()
  const env: Record<string, string> = { ...process.env as Record<string, string> }
  delete env['ROOST_SPAWN_NO_LAUNCH']
  delete env['ROOST_SPAWN_KEEP_DATA_DIR']
  env['ROOST_IRC_PORT'] = String(port)
  env['ROOST_IRC_SERVER'] = '127.0.0.1'
  env['PATH'] = `${shimDir}:${process.env['PATH']}`
  const p = Bun.spawn(['bash', ROOST, 'spawn', nick, '--cwd', cwd, ...extra], { env, stdout: 'pipe', stderr: 'pipe' })
  const [out, err, rc] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  const tmuxCalls = fs.existsSync(tmuxLog) ? fs.readFileSync(tmuxLog, 'utf8') : ''
  return { rc, out: out + err, elapsedMs: Date.now() - started, tmuxCalls }
}

function dataDirsFor(nick: string): string[] {
  return fs.readdirSync(os.tmpdir()).filter(f => f.startsWith(`roost-${nick}.`))
}

const nickOf = (n: number) => 'n'.repeat(n)

describe.if(isErgoAvailable())('roost spawn NICKLEN check (real ergo)', () => {
  let ergo: ErgoLifecycle | null = null
  beforeAll(async () => { ergo = await startErgoDedicated() })
  afterAll(async () => { await ergo?.cleanup() })

  it('refuses a nick one char over NICKLEN: non-zero, limit in message, no session, no data dir', async () => {
    const nick = nickOf(NICKLEN + 1)
    const r = await spawnRoost(ergo!.port, nick)
    expect(r.rc).not.toBe(0)
    expect(r.rc).not.toBe(3) // 3 = got past the check to the tmux has-session probe
    expect(r.out).toContain(`NICKLEN is ${NICKLEN}`)
    expect(r.out).toContain(`${NICKLEN + 1} chars`)
    expect(r.tmuxCalls).not.toContain('new-session')
    expect(dataDirsFor(nick)).toEqual([])
  })

  it('accepts a nick exactly at NICKLEN (reaches the tmux probe)', async () => {
    const r = await spawnRoost(ergo!.port, nickOf(NICKLEN))
    expect(r.rc).toBe(3)
    expect(r.out).not.toContain('NICKLEN')
  })

  it('with --perm-irc, refuses a nick whose permbot- nick is over NICKLEN and names it', async () => {
    const nick = nickOf(NICKLEN - 'permbot-'.length + 1)
    const r = await spawnRoost(ergo!.port, nick, ['--perm-irc', '--perm-target', 'pm'])
    expect(r.rc).not.toBe(0)
    expect(r.rc).not.toBe(3)
    expect(r.out).toContain(`permbot-${nick}`)
    expect(r.out).toContain(`NICKLEN is ${NICKLEN}`)
    expect(r.tmuxCalls).not.toContain('new-session')
  })

  it('with --perm-irc, accepts a nick whose permbot- nick fits', async () => {
    const r = await spawnRoost(ergo!.port, nickOf(NICKLEN - 'permbot-'.length), ['--perm-irc', '--perm-target', 'pm'])
    expect(r.rc).toBe(3)
  })

  it('the same nick without --perm-irc is not held to the permbot- limit', async () => {
    const r = await spawnRoost(ergo!.port, nickOf(NICKLEN - 'permbot-'.length + 1))
    expect(r.rc).toBe(3)
  })
})

describe('roost spawn NICKLEN check (short nicks)', () => {
  it('does not register a probe for a nick at or under ergo\'s default NICKLEN', async () => {
    let registrations = 0
    const server = net.createServer(s => {
      s.on('data', d => { if (String(d).includes('NICK ')) registrations++ })
      s.on('error', () => {})
    })
    await new Promise<void>(res => server.listen(0, '127.0.0.1', res))
    const port = (server.address() as net.AddressInfo).port
    try {
      const r = await spawnRoost(port, nickOf(NICKLEN))
      expect(r.rc).toBe(3)
      expect(r.out).not.toContain('NICKLEN')
      expect(registrations).toBe(0)
    } finally {
      server.close()
    }
  }, 30_000)

  it('probes when the permbot- nick pushes it over', async () => {
    let registrations = 0
    const server = net.createServer(s => {
      s.on('data', d => { if (String(d).includes('NICK ')) registrations++ })
      s.on('error', () => {})
    })
    await new Promise<void>(res => server.listen(0, '127.0.0.1', res))
    const port = (server.address() as net.AddressInfo).port
    try {
      await spawnRoost(port, nickOf(NICKLEN - 'permbot-'.length + 1), ['--perm-irc', '--perm-target', 'pm'])
      expect(registrations).toBe(1)
    } finally {
      server.close()
    }
  }, 30_000)
})

describe('roost spawn NICKLEN check (slow ircd)', () => {
  it('waits out a pause longer than one read before the 005 and still refuses', async () => {
    const sockets: net.Socket[] = []
    const server = net.createServer(s => {
      sockets.push(s)
      // An ircd doing ident or rDNS lookups can sit on registration for a while.
      setTimeout(() => {
        s.write(':irc.test 001 probe :Welcome\r\n:irc.test 005 probe NICKLEN=32 :are supported\r\n:irc.test 376 probe :End\r\n')
      }, 1500)
    })
    await new Promise<void>(res => server.listen(0, '127.0.0.1', res))
    const port = (server.address() as net.AddressInfo).port
    try {
      const r = await spawnRoost(port, nickOf(NICKLEN + 1))
      expect(r.rc).not.toBe(0)
      expect(r.rc).not.toBe(3)
      expect(r.out).toContain(`NICKLEN is ${NICKLEN}`)
    } finally {
      sockets.forEach(s => s.destroy())
      server.close()
    }
  }, 30_000)
})

describe('roost spawn NICKLEN check (indeterminate)', () => {
  it('warns and continues when the ircd never answers, within a bounded time', async () => {
    const sockets: net.Socket[] = []
    const server = net.createServer(s => { sockets.push(s) }) // accepts, never speaks
    await new Promise<void>(res => server.listen(0, '127.0.0.1', res))
    const port = (server.address() as net.AddressInfo).port
    try {
      const r = await spawnRoost(port, nickOf(NICKLEN + 5))
      expect(r.rc).toBe(3)
      expect(r.out).toContain('could not read NICKLEN')
      expect(r.elapsedMs).toBeLessThan(15_000)
    } finally {
      sockets.forEach(s => s.destroy())
      server.close()
    }
  }, 30_000)

  it('warns and continues at once when the ircd hangs up', async () => {
    const server = net.createServer(s => s.destroy())
    await new Promise<void>(res => server.listen(0, '127.0.0.1', res))
    const port = (server.address() as net.AddressInfo).port
    try {
      const r = await spawnRoost(port, nickOf(NICKLEN + 5))
      expect(r.rc).toBe(3)
      expect(r.out).toContain('could not read NICKLEN')
      expect(r.elapsedMs).toBeLessThan(4_000)
    } finally {
      server.close()
    }
  }, 30_000)
})
