import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { collectForNick, main } from '../src/token-usage.js'
import { mcpConnectionLine } from '../src/mcp-banner.js'

// Build a one-session JSONL containing the MCP banner for `nick` plus the
// given assistant turns (each contributing one usage block). Returns the
// path to the written file.
async function writeSessionFile(
  dir: string,
  filename: string,
  nick: string,
  turns: Array<{ input: number; output: number; cache_w?: number; cache_r?: number }>,
): Promise<string> {
  const lines: string[] = []
  // Permission-mode row (mirrors real transcripts; no usage).
  lines.push(JSON.stringify({ type: 'permission-mode', permissionMode: 'auto' }))
  // MCP attachment row carrying the marker `roost-token-usage` greps for.
  // Use the centralized banner helper so a wording change there breaks the
  // marker-matching round-trip rather than silently passing.
  lines.push(JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{
        type: 'text',
        text: `roost IRC MCP. ${mcpConnectionLine(nick)}. (test stub)`,
      }],
    },
  }))
  for (const t of turns) {
    lines.push(JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        usage: {
          input_tokens: t.input,
          output_tokens: t.output,
          cache_creation_input_tokens: t.cache_w ?? 0,
          cache_read_input_tokens: t.cache_r ?? 0,
        },
      },
    }))
  }
  const path = join(dir, filename)
  await writeFile(path, lines.join('\n') + '\n')
  return path
}

