// Dispatcher DM handler. Parses a small command grammar and routes commands
// to plugins via `Plugin.handleCommand`. The parser knows only verbs and a
// free-form target keyword; slice schemas + reply phrasing belong to plugins.
//
// Per DM: allowlist-check → parse → run each cmd inside one mutateConfig pass
// → coalesce replies into one DM. Never throws — parse failures abort with a
// one-line DM, plugin throws bubble up as [dispatcher_error] on the project channel.

import { loadConfig, loadConfigBase, loadLocalOverlay, mergeConfigs, mutateConfig, type OrchestratorConfig } from './config.js'
import { apmNick, defaultProject, leadPmNick } from './naming.js'
import { assertRepoModeAll, type Plugin } from './plugin.js'

export type Command =
  | { kind: 'watch'; target: string | null; number: number; repo: string | null; channels: string[] }
  | { kind: 'unwatch'; target: string | null; number: number; repo: string | null }
  | { kind: 'watch-repo'; target: string | null; repo: string; branch: string | null; path: string | null; channels: string[] }
  | { kind: 'unwatch-repo'; target: string | null; repo: string; branch: string | null; path: string | null }
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

// Bare `<owner>/<repo>` — the optional repo positional after a number in the
// per-N grammar. Disambiguated from channels (start with `#`) and numbers
// (all digits) purely on shape.
const OWNER_REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/

