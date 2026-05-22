// Dispatcher DM handler. Parses two global verbs (`help`, `watch list`) and
// hands every other line to plugins in `grammarPriority` order — first
// non-null claim wins. The dispatcher carries the claimed payload back to the
// same plugin's `handleCommand` unchanged; the central code never inspects it.
//
// Per DM: allowlist-check → parse → run each cmd inside one mutateConfig pass
// → coalesce replies into one DM. Never throws — parse failures abort with a
// one-line DM, plugin throws bubble up as [dispatcher_error] on the project channel.

import { loadConfig, loadConfigBase, loadLocalOverlay, mergeConfigs, mutateConfig, type OrchestratorConfig } from './config.js'
import { apmNick, defaultProject, leadPmNick } from './naming.js'
import { assertRepoModeAll, priorityOf, registeredPlugins, type Plugin } from './plugin.js'
import { splitCommands } from './plugins/grammar.js'

// `plugin` carries an opaque cmd payload — the plugin that produced it is the
// only one that handles it. `list` / `help` broadcast to every plugin.
// `raw` on `plugin` is the original DM line, injected by the dispatcher at
// parse time so daemon.log entries show what the operator actually typed.
export type Command =
  | { kind: 'plugin'; plugin: string; cmd: unknown; raw: string }
  | { kind: 'list' }
  | { kind: 'help' }
  | { kind: 'help-plugins' }
  | { kind: 'unknown'; raw: string; error: string }

export interface HandlerDeps {
  stateDir: string
  // The enabled plugin set. Iterated for parseCommand and handleCommand
  // routing. Built once at daemon boot — plugins are stateless w.r.t.
  // command handling.
  plugins: Plugin[]
  // Pure I/O — only the bits we need from RoostIrcClient.
  dm: (nick: string, text: string) => void
  postProjectError: (text: string) => void
  log: (line: string) => void
}

// Reserved verbs — operators occasionally typo `watch unwatch 5`. Surfacing
// "reserved verb" beats the generic "no plugin handles" because plugins'
// parsers defer on this shape (their target doesn't match) — without this
// pre-check the error would lose information.
const RESERVED_TARGETS = new Set(['watch', 'unwatch', 'help'])

// ---- Parser ----------------------------------------------------------------

// Sort plugins for parse-claim iteration: higher grammarPriority first, ties
// resolved by the original `plugins` array order (which mirrors
// `config.plugins` Object.keys order). Operator overrides via
// `config.plugin_priorities[name]` replace the static value outright.
function priorityOrder(plugins: Plugin[], config: OrchestratorConfig): Plugin[] {
  return [...plugins]
    .map((p, idx) => ({ p, idx, pri: priorityOf(p, config) }))
    .sort((a, b) => b.pri - a.pri || a.idx - b.idx)
    .map(x => x.p)
}

// Parse a single line. Global verbs (`help`, `watch list`) stay central;
// everything else is offered to plugins in priority order. The first plugin
// to return a non-null result wins — `{kind:'error'}` aborts (no other
// plugin gets a second crack at the same shape; see `Plugin.parseCommand`).
export function parseCommand(line: string, plugins: Plugin[], config: OrchestratorConfig): Command {
  const tokens = line.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return { kind: 'unknown', raw: line, error: 'empty command' }
  const verb = tokens[0].toLowerCase()

  if (verb === 'help') {
    if (tokens.length === 1) return { kind: 'help' }
    if (tokens.length === 2 && tokens[1].toLowerCase() === 'plugins') return { kind: 'help-plugins' }
    return { kind: 'unknown', raw: line, error: `help takes no arguments (or "help plugins"); got "${tokens.slice(1).join(' ')}"` }
  }

  if (verb === 'watch' && tokens[1]?.toLowerCase() === 'list') {
    if (tokens.length > 2) return { kind: 'unknown', raw: line, error: `watch list takes no arguments; got "${tokens.slice(2).join(' ')}"` }
    return { kind: 'list' }
  }

  if (verb === 'watch' || verb === 'unwatch') {
    const second = tokens[1]?.toLowerCase()
    if (second !== undefined && RESERVED_TARGETS.has(second)) {
      return { kind: 'unknown', raw: line, error: `${verb}: "${tokens[1]}" is a reserved verb, not a target` }
    }
    for (const p of priorityOrder(plugins, config)) {
      const result = p.parseCommand?.(line)
      if (result == null) continue
      if (result.kind === 'error') return { kind: 'unknown', raw: line, error: result.message }
      return { kind: 'plugin', plugin: p.name, cmd: result.cmd, raw: line }
    }
    const names = plugins.map(p => p.name).sort().join(', ') || '(none)'
    return { kind: 'unknown', raw: line, error: `no plugin handles \`${line}\` — enabled plugins: ${names}` }
  }

  return { kind: 'unknown', raw: line, error: `unknown command: ${tokens[0]}` }
}

