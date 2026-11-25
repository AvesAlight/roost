#!/usr/bin/env bun
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { mkdir } from 'node:fs/promises'
import {
  loadConfig,
  loadConfigBase,
  loadState,
  writeState,
  writeHeartbeat,
  writeJoinedChannels,
  writeDispatcherPid,
  removeDispatcherPid,
  writeLastError,
  clearLastError,
  loadOutbox,
  writeOutbox,
  getPluginState,
  SCHEMA_VERSION,
  type OrchestratorConfig,
  type OrchestratorState,
} from './orchestrator/config.js'

import { dispatchMessages, connectAndWait } from './orchestrator/dispatch.js'
import { outboxMessages, nextOutbox } from './orchestrator/outbox.js'
import { assertRepoModeAll, defaultPluginLogger, type Plugin, type PluginLogger, type PluginMessage, type PluginTickResult } from './orchestrator/plugin.js'
import './orchestrator/registry.js'
import { LOOP_TICK_MS, anyPluginDue, defaultIntervalSeconds, pluginIntervalSeconds, pluginIsDue, type PluginSchedule } from './orchestrator/schedule.js'
import { buildPlugins } from './orchestrator/build-plugins.js'
import { loadExternalPlugins } from './orchestrator/load-external-plugins.js'
import { resolveProjectChannel, dispatcherNick, defaultProject } from './orchestrator/naming.js'
import { handleDm } from './orchestrator/dispatcher-dm-handler.js'
import { RoostIrcClientImpl } from './irc-client-impl.js'
import type { RoostIrcClient } from './irc-client.js'

const DEFAULT_STATE_DIR = join(process.cwd(), '.orchestrator')

interface TickResult {
  messages: PluginMessage[]
  channels: string[]
  // null when the tick failed and there's nothing to commit.
  state: OrchestratorState | null
}

// Boot dance shared by daemon / --dispatch-irc / one-shot: load config + external
// plugins, build the plugin set, and run the tracked-only repo-mode check.
async function loadConfigWithPlugins(
  stateDir: string,
  log: PluginLogger,
): Promise<{ config: OrchestratorConfig; plugins: Plugin[]; projectChannel: string }> {
  const config = await loadConfig(stateDir)
  const projectChannel = resolveProjectChannel(config)
  await loadExternalPlugins(stateDir, config.plugin_paths)
  const plugins = buildPlugins(config, projectChannel, log)
  assertRepoModeAll(plugins, await loadConfigBase(stateDir))
  return { config, plugins, projectChannel }
}

// Per-plugin try/catch is an outer backstop: individual plugins already
// isolate per-entry slug-derivation failures internally, but a failure before
// any per-entry loop runs (e.g. defaultProject) would otherwise escape here
// uncaught — this is called unguarded from both daemon boot and the
// tick-failure fallback path, and an uncaught throw here crashes the whole
// daemon and drops every joined channel.
function bootChannels(plugins: Plugin[], config: OrchestratorConfig, projectChannel: string, log: PluginLogger = defaultPluginLogger): string[] {
  const chans = new Set<string>([projectChannel])
  for (const plugin of plugins) {
    try {
      for (const c of plugin.desiredChannels(config)) chans.add(c)
    } catch (e) {
      log(`orchestrator: skipping channels for plugin ${plugin.name}: ${e}\n`)
    }
  }
  return [...chans].sort()
}

// Per-tick membership target: plugins' config-static channels (desiredChannels)
// unioned with this tick's dynamic channels (result.channels). Plugins that
// only join at boot (e.g. github-new-issues) return `channels: []` from every
// runTick, so without the desiredChannels half a tick-dynamic sibling losing
// interest in a channel would part it out from under a config-static plugin.
export function reconcileDesiredChannels(
  plugins: Plugin[],
  config: OrchestratorConfig,
  projectChannel: string,
  resultChannels: string[],
): string[] {
  return [...new Set<string>([...bootChannels(plugins, config, projectChannel), ...resultChannels])].sort()
}

// IRC client shape shared by daemon and --dispatch-irc.
function newIrcClient(nick: string, channels: string[]): RoostIrcClientImpl {
  return new RoostIrcClientImpl({
    nick,
    autoJoin: channels,
    historySize: 0,
    joinHistoryLines: 0,
    joinHistoryMinutes: 0,
  })
}

