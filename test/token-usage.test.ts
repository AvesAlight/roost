import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { collectForNick, main } from '../src/token-usage.js'
import { mcpConnectionLine } from '../src/mcp-banner.js'

interface Turn {
  ts: string
  model: string
  input?: number
  output?: number
  // Cache write 5m / 1h. If only `cache_w` is set, the helper writes only
  // the aggregate `cache_creation_input_tokens` and OMITS the nested
  // `cache_creation` block — exercises the fallback path that lumps the
  // aggregate into the 5m bucket.
  cache_w_5m?: number
  cache_w_1h?: number
  cache_w?: number
  cache_r?: number
  // Optional API duration row that follows this turn.
  apiDurationMs?: number
}

// Build a session JSONL containing the MCP banner for `nick` followed by the
// given assistant turns (and an optional per-turn `system/turn_duration`
// row using the same ts). Returns the written file path.
async function writeSessionFile(
  dir: string,
  filename: string,
  nick: string,
  turns: Turn[],
): Promise<string> {
  const lines: string[] = []
  lines.push(JSON.stringify({ type: 'permission-mode', permissionMode: 'auto' }))
  lines.push(JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: `roost IRC MCP. ${mcpConnectionLine(nick)}. (test stub)` }],
    },
  }))
  for (const t of turns) {
    const usage: Record<string, unknown> = {
      input_tokens: t.input ?? 0,
      output_tokens: t.output ?? 0,
      cache_read_input_tokens: t.cache_r ?? 0,
    }
    if (typeof t.cache_w_5m === 'number' || typeof t.cache_w_1h === 'number') {
      usage.cache_creation_input_tokens = (t.cache_w_5m ?? 0) + (t.cache_w_1h ?? 0)
      usage.cache_creation = {
        ephemeral_5m_input_tokens: t.cache_w_5m ?? 0,
        ephemeral_1h_input_tokens: t.cache_w_1h ?? 0,
      }
    } else {
      // Aggregate-only path: legacy / fallback shape.
      usage.cache_creation_input_tokens = t.cache_w ?? 0
    }
    lines.push(JSON.stringify({
      type: 'assistant',
      timestamp: t.ts,
      message: { role: 'assistant', model: t.model, usage },
    }))
    if (typeof t.apiDurationMs === 'number') {
      lines.push(JSON.stringify({
        type: 'system',
        subtype: 'turn_duration',
        durationMs: t.apiDurationMs,
        timestamp: t.ts,
      }))
    }
  }
  const path = join(dir, filename)
  await writeFile(path, lines.join('\n') + '\n')
  return path
}

