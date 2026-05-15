import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, writeFile, readFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  DISPATCHER_PID_FILE,
  readDispatcherPid,
  writeDispatcherPid,
  removeDispatcherPid,
  writeJoinedChannels,
} from '../config.js'

const execFileP = promisify(execFile)

// Bun.spawn returns before exec completes — on linux the kernel may report
// the pre-exec command line for a beat. Poll ps until it shows the dir.
async function waitForPsToShow(pid: number, needle: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      const { stdout } = await execFileP('ps', ['-p', String(pid), '-o', 'args='])
      if (stdout.includes(needle)) return
    } catch { /* process not yet visible */ }
    await new Promise(r => setTimeout(r, 20))
  }
  throw new Error(`ps never reported pid ${pid} with needle ${needle}`)
}

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'roost-pid-test-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('writeDispatcherPid', () => {
  it('writes a PID file with pid + started_at_ms + cmdline', async () => {
    const info = await writeDispatcherPid(dir)
    expect(info.pid).toBe(process.pid)
    expect(info.started_at_ms).toBeGreaterThan(0)
    expect(typeof info.cmdline).toBe('string')

    const raw = await readFile(join(dir, DISPATCHER_PID_FILE), 'utf8')
    const parsed = JSON.parse(raw)
    expect(parsed.pid).toBe(process.pid)
    expect(parsed.started_at_ms).toBe(info.started_at_ms)
  })

  it('refuses to overwrite a PID file owned by a live process whose cmdline matches stateDir', async () => {
    // Spawn a real child whose command line includes `dir`, mimicking a
    // live dispatcher started with `--config-dir <dir>`. Using a script
    // path under `dir` is the most portable way to get `ps` to surface the
    // path — `bash -c "..."` argv handling varies between darwin/linux ps.
    const script = join(dir, 'fake-daemon.sh')
    await writeFile(script, '#!/usr/bin/env bash\nsleep 5\n')
    const child = Bun.spawn(['bash', script])
    try {
      // Bun.spawn returns before exec completes — poll ps until the dir
      // shows up in args so the test fails fast if the contract breaks.
      await waitForPsToShow(child.pid, dir)
      await writeFile(
        join(dir, DISPATCHER_PID_FILE),
        JSON.stringify({ pid: child.pid, started_at_ms: 0, cmdline: `bash ${dir}` })
      )
      await expect(writeDispatcherPid(dir)).rejects.toThrow(/already running/)
    } finally {
      child.kill()
      await child.exited
    }
  })

  it('overwrites a stale PID file (dead PID, no cmdline match)', async () => {
    // PID 1 (init) is alive but its cmdline won't include our stateDir.
    // readDispatcherPid treats this as stale → writeDispatcherPid recovers.
    await writeFile(
      join(dir, DISPATCHER_PID_FILE),
      JSON.stringify({ pid: 1, started_at_ms: 0, cmdline: 'unrelated' })
    )
    const info = await writeDispatcherPid(dir)
    expect(info.pid).toBe(process.pid)
  })

  it('overwrites a PID file containing a dead PID', async () => {
    // A PID we're confident is dead: very high number unlikely to exist.
    await writeFile(
      join(dir, DISPATCHER_PID_FILE),
      JSON.stringify({ pid: 999999, started_at_ms: 0, cmdline: dir })
    )
    const info = await writeDispatcherPid(dir)
    expect(info.pid).toBe(process.pid)
  })
})

describe('readDispatcherPid', () => {
  it('returns null when no PID file exists', async () => {
    expect(await readDispatcherPid(dir)).toBeNull()
  })

  it('returns null when JSON is malformed', async () => {
    await writeFile(join(dir, DISPATCHER_PID_FILE), 'not json')
    expect(await readDispatcherPid(dir)).toBeNull()
  })

  it('returns null when the PID is dead', async () => {
    await writeFile(
      join(dir, DISPATCHER_PID_FILE),
      JSON.stringify({ pid: 999999, started_at_ms: 0, cmdline: dir })
    )
    expect(await readDispatcherPid(dir)).toBeNull()
  })

  it('returns null when the PID is alive but cmdline does not reference stateDir (recycle defense)', async () => {
    // PID 1 is alive but its cmdline is not our daemon.
    await writeFile(
      join(dir, DISPATCHER_PID_FILE),
      JSON.stringify({ pid: 1, started_at_ms: 0, cmdline: 'unrelated' })
    )
    expect(await readDispatcherPid(dir)).toBeNull()
  })

  it('ignores the recorded cmdline field and trusts only ps', async () => {
    // Forging the JSON cmdline shouldn't fool readDispatcherPid — the ps
    // cross-check uses the kernel's view, not anything in the file. The
    // test runner's real `ps args=` does not contain `dir`, so this is null.
    await writeFile(
      join(dir, DISPATCHER_PID_FILE),
      JSON.stringify({ pid: process.pid, started_at_ms: 1, cmdline: `bun --foo ${dir}` })
    )
    expect(await readDispatcherPid(dir)).toBeNull()
  })
})

describe('removeDispatcherPid', () => {
  it('removes the file when present', async () => {
    await writeDispatcherPid(dir)
    await removeDispatcherPid(dir)
    await expect(access(join(dir, DISPATCHER_PID_FILE))).rejects.toThrow()
  })

  it('is a no-op when absent', async () => {
    await expect(removeDispatcherPid(dir)).resolves.toBeUndefined()
  })
})

describe('writeJoinedChannels', () => {
  it('writes channels one per line with trailing newline', async () => {
    await writeJoinedChannels(dir, ['#a', '#b', '#c'])
    const text = await readFile(join(dir, 'joined-channels.txt'), 'utf8')
    expect(text).toBe('#a\n#b\n#c\n')
  })

  it('writes an empty file when channels is empty', async () => {
    await writeJoinedChannels(dir, [])
    const text = await readFile(join(dir, 'joined-channels.txt'), 'utf8')
    expect(text).toBe('')
  })
})
