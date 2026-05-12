import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, chmodSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const BIN_DIR = join(import.meta.dirname, '../bin')
const HOOK_NAME = 'roost-compact-hook'

describe('spawn shim', () => {
  let tmpDir: string
  let shimPath: string
  let stubsDir: string

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'roost-shim-test-'))
    stubsDir = join(tmpDir, 'stubs')
    mkdirSync(stubsDir, { recursive: true })

    shimPath = join(tmpDir, HOOK_NAME)

    // Write the shim via _write_shim from bin/roost so the test stays in sync
    // with the production format — if the template changes, this test fails.
    const proc = Bun.spawn(
      ['bash', '-c', `source "${join(BIN_DIR, 'roost')}" && _write_shim "${HOOK_NAME}" "${tmpDir}"`],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    const [stderr, exitCode] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    expect(exitCode, `_write_shim setup failed: ${stderr}`).toBe(0)
  })

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  async function runShimWithRoot(root: string): Promise<string> {
    mkdirSync(join(root, 'bin'), { recursive: true })
    // Stub hook echoes its root path so we can verify which root was reached
    writeFileSync(join(root, 'bin', HOOK_NAME), `#!/bin/sh\necho "${root}"\n`)
    chmodSync(join(root, 'bin', HOOK_NAME), 0o755)
    // Stub `roost`: `roost root` returns the given root path
    writeFileSync(join(stubsDir, 'roost'), `#!/bin/sh\necho "${root}"\n`)
    chmodSync(join(stubsDir, 'roost'), 0o755)

    const proc = Bun.spawn([shimPath], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, PATH: `${stubsDir}:${process.env.PATH ?? ''}` },
    })
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ])
    expect(exitCode).toBe(0)
    return stdout.trim()
  }

  it('re-resolves roost root at exec time, not at shim-write time', async () => {
    const rootA = join(tmpDir, 'root-a')
    const rootB = join(tmpDir, 'root-b')

    // Same shim file; swapping what `roost root` returns routes to a different hook binary
    expect(await runShimWithRoot(rootA)).toBe(rootA)
    expect(await runShimWithRoot(rootB)).toBe(rootB)
  })
})
