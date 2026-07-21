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
  // Optional requestId on the assistant row — repeating it across turns
  // simulates Claude Code's "one assistant row per content block, all
  // sharing the parent API call's usage" pattern.
  requestId?: string
  // Optional uuid on the system/turn_duration row — repeating across files
  // simulates a forked/resumed transcript.
  turnUuid?: string
  // If true, mark the assistant row (and any paired turn_duration row)
  // with isSidechain:true.
  sidechain?: boolean
  // Optional cache miss reason — writes message.diagnostics.cache_miss_reason.
  cacheMissReason?: { type: string; cache_missed_input_tokens: number }
}

// A compact_boundary marker that auto-compaction writes into the JSONL.
// We dedup by uuid across files — same as turn_duration rows.
interface CompactBoundary {
  ts: string
  uuid?: string
  preTokens: number
  postTokens: number
  durationMs: number
}

function compactBoundaryRow(c: CompactBoundary): string {
  const row: Record<string, unknown> = {
    type: 'system',
    subtype: 'compact_boundary',
    timestamp: c.ts,
    compactMetadata: {
      trigger: 'auto',
      preTokens: c.preTokens,
      postTokens: c.postTokens,
      durationMs: c.durationMs,
    },
  }
  if (c.uuid) row.uuid = c.uuid
  return JSON.stringify(row)
}

// Render one Turn into the (up to two) JSONL rows Claude Code emits:
// an `assistant` row carrying the usage block, and — when apiDurationMs
// is set — a `system/turn_duration` companion. `forceSidechain` stamps
// `isSidechain:true` on both rows regardless of `turn.sidechain` (used
// by the subagent-file builder where every row is a sidechain row).
function turnRows(t: Turn, forceSidechain = false): string[] {
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
  const sidechain = forceSidechain || t.sidechain === true
  const msg: Record<string, unknown> = { role: 'assistant', model: t.model, usage }
  if (t.cacheMissReason) msg.diagnostics = { cache_miss_reason: t.cacheMissReason }
  const assist: Record<string, unknown> = {
    type: 'assistant',
    timestamp: t.ts,
    message: msg,
  }
  if (t.requestId) assist.requestId = t.requestId
  if (sidechain) assist.isSidechain = true
  const out = [JSON.stringify(assist)]
  if (typeof t.apiDurationMs === 'number') {
    const dur: Record<string, unknown> = {
      type: 'system',
      subtype: 'turn_duration',
      durationMs: t.apiDurationMs,
      timestamp: t.ts,
    }
    if (t.turnUuid) dur.uuid = t.turnUuid
    if (sidechain) dur.isSidechain = true
    out.push(JSON.stringify(dur))
  }
  return out
}

// Build a session JSONL containing the MCP banner for `nick` followed by the
// given assistant turns (and an optional per-turn `system/turn_duration`
// row using the same ts). Returns the written file path. Extra rows
// (e.g. compact_boundary) get appended after the turns.
async function writeSessionFile(
  dir: string,
  filename: string,
  nick: string,
  turns: Turn[],
  extras: { compactBoundaries?: CompactBoundary[] } = {},
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
  for (const t of turns) lines.push(...turnRows(t))
  for (const c of extras.compactBoundaries ?? []) lines.push(compactBoundaryRow(c))
  const path = join(dir, filename)
  await writeFile(path, lines.join('\n') + '\n')
  return path
}

