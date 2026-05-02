import { join, resolve } from 'node:path'
import { mkdtemp, writeFile, rm, unlink } from 'node:fs/promises'
import { accessSync, constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { afterAll } from 'bun:test'

const ROOST_ROOT = join(import.meta.dirname, '..', '..')

export function isErgoAvailable(): boolean {
  return findErgoBin() !== null
}

function findErgoBin(): string | null {
  const candidates: string[] = [
    ...(process.env.ERGO_BIN ? [resolve(process.env.ERGO_BIN)] : []),
    join(ROOST_ROOT, 'var', 'ergo-bin', 'ergo'),
  ]

  for (const c of candidates) {
    try {
      accessSync(c, constants.X_OK)
      return c
    } catch {
      // not found or not executable
    }
  }

  return Bun.which('ergo')
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as { port: number }
      srv.close(() => resolve(addr.port))
    })
    srv.on('error', reject)
  })
}

function makeErgoConfig(port: number, datadir: string): string {
  return `network:
  name: roost-test
server:
  name: roost-test.local
  max-sendq: 16k
  listeners:
    "127.0.0.1:${port}":
  sts:
    enabled: false
  lookup-hostnames: false
  forward-confirm-hostnames: false
  check-ident: false
  relaymsg:
    enabled: false
  casemapping: ascii
  enforce-utf8: true
  ip-limits:
    count: false
    throttle: false
accounts:
  authentication-enabled: false
  registration:
    enabled: false
channels:
  default-modes: +nt
  registration:
    enabled: false
logging:
  - method: stderr
    type: "* -userinput -useroutput"
    level: info
datastore:
  path: ${datadir}/ircd.db
  autoupgrade: true
lock-file: ${datadir}/ircd.lock
languages:
  enabled: false
fakelag:
  enabled: false
limits:
  nicklen: 32
  identlen: 20
  realnamelen: 150
  channellen: 64
  awaylen: 390
  kicklen: 390
  topiclen: 390
  monitor-entries: 100
  whowas-entries: 100
  chan-list-modes: 100
  registration-messages: 1024
  multiline:
    max-bytes: 16384
    max-lines: 200
history:
  enabled: true
  channel-length: 256
  client-length: 64
  autoreplay-on-join: 10
  chathistory-maxmessages: 100
  persistent:
    enabled: false
`
}

export interface ErgoContext {
  port: number
  host: string
}

export interface ErgoLifecycle extends ErgoContext {
  /** Graceful shutdown (SIGTERM). Waits for process exit. */
  kill(): Promise<void>
  /** Start a new ergo process on the same port/datadir. */
  restart(): Promise<void>
  /** Kill process (if alive) and delete the tmp datadir. */
  cleanup(): Promise<void>
}

export async function startErgo(): Promise<ErgoContext | null> {
  const ergo = findErgoBin()
  if (!ergo) {
    console.warn(
      '\nERGO NOT FOUND — skipping integration tests.\n' +
        'Run bin/install-ergo or set ERGO_BIN to the ergo binary path.\n',
    )
    return null
  }

  const port = await getFreePort()
  const datadir = await mkdtemp(join(tmpdir(), 'roost-test-'))
  const configPath = join(datadir, 'ircd.yaml')

  await writeFile(configPath, makeErgoConfig(port, datadir))

  const init = Bun.spawnSync([ergo, 'initdb', '--conf', configPath], { cwd: datadir })
  if (init.exitCode !== 0) {
    await rm(datadir, { recursive: true, force: true })
    throw new Error(`ergo initdb failed: ${new TextDecoder().decode(init.stderr)}`)
  }

  const proc = await spawnErgoProcess(ergo, configPath, datadir)

  afterAll(async () => {
    proc.kill()
    await rm(datadir, { recursive: true, force: true })
  })

  return { port, host: '127.0.0.1' }
}

async function spawnErgoProcess(
  ergo: string,
  configPath: string,
  datadir: string,
): Promise<ReturnType<typeof Bun.spawn>> {
  const proc = Bun.spawn([ergo, 'run', '--conf', configPath], {
    cwd: datadir,
    stderr: 'pipe',
    stdout: 'ignore',
  })

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      proc.kill()
      reject(new Error('ergo did not start within 5s'))
    }, 5000)

    const decoder = new TextDecoder()
    let buf = ''
    const reader = proc.stderr.getReader()

    const pump = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) {
            reader.releaseLock()
            reject(new Error('ergo exited before becoming ready'))
            return
          }
          buf += decoder.decode(value, { stream: true })
          const lines = buf.split('\n')
          buf = lines.pop() ?? ''
          for (const line of lines) {
            if (line.includes('now listening on')) {
              clearTimeout(timeout)
              reader.releaseLock() // release so proc.exited resolves cleanly
              resolve()
              return
            }
          }
        }
      } catch (e) {
        try { reader.releaseLock() } catch { /* already released */ }
        reject(e)
      }
    }
    void pump()
  })

  return proc
}

/**
 * Start a private ergo instance with lifecycle control (kill/restart/cleanup).
 * The caller owns cleanup — no afterAll is registered.
 * Returns null if ergo binary is not available (test should skip).
 */
export async function startErgoDedicated(): Promise<ErgoLifecycle | null> {
  const ergo = findErgoBin()
  if (!ergo) return null

  const port = await getFreePort()
  const datadir = await mkdtemp(join(tmpdir(), 'roost-test-'))
  const configPath = join(datadir, 'ircd.yaml')
  const lockPath = join(datadir, 'ircd.lock')

  await writeFile(configPath, makeErgoConfig(port, datadir))

  const init = Bun.spawnSync([ergo, 'initdb', '--conf', configPath], { cwd: datadir })
  if (init.exitCode !== 0) {
    await rm(datadir, { recursive: true, force: true })
    throw new Error(`ergo initdb failed: ${new TextDecoder().decode(init.stderr)}`)
  }

  let proc = await spawnErgoProcess(ergo, configPath, datadir)

  return {
    port,
    host: '127.0.0.1',

    async kill() {
      proc.kill() // SIGTERM — ergo cleans up lock file on graceful exit
      await proc.exited
      await new Promise<void>(res => setTimeout(res, 100)) // let OS release the port
    },

    async restart() {
      // Remove lock in case previous kill was unclean
      await unlink(lockPath).catch(() => {})
      proc = await spawnErgoProcess(ergo, configPath, datadir)
    },

    async cleanup() {
      try { proc.kill() } catch { /* already dead */ }
      await rm(datadir, { recursive: true, force: true })
    },
  }
}
