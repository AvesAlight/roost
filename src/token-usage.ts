#!/usr/bin/env bun
// token-usage — read Claude Code session transcripts and summarize per-nick
// API spend in a format inspired by Claude Code's own `/usage` panel:
//
//   <nick>: $14.38 ($1.42 miss) · 18m57s api / 44m42s wall
//     opus-4-7:    7.4k in / 63.4k out / 17.5M cache_r / 644.6k cache_w  ($14.38, miss: 128.3k ($1.42) [tools_changed 16.2k ($0.18) · system_changed 112.1k ($1.24)])
//     sonnet-4-6:  1.2k in /  2.4k out /  300k cache_r /   8.5k cache_w  ($0.42)
//
// Sessions are matched by the MCP banner produced by src/mcp-banner.ts —
// every roost-spawned session writes `You are connected to IRC as nick
// "<nick>"` into its MCP instructions payload, which lands verbatim (with
// JSON escaping) inside the transcript JSONL.
//
// Subcommands:
//   snapshot <stateDir> <issue> <nick>...
//     Record the current timestamp under <issue> for each <nick> in
//     <stateDir>/token-snapshots.json. Subsequent `report` calls filter
//     transcript turns to those with `timestamp > snapshot_at`, which is
//     how we slice per-issue spend for long-lived agents (lead-pm, APM)
//     out of their cumulative transcript.
//
//   report <stateDir> <issue> <nick>...
//     For each nick: walk all matching session transcripts, sum per-model
//     token usage + API duration (from `system/turn_duration` rows), pull
//     wall duration from the first/last in-scope turn timestamps, and
//     price each model via src/pricing.ts. If a snapshot exists for
//     <issue>+<nick>, only turns with `timestamp > snapshot_at` count;
//     otherwise the full cumulative is reported (which matches per-issue
//     for ephemeral nicks like workers/reviewers that live one issue).
//
// Cost is an estimate — rates in src/pricing.ts may lag Anthropic price
// changes. Unknown model IDs render `$?` and emit a stderr warning rather
// than guessing a rate.
//
// Exits 1 if any requested nick matches zero session transcripts.