function requireIrcConfig(config: OrchestratorConfig, mode: string): { nick: string; server: string; port: number } {
  const ircCfg = config.irc ?? {}
  let nick = ircCfg.nick
  if (!nick) {
    try { nick = dispatcherNick(defaultProject(config)) } catch { /* no project or repo */ }
  }
  if (!nick) throw new Error(`${mode} requires irc.nick, project, or repo in config`)
  return { nick, server: ircCfg.server ?? '127.0.0.1', port: ircCfg.port ?? 6667 }
}

export async function runOneTick(
  stateDir: string,
  config: OrchestratorConfig,
  plugins: Plugin[],
  // deferCommit: the caller runs commitTick itself, after delivery. Writing
  // state first marks events seen before they're posted, so a failed post
  // loses them for good.
  opts: { seed: boolean; dryRun: boolean; deferCommit?: boolean },
  log: PluginLogger = defaultPluginLogger,
  // Daemon-only. With a schedule, a plugin whose `plugins.<name>.interval_seconds`
  // hasn't elapsed since its last run sits this tick out. Without one every
  // plugin runs, which is what the one-shot modes want.
  schedule?: Map<string, PluginSchedule>,
  now: number = Date.now(),
): Promise<TickResult> {
  const prev = opts.seed ? null : await loadState(stateDir)
  const curState: OrchestratorState = {
    schema_version: SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    plugins: {},
  }

  const allMessages: PluginMessage[] = []
  const allChannels = new Set<string>()

  // Plugins share GH rate limits but no in-process state — parallel-safe, so
  // they still run concurrently. Each runTick is isolated so one plugin
  // crashing can't reject the whole batch and drop every plugin's messages
  // for the tick: a thrown plugin preserves its prevState, emits no messages,
  // and is logged; siblings still dispatch. Mirrors bootChannels' per-plugin
  // try/catch. A crashed plugin's config-static channels are still reconciled
  // via desiredChannels (in bootChannels). Its scraped-dynamic channels carry
  // over from its last good run when a schedule is passed; without one (the
  // one-shot modes) they are lost for the tick, which is moot since it
  // couldn't scrape.
  const results = await Promise.all(
    plugins.map(async (plugin): Promise<{ plugin: Plugin; result: PluginTickResult }> => {
      const prevState = getPluginState<unknown>(prev, plugin.name)
      if (schedule && !pluginIsDue(schedule, plugin.name, pluginIntervalSeconds(config, plugin.name, log), now)) {
        return { plugin, result: { state: prevState, messages: [], channels: schedule.get(plugin.name)?.channels ?? [] } }
      }
      try {
        const result = await plugin.runTick(config, prevState)
        schedule?.set(plugin.name, { lastRun: now, channels: result.channels })
        return { plugin, result }
      } catch (e) {
        const carried = schedule?.get(plugin.name)?.channels ?? []
        schedule?.set(plugin.name, { lastRun: now, channels: carried })
        const detail = e instanceof Error ? e.stack ?? e.message : String(e)
        log(`orchestrator: plugin ${plugin.name} tick crashed: ${detail}\n`)
        return { plugin, result: { state: prevState, messages: [], channels: carried } }
      }
    })
  )
  for (const { plugin, result } of results) {
    curState.plugins[plugin.name] = result.state
    allMessages.push(...result.messages)
    for (const c of result.channels) allChannels.add(c)
  }

  if (!opts.dryRun && !opts.deferCommit) await commitTick(stateDir, curState)

  return { messages: allMessages, channels: [...allChannels], state: curState }
}

export async function commitTick(stateDir: string, state: OrchestratorState): Promise<void> {
  await writeState(stateDir, state)
  await writeHeartbeat(stateDir)
  await clearLastError(stateDir)
}

// `first` leads the list. Under a per-client channel limit, whichever JOINs
// arrive last are the ones rejected, so the channel that carries
// [dispatcher_error] notices has to go first.
export function withFirst(first: string, channels: Iterable<string>): string[] {
  return [first, ...[...channels].filter(c => c !== first)]
}

