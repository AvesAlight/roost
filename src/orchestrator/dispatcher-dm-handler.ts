// Dispatcher DM handler: parses a small command grammar and routes parsed
// commands to plugins that opt in via `Plugin.handleCommand`. The parser
// only knows verbs (`watch`/`unwatch`/`list`/`help`) and a free-form target
// keyword; slice schemas, default targets, and reply phrasing all belong to
// plugins.
//
// All commands arrive via DM (msg.isDirect === true). The handler:
//   1. enforces an allowlist (config.irc.command_senders)
//   2. parses the message body into Command[] (multi-cmd per line is fine)
//   3. inside one mutateConfig pass, asks each plugin to handle each cmd
//   4. coalesces non-null plugin replies into ONE confirmation DM
//
// The handler never throws — parse failures abort the batch with a one-line
// DM, plugin.handleCommand throws bubble up as [dispatcher_error] on the
// project channel.

import { loadConfig, mutateConfig, type OrchestratorConfig } from './config.js'
import { apmNick, defaultProject, leadPmNick } from './naming.js'
import { assertRepoModeAll, type Plugin } from './plugin.js'

export type Command =
  | { kind: 'watch'; target: string | null; number: number; channels: string[] }
  | { kind: 'unwatch'; target: string | null; number: number }
  | { kind: 'list' }
  | { kind: 'help' }
  | { kind: 'unknown'; raw: string; error: string }

export interface HandlerDeps {
  stateDir: string
  // The enabled plugin set. Iterated for handleCommand routing. Built
  // once at daemon boot — plugins are stateless w.r.t. command handling.
  plugins: Plugin[]
  // Pure I/O — only the bits we need from RoostIrcClient.
  dm: (nick: string, text: string) => void
  postProjectError: (text: string) => void
  log: (line: string) => void
}

const CHANNEL_RE = /^#[^\s,#]+$/

// Verbs reserved for the dispatcher grammar — plugins can't override the
// surface, but they decide what each verb does for their slice.
const VERBS = new Set(['watch', 'unwatch', 'help'])

// ---- Parser ----------------------------------------------------------------

// Split a raw inbound body into individual command lines. Newlines,
// semicolons, and commas are all treated as separators.
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

  if (verb === 'help') {
    if (tokens.length > 1) return { kind: 'unknown', raw: line, error: `help takes no arguments; got "${tokens.slice(1).join(' ')}"` }
    return { kind: 'help' }
  }

  if (verb === 'watch' && tokens[1]?.toLowerCase() === 'list') {
    if (tokens.length > 2) return { kind: 'unknown', raw: line, error: `watch list takes no arguments; got "${tokens.slice(2).join(' ')}"` }
    return { kind: 'list' }
  }

  if (verb === 'watch') return parseWatchOrUnwatch(line, 'watch', tokens.slice(1))
  if (verb === 'unwatch') return parseWatchOrUnwatch(line, 'unwatch', tokens.slice(1))

  return { kind: 'unknown', raw: line, error: `unknown command: ${tokens[0]}` }
}

// Parses `[target] <num> [#chan ...]` for watch, `[target] <num>` for unwatch.
// `target` is whatever non-numeric keyword precedes the number (e.g. `pr`);
// plugins choose which target keyword they claim, including `null` for the
// bare form (no target keyword at all).
function parseWatchOrUnwatch(raw: string, verb: 'watch' | 'unwatch', rest: string[]): Command {
  let target: string | null = null
  let i = 0
  // First token: either the number (no target keyword) or a target keyword
  // followed by the number. `pr` today; future plugins (linear, etc.) can
  // claim other words without touching the parser.
  if (rest[0] !== undefined && !/^\d+$/.test(rest[0])) {
    if (VERBS.has(rest[0].toLowerCase())) {
      return { kind: 'unknown', raw, error: `${verb}: "${rest[0]}" is a reserved verb, not a target` }
    }
    target = rest[0].toLowerCase()
    i = 1
  }

  const numTok = rest[i]
  if (numTok === undefined) {
    return { kind: 'unknown', raw, error: `${verb} requires an issue/PR number` }
  }
  const number = parseInt(numTok, 10)
  if (number <= 0 || String(number) !== numTok) {
    return { kind: 'unknown', raw, error: `${verb}: "${numTok}" is not a positive integer` }
  }

  const channels = rest.slice(i + 1)
  if (verb === 'unwatch') {
    if (channels.length) {
      return { kind: 'unknown', raw, error: 'unwatch takes no channel arguments' }
    }
    return { kind: 'unwatch', target, number }
  }

  for (const c of channels) {
    if (!CHANNEL_RE.test(c)) {
      return { kind: 'unknown', raw, error: `channels must match ${CHANNEL_RE.source}: got "${c}"` }
    }
  }
  return { kind: 'watch', target, number, channels }
}

