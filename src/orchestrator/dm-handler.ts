// Dispatcher DM handler: parses a small command grammar and mutates
// .orchestrator/config.json. Replaces the haiku watcher's LLM-on-JSON loop
// (see prompts/watcher.md) with a deterministic in-process path.
//
// All commands arrive via DM (msg.isDirect === true). The handler:
//   1. enforces an allowlist (config.irc.command_senders)
//   2. parses the message body into Command[] (multi-cmd per line is fine)
//   3. mutates config via mutateConfig (single serialized writer)
//   4. DMs back ONE confirmation summarizing what changed
//
// The handler never throws — parse/apply errors become a one-line DM to
// the sender, and write errors are surfaced to the project channel by the
// caller in orchestrator.ts.

import { loadConfig, mutateConfig, type OrchestratorConfig, type WatchedEntry } from './config.js'
import { defaultProject, leadPmNick } from './naming.js'

type WatchPlugin = 'github-issues' | 'github-prs'

export type Command =
  | { kind: 'watch'; plugin: WatchPlugin; number: number; channels: string[] }
  | { kind: 'unwatch'; plugin: WatchPlugin; number: number }
  | { kind: 'list' }
  | { kind: 'help' }
  | { kind: 'unknown'; raw: string; error: string }

export interface HandlerDeps {
  stateDir: string
  // Pure I/O — only the bits we need from RoostIrcClient.
  dm: (nick: string, text: string) => void
  postProjectError: (text: string) => void
  log: (line: string) => void
}

const HELP_TEXT = [
  'commands (DM only):',
  '  watch <N> [#chan ...]       — watch issue N (and route extra channels)',
  '  unwatch <N>                 — stop watching issue N',
  '  watch pr <N> [#chan ...]    — watch PR N (and route extra channels)',
  '  unwatch pr <N>              — stop watching PR N',
  '  watch list                  — show current watch lists',
  '  help                        — this message',
  'separate multiple commands per DM with newline, semicolon, or comma.',
  'any parse error aborts the batch — nothing is applied.',
].join('\n')

const CHANNEL_RE = /^#[^\s,#]+$/

// ---- Parser ----------------------------------------------------------------

// Split a raw inbound body into individual command lines. Newlines /
// semicolons / commas are all separators — matches the watcher prompt
// grammar (which has been the operator-facing UX since the haiku watcher).
export function splitCommands(text: string): string[] {
  return text
    .split(/[\n;,]+/)
    .map(s => s.trim())
    .filter(Boolean)
}

// Parse a single command line. Returns `unknown` rather than throwing so
// the handler can DM a usage hint and keep processing.
export function parseCommand(line: string): Command {
  const tokens = line.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return { kind: 'unknown', raw: line, error: 'empty command' }
  const verb = tokens[0].toLowerCase()

  if (verb === 'help') return { kind: 'help' }

  if (verb === 'watch') {
    if (tokens[1]?.toLowerCase() === 'list') {
      if (tokens.length > 2) {
        return { kind: 'unknown', raw: line, error: `watch list takes no arguments; got "${tokens.slice(2).join(' ')}"` }
      }
      return { kind: 'list' }
    }
    return parseWatchOrUnwatch(line, 'watch', tokens.slice(1))
  }

  if (verb === 'unwatch') {
    return parseWatchOrUnwatch(line, 'unwatch', tokens.slice(1))
  }

  return { kind: 'unknown', raw: line, error: `unknown command: ${tokens[0]}` }
}

