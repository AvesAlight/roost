#!/usr/bin/env bun
// token-usage — sum token usage from Claude Code session transcripts for a
// given roost nick, and snapshot/diff totals across an issue's lifecycle.
//
// Sessions are matched by the marker that src/irc-server.ts injects into
// every MCP `instructions` payload:
//
//   You are connected to IRC as nick "<nick>"
//
// Every roost-spawned session contains this exact line (the comment in
// src/irc-server.ts notes the coupling). We grep all
// ~/.claude/projects/*/*.jsonl files for it, then sum the `usage` blocks
// emitted by assistant turns.
//
// Subcommands:
//   snapshot <stateDir> <issue> <nick>...
//     Sum cumulative usage for each nick, store under issue in
//     <stateDir>/token-snapshots.json. Used at issue setup to mark the
//     long-lived agents' starting position so we can diff at cleanup.
//
//   report <stateDir> <issue> <nick>...
//     For each nick, sum current cumulative usage. If a snapshot exists for
//     <issue>+<nick>, output the delta (cumulative - snapshot); otherwise
//     output the cumulative as-is (workers/reviewers are ephemeral so their
//     full lifetime == the issue). One line per nick.
//
// Exits non-zero if a requested nick matches zero JSONL files — silent zero
// reports are worse than a loud failure the APM can relay.

import { readdir, readFile, mkdir, rename, unlink, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { mcpConnectionLine } from './mcp-banner.js'

interface Usage {
  input: number
  output: number
  cache_creation: number
  cache_read: number
  sessions: number
}

interface SnapshotFile {
  // issue number → nick → snapshot record
  [issue: string]: {
    [nick: string]: Usage & { snapshot_at: string }
  }
}

const ZERO: Usage = { input: 0, output: 0, cache_creation: 0, cache_read: 0, sessions: 0 }

function add(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cache_creation: a.cache_creation + b.cache_creation,
    cache_read: a.cache_read + b.cache_read,
    sessions: a.sessions + b.sessions,
  }
}

function sub(a: Usage, b: Usage): Usage {
  // No clamp: cumulative usage only grows, so a negative diff means the
  // baseline drifted (transcript file deleted, snapshot manually edited,
  // session moved). We render the negative number and the caller is
  // expected to stderr-warn so the drift surfaces in the post-mortem
  // rather than getting silently zeroed.
  return {
    input: a.input - b.input,
    output: a.output - b.output,
    cache_creation: a.cache_creation - b.cache_creation,
    cache_read: a.cache_read - b.cache_read,
    sessions: a.sessions - b.sessions,
  }
}

// Project dir name encoding used by Claude Code: '/' → '-'. Lookup is by
// scanning rather than by computing the inverse, so we don't need to care.
async function listSessionFiles(projectsRoot: string): Promise<string[]> {
  let dirs: string[]
  try {
    dirs = await readdir(projectsRoot)
  } catch {
    return []
  }
  const files: string[] = []
  for (const d of dirs) {
    const full = join(projectsRoot, d)
    try {
      const s = await stat(full)
      if (!s.isDirectory()) continue
      const entries = await readdir(full)
      for (const e of entries) {
        if (e.endsWith('.jsonl')) files.push(join(full, e))
      }
    } catch {
      // unreadable dir — skip
    }
  }
  return files
}

// JSONL stores MCP instructions inside a JSON-encoded string, so the inner
// quotes around the nick are backslash-escaped. JSON.stringify produces the
// exact file-form substring (and adds outer quotes we strip off) — no need
// to write the escape by hand here.
function markerFor(nick: string): string {
  const encoded = JSON.stringify(mcpConnectionLine(nick))
  return encoded.slice(1, -1)
}

// Sum usage across all assistant turns in one JSONL file. Each assistant
// message has `message.usage` with input_tokens / output_tokens /
// cache_creation_input_tokens / cache_read_input_tokens. Resumed sessions
// can show inflated cache_read on later turns (cache hits accumulate);
// that's the honest report — we don't try to deduplicate cache hits across
// turns within a session.
function sumUsageInJson(text: string): Usage {
  let total: Usage = { ...ZERO }
  // Cheap line-by-line; each JSONL row is one JSON object.
  for (const line of text.split('\n')) {
    if (!line || !line.includes('"usage"')) continue
    let obj: unknown
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    const u = (obj as { message?: { usage?: Record<string, unknown> } }).message?.usage
    if (!u) continue
    total = add(total, {
      input: typeof u.input_tokens === 'number' ? u.input_tokens : 0,
      output: typeof u.output_tokens === 'number' ? u.output_tokens : 0,
      cache_creation: typeof u.cache_creation_input_tokens === 'number' ? u.cache_creation_input_tokens : 0,
      cache_read: typeof u.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : 0,
      sessions: 0,
    })
  }
  return { ...total, sessions: 1 }
}