// Full repo-shape spec for the whole-repo grammar — `org/r[@branch[:path]]`.
// Mirrors github-commits' state key so daemon.log lines copy-paste into a DM.
const REPO_SPEC_RE = /^([A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*)(?:@([^:@\s]+))?(?::([^\s]+))?$/

// Reserved verbs — plugins can't shadow these as targets.
const VERBS = new Set(['watch', 'unwatch', 'help'])

// ---- Parser ----------------------------------------------------------------

// Split a body into command lines. Newlines, semicolons, and commas separate.
export function splitCommands(text: string): string[] {
  return text
    .split(/[\n;,]+/)
    .map(s => s.trim())
    .filter(Boolean)
}

// Returns `unknown` rather than throwing so the handler can DM a hint and continue.
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

// Two shapes after the verb:
//   per-N : `[target] <num> [<owner>/<repo>] [#chan ...]`
//   repo  : `[target] <owner>/<repo>[@<branch>[:<path>]] [#chan ...]`
// `target` is whatever non-numeric, non-repo-shape keyword precedes the spec;
// plugins claim what they own. The spec token shape selects per-N vs repo emission.
function parseWatchOrUnwatch(raw: string, verb: 'watch' | 'unwatch', rest: string[]): Command {
  let target: string | null = null
  let i = 0
  const first = rest[0]
  if (first !== undefined && !/^\d+$/.test(first) && !REPO_SPEC_RE.test(first)) {
    if (VERBS.has(first.toLowerCase())) {
      return { kind: 'unknown', raw, error: `${verb}: "${first}" is a reserved verb, not a target` }
    }
    target = first.toLowerCase()
    i = 1
  }

  const specTok = rest[i]
  if (specTok === undefined) {
    return { kind: 'unknown', raw, error: `${verb} requires an issue/PR number or <owner>/<repo> spec` }
  }

  // Repo-shape: `owner/repo[@branch][:path]`. Picked when the token contains a `/`.
  const repoMatch = specTok.match(REPO_SPEC_RE)
  if (repoMatch) {
    const repo = repoMatch[1]
    const branch = repoMatch[2] ?? null
    const path = repoMatch[3] ?? null
    const channels = rest.slice(i + 1)
    if (verb === 'unwatch') {
      if (channels.length) {
        return { kind: 'unknown', raw, error: 'unwatch takes no channel arguments' }
      }
      return { kind: 'unwatch-repo', target, repo, branch, path }
    }
    for (const c of channels) {
      if (!CHANNEL_RE.test(c)) {
        return { kind: 'unknown', raw, error: `channels must match ${CHANNEL_RE.source}: got "${c}"` }
      }
    }
    return { kind: 'watch-repo', target, repo, branch, path, channels }
  }

  // Number-shape spec.
  const number = parseInt(specTok, 10)
  if (number <= 0 || String(number) !== specTok) {
    return { kind: 'unknown', raw, error: `${verb}: "${specTok}" is not a positive integer or <owner>/<repo> spec` }
  }
  i += 1

  // Optional repo positional after the number — `@branch`/`:path` not allowed here.
  let repo: string | null = null
  if (rest[i] !== undefined && OWNER_REPO_RE.test(rest[i])) {
    repo = rest[i]
    i += 1
  }

  const channels = rest.slice(i)
  if (verb === 'unwatch') {
    if (channels.length) {
      return { kind: 'unknown', raw, error: 'unwatch takes no channel arguments' }
    }
    return { kind: 'unwatch', target, number, repo }
  }

  for (const c of channels) {
    if (!CHANNEL_RE.test(c)) {
      return { kind: 'unknown', raw, error: `channels must match ${CHANNEL_RE.source}: got "${c}"` }
    }
  }
  return { kind: 'watch', target, number, repo, channels }
}

export function parseCommands(text: string): Command[] {
  return splitCommands(text).map(parseCommand)
}

// ---- Allowlist -------------------------------------------------------------

// Unset → `[leadPmNick(project), apmNick(project)]`. Explicit `[]` rejects all.
// Unresolvable project → `[]` + log line so a "not authorized" reply is traceable.
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

// Synopsis of the user's input shape — used only in the "no plugin handles..." reply.
function describeCommand(cmd: Extract<Command, { kind: 'watch' | 'unwatch' | 'watch-repo' | 'unwatch-repo' }>): string {
  const target = cmd.target ? `${cmd.target} ` : ''
  if (cmd.kind === 'watch-repo') return `watch ${target}<owner>/<repo>[@<branch>[:<path>]] [#chan ...]`
  if (cmd.kind === 'unwatch-repo') return `unwatch ${target}<owner>/<repo>[@<branch>[:<path>]]`
  const repoSlot = cmd.repo != null ? ' <owner>/<repo>' : ''
  return cmd.kind === 'watch'
    ? `watch ${target}<N>${repoSlot} [#chan ...]`
    : `unwatch ${target}<N>${repoSlot}`
}

// watch/unwatch match exactly one plugin; list/help broadcast and join with `\n\n`.

const HELP_SYNOPSIS = [
  'dispatcher DM grammar (one per line, or `;`/`,`-separated):',
  '  watch [<target>] <N> [<owner>/<repo>] [#chan ...]',
  '  unwatch [<target>] <N> [<owner>/<repo>]',
  '  watch <target> <owner>/<repo>[@<branch>[:<path>]] [#chan ...]',
  '  unwatch <target> <owner>/<repo>[@<branch>[:<path>]]',
  '  watch list                 — every plugin\'s active entries',
  '  help                       — this synopsis + per-plugin commands',
  '',
  '<target> is plugin-claimed (`pr`, `repo`, `new-issues`, …). per-plugin help:',
].join('\n')

async function routeOne(
  merged: OrchestratorConfig,
  local: OrchestratorConfig,
  cmd: Command,
  plugins: Plugin[],
): Promise<string | null> {
  if (cmd.kind === 'unknown') return `error: ${cmd.error}`
  const replies: string[] = []
  for (const p of plugins) {
    const reply = await p.handleCommand?.(merged, local, cmd)
    if (reply !== null && reply !== undefined) replies.push(reply)
  }
  // help leads with the dispatcher synopsis; per-plugin sections trail.
  if (cmd.kind === 'help') return [HELP_SYNOPSIS, ...replies].join('\n\n')
  if (replies.length === 0) return null
  return replies.join(cmd.kind === 'list' ? '\n\n' : '\n')
}

function unmatchedReply(cmd: Extract<Command, { kind: 'watch' | 'unwatch' | 'watch-repo' | 'unwatch-repo' }>, plugins: Plugin[]): string {
  const names = plugins.map(p => p.name).sort().join(', ') || '(none)'
  return `error: no plugin handles \`${describeCommand(cmd)}\` — enabled plugins: ${names}`
}

// ---- Handler entry point ---------------------------------------------------

export interface InboundDm {
  sender: string
  text: string
}

// Top-level DM entry. Never throws — failures land on deps.postProjectError +
// a DM to the sender. Read-only batches (list/help only) short-circuit
// mutateConfig to skip the writer queue and fsync.
export async function handleDm(deps: HandlerDeps, dm: InboundDm): Promise<void> {
  const senderLower = dm.sender.toLowerCase()
  const body = dm.text.trim()
  if (!body) return

  let snapshot: OrchestratorConfig
  try {
    snapshot = await loadConfig(deps.stateDir)
    // Tracked-only; see `Plugin.assertRepoMode` for rationale.
    assertRepoModeAll(deps.plugins, await loadConfigBase(deps.stateDir))
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

  // Any parse failure aborts the batch — a typo shouldn't half-commit.
  const unknowns = cmds.filter((c): c is Extract<Command, { kind: 'unknown' }> => c.kind === 'unknown')
  if (unknowns.length) {
    for (const u of unknowns) deps.log(`dispatcher-dm-handler: ${dm.sender} parse: ${u.error}`)
    deps.dm(dm.sender, unknowns.map(u => `error: ${u.error}`).join('\n'))
    return
  }

  const isPureRead = cmds.every(c => c.kind === 'list' || c.kind === 'help')

  // No fsync, no writer queue — list/help never mutate.
  if (isPureRead) {
    let localSnapshot: OrchestratorConfig
    try {
      localSnapshot = await loadLocalOverlay(deps.stateDir)
    } catch (e) {
      deps.log(`dispatcher-dm-handler: local overlay load failed for ${dm.sender}: ${e}`)
      deps.postProjectError(`[dispatcher_error] config.local load: ${e}`)
      return
    }
    const replies: string[] = []
    for (const cmd of cmds) {
      try {
        const reply = await routeOne(snapshot, localSnapshot, cmd, deps.plugins)
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

  // One mutateConfig wraps the whole batch. Re-merge base+local before each
  // plugin call so in-batch mutations see prior writes for idempotency.
  const replies: string[] = []
  let writeFailed = false
  try {
    await mutateConfig(deps.stateDir, async (base, local) => {
      for (const cmd of cmds) {
        const merged = mergeConfigs(base, local)
        try {
          const reply = await routeOne(merged, local, cmd, deps.plugins)
          if (reply !== null) {
            replies.push(reply)
          } else if (cmd.kind === 'watch' || cmd.kind === 'unwatch' || cmd.kind === 'watch-repo' || cmd.kind === 'unwatch-repo') {
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
    const parts = [`cmd=${cmd.kind}`]
    if ('target' in cmd) parts.push(`target=${cmd.target ?? '(default)'}`)
    if ('number' in cmd) parts.push(`n=${cmd.number}`)
    if ('repo' in cmd && cmd.repo) parts.push(`repo=${cmd.repo}`)
    if ('branch' in cmd && cmd.branch) parts.push(`branch=${cmd.branch}`)
    if ('path' in cmd && cmd.path) parts.push(`path=${cmd.path}`)
    deps.log(`dispatcher-dm-handler: ${dm.sender} ${parts.join(' ')}`)
  }
  deps.dm(dm.sender, replies.join('\n\n'))
}
