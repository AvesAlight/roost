import { describe, it, expect } from 'bun:test'
import { join } from 'node:path'

const ROOST = join(import.meta.dirname, '../bin/roost')

async function spawnRoost(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([ROOST, ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode }
}

describe('roost spawn --prompt-template', () => {
  it('errors when template file is missing', async () => {
    const r = await spawnRoost(['spawn', 'test-x', '--prompt-template', 'doesnotexist'])
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('prompt template not found')
    expect(r.stderr).toContain('prompts/doesnotexist.md')
  })

  it('errors on unsubstituted placeholder', async () => {
    const r = await spawnRoost(['spawn', 'test-x', '--prompt-template', 'worker', '--prompt-arg', 'ISSUE=42'])
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('unsubstituted placeholders')
    expect(r.stderr).toContain('${BRANCH}')
    expect(r.stderr).toContain('${REPO}')
  })

  it('errors when --prompt-arg lacks KEY=VALUE shape', async () => {
    const r = await spawnRoost(['spawn', 'test-x', '--prompt-template', 'worker', '--prompt-arg', 'badarg'])
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('expects KEY=VALUE')
  })

  it('errors when --prompt-arg used without --prompt-template', async () => {
    const r = await spawnRoost(['spawn', 'test-x', '--prompt-arg', 'ISSUE=42'])
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('--prompt-arg requires --prompt-template')
  })

  it('errors when --prompt-template combined with --prompt', async () => {
    const r = await spawnRoost(['spawn', 'test-x', '--prompt', 'hi', '--prompt-template', 'worker'])
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('mutually exclusive')
  })

  it('substitutes placeholders and prints with --dry-run', async () => {
    const r = await spawnRoost([
      'spawn', 'test-x',
      '--prompt-template', 'worker',
      '--prompt-arg', 'ISSUE=42',
      '--prompt-arg', 'REPO=AlexSc/roost',
      '--prompt-arg', 'BRANCH=feat/42-thing',
      '--dry-run',
    ])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('worker-42')
    expect(r.stdout).toContain('AlexSc/roost#42')
    expect(r.stdout).toContain('feat/42-thing')
    expect(r.stdout).toContain('[worker-42]')
    expect(r.stdout).not.toContain('${')
  })
})