import { readFile, mkdir, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { mcpConnectionLine } from './mcp-banner.js'
import { costFor, missCostFor, type UsageCounts } from './pricing.js'

type ModelUsage = UsageCounts
// Per-reason miss token counts split by cache-creation TTL tier. The tier
// is read from the creation block on the same JSONL row that reported the miss.
type MissCounts = { tokens5m: number; tokens1h: number }

// Aggregate of compact_boundary rows for a nick. Each compaction is one
// summarization API call whose own usage block is NOT logged in the JSONL —
// only the pre/post context-size totals and the wall duration are. We surface
// what's available so the gap is visible; we do not synthesize a per-field
// usage from preTokens because the input/cache_r split is unknowable here.
interface CompactionStats { count: number; preTokens: number; postTokens: number; durationMs: number }

interface NickReport {
  byModel: Map<string, ModelUsage>
  // Direct cache miss data from message.diagnostics.cache_miss_reason.
  // Outer key: model ID. Inner key: reason type (tools_changed, system_changed,
  // messages_changed, previous_message_not_found, unavailable).
  // Value: miss token counts split by creation tier (from the same row's cache_creation block).
  missByModel: Map<string, Map<string, MissCounts>>
  apiDurationMs: number
  wallFirst?: string
  wallLast?: string
  // Number of contributing JSONL transcript files (parent + each subagent file
  // counted separately).
  transcripts: number
  unknownModels: Set<string>
  files: string[]
  compactions: CompactionStats
}

interface SnapshotFile {
  // issue number → nick → snapshot record
  [issue: string]: {
    [nick: string]: { snapshot_at: string }
  }
}

function emptyReport(): NickReport {
  return {
    byModel: new Map(),
    missByModel: new Map(),
    apiDurationMs: 0,
    transcripts: 0,
    unknownModels: new Set(),
    files: [],
    compactions: { count: 0, preTokens: 0, postTokens: 0, durationMs: 0 },
  }
}

// Single accumulator for all three UsageCounts merge sites (addToModel,
// mergeUsageMap, and the inline loop in scanFile were all identical).
function addToUsageMap(into: Map<string, UsageCounts>, model: string, u: UsageCounts): void {
  const cur = into.get(model) ?? { input: 0, output: 0, cache_creation_5m: 0, cache_creation_1h: 0, cache_read: 0 }
  cur.input += u.input
  cur.output += u.output
  cur.cache_creation_5m += u.cache_creation_5m
  cur.cache_creation_1h += u.cache_creation_1h
  cur.cache_read += u.cache_read
  into.set(model, cur)
}

function addToMissMap(into: Map<string, Map<string, MissCounts>>, from: Map<string, Map<string, MissCounts>>): void {
  for (const [model, reasons] of from) {
    let intoReasons = into.get(model)
    if (!intoReasons) {
      intoReasons = new Map<string, MissCounts>()
      into.set(model, intoReasons)
    }
    for (const [reason, counts] of reasons) {
      const cur = intoReasons.get(reason) ?? { tokens5m: 0, tokens1h: 0 }
      cur.tokens5m += counts.tokens5m
      cur.tokens1h += counts.tokens1h
      intoReasons.set(reason, cur)
    }
  }
}

function mergeCompactions(into: CompactionStats, from: CompactionStats): void {
  into.count += from.count
  into.preTokens += from.preTokens
  into.postTokens += from.postTokens
  into.durationMs += from.durationMs
}

function trackTs(report: NickReport, ts: string): void {
  if (!report.wallFirst || ts < report.wallFirst) report.wallFirst = ts
  if (!report.wallLast || ts > report.wallLast) report.wallLast = ts
}

async function listSessionFiles(projectsRoot: string): Promise<string[]> {
  const files: string[] = []
  for await (const f of new Bun.Glob('*/*.jsonl').scan({ cwd: projectsRoot, absolute: true })) {
    files.push(f)
  }
  return files
}

// For a parent transcript at `<projectDir>/<sessionId>.jsonl`, subagent
// transcripts live in `<projectDir>/<sessionId>/subagents/agent-*.jsonl`.
// Directory locality is the attribution signal — subagent jsonls don't
// carry the MCP banner (the banner is in the parent's instructions), so
// we don't marker-check them; we bill them to whichever nick the parent
// matched.
async function listSubagentFiles(parentFile: string): Promise<string[]> {
  const ext = '.jsonl'
  if (!parentFile.endsWith(ext)) return []
  const subagentDir = join(parentFile.slice(0, -ext.length), 'subagents')
  const files: string[] = []
  try {
    for await (const f of new Bun.Glob('agent-*.jsonl').scan({ cwd: subagentDir, absolute: true })) {
      files.push(f)
    }
  } catch {
    // No subagent dir for this parent — common case, not an error.
  }
  return files
}

// JSONL stores MCP instructions inside a JSON-encoded string, so the inner
// quotes around the nick are backslash-escaped. JSON.stringify gives us the
// file-form substring (and adds outer quotes we strip off).
function markerFor(nick: string): string {
  const encoded = JSON.stringify(mcpConnectionLine(nick))
  return encoded.slice(1, -1)
}

// Parsed row shape (only fields we care about — JSONL has many more).
interface AnyRow {
  type?: string
  subtype?: string
  timestamp?: string
  durationMs?: number
  requestId?: string
  uuid?: string
  isSidechain?: boolean
  // system/compact_boundary rows: emitted when Claude Code auto-compacts the
  // conversation. preTokens/postTokens describe the context size; durationMs
  // is the compaction API call's wall time. No per-field usage block.
  compactMetadata?: {
    trigger?: string
    preTokens?: number
    postTokens?: number
    durationMs?: number
  }
  message?: {
    model?: string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
      // Nested per-TTL breakdown when prompt caching is on. The aggregate
      // `cache_creation_input_tokens` equals the sum of these two.
      cache_creation?: {
        ephemeral_5m_input_tokens?: number
        ephemeral_1h_input_tokens?: number
      }
    }
    diagnostics?: {
      cache_miss_reason?: {
        type?: string
        cache_missed_input_tokens?: number
      }
    }
  }
}

