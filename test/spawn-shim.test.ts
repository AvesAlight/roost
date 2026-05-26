import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, chmodSync, mkdirSync, writeFileSync, rmSync, symlinkSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const ROOST_BIN = join(import.meta.dirname, '../bin/roost')

// `hook-exec` is the PATH-stable dispatcher that replaced the per-session shim
// files under ROOST_DATA_DIR. The invariants under test mirror what the old
// shim did, minus the `/tmp/roost-*` file dependency that macOS tmp_cleaner
// could erase out from under a long-running session:
//
//   1. ROOST_DIR is re-resolved on every invocation by walking the symlinks
//      at the top of bin/roost. After `brew upgrade roost` re-points the
//      brew-opt symlink, the next hook-exec call lands on the new Cellar.
//   2. Missing or non-executable target exits 127 with a clear stderr; a
//      missing name exits 1 with usage hint.

describe('hook-exec dispatch', () => {
  let tmpDir: string

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'roost-hook-exec-test-'))
  })

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  // Build a fake Cellar at <cellar>/bin/{roost,<hookName>}. bin/roost is a
  // *copy* of the real roost script (not a symlink) so the symlink walk at
  // the top of bin/roost terminates inside <cellar> rather than chasing the
  // symlink back to the real source tree. The stub hook echoes <cellar>.
  function makeFakeCellar(cellar: string, hookName: string): void {
    mkdirSync(join(cellar, 'bin'), { recursive: true })
    copyFileSync(ROOST_BIN, join(cellar, 'bin', 'roost'))
    chmodSync(join(cellar, 'bin', 'roost'), 0o755)
    const hook = join(cellar, 'bin', hookName)
    writeFileSync(hook, `#!/bin/sh\necho "${cellar}"\n`)
    chmodSync(hook, 0o755)
  }

  it('re-resolves ROOST_DIR via the symlink walk on every call', async () => {
    // Mirror the brew layout: <prefix>/bin/roost -> <prefix>/opt/roost/bin/roost,
    // <prefix>/opt/roost -> <prefix>/Cellar/roost/<version>.
    const prefix = tmpDir
    const cellarA = join(prefix, 'Cellar/roost/0.0.1')
    const cellarB = join(prefix, 'Cellar/roost/0.0.2')
    makeFakeCellar(cellarA, 'irc-stub-hook')
    makeFakeCellar(cellarB, 'irc-stub-hook')

    mkdirSync(join(prefix, 'opt'), { recursive: true })
    mkdirSync(join(prefix, 'bin'), { recursive: true })
    const optSymlink = join(prefix, 'opt/roost')
    const brewBin    = join(prefix, 'bin/roost')
    symlinkSync(cellarA, optSymlink)
    symlinkSync(join(optSymlink, 'bin/roost'), brewBin)

    const run = async (): Promise<string> => {
      const proc = Bun.spawn([brewBin, 'hook-exec', 'irc-stub-hook'], { stdout: 'pipe', stderr: 'pipe' })
      const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
      return stdout.trim()
    }

    expect(await run()).toBe(cellarA)

    // Simulate `brew upgrade`: re-point the opt symlink at the new Cellar.
    rmSync(optSymlink)
    symlinkSync(cellarB, optSymlink)

    expect(await run()).toBe(cellarB)
  })

  it('exits 127 with stderr when the target hook is missing', async () => {
    const proc = Bun.spawn([ROOST_BIN, 'hook-exec', 'no-such-hook'], { stdout: 'pipe', stderr: 'pipe' })
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
    expect(exitCode).toBe(127)
    expect(stderr).toContain('not executable')
    expect(stderr).toContain('no-such-hook')
  })

  it('exits 1 with usage when called with no hook name', async () => {
    const proc = Bun.spawn([ROOST_BIN, 'hook-exec'], { stdout: 'pipe', stderr: 'pipe' })
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
    expect(exitCode).toBe(1)
    expect(stderr).toContain('requires a hook name')
  })

  // Direct regression for the bug: tmp_cleaner wiped ROOST_DATA_DIR overnight,
  // the next hook call landed on a non-existent shim path and exited 127, and
  // the worker hung on a TUI prompt nobody could see. Now that hook entry
  // points live at the roost binary instead of inside DATA_DIR, rm -rf'ing
  // DATA_DIR mid-session has no effect on hook resolution.
  it('hook entry point still resolves after ROOST_DATA_DIR is deleted', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'roost-deleted-data-dir-'))
    rmSync(dataDir, { recursive: true, force: true })

    const proc = Bun.spawn([ROOST_BIN, 'hook-exec', 'roost-session-start-hook'], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, ROOST_DATA_DIR: dataDir },
    })
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    expect(exitCode).toBe(0)
    expect(stdout).toContain('hookEventName')
  })
})
