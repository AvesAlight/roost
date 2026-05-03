import { describe, it, expect } from 'bun:test'

const DISPATCHER = `${import.meta.dir}/../bin/orchestrator_poll`

describe('orchestrator_poll --self-test', () => {
  it('passes all self-tests', async () => {
    const proc = Bun.spawn(['python3', DISPATCHER, '--self-test'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    if (exitCode !== 0) {
      throw new Error(`self-test failed:\n${stderr}`)
    }
    expect(stdout).toContain('passed')
  })
})