export function parseCommands(text: string): Command[] {
  return splitCommands(text).map(parseCommand)
}

// ---- Allowlist -------------------------------------------------------------

// Resolves command_senders. Unset → `[leadPmNick(project), apmNick(project)]`
// (see naming.ts — single source of truth for the convention). Both lead and
// APM are documented team members that need DM access; trusting both by
// default avoids respawning a lead just to flip an unwatch.
// Explicit `[]` means nobody is allowed. If project is unresolvable, falls
// back to `[]` and logs the cause so an operator chasing a "not authorized"
// reply can find the root cause in daemon.log.
export function resolveAllowlist(config: OrchestratorConfig, log?: (line: string) => void): string[] {
  const explicit = config.irc?.command_senders
  if (explicit !== undefined) return explicit
  try {
    const project = defaultProject(config)
    return [leadPmNick(project), apmNick(project)]
  } catch (e) {
    log?.(`dispatcher-dm-handler: cannot resolve default allowlist (no project/repo in config): ${e}`)
    return []
  }
}

// ---- Routing ---------------------------------------------------------------

// One DM-able description of a watch/unwatch the parser produced, used
// only in the "no plugin handles..." reply. Matches the user's input shape.
function describeCommand(cmd: Extract<Command, { kind: 'watch' | 'unwatch' }>): string {
  const target = cmd.target ? `${cmd.target} ` : ''
  return cmd.kind === 'watch'
    ? `watch ${target}<N> [#chan ...]`
    : `unwatch ${target}<N>`
}

// Ask every plugin to handle `cmd` against the (in-progress) config.
// Returns the coalesced reply (or null if every plugin abstained — caller
// surfaces "no plugin handles ..."). watch/unwatch should match exactly
// one plugin; list/help broadcast to all and join with `\n\n`.
async function routeOne(
  config: OrchestratorConfig,
  cmd: Command,
  plugins: Plugin[],
): Promise<string | null> {
  if (cmd.kind === 'unknown') return `error: ${cmd.error}`
  const replies: string[] = []
  for (const p of plugins) {
    const reply = await p.handleCommand?.(config, cmd)
    if (reply !== null && reply !== undefined) replies.push(reply)
  }
  if (replies.length === 0) return null
  // list/help broadcast to all enabled plugins — separate sections with a
  // blank line so the output is readable when multiple plugins contribute.
  const sep = cmd.kind === 'list' || cmd.kind === 'help' ? '\n\n' : '\n'
  return replies.join(sep)
}

function unmatchedReply(cmd: Extract<Command, { kind: 'watch' | 'unwatch' }>, plugins: Plugin[]): string {
  const names = plugins.map(p => p.name).sort().join(', ') || '(none)'
  return `error: no plugin handles \`${describeCommand(cmd)}\` — enabled plugins: ${names}`
}

// ---- Handler entry point ---------------------------------------------------

export interface InboundDm {
  sender: string
  text: string
}