export function parseCommands(text: string, plugins: Plugin[], config: OrchestratorConfig): Command[] {
  return splitCommands(text).map(line => parseCommand(line, plugins, config))
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

const HELP_SYNOPSIS = [
  'dispatcher DM grammar (one per line, or `;`/`,`-separated):',
  '  watch list                 — every plugin\'s active entries',
  '  help                       — this synopsis + per-plugin commands',
  '  help plugins               — all registered plugin classes (enabled or not)',
  '',
  'plugins claim their own watch/unwatch shapes; per-plugin grammar:',
].join('\n')

async function routeOne(
  merged: OrchestratorConfig,
  local: OrchestratorConfig,
  cmd: Command,
  plugins: Plugin[],
): Promise<string | null> {
  if (cmd.kind === 'unknown') return `error: ${cmd.error}`

  if (cmd.kind === 'help-plugins') {
    const plugins = registeredPlugins().sort((a, b) => a.name.localeCompare(b.name))
    const header = `registered plugins (${plugins.length}):`
    if (!plugins.length) return `${header}\n  (none)`
    const lines = plugins.map(p => p.description ? `  ${p.name} — ${p.description}` : `  ${p.name}`)
    return [header, ...lines].join('\n')
  }

  // list/help broadcast — every plugin contributes its own section.
  if (cmd.kind === 'list' || cmd.kind === 'help') {
    const replies: string[] = []
    for (const p of plugins) {
      const reply = await p.handleCommand?.(merged, local, cmd)
      if (reply !== null && reply !== undefined) replies.push(reply)
    }
    if (cmd.kind === 'help') return [HELP_SYNOPSIS, ...replies].join('\n\n')
    return replies.join('\n\n')
  }

  // Plugin-claimed: route back to the exact plugin that parsed it.
  const owner = plugins.find(p => p.name === cmd.plugin)
  if (!owner) return `error: plugin ${cmd.plugin} not registered (parse-time claim, runtime miss)`
  const reply = await owner.handleCommand?.(merged, local, cmd)
  return reply ?? null
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

  const cmds = parseCommands(body, deps.plugins, snapshot)
  if (cmds.length === 0) return

  // Any parse failure aborts the batch — a typo shouldn't half-commit.
  const unknowns = cmds.filter((c): c is Extract<Command, { kind: 'unknown' }> => c.kind === 'unknown')
  if (unknowns.length) {
    for (const u of unknowns) deps.log(`dispatcher-dm-handler: ${dm.sender} parse: ${u.error} raw=${JSON.stringify(u.raw)}`)
    deps.dm(dm.sender, unknowns.map(u => `error: ${u.error}`).join('\n'))
    return
  }

  const isPureRead = cmds.every(c => c.kind === 'list' || c.kind === 'help' || c.kind === 'help-plugins')

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
          if (reply !== null) replies.push(reply)
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
    if (cmd.kind === 'plugin') parts.push(`plugin=${cmd.plugin}`, `raw=${JSON.stringify(cmd.raw)}`)
    deps.log(`dispatcher-dm-handler: ${dm.sender} ${parts.join(' ')}`)
  }
  deps.dm(dm.sender, replies.join('\n\n'))
}