// Capture stdout + stderr writes for one async block, restore afterward.
async function capture<T>(fn: () => Promise<T>): Promise<{ result: T; out: string; err: string }> {
  const outChunks: string[] = []
  const errChunks: string[] = []
  const origOut = process.stdout.write.bind(process.stdout)
  const origErr = process.stderr.write.bind(process.stderr)
  ;(process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => { outChunks.push(s); return true }
  ;(process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => { errChunks.push(s); return true }
  try {
    const result = await fn()
    return { result, out: outChunks.join(''), err: errChunks.join('') }
  } finally {
    ;(process.stdout as unknown as { write: typeof origOut }).write = origOut
    ;(process.stderr as unknown as { write: typeof origErr }).write = origErr
  }
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
    process.env.CLAUDE_PROJECTS_DIR = projects
  })

  afterEach(async () => {
    delete process.env.CLAUDE_PROJECTS_DIR
    await rm(tmp, { recursive: true, force: true })
  })

  describe('collectForNick', () => {
    it('sums per-model usage across multiple sessions in different dirs', async () => {
      const a = join(projects, '-pa')
      const b = join(projects, '-pb')
      await mkdir(a, { recursive: true })
      await mkdir(b, { recursive: true })
      await writeSessionFile(a, 's1.jsonl', 'roost-worker-99', [
        { ts: '2026-05-16T10:00:00Z', model: 'claude-opus-4-7', input: 10, output: 5, cache_w: 100, cache_r: 200, apiDurationMs: 4000 },
        { ts: '2026-05-16T10:05:00Z', model: 'claude-sonnet-4-6', input: 20, output: 7, apiDurationMs: 1000 },
      ])
      await writeSessionFile(b, 's2.jsonl', 'roost-worker-99', [
        { ts: '2026-05-16T11:00:00Z', model: 'claude-opus-4-7', input: 1, output: 2, cache_r: 4, apiDurationMs: 500 },
      ])
      // Different nick — must not contribute.
      await writeSessionFile(a, 'other.jsonl', 'roost-worker-100', [
        { ts: '2026-05-16T10:00:00Z', model: 'claude-opus-4-7', input: 999, output: 999 },
      ])

      const r = await collectForNick('roost-worker-99', projects)
      const opus = r.byModel.get('claude-opus-4-7')!
      const sonnet = r.byModel.get('claude-sonnet-4-6')!
      expect(opus.input).toBe(11)
      expect(opus.output).toBe(7)
      // Aggregate `cache_w: 100` with no nested → lumps into the 5m bucket.
      expect(opus.cache_creation_5m).toBe(100)
      expect(opus.cache_creation_1h).toBe(0)
      expect(opus.cache_read).toBe(204)
      expect(sonnet.input).toBe(20)
      expect(sonnet.output).toBe(7)
      expect(r.apiDurationMs).toBe(5500)
      expect(r.sessions).toBe(2)
      expect(r.wallFirst).toBe('2026-05-16T10:00:00Z')
      expect(r.wallLast).toBe('2026-05-16T11:00:00Z')
      expect(r.files).toHaveLength(2)
    })

    it('reads nested cache_creation 5m/1h breakdown when present', async () => {
      const d = join(projects, '-p')
      await mkdir(d, { recursive: true })
      await writeSessionFile(d, 's.jsonl', 'roost-x', [
        { ts: '2026-05-16T10:00:00Z', model: 'claude-opus-4-7', cache_w_5m: 1000, cache_w_1h: 500 },
      ])
      const r = await collectForNick('roost-x', projects)
      const opus = r.byModel.get('claude-opus-4-7')!
      expect(opus.cache_creation_5m).toBe(1000)
      expect(opus.cache_creation_1h).toBe(500)
    })

    it('returns empty report when nick is unknown', async () => {
      const d = join(projects, '-p')
      await mkdir(d, { recursive: true })
      await writeSessionFile(d, 's.jsonl', 'someone-else', [{ ts: '2026-05-16T10:00:00Z', model: 'claude-opus-4-7', input: 5, output: 5 }])
      const r = await collectForNick('roost-worker-missing', projects)
      expect(r.byModel.size).toBe(0)
      expect(r.sessions).toBe(0)
      expect(r.files).toEqual([])
    })

    it('does not partial-match: nick "worker-1" must not match "worker-10"', async () => {
      const d = join(projects, '-p')
      await mkdir(d, { recursive: true })
      await writeSessionFile(d, 's.jsonl', 'roost-worker-10', [{ ts: '2026-05-16T10:00:00Z', model: 'claude-opus-4-7', input: 7, output: 3 }])
      const r = await collectForNick('roost-worker-1', projects)
      expect(r.files).toEqual([])
    })

    it('handles malformed JSONL rows without crashing', async () => {
      const d = join(projects, '-p')
      await mkdir(d, { recursive: true })
      const path = join(d, 'broken.jsonl')
      const banner = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: `roost IRC MCP. ${mcpConnectionLine('roost-x')}.` }] },
      })
      const goodTurn = JSON.stringify({
        type: 'assistant',
        timestamp: '2026-05-16T10:00:00Z',
        message: { role: 'assistant', model: 'claude-opus-4-7', usage: { input_tokens: 8, output_tokens: 4, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
      })
      await writeFile(path, [banner, '{garbage', goodTurn, '"usage": this is not json', ''].join('\n'))
      const r = await collectForNick('roost-x', projects)
      expect(r.byModel.get('claude-opus-4-7')!.input).toBe(8)
      expect(r.sessions).toBe(1)
    })

    it('sinceTs filter excludes pre-window turns', async () => {
      const d = join(projects, '-p')
      await mkdir(d, { recursive: true })
      await writeSessionFile(d, 's.jsonl', 'roost-lead-pm', [
        { ts: '2026-05-16T09:00:00Z', model: 'claude-opus-4-7', input: 1000, output: 500, apiDurationMs: 10_000 },
        { ts: '2026-05-16T11:00:00Z', model: 'claude-opus-4-7', input: 50, output: 25, apiDurationMs: 2_000 },
      ])
      const r = await collectForNick('roost-lead-pm', projects, '2026-05-16T10:00:00Z')
      const opus = r.byModel.get('claude-opus-4-7')!
      expect(opus.input).toBe(50)
      expect(opus.output).toBe(25)
      expect(r.apiDurationMs).toBe(2_000)
      expect(r.sessions).toBe(1)
    })

    it('tracks unknown models for later warning', async () => {
      const d = join(projects, '-p')
      await mkdir(d, { recursive: true })
      await writeSessionFile(d, 's.jsonl', 'roost-x', [
        { ts: '2026-05-16T10:00:00Z', model: 'claude-mystery-9-0', input: 10, output: 10 },
      ])
      const r = await collectForNick('roost-x', projects)
      expect(r.unknownModels.has('claude-mystery-9-0')).toBe(true)
    })

    it('skips <synthetic> model rows from unknown-models set', async () => {
      const d = join(projects, '-p')
      await mkdir(d, { recursive: true })
      await writeSessionFile(d, 's.jsonl', 'roost-x', [
        { ts: '2026-05-16T10:00:00Z', model: '<synthetic>', input: 0, output: 1 },
      ])
      const r = await collectForNick('roost-x', projects)
      expect(r.unknownModels.has('<synthetic>')).toBe(false)
    })
  })

  describe('main: snapshot + report', () => {
    it('snapshot records timestamp only; report after no chatter shows no in-window activity', async () => {
      const d = join(projects, '-p')
      await mkdir(d, { recursive: true })
      await writeSessionFile(d, 's.jsonl', 'roost-lead-pm', [
        { ts: '2026-05-16T09:00:00Z', model: 'claude-opus-4-7', input: 100, output: 50, apiDurationMs: 5000 },
      ])
      const snap = await capture(() => main(['snapshot', stateDir, '319', 'roost-lead-pm']))
      expect(snap.result).toBe(0)
      const snapFile = JSON.parse(await readFile(join(stateDir, 'token-snapshots.json'), 'utf8')) as Record<string, Record<string, { snapshot_at: string }>>
      expect(snapFile['319']['roost-lead-pm'].snapshot_at).toBeTruthy()

      const rep = await capture(() => main(['report', stateDir, '319', 'roost-lead-pm']))
      expect(rep.result).toBe(0)
      expect(rep.out).toContain('roost-lead-pm: $0.00 · 0s api / 0s wall')
      expect(rep.out).toContain('(no in-window activity)')
    })

    it('report after new turns shows only the post-snapshot delta', async () => {
      const d = join(projects, '-p')
      await mkdir(d, { recursive: true })
      const path = await writeSessionFile(d, 's.jsonl', 'roost-lead-pm', [
        { ts: '2026-05-16T09:00:00Z', model: 'claude-opus-4-7', input: 1_000_000, output: 100_000, apiDurationMs: 60_000 },
      ])
      const snap = await capture(() => main(['snapshot', stateDir, '319', 'roost-lead-pm']))
      expect(snap.result).toBe(0)

      // Append a new post-snapshot turn. snapshot_at is `now`; using a
      // future-ish ts here puts the turn unambiguously after it.
      const newTurn = JSON.stringify({
        type: 'assistant',
        timestamp: '2099-01-01T00:00:00Z',
        message: { role: 'assistant', model: 'claude-opus-4-7', usage: { input_tokens: 7, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
      })
      const newDur = JSON.stringify({
        type: 'system', subtype: 'turn_duration', durationMs: 1500, timestamp: '2099-01-01T00:00:00Z',
      })
      await writeFile(path, (await readFile(path, 'utf8')) + newTurn + '\n' + newDur + '\n')

      const rep = await capture(() => main(['report', stateDir, '319', 'roost-lead-pm']))
      // Pre-snapshot 1M-input turn must NOT count; only the 7/3 turn does.
      expect(rep.out).toContain('opus-4-7: 7 in / 3 out')
      expect(rep.out).toContain('1s api')
    })

    it('report without snapshot prints full cumulative + per-model $ + duration', async () => {
      const d = join(projects, '-p')
      await mkdir(d, { recursive: true })
      await writeSessionFile(d, 's.jsonl', 'roost-worker-319', [
        { ts: '2026-05-16T10:00:00Z', model: 'claude-opus-4-7', input: 1_000_000, output: 100_000, apiDurationMs: 60_000 },
        { ts: '2026-05-16T10:30:00Z', model: 'claude-sonnet-4-6', input: 500_000, output: 50_000, apiDurationMs: 30_000 },
      ])
      const rep = await capture(() => main(['report', stateDir, '319', 'roost-worker-319']))
      expect(rep.result).toBe(0)
      // Opus 4.7 1M in × $5 + 100k out × $25 = $5 + $2.50 = $7.50
      // Sonnet 4.6 500k in × $3 + 50k out × $15 = $1.50 + $0.75 = $2.25
      // Total $9.75
      expect(rep.out).toContain('roost-worker-319: $9.75')
      expect(rep.out).toContain('opus-4-7:')
      expect(rep.out).toContain('($7.50)')
      expect(rep.out).toContain('sonnet-4-6:')
      expect(rep.out).toContain('($2.25)')
      // Wall: 10:00 → 10:30 = 30m. API: 60+30 = 90s = 1m30s.
      expect(rep.out).toContain('1m30s api / 30m00s wall')
    })

    it('unknown model renders $? at totals AND warns once on stderr', async () => {
      const d = join(projects, '-p')
      await mkdir(d, { recursive: true })
      await writeSessionFile(d, 's.jsonl', 'roost-x', [
        { ts: '2026-05-16T10:00:00Z', model: 'claude-mystery-9-0', input: 100, output: 100 },
        { ts: '2026-05-16T10:01:00Z', model: 'claude-opus-4-7', input: 1000, output: 500 },
      ])
      const rep = await capture(() => main(['report', stateDir, '319', 'roost-x']))
      // Mystery model → null → total bubbles to $?.
      expect(rep.out).toContain('roost-x: $?')
      // Per-model lines: opus has $; mystery has $?.
      expect(rep.out).toMatch(/mystery-9-0:.*\$\?/)
      // Opus 4.7: 1000 × $5 + 500 × $25 = 5000 + 12500 = 17500 / 1M = $0.0175 → $0.02
      expect(rep.out).toMatch(/opus-4-7:.*\$0\.02/)
      expect(rep.err).toContain('no pricing for model(s): claude-mystery-9-0')
      expect(rep.err).toContain('add to src/pricing.ts')
    })

    it('exits non-zero when any nick matches zero session files', async () => {
      const d = join(projects, '-p')
      await mkdir(d, { recursive: true })
      await writeSessionFile(d, 's.jsonl', 'roost-lead-pm', [{ ts: '2026-05-16T10:00:00Z', model: 'claude-opus-4-7', input: 5, output: 5 }])
      const rep = await capture(() => main(['report', stateDir, '999', 'roost-lead-pm', 'roost-ghost']))
      expect(rep.result).toBe(1)
      expect(rep.err).toContain('roost-ghost')
    })

    it('snapshot rejects nicks with no transcripts (loud baseline failure)', async () => {
      const rep = await capture(() => main(['snapshot', stateDir, '999', 'roost-ghost']))
      expect(rep.result).toBe(1)
      expect(rep.err).toContain('roost-ghost')
    })

    it('rejects non-numeric issue arg', async () => {
      const rep = await capture(() => main(['report', stateDir, 'PR-12', 'whatever']))
      expect(rep.result).toBe(2)
      expect(rep.err).toContain('numeric')
    })

    it('snapshot for a second issue preserves the first entry', async () => {
      const d = join(projects, '-p')
      await mkdir(d, { recursive: true })
      await writeSessionFile(d, 'a.jsonl', 'roost-lead-pm', [{ ts: '2026-05-16T10:00:00Z', model: 'claude-opus-4-7', input: 10, output: 5 }])
      await writeSessionFile(d, 'b.jsonl', 'roost-apm', [{ ts: '2026-05-16T10:00:00Z', model: 'claude-sonnet-4-6', input: 10, output: 5 }])
      await capture(() => main(['snapshot', stateDir, '319', 'roost-lead-pm', 'roost-apm']))
      await capture(() => main(['snapshot', stateDir, '320', 'roost-lead-pm']))
      const snap = JSON.parse(await readFile(join(stateDir, 'token-snapshots.json'), 'utf8')) as Record<string, Record<string, { snapshot_at: string }>>
      expect(snap['319']?.['roost-lead-pm']?.snapshot_at).toBeTruthy()
      expect(snap['319']?.['roost-apm']?.snapshot_at).toBeTruthy()
      expect(snap['320']?.['roost-lead-pm']?.snapshot_at).toBeTruthy()
      expect(snap['320']?.['roost-apm']).toBeUndefined()
    })

    it('one report invocation prints multi-line output per nick for 4 nicks', async () => {
      const d = join(projects, '-p')
      await mkdir(d, { recursive: true })
      await writeSessionFile(d, 'w.jsonl', 'roost-worker-42', [{ ts: '2026-05-16T10:00:00Z', model: 'claude-sonnet-4-6', input: 100, output: 10, apiDurationMs: 500 }])
      await writeSessionFile(d, 'r.jsonl', 'roost-reviewer-42', [{ ts: '2026-05-16T10:00:00Z', model: 'claude-opus-4-7', input: 50, output: 5, apiDurationMs: 300 }])
      await writeSessionFile(d, 'l.jsonl', 'roost-lead-pm', [{ ts: '2026-05-16T10:00:00Z', model: 'claude-opus-4-7', input: 1000, output: 500, apiDurationMs: 5000 }])
      await writeSessionFile(d, 'a.jsonl', 'roost-apm', [{ ts: '2026-05-16T10:00:00Z', model: 'claude-sonnet-4-6', input: 200, output: 100, apiDurationMs: 1000 }])
      await capture(() => main(['snapshot', stateDir, '42', 'roost-lead-pm', 'roost-apm']))
      const rep = await capture(() => main([
        'report', stateDir, '42',
        'roost-worker-42', 'roost-reviewer-42', 'roost-lead-pm', 'roost-apm',
      ]))
      expect(rep.result).toBe(0)
      // Each nick produces a head line + at least one model sub-line.
      // 4 nicks: 2 with model data (worker, reviewer — pre-snapshot for them
      // doesn't apply since they had no snapshot), 2 without (lead/apm have
      // a snapshot but no post-snapshot activity).
      expect(rep.out).toContain('roost-worker-42:')
      expect(rep.out).toContain('roost-reviewer-42:')
      expect(rep.out).toContain('roost-lead-pm: $0.00')
      expect(rep.out).toContain('roost-apm: $0.00')
      expect(rep.out).toContain('(no in-window activity)')
    })
  })
})