// Joins every desired channel the client isn't in, `first` before the rest.
// Returns the rejected ones with the server's reason. Callers must not trust
// `desired` as the joined set. A join dropped by a disconnect isn't a
// rejection: it stops the pass and isn't reported. `complete` is false then.
export async function joinDesired(
  client: Pick<RoostIrcClient, 'isJoined' | 'join'>,
  desired: Iterable<string>,
  first?: string,
): Promise<{ failed: Map<string, string>; complete: boolean }> {
  const failed = new Map<string, string>()
  for (const ch of first ? withFirst(first, desired) : desired) {
    if (client.isJoined(ch)) continue
    const r = await client.join(ch)
    if (r.ok) continue
    if (r.reason === 'disconnected') return { failed, complete: false }
    failed.set(ch, r.reason ?? 'unknown')
  }
  return { failed, complete: true }
}

// Posts this tick's messages plus anything queued from earlier ticks, then
// rewrites the outbox with whatever still couldn't go out. Run before
// commitTick: if the process dies in between, events re-derive and repeat
// rather than vanish.
export async function deliver(
  stateDir: string,
  client: RoostIrcClient,
  fresh: PluginMessage[],
  desired: ReadonlySet<string>,
  log: PluginLogger,
): Promise<{ posted: number; held: number; failures: string[] }> {
  const queued = outboxMessages(await loadOutbox(stateDir, log), desired)
  for (const e of queued.dropped) log(`orchestrator: outbox drop ${e.channel} (no longer watched), queued ${e.queued_at}\n`)
  const outcome = await dispatchMessages([...queued.messages, ...fresh], client)
  const next = nextOutbox(queued.kept, outcome.held, new Date().toISOString())
  for (const [ch, n] of next.overflow) log(`orchestrator: outbox full for ${ch}, dropped ${n} oldest message(s)\n`)
  await writeOutbox(stateDir, next.entries)
  return { posted: outcome.posted, held: next.entries.length, failures: outcome.failures }
}