// Per-file scan result returned by scanFile. The caller merges these into the
// nick-level accumulators.
interface ScanResult {
  byModel: Map<string, UsageCounts>
  missByModel: Map<string, Map<string, MissCounts>>
  apiDurationMs: number
  wallFirst?: string
  wallLast?: string
  unknownModels: Set<string>
  contributed: boolean
  compactions: CompactionStats
}

// Walk one JSONL file and return its token usage. Only rows with
// `timestamp > sinceTs` (when sinceTs is set) contribute. `seenRequestIds`
// is shared across files so the same API call (one requestId) is only
// counted once — Claude Code writes one assistant row per content block
// of a multi-part response (text + tool_use + tool_use…) and each row
// repeats the parent API call's `usage` block verbatim. Forked or resumed
// transcripts also share requestIds across files. Sidechain (subagent)
// rows in a *parent* transcript are skipped: in current Claude Code
// their full transcripts live in `PROJECT/SESSION/subagents/agent-*.jsonl`
// (scanned separately with `countSidechain: true`), so this is defensive
// — older or future shapes that inline sidechain rows in the parent are
// filtered here to avoid double-counting.
//
// Compaction handling: a `system/compact_boundary` row marks an auto-
// compaction. It carries preTokens/postTokens + durationMs but no per-
// field usage block — the summary API call itself isn't logged. We
// aggregate the markers so the gap is visible, without pricing it.
function scanFile(text: string, seenRequestIds: Set<string>, seenTurnUuids: Set<string>, seenCompactUuids: Set<string>, sinceTs?: string, countSidechain = false): ScanResult {
  const byModel = new Map<string, UsageCounts>()
  const missByModel = new Map<string, Map<string, MissCounts>>()
  let apiDurationMs = 0
  let wallFirst: string | undefined
  let wallLast: string | undefined
  const unknownModels = new Set<string>()
  const compactions: CompactionStats = { count: 0, preTokens: 0, postTokens: 0, durationMs: 0 }
  let contributed = false

  const trackLocal = (ts: string) => {
    if (!wallFirst || ts < wallFirst) wallFirst = ts
    if (!wallLast || ts > wallLast) wallLast = ts
  }

  for (const line of text.split('\n')) {
    if (!line) continue
    let row: AnyRow
    try {
      row = JSON.parse(line) as AnyRow
    } catch {
      continue
    }
    const ts = row.timestamp
    if (sinceTs && (!ts || ts <= sinceTs)) continue
    if (row.isSidechain && !countSidechain) continue

    // Assistant turn: model + usage block.
    if (row.type === 'assistant' && row.message?.usage && row.message.model) {
      // Dedup multi-part API responses: same requestId → same usage block.
      // Rows lacking a requestId (older transcripts, synthetic rows) are
      // not deduped — each row counts independently.
      if (row.requestId) {
        if (seenRequestIds.has(row.requestId)) continue
        seenRequestIds.add(row.requestId)
      }
      const u = row.message.usage
      // Cache-write breakdown: prefer the nested per-TTL fields when
      // present (every modern transcript has them). Fall back to lumping
      // the aggregate into the 5m bucket — that's the common case under
      // default `cache_control` and avoids overcharging at 1h rates.
      const nested = u.cache_creation
      let cache5m: number
      let cache1h: number
      if (nested && (typeof nested.ephemeral_5m_input_tokens === 'number' || typeof nested.ephemeral_1h_input_tokens === 'number')) {
        cache5m = nested.ephemeral_5m_input_tokens ?? 0
        cache1h = nested.ephemeral_1h_input_tokens ?? 0
      } else {
        cache5m = u.cache_creation_input_tokens ?? 0
        cache1h = 0
      }
      const tokens: UsageCounts = {
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        cache_creation_5m: cache5m,
        cache_creation_1h: cache1h,
        cache_read: u.cache_read_input_tokens ?? 0,
      }
      // A purely-empty usage row contributes nothing — skip so an idle
      // session doesn't get tagged as "contributed".
      if (tokens.input || tokens.output || tokens.cache_creation_5m || tokens.cache_creation_1h || tokens.cache_read) {
        addToUsageMap(byModel, row.message.model, tokens)
        if (costFor(row.message.model, tokens) === null) {
          unknownModels.add(row.message.model)
        }
        if (ts) trackLocal(ts)
        contributed = true
      }

      // Cache miss reason: direct signal from Claude Code for why the cache
      // was not hit. Split the miss tokens by the creation tier mix on this
      // same row so the premium is computed at the correct rate (1h vs 5m).
      const missReason = row.message.diagnostics?.cache_miss_reason
      if (missReason?.type && typeof missReason.cache_missed_input_tokens === 'number' && missReason.cache_missed_input_tokens > 0) {
        const missTokens = missReason.cache_missed_input_tokens
        const creationTotal = cache5m + cache1h
        let miss5m: number, miss1h: number
        if (creationTotal > 0) {
          miss5m = missTokens * cache5m / creationTotal
          miss1h = missTokens * cache1h / creationTotal
        } else {
          // No creation block on this row — fall back to 5m (conservative lower bound).
          miss5m = missTokens
          miss1h = 0
        }
        let modelMiss = missByModel.get(row.message.model)
        if (!modelMiss) {
          modelMiss = new Map<string, MissCounts>()
          missByModel.set(row.message.model, modelMiss)
        }
        const cur = modelMiss.get(missReason.type) ?? { tokens5m: 0, tokens1h: 0 }
        cur.tokens5m += miss5m
        cur.tokens1h += miss1h
        modelMiss.set(missReason.type, cur)
      }
      continue
    }

    // System turn_duration row: one per assistant API call, carries the
    // model's wall time for that call. Use these for API-time total.
    // Dedup by uuid so forked/resumed transcripts don't re-add the same
    // turn; within a single file these uuids are already unique.
    if (row.type === 'system' && row.subtype === 'turn_duration' && typeof row.durationMs === 'number') {
      if (row.uuid) {
        if (seenTurnUuids.has(row.uuid)) continue
        seenTurnUuids.add(row.uuid)
      }
      apiDurationMs += row.durationMs
      if (ts) trackLocal(ts)
      contributed = true
      continue
    }

    // System compact_boundary row: marks an auto-compaction. The summary
    // API call's per-field usage is not in the JSONL, so we only surface
    // the available aggregates (pre/post context size, wall duration).
    // Dedup by uuid so a forked/resumed transcript doesn't re-add it.
    if (row.type === 'system' && row.subtype === 'compact_boundary' && row.compactMetadata) {
      if (row.uuid) {
        if (seenCompactUuids.has(row.uuid)) continue
        seenCompactUuids.add(row.uuid)
      }
      compactions.count += 1
      compactions.preTokens += row.compactMetadata.preTokens ?? 0
      compactions.postTokens += row.compactMetadata.postTokens ?? 0
      compactions.durationMs += row.compactMetadata.durationMs ?? 0
      if (ts) trackLocal(ts)
      contributed = true
      continue
    }
  }
  return { byModel, missByModel, apiDurationMs, wallFirst, wallLast, unknownModels, contributed, compactions }
}