function parseWatchOrUnwatch(raw: string, verb: 'watch' | 'unwatch', rest: string[]): Command {
  let plugin: WatchPlugin = 'github-issues'
  let i = 0
  if (rest[0]?.toLowerCase() === 'pr') {
    plugin = 'github-prs'
    i = 1
  }

  const numTok = rest[i]
  if (numTok === undefined) {
    return { kind: 'unknown', raw, error: `${verb} requires an issue/PR number` }
  }
  const number = parseInt(numTok, 10)
  if (!Number.isInteger(number) || number <= 0 || String(number) !== numTok) {
    return { kind: 'unknown', raw, error: `${verb}: "${numTok}" is not a positive integer` }
  }

  const channels = rest.slice(i + 1)
  if (verb === 'unwatch') {
    if (channels.length) {
      return { kind: 'unknown', raw, error: 'unwatch takes no channel arguments' }
    }
    return { kind: 'unwatch', plugin, number }
  }

  for (const c of channels) {
    if (!CHANNEL_RE.test(c)) {
      return { kind: 'unknown', raw, error: `channels must match ${CHANNEL_RE.source}: got "${c}"` }
    }
  }
  return { kind: 'watch', plugin, number, channels }
}

export function parseCommands(text: string): Command[] {
  return splitCommands(text).map(parseCommand)
}

// ---- Apply -----------------------------------------------------------------

interface WatchSlice {
  watched?: WatchedEntry[]
}

function getSlice(config: OrchestratorConfig, plugin: WatchPlugin): WatchSlice {
  config.plugins ??= {}
  const existing = config.plugins[plugin]
  if (existing && typeof existing === 'object') return existing as WatchSlice
  const fresh: WatchSlice = {}
  config.plugins[plugin] = fresh
  return fresh
}

// One-line summary suitable for inclusion in the per-message confirmation
// DM. The handler concatenates these with `\n`.
export function applyCommand(config: OrchestratorConfig, cmd: Command): string {
  if (cmd.kind === 'help') return HELP_TEXT
  if (cmd.kind === 'list') return formatList(config)
  if (cmd.kind === 'unknown') return `error: ${cmd.error} (line: ${cmd.raw})`

  const slice = getSlice(config, cmd.plugin)
  slice.watched ??= []
  const watched = slice.watched
  const label = cmd.plugin === 'github-prs' ? 'pr' : 'issue'

  if (cmd.kind === 'watch') {
    let entry = watched.find(e => e.number === cmd.number)
    if (!entry) {
      entry = { number: cmd.number }
      if (cmd.channels.length) entry.channels = [...cmd.channels]
      watched.push(entry)
      return cmd.channels.length
        ? `watching ${label} #${cmd.number} + ${cmd.channels.join(' ')}`
        : `watching ${label} #${cmd.number}`
    }
    if (!cmd.channels.length) return `already watching ${label} #${cmd.number}`
    const existing = new Set(entry.channels ?? [])
    const added: string[] = []
    for (const c of cmd.channels) if (!existing.has(c)) { existing.add(c); added.push(c) }
    if (!added.length) return `${label} #${cmd.number} channels unchanged`
    entry.channels = [...existing]
    return `${label} #${cmd.number} + ${added.join(' ')}`
  }

  // unwatch
  const idx = watched.findIndex(e => e.number === cmd.number)
  if (idx < 0) return `not watching ${label} #${cmd.number}`
  watched.splice(idx, 1)
  return `unwatched ${label} #${cmd.number}`
}

// ---- watch list formatter --------------------------------------------------

export function formatList(config: OrchestratorConfig): string {
  const issues = (config.plugins?.['github-issues'] as WatchSlice | undefined)?.watched ?? []
  const prs = (config.plugins?.['github-prs'] as WatchSlice | undefined)?.watched ?? []

  const fmtEntry = (e: WatchedEntry): string => {
    const chans = e.channels?.length ? ` + ${e.channels.join(' ')}` : ''
    return `  #${e.number}${chans}`
  }

  const lines: string[] = []
  lines.push(`issues (${issues.length}):`)
  if (issues.length) for (const e of issues) lines.push(fmtEntry(e))
  else lines.push('  (none)')
  lines.push(`prs (${prs.length}):`)
  if (prs.length) for (const e of prs) lines.push(fmtEntry(e))
  else lines.push('  (none)')
  return lines.join('\n')
}

// ---- Allowlist -------------------------------------------------------------

