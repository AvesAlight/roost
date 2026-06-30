/**
 * Verify bun resolution in bin/roost-irc-server and bin/dispatcher.
 *
 * Primary scenario mirrors the actual reported failure: bun installed
 * from-source to ~/.bun/bin, that directory absent from the non-interactive
 * login shell's PATH, BUN_BIN unset. The fix's candidate-3 fallback
 * (${HOME}/.bun/bin/bun) must pick it up and the MCP must connect to ergo.
 */
import { describe, it, expect, beforeAll } from 'bun:test'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { join, dirname, resolve } from 'node:path'
import { mkdirSync, symlinkSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { startErgo, isErgoAvailable, type ErgoContext } from './helpers/ergo.js'
import { wireMcpClient, pollUntilIrcReady } from './helpers/mcp-core.js'

const ROOST_ROOT = join(import.meta.dirname, '..')
const IRC_SERVER_SCRIPT = join(ROOST_ROOT, 'bin', 'roost-irc-server')
const DISPATCHER_SCRIPT = join(ROOST_ROOT, 'bin', 'dispatcher')

// Remove bun's own directory from PATH so the scripts fall through to the
// candidate-based resolution — keeps system PATH intact for bash/exec/etc.
function pathWithoutBun(): string {
  const realBun = Bun.which('bun')
  if (!realBun) return process.env.PATH ?? ''
  const bunDir = resolve(dirname(realBun))
  return (process.env.PATH ?? '').split(':').filter(p => resolve(p) !== bunDir).join(':')
}

// Base env: scrub ROOST_*, BUN_BIN, and BUN_INSTALL from the test runner's
// env so resolution tests start from a clean slate.
function scrubEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([k, v]) => v !== undefined && !k.startsWith('ROOST_') && k !== 'BUN_BIN' && k !== 'BUN_INSTALL',
    ),
  ) as Record<string, string>
}

describe.if(isErgoAvailable())('bin/roost-irc-server bun resolution — MCP connects', () => {
  let ergo: ErgoContext

  beforeAll(async () => {
    ergo = (await startErgo())!
  })

  it('candidate-3 fallback: MCP connects via ${HOME}/.bun/bin/bun with bun absent from PATH (primary failure scenario)', async () => {
    const realBun = Bun.which('bun')!
    const tmpHome = mkdtempSync(join(tmpdir(), 'roost-bun-home-'))
    let handle: Awaited<ReturnType<typeof wireMcpClient>> | undefined
    try {
      mkdirSync(join(tmpHome, '.bun', 'bin'), { recursive: true })
      symlinkSync(realBun, join(tmpHome, '.bun', 'bin', 'bun'))

      const transport = new StdioClientTransport({
        command: IRC_SERVER_SCRIPT,
        args: [],
        env: {
          ...scrubEnv(),
          ROOST_IRC_SERVER: ergo.host,
          ROOST_IRC_PORT: String(ergo.port),
          ROOST_IRC_NICK: 'bun-res-cand3',
          HOME: tmpHome,
          PATH: pathWithoutBun(),
        },
        stderr: 'pipe',
      })

      handle = await wireMcpClient(transport, 'bun-res-cand3')
      await pollUntilIrcReady(handle)
      const { tools } = await handle.client.listTools()
      expect(tools.map(t => t.name)).toContain('channel_message')
    } finally {
      await handle?.client.close()
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('BUN_BIN override: MCP connects when bun absent from PATH and HOME', async () => {
    const realBun = Bun.which('bun')!
    const tmpHome = mkdtempSync(join(tmpdir(), 'roost-bun-home-'))
    let handle: Awaited<ReturnType<typeof wireMcpClient>> | undefined
    try {
      const transport = new StdioClientTransport({
        command: IRC_SERVER_SCRIPT,
        args: [],
        env: {
          ...scrubEnv(),
          ROOST_IRC_SERVER: ergo.host,
          ROOST_IRC_PORT: String(ergo.port),
          ROOST_IRC_NICK: 'bun-res-bun-bin',
          HOME: tmpHome,
          PATH: pathWithoutBun(),
          BUN_BIN: realBun,
        },
        stderr: 'pipe',
      })

      handle = await wireMcpClient(transport, 'bun-res-bun-bin')
      await pollUntilIrcReady(handle)
      const { tools } = await handle.client.listTools()
      expect(tools.map(t => t.name)).toContain('channel_message')
    } finally {
      await handle?.client.close()
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })
})

describe('bin/roost-irc-server bun resolution — error cases', () => {
  it('exits non-zero with message when bun not found anywhere', async () => {
    const proc = Bun.spawn([IRC_SERVER_SCRIPT], {
      env: {
        PATH: '/usr/bin:/bin',
        HOME: '/nonexistent-bun-test',
        ROOST_IRC_SERVER: '127.0.0.1',
        ROOST_IRC_PORT: '16667',
        ROOST_IRC_NICK: 'bun-test-err',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stderr, exitCode] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    expect(exitCode).not.toBe(0)
    expect(stderr).toContain('bun not found')
  })

  it('exits non-zero when BUN_BIN is set but not executable', async () => {
    const proc = Bun.spawn([IRC_SERVER_SCRIPT], {
      env: {
        PATH: '/usr/bin:/bin',
        HOME: '/nonexistent-bun-test',
        BUN_BIN: '/nonexistent/bun',
        ROOST_IRC_SERVER: '127.0.0.1',
        ROOST_IRC_PORT: '16667',
        ROOST_IRC_NICK: 'bun-test-bad',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stderr, exitCode] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    expect(exitCode).not.toBe(0)
    expect(stderr).toContain('BUN_BIN=')
    expect(stderr).toContain('is not executable')
  })
})

describe('bin/dispatcher bun resolution — error case', () => {
  it('exits non-zero with message when bun not found anywhere', async () => {
    const proc = Bun.spawn([DISPATCHER_SCRIPT], {
      env: {
        PATH: '/usr/bin:/bin',
        HOME: '/nonexistent-bun-test',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stderr, exitCode] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    expect(exitCode).not.toBe(0)
    expect(stderr).toContain('bun not found')
  })
})