export async function collectForNick(
  nick: string,
  projectsRoot: string,
  sinceTs?: string,
): Promise<NickReport> {
  const marker = markerFor(nick)
  const files = await listSessionFiles(projectsRoot)
  const report = emptyReport()
  // Scan-wide so a requestId / turn uuid / compact_boundary uuid shared
  // across forked or resumed transcripts is only counted once.
  const seenRequestIds = new Set<string>()
  const seenTurnUuids = new Set<string>()
  const seenCompactUuids = new Set<string>()
  for (const f of files) {
    let text: string
    try {
      text = await readFile(f, 'utf8')
    } catch {
      continue
    }
    // Cheap pre-filter: if the file never mentions this nick's MCP banner,
    // skip the parse entirely.
    if (!text.includes(marker)) continue
    report.files.push(f)

    const result = scanFile(text, seenRequestIds, seenTurnUuids, seenCompactUuids, sinceTs)
    if (result.contributed) report.transcripts += 1
    for (const [m, u] of result.byModel) addToUsageMap(report.byModel, m, u)
    addToMissMap(report.missByModel, result.missByModel)
    report.apiDurationMs += result.apiDurationMs
    if (result.wallFirst) trackTs(report, result.wallFirst)
    if (result.wallLast) trackTs(report, result.wallLast)
    for (const m of result.unknownModels) report.unknownModels.add(m)
    mergeCompactions(report.compactions, result.compactions)

    // Subagent transcripts: same nick, billed by directory locality.
    const subagentFiles = await listSubagentFiles(f)
    for (const sub of subagentFiles) {
      let subText: string
      try {
        subText = await readFile(sub, 'utf8')
      } catch {
        continue
      }
      report.files.push(sub)
      const subResult = scanFile(subText, seenRequestIds, seenTurnUuids, seenCompactUuids, sinceTs, true)
      // Each contributing subagent file increments transcripts independently —
      // a worker that fires 3 Task subagents shows `transcripts: 4` (parent + 3).
      if (subResult.contributed) report.transcripts += 1
      for (const [m, u] of subResult.byModel) addToUsageMap(report.byModel, m, u)
      addToMissMap(report.missByModel, subResult.missByModel)
      report.apiDurationMs += subResult.apiDurationMs
      if (subResult.wallFirst) trackTs(report, subResult.wallFirst)
      if (subResult.wallLast) trackTs(report, subResult.wallLast)
      for (const m of subResult.unknownModels) report.unknownModels.add(m)
      mergeCompactions(report.compactions, subResult.compactions)
    }
  }
  return report
}

