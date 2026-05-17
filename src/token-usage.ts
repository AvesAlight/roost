#!/usr/bin/env bun
// token-usage — read Claude Code session transcripts and summarize per-nick
// API spend in a format inspired by Claude Code's own `/usage` panel:
//
//   <nick>: $14.38 · 18m57s api / 44m42s wall
//     opus-4-7:    7.4k in / 63.4k out / 17.5M cache_r / 644.6k cache_w  ($14.38)
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
import { costFor, excessCreationCost, type UsageCounts } from './pricing.js'

type ModelUsage = UsageCounts

interface NickReport {
  byModel: Map<string, ModelUsage>
  // Excess cache creation per model, summed across sessions. "Excess" = the
  // portion of cache_creation that exceeded cache_read within a single session
  // — tokens written but never read back. Computed per-session (not in aggregate)
  // so a wasted write in one session isn't masked by reads in another.
  excessByModel: Map<string, { excess5m: number; excess1h: number }>
  apiDurationMs: number
  wallFirst?: string
  wallLast?: string
  // Number of contributing JSONL transcript files (parent + each subagent file
  // counted separately). Distinct from the "session" scope used for excess
  // computation, which groups a parent and all its subagents together.
  transcripts: number
  unknownModels: Set<string>
  files: string[]
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
    excessByModel: new Map(),
    apiDurationMs: 0,
    transcripts: 0,
    unknownModels: new Set(),
    files: [],
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

// For each model in the session map, compute the excess creation tokens
// (max(0, creation_total - cache_read)) and accumulate into report.excessByModel.
// The excess is split between tiers proportionally to their share of creation.
function accumulateExcess(report: NickReport, sessionByModel: Map<string, UsageCounts>): void {
  for (const [model, u] of sessionByModel) {
    const creationTotal = u.cache_creation_5m + u.cache_creation_1h
    const excess = Math.max(0, creationTotal - u.cache_read)
    if (excess === 0 || creationTotal === 0) continue
    const ratio5m = u.cache_creation_5m / creationTotal
    const cur = report.excessByModel.get(model) ?? { excess5m: 0, excess1h: 0 }
    cur.excess5m += excess * ratio5m
    cur.excess1h += excess * (1 - ratio5m)
    report.excessByModel.set(model, cur)
  }
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
  }
}

// Per-file scan result returned by scanFile. The caller merges these into the
// session-level and nick-level accumulators.
interface ScanResult {
  byModel: Map<string, UsageCounts>
  apiDurationMs: number
  wallFirst?: string
  wallLast?: string
  unknownModels: Set<string>
  contributed: boolean
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
function scanFile(text: string, seenRequestIds: Set<string>, seenTurnUuids: Set<string>, sinceTs?: string, countSidechain = false): ScanResult {
  const byModel = new Map<string, UsageCounts>()
  let apiDurationMs = 0
  let wallFirst: string | undefined
  let wallLast: string | undefined
  const unknownModels = new Set<string>()
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
  }
  return { byModel, apiDurationMs, wallFirst, wallLast, unknownModels, contributed }
}

export async function collectForNick(
  nick: string,
  projectsRoot: string,
  sinceTs?: string,
): Promise<NickReport> {
  const marker = markerFor(nick)
  const files = await listSessionFiles(projectsRoot)
  const report = emptyReport()
  // Scan-wide so a requestId / turn uuid shared across forked or resumed
  // transcripts is only counted once.
  const seenRequestIds = new Set<string>()
  const seenTurnUuids = new Set<string>()
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

    // Accumulate parent + all subagents into a session-level map before
    // merging into the nick-level report. This lets us compute per-session
    // excess creation (writes that weren't read back within the session)
    // without cross-session reads masking the waste.
    const sessionByModel = new Map<string, UsageCounts>()

    const result = scanFile(text, seenRequestIds, seenTurnUuids, sinceTs)
    if (result.contributed) report.transcripts += 1
    for (const [m, u] of result.byModel) addToUsageMap(sessionByModel, m, u)
    report.apiDurationMs += result.apiDurationMs
    if (result.wallFirst) trackTs(report, result.wallFirst)
    if (result.wallLast) trackTs(report, result.wallLast)
    for (const m of result.unknownModels) report.unknownModels.add(m)

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
      const subResult = scanFile(subText, seenRequestIds, seenTurnUuids, sinceTs, true)
      // Each contributing subagent file increments transcripts independently —
      // a worker that fires 3 Task subagents shows `transcripts: 4` (parent + 3).
      if (subResult.contributed) report.transcripts += 1
      for (const [m, u] of subResult.byModel) addToUsageMap(sessionByModel, m, u)
      report.apiDurationMs += subResult.apiDurationMs
      if (subResult.wallFirst) trackTs(report, subResult.wallFirst)
      if (subResult.wallLast) trackTs(report, subResult.wallLast)
      for (const m of subResult.unknownModels) report.unknownModels.add(m)
    }

    // Merge session totals into the nick-level report and compute excess.
    for (const [model, u] of sessionByModel) addToUsageMap(report.byModel, model, u)
    accumulateExcess(report, sessionByModel)
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
  let totalExcess: number | null = 0
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

    const exc = r.excessByModel.get(model)
    const ec = exc ? excessCreationCost(model, exc.excess5m, exc.excess1h) : 0
    if (totalExcess !== null) {
      if (ec === null) totalExcess = null
      else totalExcess += ec
    }
    const excStr = ec !== 0 ? `, ${fmtDollars(ec)} excess` : ''

    perModel.push({
      model,
      line: `  ${shortModel(model)}: ${fmtTokens(u.input)} in / ${fmtTokens(u.output)} out / ${fmtTokens(u.cache_read)} cache_r / ${fmtTokens(u.cache_creation_5m)} cache_w_5m / ${fmtTokens(u.cache_creation_1h)} cache_w_1h  (${fmtDollars(c)}${excStr})`,
    })
  }
  let wallMs = 0
  if (r.wallFirst && r.wallLast) {
    wallMs = Date.parse(r.wallLast) - Date.parse(r.wallFirst)
    if (wallMs < 0) wallMs = 0
  }
  const excessPart = totalExcess === null || totalExcess > 0
    ? ` (${fmtDollars(totalExcess)} excess)`
    : ''
  const head = `${nick}: ${fmtDollars(totalCost)}${excessPart} · ${fmtDuration(r.apiDurationMs)} api / ${fmtDuration(wallMs)} wall`
  if (perModel.length === 0) {
    return `${head}\n  (no in-window activity)`
  }
  return [head, ...perModel.map((p) => p.line)].join('\n')
}

function usage(stream: NodeJS.WriteStream): void {
  stream.write(`Usage: roost-token-usage <subcommand> <stateDir> <issue> <nick>...

Subcommands:
  snapshot   Record a per-nick snapshot timestamp under <issue> in
             <stateDir>/token-snapshots.json. Subsequent reports for the
             same <issue> only count turns after this time.
  report     For each nick, print a multi-line cost report:
                <nick>: $X.XX ($Y.YY excess) · 18m57s api / 44m42s wall
                  <model>: in/out/cache_r/cache_w  ($X.XX, $Y.YY excess)
             If a snapshot exists for <issue>+<nick>, only in-window turns
             count; otherwise the full transcript cumulative is reported.
             "excess" = cost of cache writes that exceeded cache reads within
             each session (a lower bound — only intra-session waste is
             detected; reads in one session don't offset writes in another).

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
