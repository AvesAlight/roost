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

// Bare `<owner>/<repo>` used as the optional repo positional after a number
// in the per-N grammar (`watch pr 5 org/repo [#chan ...]`). The `/` is
// load-bearing for parser disambiguation — channels start with `#`, repo
// args contain `/`, numbers are all digits.
const OWNER_REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/

// Full repo-shape spec for the whole-repo grammar (`watch repo
// org/r[@branch[:path]]`). Branch defaults to the plugin's convention when
// omitted (github-commits uses `main`); path is optional. `@` separates
// branch from owner/repo to match the github-commits state-key shape
// (`<repo>@<branch>:<path>`) so log lines and DM input use the same string.
const REPO_SPEC_RE = /^([A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*)(?:@([^:@\s]+))?(?::([^\s]+))?$/

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

// Parses two grammar shapes after the verb:
//   per-N : `[target] <num> [<owner>/<repo>] [#chan ...]`  (watch/unwatch)
//   repo  : `[target] <owner>/<repo>[@<branch>[:<path>]] [#chan ...]`
// `target` is whatever non-numeric, non-repo-shape keyword precedes the spec
// (e.g. `pr`, `repo`, `new-issues`); plugins claim which keyword they own
// (including `null` for the bare form). Shape selection is driven by the
// spec token — a number emits `watch`/`unwatch`, a repo-shape token emits
// `watch-repo`/`unwatch-repo`.
function parseWatchOrUnwatch(raw: string, verb: 'watch' | 'unwatch', rest: string[]): Command {
  let target: string | null = null
  let i = 0
  // Optional target keyword: first token that is neither a number nor a
  // repo-shape spec. `repo`/`new-issues`/`pr`/etc. all flow through here —
  // the parser stays target-agnostic; plugins decide what they claim.
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

  // Repo-shape spec: `owner/repo[@branch][:path]`. Selected over number
  // when the token contains a `/`. Channels (which start with `#`) and
  // numbers can never match this pattern, so disambiguation is purely on
  // shape — no lookahead needed.
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

  // Optional repo positional after the number. Disambiguated from channels
  // by containing `/` (channels start with `#`); `@branch` and `:path`
  // are not allowed in this slot — per-N entries pin one PR/issue, not a
  // branch/path. Exactly one repo positional permitted.
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
function describeCommand(cmd: Extract<Command, { kind: 'watch' | 'unwatch' | 'watch-repo' | 'unwatch-repo' }>): string {
  const target = cmd.target ? `${cmd.target} ` : ''
  if (cmd.kind === 'watch-repo') return `watch ${target}<owner>/<repo>[@<branch>[:<path>]] [#chan ...]`
  if (cmd.kind === 'unwatch-repo') return `unwatch ${target}<owner>/<repo>[@<branch>[:<path>]]`
  const repoSlot = cmd.repo != null ? ' <owner>/<repo>' : ''
  return cmd.kind === 'watch'
    ? `watch ${target}<N>${repoSlot} [#chan ...]`
    : `unwatch ${target}<N>${repoSlot}`
}

// Ask every plugin to handle `cmd` against the merged config view, with
// `local` as the writable overlay. Returns the coalesced reply (or null if
// every plugin abstained — caller surfaces "no plugin handles ...").
// watch/unwatch should match exactly one plugin; list/help broadcast to
// all and join with `\n\n`.

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
  // Help always gets the dispatcher synopsis at the top so operators can
  // discover the grammar from one entry — per-plugin sections trail.
  if (cmd.kind === 'help') return [HELP_SYNOPSIS, ...replies].join('\n\n')
  if (replies.length === 0) return null
  // list broadcasts to all enabled plugins — separate sections with a
  // blank line so the output is readable when multiple plugins contribute.
  const sep = cmd.kind === 'list' ? '\n\n' : '\n'
  return replies.join(sep)
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
    // Strict invariant runs against tracked entries only; local overlay
    // entries are parser-validated on write. See Plugin.assertRepoMode docs.
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

  // Any parse failure aborts the batch — a typo shouldn't silently commit
  // the half that parsed. Report all parse errors in one reply.
  const unknowns = cmds.filter((c): c is Extract<Command, { kind: 'unknown' }> => c.kind === 'unknown')
  if (unknowns.length) {
    for (const u of unknowns) deps.log(`dispatcher-dm-handler: ${dm.sender} parse: ${u.error}`)
    deps.dm(dm.sender, unknowns.map(u => `error: ${u.error}`).join('\n'))
    return
  }

  const isPureRead = cmds.every(c => c.kind === 'list' || c.kind === 'help')

  // Pure-read path: route against the snapshot, no fsync. The local
  // overlay is also read-only here — list/help never mutate.
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

  // Write path: one mutateConfig call wraps the whole batch. We re-merge
  // base + local before each plugin call so in-batch mutations (e.g. two
  // `watch pr 5` lines in one DM) see prior writes when checking
  // idempotency.
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
