import { describe, it, expect } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const POLL_BIN = join(import.meta.dir, '../../../bin/orchestrator_poll')

async function runPoll(cwd: string, args: string[] = []): Promise<{ stderr: string; exitCode: number }> {
  const proc = Bun.spawn([POLL_BIN, ...args], { cwd, stderr: 'pipe', stdout: 'pipe' })
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  return { stderr, exitCode }
}

describe('orchestrator cwd-default', () => {
  it('defaults state dir to <cwd>/.orchestrator', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'roost-test-'))
    try {
      const { stderr, exitCode } = await runPoll(tmp)
      expect(exitCode).toBe(3)
      expect(stderr).toContain(join(tmp, '.orchestrator', 'config.json'))
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

  it('--config-dir overrides the default', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'roost-test-'))
    const override = await mkdtemp(join(tmpdir(), 'roost-override-'))
    try {
      const { stderr, exitCode } = await runPoll(tmp, ['--config-dir', override])
      expect(exitCode).toBe(3)
      expect(stderr).toContain(join(override, 'config.json'))
      expect(stderr).not.toContain(join(tmp, '.orchestrator'))
    } finally {
      await rm(tmp, { recursive: true, force: true })
      await rm(override, { recursive: true, force: true })
    }
  })
})