async function runDaemon(stateDir: string): Promise<void> {
  await mkdir(stateDir, { recursive: true })
  const logWriter = Bun.file(join(stateDir, 'daemon.log')).writer()
  const log = (msg: string) => {
    process.stderr.write(msg)
    logWriter.write(msg)
    logWriter.flush()
  }

  // In-daemon source of truth for "this dispatcher owns this stateDir";
  // bin/start-dispatcher has a cheaper exclusive-create lock for the front-door check.
  const pidInfo = await writeDispatcherPid(stateDir)
  log(`orchestrator[daemon]: pid ${pidInfo.pid} written to ${stateDir}/dispatcher.pid\n`)

  const { config: initialConfig, plugins, projectChannel } = await loadConfigWithPlugins(stateDir, log)
  let config = initialConfig
  const { nick, server, port } = requireIrcConfig(config, 'daemon mode')
  const interval = defaultIntervalSeconds(config) * 1000
  const initialChannels = bootChannels(plugins, config, projectChannel, log)
  log(`orchestrator[daemon]: starting nick=${nick} server=${server}:${port} channels=${initialChannels.join(',')} interval=${interval / 1000}s\n`)

  const bootOrder = withFirst(projectChannel, initialChannels)
  const client = newIrcClient(nick, bootOrder)
  await connectAndWait(client, { host: server, port, nick, autoReconnect: true, autoReconnectMaxRetries: 30 }, bootOrder)
  log('orchestrator[daemon]: connected\n')

  const trySay = (ch: string, text: string) => {
    try { client.say(ch, text) } catch { /* best-effort */ }
  }
  // A post to the project channel while the dispatcher isn't in it goes
  // nowhere, so the notice falls back to daemon.log.
  const notifyProject = (text: string) => {
    if (client.isJoined(projectChannel)) trySay(projectChannel, text)
    else log(`orchestrator[daemon]: not in ${projectChannel}, notice not posted: ${text}\n`)
  }

  const dmHandlerDeps = {
    stateDir,
    plugins,
    dm: (target: string, text: string) => {
      try { client.say(target, text) } catch (e) { log(`orchestrator[daemon]: dm reply failed: ${e}\n`) }
    },
    postProjectError: (text: string) => notifyProject(text),
    log: (line: string) => log(`${line}\n`),
  }

  client.on('message', (msg) => {
    if (!msg.isDirect) return
    handleDm(dmHandlerDeps, { sender: msg.sender, text: msg.text }).catch((e: unknown) => {
      log(`orchestrator[daemon]: dispatcher-dm-handler crashed: ${e}\n`)
    })
  })

  let stop = false
  const stopController = new AbortController()
  const handleStop = (sig: string) => {
    log(`orchestrator[daemon]: ${sig}, shutting down\n`)
    stop = true
    stopController.abort()
  }
  process.on('SIGTERM', () => handleStop('SIGTERM'))
  process.on('SIGINT', () => handleStop('SIGINT'))

  // Sleep that wakes immediately on SIGTERM/SIGINT instead of waiting out the full interval.
  const sleepInterruptible = (ms: number) =>
    new Promise<void>(resolve => {
      const timer = setTimeout(resolve, ms)
      stopController.signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
    })

  const tickOpts = { seed: false, dryRun: false, deferCommit: true }
  const pluginSchedule = new Map<string, PluginSchedule>()
  // Channel -> reason for joins that failed on the last complete pass. A
  // [dispatcher_error] posts when a channel starts failing or its reason
  // changes, not every tick.
  let unjoinable = new Map<string, string>()

  // The loop wakes every LOOP_TICK_MS but only does a full pass (config, state,
  // IRC sync, delivery, heartbeat) when a plugin is due, or the default interval
  // has gone by so outbox retries and the heartbeat keep their old cadence.
  let lastPass = 0
  while (!stop) {
    const tickStart = Date.now()
    if (!anyPluginDue(plugins, pluginSchedule, config, tickStart) && tickStart - lastPass < defaultIntervalSeconds(config) * 1000) {
      await sleepInterruptible(LOOP_TICK_MS)
      continue
    }
    lastPass = tickStart
    try {
      const next = await loadConfig(stateDir)
      assertRepoModeAll(plugins, await loadConfigBase(stateDir))
      config = next
    } catch (e) {
      log(`orchestrator[daemon]: config load failed: ${e}\n`)
    }

    let result: TickResult
    try {
      result = await runOneTick(stateDir, config, plugins, tickOpts, log, pluginSchedule, tickStart)
    } catch (e) {
      const msg = String(e)
      log(`orchestrator[daemon]: tick failed: ${msg}\n`)
      notifyProject(`[dispatcher_error] ${msg}`)
      // Fall back to the config-only channel view so a transient GH/scrape
      // blip doesn't part every #issue-N until the next success.
      result = { messages: [], channels: bootChannels(plugins, config, projectChannel, log), state: null }
    }

    // Reconcile IRC membership against plugins' desired set, then snapshot
    // what the client is actually in. A rejected join (e.g. the server's
    // per-client channel limit) leaves that channel out of the snapshot.
    const desired = new Set<string>(reconcileDesiredChannels(plugins, config, projectChannel, result.channels))
    // Offline, every join fails for the same non-actionable reason. Skip the
    // sync and keep last tick's failure view. Delivery still runs: with no
    // channels joined, it queues everything.
    if (client.isReady()) {
      try {
        for (const ch of (await client.whoisChannels()) ?? []) {
          if (!desired.has(ch)) await client.leave(ch)
        }
        const { failed, complete } = await joinDesired(client, desired, projectChannel)
        if (complete) {
          for (const [ch, reason] of failed) {
            log(`orchestrator[daemon]: can't join ${ch}: ${reason}\n`)
            if (unjoinable.get(ch) !== reason) notifyProject(`[dispatcher_error] can't join ${ch}: ${reason}. Its events are queued until the join works.`)
          }
          for (const ch of unjoinable.keys()) {
            if (!failed.has(ch) && client.isJoined(ch)) log(`orchestrator[daemon]: joined ${ch} after earlier failure\n`)
          }
          unjoinable = failed
        }
      } catch (e) {
        log(`orchestrator[daemon]: channel sync failed: ${e}\n`)
      }
    } else {
      log('orchestrator[daemon]: offline, channel sync skipped\n')
    }
    try {
      await writeJoinedChannels(stateDir, [...desired].filter(ch => client.isJoined(ch)).sort())
    } catch (e) {
      log(`orchestrator[daemon]: joined-channels snapshot failed: ${e}\n`)
    }

    let delivered = false
    try {
      const d = await deliver(stateDir, client, result.messages, desired, log)
      delivered = true
      if (d.failures.length) {
        log(`orchestrator[daemon]: dispatch error: ${d.failures.join('; ')}\n`)
        notifyProject(`[dispatcher_error] dispatch: ${d.failures.join('; ')}`)
      }
      const secs = ((Date.now() - tickStart) / 1000).toFixed(1)
      if (d.posted || d.held) log(`orchestrator[daemon]: tick posted to ${d.posted} channel(s), ${d.held} message(s) queued, in ${secs}s\n`)
      else log(`orchestrator[daemon]: tick clean, 0 events in ${secs}s\n`)
    } catch (e) {
      // Outbox write failed: don't commit, so this tick's events re-derive next tick.
      log(`orchestrator[daemon]: delivery failed, state not advanced: ${e}\n`)
      notifyProject(`[dispatcher_error] delivery: ${e}`)
    }
    // Delivery already happened, so a commit failure must not look like a
    // delivery failure. Events will re-derive and repost until the write works.
    if (delivered && result.state) {
      try {
        await commitTick(stateDir, result.state)
      } catch (e) {
        log(`orchestrator[daemon]: state write failed, this tick's events will repost: ${e}\n`)
        notifyProject(`[dispatcher_error] state write: ${e}`)
      }
    }

    await sleepInterruptible(LOOP_TICK_MS)
  }

  client.quit()
  await removeDispatcherPid(stateDir)
  logWriter.flush()
  log('orchestrator[daemon]: exited cleanly\n')
}