describe('token-usage', () => {
  let tmp: string
  let projects: string
  let stateDir: string

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'roost-token-usage-'))
    projects = join(tmp, 'projects')
    stateDir = join(tmp, 'state')
    await mkdir(projects, { recursive: true })
    await mkdir(stateDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  describe('collectForNick', () => {
    it('sums usage across multiple sessions in different project dirs', async () => {
      const dirA = join(projects, '-foo-project-a')
      const dirB = join(projects, '-foo-project-b')
      await mkdir(dirA, { recursive: true })
      await mkdir(dirB, { recursive: true })
      await writeSessionFile(dirA, 'sess1.jsonl', 'roost-worker-99', [
        { input: 10, output: 5, cache_w: 100, cache_r: 200 },
        { input: 20, output: 7, cache_w: 0, cache_r: 50 },
      ])
      await writeSessionFile(dirB, 'sess2.jsonl', 'roost-worker-99', [
        { input: 1, output: 2, cache_w: 3, cache_r: 4 },
      ])
      // Different nick — should NOT contribute.
      await writeSessionFile(dirA, 'other.jsonl', 'roost-worker-100', [
        { input: 999, output: 999 },
      ])

      const r = await collectForNick('roost-worker-99', projects)
      expect(r.usage.input).toBe(31)
      expect(r.usage.output).toBe(14)
      expect(r.usage.cache_creation).toBe(103)
      expect(r.usage.cache_read).toBe(254)
      expect(r.usage.sessions).toBe(2)
      expect(r.files).toHaveLength(2)
    })

    it('returns zero usage / empty files when nick is unknown', async () => {
      const dir = join(projects, '-foo')
      await mkdir(dir, { recursive: true })
      await writeSessionFile(dir, 'sess.jsonl', 'some-other-nick', [{ input: 5, output: 5 }])
      const r = await collectForNick('roost-worker-missing', projects)
      expect(r.usage.input).toBe(0)
      expect(r.usage.sessions).toBe(0)
      expect(r.files).toEqual([])
    })

    it('does not partial-match: nick "worker-1" must not match "worker-10"', async () => {
      const dir = join(projects, '-foo')
      await mkdir(dir, { recursive: true })
      await writeSessionFile(dir, 'sess.jsonl', 'roost-worker-10', [{ input: 7, output: 3 }])
      const r = await collectForNick('roost-worker-1', projects)
      // Marker uses the exact quoted nick — substring "worker-1" inside
      // "worker-10" does not match because the closing \" comes after the 0.
      expect(r.files).toEqual([])
    })

    it('handles malformed JSONL lines without crashing', async () => {
      const dir = join(projects, '-foo')
      await mkdir(dir, { recursive: true })
      const path = join(dir, 'broken.jsonl')
      const good = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'You are connected to IRC as nick "roost-x"' }] },
      })
      const goodTurn = JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', usage: { input_tokens: 8, output_tokens: 4, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
      })
      await writeFile(path, [good, '{garbage', goodTurn, '"usage": this is not json', ''].join('\n'))

      const r = await collectForNick('roost-x', projects)
      expect(r.usage.input).toBe(8)
      expect(r.usage.output).toBe(4)
      expect(r.usage.sessions).toBe(1)
    })
  })

  describe('main: snapshot + report dance', () => {
    beforeEach(() => {
      process.env.CLAUDE_PROJECTS_DIR = projects
    })
    afterEach(() => {
      delete process.env.CLAUDE_PROJECTS_DIR
    })

    it('snapshot writes baseline; report against same data yields zero deltas', async () => {
      const dir = join(projects, '-stuff')
      await mkdir(dir, { recursive: true })
      await writeSessionFile(dir, 's.jsonl', 'roost-lead-pm', [
        { input: 100, output: 50, cache_w: 500, cache_r: 2000 },
      ])

      const snapCode = await main(['snapshot', stateDir, '319', 'roost-lead-pm'])
      expect(snapCode).toBe(0)

      const snapText = await readFile(join(stateDir, 'token-snapshots.json'), 'utf8')
      const snap = JSON.parse(snapText) as Record<string, Record<string, { input: number; snapshot_at: string }>>
      expect(snap['319']['roost-lead-pm'].input).toBe(100)
      expect(snap['319']['roost-lead-pm'].snapshot_at).toBeTruthy()

      // No new turns added — report should print zero deltas.
      const lines: string[] = []
      const orig = process.stdout.write.bind(process.stdout)
      ;(process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
        lines.push(s)
        return true
      }
      try {
        const code = await main(['report', stateDir, '319', 'roost-lead-pm'])
        expect(code).toBe(0)
      } finally {
        ;(process.stdout as unknown as { write: typeof orig }).write = orig
      }
      const out = lines.join('')
      expect(out).toContain('roost-lead-pm: in=0 out=0 cache_w=0 cache_r=0 sessions=0')
    })

    it('report after additional turns shows the delta only', async () => {
      const dir = join(projects, '-stuff')
      await mkdir(dir, { recursive: true })
      const path = await writeSessionFile(dir, 's.jsonl', 'roost-lead-pm', [
        { input: 100, output: 50 },
      ])

      await main(['snapshot', stateDir, '319', 'roost-lead-pm'])

      // Append a new assistant turn after the snapshot.
      const newTurn = JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', usage: { input_tokens: 7, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
      })
      const existing = await readFile(path, 'utf8')
      await writeFile(path, existing + newTurn + '\n')

      const lines: string[] = []
      const orig = process.stdout.write.bind(process.stdout)
      ;(process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
        lines.push(s)
        return true
      }
      try {
        await main(['report', stateDir, '319', 'roost-lead-pm'])
      } finally {
        ;(process.stdout as unknown as { write: typeof orig }).write = orig
      }
      const out = lines.join('')
      expect(out).toContain('roost-lead-pm: in=7 out=3 cache_w=0 cache_r=0 sessions=0')
    })

    it('report with no snapshot prints cumulative (ephemeral nick case)', async () => {
      const dir = join(projects, '-stuff')
      await mkdir(dir, { recursive: true })
      await writeSessionFile(dir, 's.jsonl', 'roost-worker-319', [
        { input: 12_345, output: 4567 },
      ])

      const lines: string[] = []
      const orig = process.stdout.write.bind(process.stdout)
      ;(process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
        lines.push(s)
        return true
      }
      try {
        await main(['report', stateDir, '319', 'roost-worker-319'])
      } finally {
        ;(process.stdout as unknown as { write: typeof orig }).write = orig
      }
      const out = lines.join('')
      // 12345 → 12k, 4567 → 4.6k
      expect(out).toContain('roost-worker-319: in=12k out=4.6k')
    })

    it('exits non-zero when any nick matches zero session files', async () => {
      const dir = join(projects, '-stuff')
      await mkdir(dir, { recursive: true })
      await writeSessionFile(dir, 's.jsonl', 'roost-lead-pm', [{ input: 5, output: 5 }])

      const errs: string[] = []
      const orig = process.stderr.write.bind(process.stderr)
      ;(process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
        errs.push(s)
        return true
      }
      try {
        const code = await main(['report', stateDir, '999', 'roost-lead-pm', 'roost-ghost'])
        expect(code).toBe(1)
      } finally {
        ;(process.stderr as unknown as { write: typeof orig }).write = orig
      }
      expect(errs.join('')).toContain('roost-ghost')
    })

    it('rejects non-numeric issue arg', async () => {
      // No session files needed — bails before scanning.
      const errs: string[] = []
      const orig = process.stderr.write.bind(process.stderr)
      ;(process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
        errs.push(s)
        return true
      }
      try {
        const code = await main(['report', stateDir, 'PR-12', 'whatever'])
        expect(code).toBe(2)
      } finally {
        ;(process.stderr as unknown as { write: typeof orig }).write = orig
      }
      expect(errs.join('')).toContain('numeric')
    })

    it('snapshot for a second issue preserves the first issue entry', async () => {
      const dir = join(projects, '-stuff')
      await mkdir(dir, { recursive: true })
      await writeSessionFile(dir, 'sa.jsonl', 'roost-lead-pm', [{ input: 100, output: 50 }])
      await writeSessionFile(dir, 'sb.jsonl', 'roost-apm', [{ input: 10, output: 5 }])

      await main(['snapshot', stateDir, '319', 'roost-lead-pm', 'roost-apm'])
      await main(['snapshot', stateDir, '320', 'roost-lead-pm'])

      const snap = JSON.parse(await readFile(join(stateDir, 'token-snapshots.json'), 'utf8')) as Record<string, Record<string, { input: number }>>
      expect(snap['319']?.['roost-lead-pm']?.input).toBe(100)
      expect(snap['319']?.['roost-apm']?.input).toBe(10)
      expect(snap['320']?.['roost-lead-pm']?.input).toBe(100)
      // 320 didn't pass roost-apm — earlier entry should not have leaked.
      expect(snap['320']?.['roost-apm']).toBeUndefined()
    })

    it('one report invocation handles multiple nicks and prints one line per', async () => {
      const dir = join(projects, '-stuff')
      await mkdir(dir, { recursive: true })
      await writeSessionFile(dir, 'sw.jsonl', 'roost-worker-42', [{ input: 100, output: 10 }])
      await writeSessionFile(dir, 'sr.jsonl', 'roost-reviewer-42', [{ input: 50, output: 5 }])
      await writeSessionFile(dir, 'sl.jsonl', 'roost-lead-pm', [{ input: 1000, output: 500 }])
      await writeSessionFile(dir, 'sa.jsonl', 'roost-apm', [{ input: 200, output: 100 }])

      // Snapshot only the long-lived agents at "setup" time.
      await main(['snapshot', stateDir, '42', 'roost-lead-pm', 'roost-apm'])

      const lines: string[] = []
      const orig = process.stdout.write.bind(process.stdout)
      ;(process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
        lines.push(s)
        return true
      }
      try {
        const code = await main([
          'report', stateDir, '42',
          'roost-worker-42', 'roost-reviewer-42', 'roost-lead-pm', 'roost-apm',
        ])
        expect(code).toBe(0)
      } finally {
        ;(process.stdout as unknown as { write: typeof orig }).write = orig
      }
      const out = lines.join('')
      const printed = out.trim().split('\n')
      expect(printed).toHaveLength(4)
      // Workers/reviewers report cumulative (no snapshot); lead/apm diff to zero.
      expect(printed[0]).toContain('roost-worker-42: in=100 out=10')
      expect(printed[0]).toContain('sessions=1')
      expect(printed[1]).toContain('roost-reviewer-42: in=50 out=5')
      expect(printed[2]).toBe('roost-lead-pm: in=0 out=0 cache_w=0 cache_r=0 sessions=0')
      expect(printed[3]).toBe('roost-apm: in=0 out=0 cache_w=0 cache_r=0 sessions=0')
    })

    it('negative diff (snapshot drift) renders raw and stderr-warns', async () => {
      const dir = join(projects, '-stuff')
      await mkdir(dir, { recursive: true })
      const path = await writeSessionFile(dir, 's.jsonl', 'roost-lead-pm', [{ input: 100, output: 50 }])
      await main(['snapshot', stateDir, '42', 'roost-lead-pm'])

      // Simulate drift: rewrite the session so cumulative dropped below the snapshot.
      await rm(path)
      await writeSessionFile(dir, 's.jsonl', 'roost-lead-pm', [{ input: 30, output: 10 }])

      const outLines: string[] = []
      const errLines: string[] = []
      const origOut = process.stdout.write.bind(process.stdout)
      const origErr = process.stderr.write.bind(process.stderr)
      ;(process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => { outLines.push(s); return true }
      ;(process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => { errLines.push(s); return true }
      try {
        const code = await main(['report', stateDir, '42', 'roost-lead-pm'])
        expect(code).toBe(0)
      } finally {
        ;(process.stdout as unknown as { write: typeof origOut }).write = origOut
        ;(process.stderr as unknown as { write: typeof origErr }).write = origErr
      }
      // No Math.max clamp — the raw negative renders.
      expect(outLines.join('')).toContain('in=-70')
      expect(errLines.join('')).toContain('negative diff')
      expect(errLines.join('')).toContain('roost-lead-pm')
    })
  })
})