// Resolves command_senders. Unset → `[leadPmNick(project)]` (see
// naming.ts:leadPmNick — the single source of truth for the convention).
// Explicit `[]` means nobody is allowed; everyone gets rejected silently
// past the initial DM reply. If project is unresolvable, falls back to
// `[]` and logs the cause so an operator chasing a "not authorized"
// reply can find the root cause in daemon.log.
export function resolveAllowlist(config: OrchestratorConfig, log?: (line: string) => void): string[] {
  const explicit = config.irc?.command_senders
  if (explicit !== undefined) return explicit
  try {
    return [leadPmNick(defaultProject(config))]
  } catch (e) {
    log?.(`dm-handler: cannot resolve default allowlist (no project/repo in config): ${e}`)
    return []
  }
}

// ---- Handler entry point ---------------------------------------------------

export interface InboundDm {
  sender: string
  text: string
}

// Top-level DM entry. Never throws — write/load failures are caught and
// posted to the project channel via deps.postProjectError so the operator
// notices a broken config.
//
// Read commands (help, list) and any-unknown batches short-circuit before
// mutateConfig so we don't acquire the writer queue for a pure read or a
// parse-failed message. Writes flow through mutateConfig as one atomic
// commit per DM — a multi-cmd message is one fsync, one reply.
export async function handleDm(deps: HandlerDeps, dm: InboundDm): Promise<void> {
  const senderLower = dm.sender.toLowerCase()
  const body = dm.text.trim()
  if (!body) return

  // Single loadConfig per DM. Used for allowlist + (if pure-read) for the
  // formatList payload. Writes re-load inside mutateConfig for freshness.
  let snapshot: OrchestratorConfig
  try {
    snapshot = await loadConfig(deps.stateDir)
  } catch (e) {
    deps.log(`dm-handler: config load failed for ${dm.sender}: ${e}`)
    deps.postProjectError(`[dispatcher_error] config load: ${e}`)
    return
  }

  const allowed = new Set(resolveAllowlist(snapshot, deps.log).map(n => n.toLowerCase()))
  if (!allowed.has(senderLower)) {
    deps.log(`dm-handler: rejecting ${dm.sender} (not in allowlist)`)
    deps.dm(dm.sender, 'not authorized; configure irc.command_senders')
    return
  }

  const cmds = parseCommands(body)
  if (cmds.length === 0) return

  // If any command failed to parse, report all parse errors and apply
  // nothing — a typo in one half of a multi-cmd DM shouldn't silently
  // commit the other half.
  const unknowns = cmds.filter((c): c is Extract<Command, { kind: 'unknown' }> => c.kind === 'unknown')
  if (unknowns.length) {
    for (const u of unknowns) deps.log(`dm-handler: ${dm.sender} parse: ${u.error}`)
    deps.dm(dm.sender, unknowns.map(u => `error: ${u.error}`).join('\n'))
    return
  }

  // Pure-read commands (help, list, or any mix of the two) don't need
  // the writer queue. Format directly from the snapshot — no fsync.
  if (cmds.every(c => c.kind === 'help' || c.kind === 'list')) {
    const replies = cmds.map(c => applyCommand(snapshot, c))
    for (const c of cmds) deps.log(`dm-handler: ${dm.sender} cmd=${c.kind}`)
    deps.dm(dm.sender, replies.join('\n'))
    return
  }

  // Write path. mutateConfig re-loads inside the mutex for freshness.
  const replies: string[] = []
  try {
    await mutateConfig(deps.stateDir, (config) => {
      for (const cmd of cmds) replies.push(applyCommand(config, cmd))
    })
  } catch (e) {
    deps.log(`dm-handler: mutateConfig failed for ${dm.sender}: ${e}`)
    deps.postProjectError(`[dispatcher_error] config write: ${e}`)
    deps.dm(dm.sender, `error: failed to update config — ${e}`)
    return
  }

  for (const cmd of cmds) {
    const summary = `cmd=${cmd.kind}${'plugin' in cmd ? ` plugin=${cmd.plugin}` : ''}${'number' in cmd ? ` n=${cmd.number}` : ''}`
    deps.log(`dm-handler: ${dm.sender} ${summary}`)
  }
  deps.dm(dm.sender, replies.join('\n'))
}