// Top-level DM entry. Never throws — load/write/handler failures are caught
// and surfaced via deps.postProjectError + a DM to the sender so the
// operator notices a broken handler.
//
// Read-only batches (only list/help/unknown) short-circuit before
// mutateConfig so we don't acquire the writer queue or pay an fsync.
export async function handleDm(deps: HandlerDeps, dm: InboundDm): Promise<void> {
  const senderLower = dm.sender.toLowerCase()
  const body = dm.text.trim()
  if (!body) return

  let snapshot: OrchestratorConfig
  try {
    snapshot = await loadConfig(deps.stateDir)
    assertRepoModeAll(deps.plugins, snapshot)
  } catch (e) {
    deps.log(`dispatcher-dm-handler: config load failed for ${dm.sender}: ${e}`)
    deps.postProjectError(`[dispatcher_error] config load: ${e}`)
    return
  }

  const allowed = new Set(resolveAllowlist(snapshot, deps.log).map(n => n.toLowerCase()))
  if (!allowed.has(senderLower)) {
    deps.log(`dispatcher-dm-handler: rejecting ${dm.sender} (not in allowlist)`)
    deps.dm(dm.sender, 'not authorized; configure irc.command_senders')
    return
  }

  const cmds = parseCommands(body)
  if (cmds.length === 0) return

  // Any parse failure aborts the batch — a typo shouldn't silently commit
  // the half that parsed. Report all parse errors in one reply.
  const unknowns = cmds.filter((c): c is Extract<Command, { kind: 'unknown' }> => c.kind === 'unknown')
  if (unknowns.length) {
    for (const u of unknowns) deps.log(`dispatcher-dm-handler: ${dm.sender} parse: ${u.error}`)
    deps.dm(dm.sender, unknowns.map(u => `error: ${u.error}`).join('\n'))
    return
  }

  const isPureRead = cmds.every(c => c.kind === 'list' || c.kind === 'help')

  // Pure-read path: route against the snapshot, no fsync.
  if (isPureRead) {
    const replies: string[] = []
    for (const cmd of cmds) {
      try {
        const reply = await routeOne(snapshot, cmd, deps.plugins)
        if (reply !== null) replies.push(reply)
        deps.log(`dispatcher-dm-handler: ${dm.sender} cmd=${cmd.kind}`)
      } catch (e) {
        deps.log(`dispatcher-dm-handler: handler threw on ${cmd.kind} from ${dm.sender}: ${e}`)
        deps.postProjectError(`[dispatcher_error] handleCommand(${cmd.kind}): ${e}`)
        replies.push(`error: handler crashed on ${cmd.kind}`)
      }
    }
    if (replies.length) deps.dm(dm.sender, replies.join('\n\n'))
    return
  }

  // Write path: one mutateConfig call wraps the whole batch.
  const replies: string[] = []
  let writeFailed = false
  try {
    await mutateConfig(deps.stateDir, async (config) => {
      for (const cmd of cmds) {
        try {
          const reply = await routeOne(config, cmd, deps.plugins)
          if (reply !== null) {
            replies.push(reply)
          } else if (cmd.kind === 'watch' || cmd.kind === 'unwatch') {
            replies.push(unmatchedReply(cmd, deps.plugins))
          }
        } catch (e) {
          deps.log(`dispatcher-dm-handler: handler threw on ${cmd.kind} from ${dm.sender}: ${e}`)
          deps.postProjectError(`[dispatcher_error] handleCommand(${cmd.kind}): ${e}`)
          replies.push(`error: handler crashed on ${cmd.kind}`)
        }
      }
    })
  } catch (e) {
    writeFailed = true
    deps.log(`dispatcher-dm-handler: mutateConfig failed for ${dm.sender}: ${e}`)
    deps.postProjectError(`[dispatcher_error] config write: ${e}`)
    deps.dm(dm.sender, `error: failed to update config — ${e}`)
  }

  if (writeFailed) return
  for (const cmd of cmds) {
    const summary = `cmd=${cmd.kind}${'target' in cmd ? ` target=${cmd.target ?? '(default)'}` : ''}${'number' in cmd ? ` n=${cmd.number}` : ''}`
    deps.log(`dispatcher-dm-handler: ${dm.sender} ${summary}`)
  }
  deps.dm(dm.sender, replies.join('\n\n'))
}