export interface CollectResult {
  nick: string
  usage: Usage
  files: string[]
}

export async function collectForNick(nick: string, projectsRoot: string): Promise<CollectResult> {
  const marker = markerFor(nick)
  const files = await listSessionFiles(projectsRoot)
  let total: Usage = { ...ZERO }
  const matched: string[] = []
  for (const f of files) {
    let text: string
    try {
      text = await readFile(f, 'utf8')
    } catch {
      continue
    }
    if (!text.includes(marker)) continue
    matched.push(f)
    total = add(total, sumUsageInJson(text))
  }
  return { nick, usage: total, files: matched }
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

function fmt(n: number): string {
  // Compact: 12345 → "12.3k", 1234567 → "1.2M". Below 1000 stay raw.
  if (n < 1000) return String(n)
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + 'k'
  return (n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0) + 'M'
}

function formatLine(nick: string, u: Usage): string {
  return `${nick}: in=${fmt(u.input)} out=${fmt(u.output)} cache_w=${fmt(u.cache_creation)} cache_r=${fmt(u.cache_read)} sessions=${u.sessions}`
}

function usage(stream: NodeJS.WriteStream): void {
  stream.write(`Usage: roost-token-usage <subcommand> <stateDir> <issue> <nick>...

Subcommands:
  snapshot   Record cumulative token usage for each nick under <issue>.
             Used at issue setup so cleanup can diff against this baseline.
  report     For each nick, print one line summarizing tokens used.
             If a snapshot exists for <issue>+<nick>, output the delta;
             otherwise output the cumulative total.

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

  const results: CollectResult[] = []
  const missing: string[] = []
  for (const nick of nicks) {
    const r = await collectForNick(nick, projectsRoot)
    if (r.files.length === 0) missing.push(nick)
    results.push(r)
  }
  if (missing.length > 0) {
    process.stderr.write(`roost-token-usage: no session transcripts found for: ${missing.join(', ')}\n`)
    process.stderr.write(`  scanned: ${projectsRoot}\n`)
    process.stderr.write('  (a session must contain the MCP banner "You are connected to IRC as nick \\"<nick>\\"" — check the nick spelling, or that the agent ever booted.)\n')
    return 1
  }

  if (subcommand === 'snapshot') {
    const snaps = await readSnapshots(stateDir)
    const now = new Date().toISOString()
    snaps[issue] = snaps[issue] ?? {}
    for (const r of results) {
      snaps[issue][r.nick] = { ...r.usage, snapshot_at: now }
    }
    await writeSnapshots(stateDir, snaps)
    for (const r of results) {
      process.stdout.write(`snapshot ${issue} ${formatLine(r.nick, r.usage)}\n`)
    }
    return 0
  }

  // report
  const snaps = await readSnapshots(stateDir)
  const baseline = snaps[issue] ?? {}
  for (const r of results) {
    const base = baseline[r.nick]
    if (base) {
      const baseUsage: Usage = {
        input: base.input,
        output: base.output,
        cache_creation: base.cache_creation,
        cache_read: base.cache_read,
        sessions: base.sessions,
      }
      const diff = sub(r.usage, baseUsage)
      // Cumulative usage only grows. A negative component means the
      // baseline drifted (transcript pruned, snapshot hand-edited,
      // session relocated). Render anyway, but warn so the lead sees it.
      const negative = diff.input < 0 || diff.output < 0
        || diff.cache_creation < 0 || diff.cache_read < 0 || diff.sessions < 0
      if (negative) {
        process.stderr.write(
          `roost-token-usage: warning: negative diff for ${r.nick} (snapshot drift suspected — transcript pruned or snapshot edited?)\n`,
        )
      }
      process.stdout.write(formatLine(r.nick, diff) + '\n')
    } else {
      process.stdout.write(formatLine(r.nick, r.usage) + '\n')
    }
  }
  return 0
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2))
  process.exit(code)
}