async function readSnapshots(stateDir: string): Promise<SnapshotFile> {
  const path = join(stateDir, 'token-snapshots.json')
  try {
    const text = await readFile(path, 'utf8')
    return JSON.parse(text) as SnapshotFile
  } catch {
    return {}
  }
}

async function writeSnapshots(stateDir: string, data: SnapshotFile): Promise<void> {
  await mkdir(stateDir, { recursive: true })
  const tmp = join(stateDir, `.token-snapshots.${process.pid}.${Date.now()}.tmp`)
  try {
    await Bun.write(tmp, JSON.stringify(data, null, 2) + '\n')
    await rename(tmp, join(stateDir, 'token-snapshots.json'))
  } catch (e) {
    try { await unlink(tmp) } catch { /* ignore */ }
    throw e
  }
}

// 12345 → "12.3k", 1_234_567 → "1.2M". Tokens-style compaction.
function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + 'k'
  return (n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0) + 'M'
}

// /usage renders seconds granularity ("18m 57s") — match it. Sub-second
// quantities collapse to "0s" rather than "Xms" so the column is uniform.
function fmtDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}h${m.toString().padStart(2, '0')}m`
  if (m > 0) return `${m}m${s.toString().padStart(2, '0')}s`
  return `${s}s`
}

function fmtDollars(n: number | null): string {
  if (n === null) return '$?'
  return `$${n.toFixed(2)}`
}

// `claude-opus-4-7` → `opus-4-7`. Cosmetic shortening to keep output tight.
function shortModel(model: string): string {
  return model.startsWith('claude-') ? model.slice('claude-'.length) : model
}

function formatNick(nick: string, r: NickReport): string {
  let totalCost: number | null = 0
  let totalMissCost: number | null = 0
  const perModel: Array<{ model: string; line: string }> = []
  // Stable order so output is reproducible across runs.
  const models = [...r.byModel.keys()].sort()
  for (const model of models) {
    const u = r.byModel.get(model)!
    const c = costFor(model, u)
    if (totalCost !== null) {
      if (c === null) totalCost = null
      else totalCost += c
    }

    let missStr = ''
    const modelMiss = r.missByModel.get(model)
    if (modelMiss && modelMiss.size > 0) {
      let missTotal5m = 0, missTotal1h = 0
      for (const { tokens5m, tokens1h } of modelMiss.values()) {
        missTotal5m += tokens5m
        missTotal1h += tokens1h
      }
      const mc = missCostFor(model, missTotal5m, missTotal1h)
      if (totalMissCost !== null) {
        if (mc === null) totalMissCost = null
        else totalMissCost += mc
      }
      // Sort by total token count descending so the costliest reason appears first.
      const reasons = [...modelMiss.entries()].sort(
        (a, b) => (b[1].tokens5m + b[1].tokens1h) - (a[1].tokens5m + a[1].tokens1h)
      )
      const reasonParts = reasons.map(([reason, { tokens5m, tokens1h }]) =>
        `${reason} ${fmtTokens(tokens5m + tokens1h)} (${fmtDollars(missCostFor(model, tokens5m, tokens1h))})`
      )
      missStr = `, miss: ${fmtTokens(missTotal5m + missTotal1h)} (${fmtDollars(mc)}) [${reasonParts.join(' · ')}]`
    }

    perModel.push({
      model,
      line: `  ${shortModel(model)}: ${fmtTokens(u.input)} in / ${fmtTokens(u.output)} out / ${fmtTokens(u.cache_read)} cache_r / ${fmtTokens(u.cache_creation_5m)} cache_w_5m / ${fmtTokens(u.cache_creation_1h)} cache_w_1h  (${fmtDollars(c)}${missStr})`,
    })
  }
  let wallMs = 0
  if (r.wallFirst && r.wallLast) {
    wallMs = Date.parse(r.wallLast) - Date.parse(r.wallFirst)
    if (wallMs < 0) wallMs = 0
  }
  const missPart = totalMissCost === null || totalMissCost > 0
    ? ` (${fmtDollars(totalMissCost)} miss)`
    : ''
  const head = `${nick}: ${fmtDollars(totalCost)}${missPart} · ${fmtDuration(r.apiDurationMs)} api / ${fmtDuration(wallMs)} wall`
  // Compaction is its own line — surface what the JSONL gives us (pre/post
  // context size, total wall) and explicitly call out that the API call's
  // input/output isn't captured. See scanFile's "Known gaps" comment.
  const compactionLine = r.compactions.count > 0
    ? `  compaction: ${r.compactions.count}× (pre ${fmtTokens(r.compactions.preTokens)} → post ${fmtTokens(r.compactions.postTokens)}, ${fmtDuration(r.compactions.durationMs)}; call cost not captured)`
    : null
  if (perModel.length === 0) {
    const tail = compactionLine ?? '  (no in-window activity)'
    return `${head}\n${tail}`
  }
  const lines = [head, ...perModel.map((p) => p.line)]
  if (compactionLine) lines.push(compactionLine)
  return lines.join('\n')
}

function usage(stream: NodeJS.WriteStream): void {
  stream.write(`Usage: roost-token-usage <subcommand> <stateDir> <issue> <nick>...

