import { describe, test, expect, afterAll } from 'bun:test'
import { join } from 'node:path'

const ROOST_ROOT = join(import.meta.dirname, '..')
const ROOST_BIN = join(ROOST_ROOT, 'bin', 'roost')

function isTmuxAvailable(): boolean {
  return Bun.which('tmux') !== null
}

async function roost(...args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([ROOST_BIN, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode }
}

async function tmuxListWindows(session: string): Promise<string[]> {
  const proc = Bun.spawn(['tmux', 'list-windows', '-t', session, '-F', '#{window_name}'], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  if (exitCode !== 0) return []
  return stdout.trim().split('\n').filter(Boolean)
}

async function tmuxKillSession(session: string): Promise<void> {
  const proc = Bun.spawn(['tmux', 'kill-session', '-t', session], { stdout: 'pipe', stderr: 'pipe' })
  await proc.exited
}

describe.if(isTmuxAvailable())('roost service', () => {
  const SESSION = 'roost-services'
  const CMD = '/usr/bin/yes'
  const NAME = 'yes'

  afterAll(async () => {
    await tmuxKillSession(SESSION)
  })

  test('start spawns window in roost-services session', async () => {
    const { exitCode, stdout } = await roost('service', 'start', CMD)
    expect(exitCode).toBe(0)
    expect(stdout).toContain(`service ${NAME}: started`)
    const windows = await tmuxListWindows(SESSION)
    expect(windows).toContain(NAME)
  })

  test('start is idempotent when process is running', async () => {
    const windowsBefore = await tmuxListWindows(SESSION)
    const { exitCode, stdout } = await roost('service', 'start', CMD)
    expect(exitCode).toBe(0)
    expect(stdout).toContain('no-op')
    const windowsAfter = await tmuxListWindows(SESSION)
    // window count unchanged
    expect(windowsAfter.filter(w => w === NAME).length).toBe(
      windowsBefore.filter(w => w === NAME).length,
    )
  })

  test('status shows service as up', async () => {
    const { exitCode, stdout } = await roost('service', 'status')
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(new RegExp(`${NAME}.*up`))
  })

  test('stop removes window', async () => {
    const { exitCode, stdout } = await roost('service', 'stop', NAME)
    expect(exitCode).toBe(0)
    expect(stdout).toContain(`service ${NAME}: stopped`)
    const windows = await tmuxListWindows(SESSION)
    expect(windows).not.toContain(NAME)
  })

  test('stop on missing service exits 0 with friendly note', async () => {
    const { exitCode, stdout } = await roost('service', 'stop', NAME)
    expect(exitCode).toBe(0)
    expect(stdout).toContain('not running')
  })
})