// Build a subagent JSONL at `<parentFile-without-.jsonl>/subagents/agent-<id>.jsonl`.
// No MCP banner — Claude Code only writes the banner into parent
// transcripts. All rows are marked isSidechain:true to match real shape.
async function writeSubagentFile(
  parentFile: string,
  agentId: string,
  turns: Turn[],
): Promise<string> {
  if (!parentFile.endsWith('.jsonl')) throw new Error('parentFile must end with .jsonl')
  const dir = join(parentFile.slice(0, -'.jsonl'.length), 'subagents')
  await mkdir(dir, { recursive: true })
  const lines: string[] = []
  for (const t of turns) lines.push(...turnRows(t, true))
  const path = join(dir, `agent-${agentId}.jsonl`)
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
      expect(r.transcripts).toBe(2)
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
      expect(r.transcripts).toBe(0)
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
      expect(r.transcripts).toBe(1)
    })

    it('sinceTs filter excludes pre-window turns', async () => {
      const d = join(projects, '-p')
      await mkdir(d, { recursive: true })
      await writeSessionFile(d, 's.jsonl', 'roost-pm', [
        { ts: '2026-05-16T09:00:00Z', model: 'claude-opus-4-7', input: 1000, output: 500, apiDurationMs: 10_000 },
        { ts: '2026-05-16T11:00:00Z', model: 'claude-opus-4-7', input: 50, output: 25, apiDurationMs: 2_000 },
      ])
      const r = await collectForNick('roost-pm', projects, '2026-05-16T10:00:00Z')
      const opus = r.byModel.get('claude-opus-4-7')!
      expect(opus.input).toBe(50)
      expect(opus.output).toBe(25)
      expect(r.apiDurationMs).toBe(2_000)
      expect(r.transcripts).toBe(1)
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

    it('dedups assistant rows with the same requestId (multi-part response)', async () => {
      const d = join(projects, '-p')
      await mkdir(d, { recursive: true })
      // Three assistant rows under the same requestId — Claude Code writes
      // one row per content block (text, tool_use, tool_use) and each
      // repeats the parent API call's usage block verbatim.
      await writeSessionFile(d, 's.jsonl', 'roost-x', [
        { ts: '2026-05-16T10:00:00Z', model: 'claude-opus-4-7', input: 10, output: 100, cache_w_5m: 1000, cache_r: 50000, requestId: 'req_A' },
        { ts: '2026-05-16T10:00:01Z', model: 'claude-opus-4-7', input: 10, output: 100, cache_w_5m: 1000, cache_r: 50000, requestId: 'req_A' },
        { ts: '2026-05-16T10:00:02Z', model: 'claude-opus-4-7', input: 10, output: 100, cache_w_5m: 1000, cache_r: 50000, requestId: 'req_A' },
        // A genuinely new call must still count.
        { ts: '2026-05-16T10:01:00Z', model: 'claude-opus-4-7', input: 5, output: 50, cache_w_5m: 500, cache_r: 25000, requestId: 'req_B' },
      ])
      const r = await collectForNick('roost-x', projects)
      const opus = r.byModel.get('claude-opus-4-7')!
      expect(opus.input).toBe(15)
      expect(opus.output).toBe(150)
      expect(opus.cache_creation_5m).toBe(1500)
      expect(opus.cache_read).toBe(75000)
    })

    it('rows without requestId are not collapsed (older shapes count as today)', async () => {
      const d = join(projects, '-p')
      await mkdir(d, { recursive: true })
      // No requestId at all → each row counts independently.
      await writeSessionFile(d, 's.jsonl', 'roost-x', [
        { ts: '2026-05-16T10:00:00Z', model: 'claude-opus-4-7', input: 7, output: 3 },
        { ts: '2026-05-16T10:00:01Z', model: 'claude-opus-4-7', input: 7, output: 3 },
      ])
      const r = await collectForNick('roost-x', projects)
      const opus = r.byModel.get('claude-opus-4-7')!
      expect(opus.input).toBe(14)
      expect(opus.output).toBe(6)
    })

    it('dedups requestId across files (forked/resumed transcripts)', async () => {
      const d = join(projects, '-p')
      await mkdir(d, { recursive: true })
      const turn = { ts: '2026-05-16T10:00:00Z', model: 'claude-opus-4-7', input: 10, output: 100, cache_r: 5000, requestId: 'req_shared' }
      await writeSessionFile(d, 'fork-a.jsonl', 'roost-x', [turn])
      await writeSessionFile(d, 'fork-b.jsonl', 'roost-x', [turn])
      const r = await collectForNick('roost-x', projects)
      const opus = r.byModel.get('claude-opus-4-7')!
      // Same requestId in two files → counted once.
      expect(opus.input).toBe(10)
      expect(opus.output).toBe(100)
      expect(opus.cache_read).toBe(5000)
    })

    it('skips sidechain (subagent) assistant rows entirely', async () => {
      const d = join(projects, '-p')
      await mkdir(d, { recursive: true })
      await writeSessionFile(d, 's.jsonl', 'roost-x', [
        { ts: '2026-05-16T10:00:00Z', model: 'claude-opus-4-7', input: 10, output: 5, apiDurationMs: 1000, requestId: 'req_main' },
        { ts: '2026-05-16T10:00:30Z', model: 'claude-opus-4-7', input: 999, output: 999, cache_w_5m: 99999, apiDurationMs: 5000, requestId: 'req_sub', sidechain: true },
      ])
      const r = await collectForNick('roost-x', projects)
      const opus = r.byModel.get('claude-opus-4-7')!
      // Only the main-thread row contributes.
      expect(opus.input).toBe(10)
      expect(opus.output).toBe(5)
      expect(opus.cache_creation_5m).toBe(0)
      // Sidechain turn_duration is also skipped.
      expect(r.apiDurationMs).toBe(1000)
    })

    it('dedups turn_duration rows by uuid across files', async () => {
      const d = join(projects, '-p')
      await mkdir(d, { recursive: true })
      const turn = { ts: '2026-05-16T10:00:00Z', model: 'claude-opus-4-7', input: 1, output: 1, requestId: 'req_x', apiDurationMs: 4000, turnUuid: 'turn_shared' }
      await writeSessionFile(d, 'fork-a.jsonl', 'roost-x', [turn])
      await writeSessionFile(d, 'fork-b.jsonl', 'roost-x', [turn])
      const r = await collectForNick('roost-x', projects)
      // Counted once, not twice.
      expect(r.apiDurationMs).toBe(4000)
    })

    it('bills subagent transcripts under a matched parent to the parent nick', async () => {
      const d = join(projects, '-p')
      await mkdir(d, { recursive: true })
      const parent = await writeSessionFile(d, 'session.jsonl', 'roost-worker-99', [
        { ts: '2026-05-16T10:00:00Z', model: 'claude-opus-4-7', input: 100, output: 50, apiDurationMs: 2000 },
      ])
      await writeSubagentFile(parent, 'aaa1111111111111a', [
        { ts: '2026-05-16T10:01:00Z', model: 'claude-haiku-4-5-20251001', input: 200, output: 75, apiDurationMs: 800 },
        { ts: '2026-05-16T10:02:00Z', model: 'claude-haiku-4-5-20251001', input: 50, output: 25, apiDurationMs: 400 },
      ])
      const r = await collectForNick('roost-worker-99', projects)
      // Parent nick gets the haiku usage from the subagent.
      const opus = r.byModel.get('claude-opus-4-7')!
      const haiku = r.byModel.get('claude-haiku-4-5-20251001')!
      expect(opus.input).toBe(100)
      expect(haiku.input).toBe(250)
      expect(haiku.output).toBe(100)
      expect(r.apiDurationMs).toBe(3200)
      // sessions counts parent + the contributing subagent file.
      expect(r.transcripts).toBe(2)
      expect(r.files).toHaveLength(2)
      // Wall extends across both.
      expect(r.wallFirst).toBe('2026-05-16T10:00:00Z')
      expect(r.wallLast).toBe('2026-05-16T10:02:00Z')
    })

    it('subagents under an unmatched parent (different nick) do not count', async () => {
      const d = join(projects, '-p')
      await mkdir(d, { recursive: true })
      const ourParent = await writeSessionFile(d, 'ours.jsonl', 'roost-worker-99', [
        { ts: '2026-05-16T10:00:00Z', model: 'claude-opus-4-7', input: 10, output: 5 },
      ])
      const theirParent = await writeSessionFile(d, 'theirs.jsonl', 'roost-worker-100', [
        { ts: '2026-05-16T10:00:00Z', model: 'claude-opus-4-7', input: 999, output: 999 },
      ])
      // Our subagent: should count.
      await writeSubagentFile(ourParent, 'aaa1111111111111a', [
        { ts: '2026-05-16T10:01:00Z', model: 'claude-haiku-4-5-20251001', input: 7, output: 3 },
      ])
      // Their subagent: must NOT bill to us.
      await writeSubagentFile(theirParent, 'aaa2222222222222a', [
        { ts: '2026-05-16T10:01:00Z', model: 'claude-haiku-4-5-20251001', input: 9999, output: 9999 },
      ])
      const r = await collectForNick('roost-worker-99', projects)
      const haiku = r.byModel.get('claude-haiku-4-5-20251001')!
      expect(haiku.input).toBe(7)
      expect(haiku.output).toBe(3)
    })

    it('still skips inline sidechain rows in the parent (no double-count with subagent file)', async () => {
      const d = join(projects, '-p')
      await mkdir(d, { recursive: true })
      const parent = await writeSessionFile(d, 's.jsonl', 'roost-x', [
        { ts: '2026-05-16T10:00:00Z', model: 'claude-opus-4-7', input: 10, output: 5, apiDurationMs: 1000, requestId: 'req_main' },
        // Defensive: an inline sidechain row in the *parent* file gets skipped.
        { ts: '2026-05-16T10:00:30Z', model: 'claude-haiku-4-5-20251001', input: 999, output: 999, requestId: 'req_inline_sub', sidechain: true },
      ])
      // Authoritative copy of the same call in the proper subagent file — counts.
      await writeSubagentFile(parent, 'aaa3333333333333a', [
        { ts: '2026-05-16T10:00:30Z', model: 'claude-haiku-4-5-20251001', input: 8, output: 4, requestId: 'req_inline_sub' },
      ])
      const r = await collectForNick('roost-x', projects)
      const haiku = r.byModel.get('claude-haiku-4-5-20251001')!
      // Inline parent copy skipped, subagent copy counted once.
      expect(haiku.input).toBe(8)
      expect(haiku.output).toBe(4)
    })

    it('cross-file requestId dedup spans parent and subagent', async () => {
      const d = join(projects, '-p')
      await mkdir(d, { recursive: true })
      const parent = await writeSessionFile(d, 's.jsonl', 'roost-x', [
        { ts: '2026-05-16T10:00:00Z', model: 'claude-opus-4-7', input: 50, output: 25, requestId: 'req_shared' },
      ])
      // Same requestId shows up in the subagent file — pathological, but the
      // shared seen-set should keep it from double-counting.
      await writeSubagentFile(parent, 'aaa4444444444444a', [
        { ts: '2026-05-16T10:00:30Z', model: 'claude-opus-4-7', input: 50, output: 25, requestId: 'req_shared' },
      ])
      const r = await collectForNick('roost-x', projects)
      const opus = r.byModel.get('claude-opus-4-7')!
      expect(opus.input).toBe(50)
      expect(opus.output).toBe(25)
    })

    it('sinceTs filter applies to subagent rows the same as parent rows', async () => {
      const d = join(projects, '-p')
      await mkdir(d, { recursive: true })
      const parent = await writeSessionFile(d, 's.jsonl', 'roost-pm', [
        { ts: '2026-05-16T09:00:00Z', model: 'claude-opus-4-7', input: 1000, output: 500, apiDurationMs: 10_000 },
      ])
      await writeSubagentFile(parent, 'aaa5555555555555a', [
        // Pre-window subagent turn — must NOT count.
        { ts: '2026-05-16T09:30:00Z', model: 'claude-haiku-4-5-20251001', input: 1_000_000, output: 1_000_000, apiDurationMs: 99_999 },
        // Post-window subagent turn — counts.
        { ts: '2026-05-16T11:00:00Z', model: 'claude-haiku-4-5-20251001', input: 11, output: 22, apiDurationMs: 333 },
      ])
      const r = await collectForNick('roost-pm', projects, '2026-05-16T10:00:00Z')
      // Parent pre-window turn excluded, only post-window subagent turn counts.
      expect(r.byModel.get('claude-opus-4-7')).toBeUndefined()
      const haiku = r.byModel.get('claude-haiku-4-5-20251001')!
      expect(haiku.input).toBe(11)
      expect(haiku.output).toBe(22)
      expect(r.apiDurationMs).toBe(333)
    })

    it('parses cache_miss_reason from assistant row', async () => {
      const d = join(projects, '-p')
      await mkdir(d, { recursive: true })
      // No cache_w → creation total = 0 → falls back to all 5m tier.
      await writeSessionFile(d, 's.jsonl', 'roost-x', [
        { ts: '2026-05-16T10:00:00Z', model: 'claude-opus-4-7', input: 10, output: 5,
          cacheMissReason: { type: 'tools_changed', cache_missed_input_tokens: 16_200 } },
      ])
      const r = await collectForNick('roost-x', projects)
      const entry = r.missByModel.get('claude-opus-4-7')!.get('tools_changed')!
      expect(entry.tokens5m + entry.tokens1h).toBe(16_200)
      expect(entry.tokens5m).toBe(16_200)
      expect(entry.tokens1h).toBe(0)
    })

    it('dedups miss data by requestId — same API call counted once', async () => {
      const d = join(projects, '-p')
      await mkdir(d, { recursive: true })
      // Two rows sharing a requestId (multi-part response) — miss should count once.
      await writeSessionFile(d, 's.jsonl', 'roost-x', [
        { ts: '2026-05-16T10:00:00Z', model: 'claude-opus-4-7', input: 10, output: 5, requestId: 'req_A',
          cacheMissReason: { type: 'system_changed', cache_missed_input_tokens: 50_000 } },
        { ts: '2026-05-16T10:00:01Z', model: 'claude-opus-4-7', input: 10, output: 5, requestId: 'req_A',
          cacheMissReason: { type: 'system_changed', cache_missed_input_tokens: 50_000 } },
      ])
      const r = await collectForNick('roost-x', projects)
      const entry = r.missByModel.get('claude-opus-4-7')!.get('system_changed')!
      expect(entry.tokens5m + entry.tokens1h).toBe(50_000)
    })

    it('accumulates miss tokens across multiple calls with different reasons', async () => {
      const d = join(projects, '-p')
      await mkdir(d, { recursive: true })
      await writeSessionFile(d, 's.jsonl', 'roost-x', [
        { ts: '2026-05-16T10:00:00Z', model: 'claude-opus-4-7', input: 10, output: 5, requestId: 'req_1',
          cacheMissReason: { type: 'tools_changed', cache_missed_input_tokens: 16_000 } },
        { ts: '2026-05-16T10:01:00Z', model: 'claude-opus-4-7', input: 10, output: 5, requestId: 'req_2',
          cacheMissReason: { type: 'system_changed', cache_missed_input_tokens: 112_000 } },
        { ts: '2026-05-16T10:02:00Z', model: 'claude-opus-4-7', input: 10, output: 5, requestId: 'req_3',
          cacheMissReason: { type: 'tools_changed', cache_missed_input_tokens: 8_000 } },
      ])
      const r = await collectForNick('roost-x', projects)
      const miss = r.missByModel.get('claude-opus-4-7')!
      const tc = miss.get('tools_changed')!
      expect(tc.tokens5m + tc.tokens1h).toBe(24_000)
      const sc = miss.get('system_changed')!
      expect(sc.tokens5m + sc.tokens1h).toBe(112_000)
    })

    it('miss data from subagent files flows to parent nick report', async () => {
      const d = join(projects, '-p')
      await mkdir(d, { recursive: true })
      const parent = await writeSessionFile(d, 's.jsonl', 'roost-x', [
        { ts: '2026-05-16T10:00:00Z', model: 'claude-opus-4-7', input: 10, output: 5, requestId: 'req_parent',
          cacheMissReason: { type: 'tools_changed', cache_missed_input_tokens: 5_000 } },
      ])
      await writeSubagentFile(parent, 'aaa6666666666666a', [
        { ts: '2026-05-16T10:01:00Z', model: 'claude-haiku-4-5-20251001', input: 8, output: 4, requestId: 'req_sub',
          cacheMissReason: { type: 'messages_changed', cache_missed_input_tokens: 3_000 } },
      ])
      const r = await collectForNick('roost-x', projects)
      const opusEntry = r.missByModel.get('claude-opus-4-7')!.get('tools_changed')!
      expect(opusEntry.tokens5m + opusEntry.tokens1h).toBe(5_000)
      const haikuEntry = r.missByModel.get('claude-haiku-4-5-20251001')!.get('messages_changed')!
      expect(haikuEntry.tokens5m + haikuEntry.tokens1h).toBe(3_000)
    })

    it('no miss entry when diagnostics field is absent', async () => {
      const d = join(projects, '-p')
      await mkdir(d, { recursive: true })
      await writeSessionFile(d, 's.jsonl', 'roost-x', [
        { ts: '2026-05-16T10:00:00Z', model: 'claude-opus-4-7', input: 10, output: 5 },
      ])
      const r = await collectForNick('roost-x', projects)
      expect(r.missByModel.size).toBe(0)
    })

    it('aggregates compact_boundary markers into compactions stats', async () => {
      const d = join(projects, '-p')
      await mkdir(d, { recursive: true })
      await writeSessionFile(d, 's.jsonl', 'roost-x', [
        { ts: '2026-05-16T10:00:00Z', model: 'claude-opus-4-7', input: 1, output: 1 },
      ], {
        compactBoundaries: [
          { ts: '2026-05-16T10:30:00Z', uuid: 'compact_1', preTokens: 200_000, postTokens: 10_000, durationMs: 90_000 },
          { ts: '2026-05-16T11:30:00Z', uuid: 'compact_2', preTokens: 150_000, postTokens: 8_000, durationMs: 60_000 },
        ],
      })
      const r = await collectForNick('roost-x', projects)
      expect(r.compactions.count).toBe(2)
      expect(r.compactions.preTokens).toBe(350_000)
      expect(r.compactions.postTokens).toBe(18_000)
      expect(r.compactions.durationMs).toBe(150_000)
    })

    it('dedups compact_boundary rows by uuid across forked transcripts', async () => {
      const d = join(projects, '-p')
      await mkdir(d, { recursive: true })
      const shared: CompactBoundary = { ts: '2026-05-16T10:30:00Z', uuid: 'compact_shared', preTokens: 100_000, postTokens: 5_000, durationMs: 50_000 }
      await writeSessionFile(d, 'fork-a.jsonl', 'roost-x', [
        { ts: '2026-05-16T10:00:00Z', model: 'claude-opus-4-7', input: 1, output: 1 },
      ], { compactBoundaries: [shared] })
      await writeSessionFile(d, 'fork-b.jsonl', 'roost-x', [
        { ts: '2026-05-16T10:00:00Z', model: 'claude-opus-4-7', input: 1, output: 1 },
      ], { compactBoundaries: [shared] })
      const r = await collectForNick('roost-x', projects)
      // Counted once, not twice.
      expect(r.compactions.count).toBe(1)
      expect(r.compactions.preTokens).toBe(100_000)
    })

    it('sinceTs excludes pre-window compact_boundary rows', async () => {
      const d = join(projects, '-p')
      await mkdir(d, { recursive: true })
      await writeSessionFile(d, 's.jsonl', 'roost-pm', [
        { ts: '2026-05-16T11:00:00Z', model: 'claude-opus-4-7', input: 5, output: 5 },
      ], {
        compactBoundaries: [
          { ts: '2026-05-16T09:00:00Z', uuid: 'pre', preTokens: 999_000, postTokens: 99_000, durationMs: 99_000 },
          { ts: '2026-05-16T11:30:00Z', uuid: 'post', preTokens: 200_000, postTokens: 10_000, durationMs: 80_000 },
        ],
      })
      const r = await collectForNick('roost-pm', projects, '2026-05-16T10:00:00Z')
      expect(r.compactions.count).toBe(1)
      expect(r.compactions.preTokens).toBe(200_000)
    })

    it('splits miss tokens by creation tier from the same row', async () => {
      const d = join(projects, '-p')
      await mkdir(d, { recursive: true })
      // creation_5m=600k, creation_1h=400k → 60/40 split
      // miss=1M → 600k at 5m premium, 400k at 1h premium
      await writeSessionFile(d, 's.jsonl', 'roost-x', [
        { ts: '2026-05-16T10:00:00Z', model: 'claude-opus-4-7', requestId: 'req_1',
          cache_w_5m: 600_000, cache_w_1h: 400_000,
          cacheMissReason: { type: 'tools_changed', cache_missed_input_tokens: 1_000_000 } },
      ])
      const r = await collectForNick('roost-x', projects)
      const entry = r.missByModel.get('claude-opus-4-7')!.get('tools_changed')!
      expect(entry.tokens5m).toBeCloseTo(600_000)
      expect(entry.tokens1h).toBeCloseTo(400_000)
    })
  })

  describe('main: snapshot + report', () => {
    it('snapshot records timestamp only; report after no chatter shows no in-window activity', async () => {
      const d = join(projects, '-p')
      await mkdir(d, { recursive: true })
      await writeSessionFile(d, 's.jsonl', 'roost-pm', [
        { ts: '2026-05-16T09:00:00Z', model: 'claude-opus-4-7', input: 100, output: 50, apiDurationMs: 5000 },
      ])
      const snap = await capture(() => main(['snapshot', stateDir, '319', 'roost-pm']))
      expect(snap.result).toBe(0)
      const snapFile = JSON.parse(await readFile(join(stateDir, 'token-snapshots.json'), 'utf8')) as Record<string, Record<string, { snapshot_at: string }>>
      expect(snapFile['319']['roost-pm'].snapshot_at).toBeTruthy()

      const rep = await capture(() => main(['report', stateDir, '319', 'roost-pm']))
      expect(rep.result).toBe(0)
      expect(rep.out).toContain('roost-pm: $0.00 · 0s api / 0s wall')
      expect(rep.out).toContain('(no in-window activity)')
    })

    it('report after new turns shows only the post-snapshot delta', async () => {
      const d = join(projects, '-p')
      await mkdir(d, { recursive: true })
      const path = await writeSessionFile(d, 's.jsonl', 'roost-pm', [
        { ts: '2026-05-16T09:00:00Z', model: 'claude-opus-4-7', input: 1_000_000, output: 100_000, apiDurationMs: 60_000 },
      ])
      const snap = await capture(() => main(['snapshot', stateDir, '319', 'roost-pm']))
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

      const rep = await capture(() => main(['report', stateDir, '319', 'roost-pm']))
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

    it('per-model line shows cache_w_5m and cache_w_1h as separate columns', async () => {
      const d = join(projects, '-p')
      await mkdir(d, { recursive: true })
      await writeSessionFile(d, 's.jsonl', 'roost-x', [
        { ts: '2026-05-16T10:00:00Z', model: 'claude-opus-4-7', input: 1, output: 1, cache_w_5m: 1234, cache_w_1h: 5678 },
      ])
      const rep = await capture(() => main(['report', stateDir, '319', 'roost-x']))
      // Two distinct columns, both labeled — locks the format alex asked for.
      expect(rep.out).toMatch(/1\.2k cache_w_5m \/ 5\.7k cache_w_1h/)
      expect(rep.out).not.toContain(' cache_w ')
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

    it('dated model id (Claude Code snapshot form) prices via the bare-alias fallback, not $?', async () => {
      const d = join(projects, '-p')
      await mkdir(d, { recursive: true })
      await writeSessionFile(d, 's.jsonl', 'roost-x', [
        { ts: '2026-05-16T10:00:00Z', model: 'claude-opus-4-8-20260615', input: 1000, output: 500 },
      ])
      const rep = await capture(() => main(['report', stateDir, '319', 'roost-x']))
      // Opus 4.8: 1000 × $5 + 500 × $25 = 5000 + 12500 = 17500 / 1M = $0.0175 → $0.02
      expect(rep.out).toContain('roost-x: $0.02')
      expect(rep.out).toMatch(/opus-4-8-20260615:.*\$0\.02/)
      expect(rep.err).toBe('')
    })

    it('exits non-zero when any nick matches zero session files', async () => {
      const d = join(projects, '-p')
      await mkdir(d, { recursive: true })
      await writeSessionFile(d, 's.jsonl', 'roost-pm', [{ ts: '2026-05-16T10:00:00Z', model: 'claude-opus-4-7', input: 5, output: 5 }])
      const rep = await capture(() => main(['report', stateDir, '999', 'roost-pm', 'roost-ghost']))
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
      await writeSessionFile(d, 'a.jsonl', 'roost-pm', [{ ts: '2026-05-16T10:00:00Z', model: 'claude-opus-4-7', input: 10, output: 5 }])
      await writeSessionFile(d, 'b.jsonl', 'roost-apm', [{ ts: '2026-05-16T10:00:00Z', model: 'claude-sonnet-4-6', input: 10, output: 5 }])
      await capture(() => main(['snapshot', stateDir, '319', 'roost-pm', 'roost-apm']))
      await capture(() => main(['snapshot', stateDir, '320', 'roost-pm']))
      const snap = JSON.parse(await readFile(join(stateDir, 'token-snapshots.json'), 'utf8')) as Record<string, Record<string, { snapshot_at: string }>>
      expect(snap['319']?.['roost-pm']?.snapshot_at).toBeTruthy()
      expect(snap['319']?.['roost-apm']?.snapshot_at).toBeTruthy()
      expect(snap['320']?.['roost-pm']?.snapshot_at).toBeTruthy()
      expect(snap['320']?.['roost-apm']).toBeUndefined()
    })

    it('one report invocation prints multi-line output per nick for 4 nicks', async () => {
      const d = join(projects, '-p')
      await mkdir(d, { recursive: true })
      await writeSessionFile(d, 'w.jsonl', 'roost-worker-42', [{ ts: '2026-05-16T10:00:00Z', model: 'claude-sonnet-4-6', input: 100, output: 10, apiDurationMs: 500 }])
      await writeSessionFile(d, 'r.jsonl', 'roost-reviewer-42', [{ ts: '2026-05-16T10:00:00Z', model: 'claude-opus-4-7', input: 50, output: 5, apiDurationMs: 300 }])
      await writeSessionFile(d, 'l.jsonl', 'roost-pm', [{ ts: '2026-05-16T10:00:00Z', model: 'claude-opus-4-7', input: 1000, output: 500, apiDurationMs: 5000 }])
      await writeSessionFile(d, 'a.jsonl', 'roost-apm', [{ ts: '2026-05-16T10:00:00Z', model: 'claude-sonnet-4-6', input: 200, output: 100, apiDurationMs: 1000 }])
      await capture(() => main(['snapshot', stateDir, '42', 'roost-pm', 'roost-apm']))
      const rep = await capture(() => main([
        'report', stateDir, '42',
        'roost-worker-42', 'roost-reviewer-42', 'roost-pm', 'roost-apm',
      ]))
      expect(rep.result).toBe(0)
      // Each nick produces a head line + at least one model sub-line.
      // 4 nicks: 2 with model data (worker, reviewer — pre-snapshot for them
      // doesn't apply since they had no snapshot), 2 without (lead/apm have
      // a snapshot but no post-snapshot activity).
      expect(rep.out).toContain('roost-worker-42:')
      expect(rep.out).toContain('roost-reviewer-42:')
      expect(rep.out).toContain('roost-pm: $0.00')
      expect(rep.out).toContain('roost-apm: $0.00')
      expect(rep.out).toContain('(no in-window activity)')
    })

    it('shows miss cost in per-model line and header when nonzero', async () => {
      const d = join(projects, '-p')
      await mkdir(d, { recursive: true })
      // tools_changed miss: 1M tokens at 1h creation tier (realistic — real data shows 1h)
      // opus-4-7 1h miss premium = ($10 - $0.50)/M = $9.50/M → 1M × $9.50/M = $9.50
      await writeSessionFile(d, 's.jsonl', 'roost-x', [
        { ts: '2026-05-16T10:00:00Z', model: 'claude-opus-4-7', input: 1, output: 1, requestId: 'req_1',
          cache_w_1h: 1_000_000,
          cacheMissReason: { type: 'tools_changed', cache_missed_input_tokens: 1_000_000 } },
      ])
      const rep = await capture(() => main(['report', stateDir, '339', 'roost-x']))
      expect(rep.result).toBe(0)
      // Header shows total miss cost
      expect(rep.out).toContain('$9.50 miss')
      // Per-model line shows miss breakdown
      expect(rep.out).toMatch(/opus-4-7:.*miss: 1\.0M \(\$9\.50\) \[tools_changed 1\.0M \(\$9\.50\)\]/)
    })

    it('omits miss from header and per-model line when no cache misses', async () => {
      const d = join(projects, '-p')
      await mkdir(d, { recursive: true })
      await writeSessionFile(d, 's.jsonl', 'roost-x', [
        { ts: '2026-05-16T10:00:00Z', model: 'claude-opus-4-7', input: 10, output: 5 },
      ])
      const rep = await capture(() => main(['report', stateDir, '339', 'roost-x']))
      expect(rep.result).toBe(0)
      expect(rep.out).not.toContain('miss')
    })

    it('report renders compaction line when nick has compact_boundary rows', async () => {
      const d = join(projects, '-p')
      await mkdir(d, { recursive: true })
      await writeSessionFile(d, 's.jsonl', 'roost-pm', [
        { ts: '2026-05-16T10:00:00Z', model: 'claude-opus-4-7', input: 100, output: 50, apiDurationMs: 5000 },
      ], {
        compactBoundaries: [
          { ts: '2026-05-16T10:30:00Z', uuid: 'c1', preTokens: 268_000, postTokens: 12_000, durationMs: 131_000 },
        ],
      })
      const rep = await capture(() => main(['report', stateDir, '334', 'roost-pm']))
      expect(rep.result).toBe(0)
      expect(rep.out).toContain('compaction: 1× (pre 268k → post 12k, 2m11s; call cost not captured)')
    })

    it('report omits compaction line when nick has no compactions', async () => {
      const d = join(projects, '-p')
      await mkdir(d, { recursive: true })
      await writeSessionFile(d, 's.jsonl', 'roost-x', [
        { ts: '2026-05-16T10:00:00Z', model: 'claude-opus-4-7', input: 10, output: 5 },
      ])
      const rep = await capture(() => main(['report', stateDir, '334', 'roost-x']))
      expect(rep.out).not.toContain('compaction')
    })

    it('miss costs are summed across sessions and reasons per nick', async () => {
      const a = join(projects, '-pa')
      const b = join(projects, '-pb')
      await mkdir(a, { recursive: true })
      await mkdir(b, { recursive: true })
      // Session A: tools_changed 500k tokens → $5.75/M × 500k = $2.875
      await writeSessionFile(a, 's1.jsonl', 'roost-pm', [
        { ts: '2026-05-16T10:00:00Z', model: 'claude-opus-4-7', input: 1, output: 1, requestId: 'req_A',
          cacheMissReason: { type: 'tools_changed', cache_missed_input_tokens: 500_000 } },
      ])
      // Session B: system_changed 200k tokens → $5.75/M × 200k = $1.15
      await writeSessionFile(b, 's2.jsonl', 'roost-pm', [
        { ts: '2026-05-16T11:00:00Z', model: 'claude-opus-4-7', input: 1, output: 1, requestId: 'req_B',
          cacheMissReason: { type: 'system_changed', cache_missed_input_tokens: 200_000 } },
      ])
      const rep = await capture(() => main(['report', stateDir, '339', 'roost-pm']))
      // Total miss: 700k tokens → $5.75/M × 700k = $4.025 → $4.03 (rounding)
      expect(rep.out).toContain('$4.03 miss')
      // Both reasons appear in the per-model line, system_changed first (larger cost after sorting by tokens)
      expect(rep.out).toContain('tools_changed')
      expect(rep.out).toContain('system_changed')
    })
  })
})