Subcommands:
  snapshot   Record a per-nick snapshot timestamp under <issue> in
             <stateDir>/token-snapshots.json. Subsequent reports for the
             same <issue> only count turns after this time.
  report     For each nick, print a multi-line cost report:
                <nick>: $X.XX ($Y.YY miss) · 18m57s api / 44m42s wall
                  <model>: in/out/cache_r/cache_w  ($X.XX, miss: N ($Y.YY) [reason ...])
             If a snapshot exists for <issue>+<nick>, only in-window turns
             count; otherwise the full transcript cumulative is reported.
             "miss" cost = (creation_rate - read_rate) x missed tokens; source:
             message.diagnostics.cache_miss_reason in session transcripts.

Cost is an estimate. Unknown model IDs render '$?' and emit a stderr
warning; update src/pricing.ts to add them.

Exits 1 if any requested nick matches zero session transcripts.

Env:
  CLAUDE_PROJECTS_DIR  Override the ~/.claude/projects scan root (tests).
`)
}

export async function main(argv: string[]): Promise<number> {
  if (argv.length < 4) {
    usage(process.stderr)
    return 2
  }
  const [subcommand, stateDir, issueRaw, ...nicks] = argv
  if (subcommand !== 'snapshot' && subcommand !== 'report') {
    process.stderr.write(`roost-token-usage: unknown subcommand: ${subcommand}\n`)
    usage(process.stderr)
    return 2
  }
  const issue = String(issueRaw)
  if (!/^[0-9]+$/.test(issue)) {
    process.stderr.write(`roost-token-usage: <issue> must be numeric, got: ${issue}\n`)
    return 2
  }
  if (nicks.length === 0) {
    process.stderr.write('roost-token-usage: pass at least one <nick>\n')
    return 2
  }

  const projectsRoot = process.env.CLAUDE_PROJECTS_DIR ?? join(homedir(), '.claude', 'projects')

  if (subcommand === 'snapshot') {
    // Snapshotting just records `now` per nick — no need to scan
    // transcripts. We still verify each nick has at least one transcript
    // so a typo doesn't silently set a baseline against nothing.
    const missing: string[] = []
    for (const nick of nicks) {
      const probe = await collectForNick(nick, projectsRoot)
      if (probe.files.length === 0) missing.push(nick)
    }
    if (missing.length > 0) {
      process.stderr.write(`roost-token-usage: no session transcripts found for: ${missing.join(', ')}\n`)
      process.stderr.write(`  scanned: ${projectsRoot}\n`)
      process.stderr.write('  (a session must contain the MCP banner "You are connected to IRC as nick \\"<nick>\\"" — check the nick spelling, or that the agent ever booted.)\n')
      return 1
    }
    const snaps = await readSnapshots(stateDir)
    const now = new Date().toISOString()
    snaps[issue] = snaps[issue] ?? {}
    for (const nick of nicks) {
      snaps[issue][nick] = { snapshot_at: now }
      process.stdout.write(`snapshot ${issue} ${nick} at ${now}\n`)
    }
    await writeSnapshots(stateDir, snaps)
    return 0
  }

  // report
  const snaps = await readSnapshots(stateDir)
  const baseline = snaps[issue] ?? {}
  const reports: Array<{ nick: string; report: NickReport }> = []
  const missing: string[] = []
  for (const nick of nicks) {
    const since = baseline[nick]?.snapshot_at
    const r = await collectForNick(nick, projectsRoot, since)
    if (r.files.length === 0) missing.push(nick)
    reports.push({ nick, report: r })
  }
  if (missing.length > 0) {
    process.stderr.write(`roost-token-usage: no session transcripts found for: ${missing.join(', ')}\n`)
    process.stderr.write(`  scanned: ${projectsRoot}\n`)
    process.stderr.write('  (a session must contain the MCP banner "You are connected to IRC as nick \\"<nick>\\"" — check the nick spelling, or that the agent ever booted.)\n')
    return 1
  }

  for (const { nick, report } of reports) {
    if (report.unknownModels.size > 0) {
      const list = [...report.unknownModels].sort().join(', ')
      process.stderr.write(`roost-token-usage: warning: ${nick}: no pricing for model(s): ${list} (add to src/pricing.ts)\n`)
    }
    process.stdout.write(formatNick(nick, report) + '\n')
  }
  return 0
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2))
  process.exit(code)
}