async function runDispatchIrc(stateDir: string, seed: boolean): Promise<void> {
  const { config, plugins, projectChannel } = await loadConfigWithPlugins(stateDir, defaultPluginLogger)
  const { nick, server, port } = requireIrcConfig(config, '--dispatch-irc')
  const channels = withFirst(projectChannel, bootChannels(plugins, config, projectChannel))

  const client = newIrcClient(nick, channels)
  await connectAndWait(client, { host: server, port, nick }, channels)
  try {
    const result = await runOneTick(stateDir, config, plugins, { seed, dryRun: false, deferCommit: true }, defaultPluginLogger)
    const desired = new Set(reconcileDesiredChannels(plugins, config, projectChannel, result.channels))
    for (const [ch, reason] of (await joinDesired(client, desired, projectChannel)).failed) {
      process.stderr.write(`orchestrator[--dispatch-irc]: can't join ${ch}: ${reason}\n`)
    }
    const d = await deliver(stateDir, client, result.messages, desired, defaultPluginLogger)
    if (d.failures.length) process.stderr.write(`orchestrator[--dispatch-irc]: dispatch error: ${d.failures.join('; ')}\n`)
    process.stderr.write(`orchestrator[--dispatch-irc]: posted to ${d.posted} channel(s), ${d.held} message(s) queued\n`)
    if (result.state) await commitTick(stateDir, result.state)
  } finally {
    client.quit()
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      seed: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      'dispatch-irc': { type: 'boolean', default: false },
      daemon: { type: 'boolean', default: false },
      'config-dir': { type: 'string' },
    },
  })

  const stateDir = (values['config-dir'] as string | undefined) ?? DEFAULT_STATE_DIR

  try {
    if (values['daemon']) {
      await runDaemon(stateDir)
      process.exit(0)
    }
    if (values['dispatch-irc']) {
      await runDispatchIrc(stateDir, values['seed'] as boolean)
      process.exit(0)
    }
    // One-shot: fetch + diff, print events JSON.
    const { config, plugins } = await loadConfigWithPlugins(stateDir, defaultPluginLogger)
    const result = await runOneTick(stateDir, config, plugins, {
      seed: values['seed'] as boolean,
      dryRun: values['dry-run'] as boolean,
    }, defaultPluginLogger)
    console.log(JSON.stringify(result.messages, null, 2))
  } catch (e) {
    const tb = e instanceof Error ? e.stack ?? String(e) : String(e)
    process.stderr.write(tb + '\n')
    await writeLastError(stateDir, tb)
    process.exit(3)
  }
}

if (import.meta.main) {
  main()
}
