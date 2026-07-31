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
  getPluginState,
  SCHEMA_VERSION,
  type OrchestratorConfig,
  type OrchestratorState,
} from './orchestrator/config.js'

import { dispatchMessages, connectAndWait } from './orchestrator/dispatch.js'
import { assertRepoModeAll, defaultPluginLogger, type Plugin, type PluginLogger, type PluginMessage, type PluginTickResult } from './orchestrator/plugin.js'
import './orchestrator/registry.js'
import { buildPlugins } from './orchestrator/build-plugins.js'
import { loadExternalPlugins } from './orchestrator/load-external-plugins.js'
import { resolveProjectChannel, dispatcherNick, defaultProject } from './orchestrator/naming.js'
import { handleDm } from './orchestrator/dispatcher-dm-handler.js'
import { RoostIrcClientImpl } from './irc-client-impl.js'

const DEFAULT_STATE_DIR = join(process.cwd(), '.orchestrator')

interface TickResult {
  messages: PluginMessage[]
  channels: string[]
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
  opts: { seed: boolean; dryRun: boolean },
  log: PluginLogger = defaultPluginLogger,
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
  // via desiredChannels (in bootChannels); only its scraped-dynamic channels
  // for this tick are lost, which is moot since it couldn't scrape.
  const results = await Promise.all(
    plugins.map(async (plugin): Promise<{ plugin: Plugin; result: PluginTickResult }> => {
      const prevState = getPluginState<unknown>(prev, plugin.name)
      try {
        return { plugin, result: await plugin.runTick(config, prevState) }
      } catch (e) {
        const detail = e instanceof Error ? e.stack ?? e.message : String(e)
        log(`orchestrator: plugin ${plugin.name} tick crashed: ${detail}\n`)
        return { plugin, result: { state: prevState, messages: [], channels: [] } }
      }
    })
  )
  for (const { plugin, result } of results) {
    curState.plugins[plugin.name] = result.state
    allMessages.push(...result.messages)
    for (const c of result.channels) allChannels.add(c)
  }

  if (!opts.dryRun) {
    await writeState(stateDir, curState)
    await writeHeartbeat(stateDir)
    await clearLastError(stateDir)
  }

  return { messages: allMessages, channels: [...allChannels] }
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
  // bin/start-dispatcher has a cheaper mkdir lock for the front-door check.
  const pidInfo = await writeDispatcherPid(stateDir)
  log(`orchestrator[daemon]: pid ${pidInfo.pid} written to ${stateDir}/dispatcher.pid\n`)

  const { config: initialConfig, plugins, projectChannel } = await loadConfigWithPlugins(stateDir, log)
  let config = initialConfig
  const { nick, server, port } = requireIrcConfig(config, 'daemon mode')
  const interval = Math.max(5, (config.irc?.interval_seconds ?? 60)) * 1000
  const initialChannels = bootChannels(plugins, config, projectChannel, log)
  log(`orchestrator[daemon]: starting nick=${nick} server=${server}:${port} channels=${initialChannels.join(',')} interval=${interval / 1000}s\n`)

  const client = newIrcClient(nick, initialChannels)
  await connectAndWait(client, { host: server, port, nick, autoReconnect: true, autoReconnectMaxRetries: 30 }, initialChannels)
  log('orchestrator[daemon]: connected\n')

  const trySay = (ch: string, text: string) => {
    try { client.say(ch, text) } catch { /* best-effort */ }
  }

  const dmHandlerDeps = {
    stateDir,
    plugins,
    dm: (target: string, text: string) => {
      try { client.say(target, text) } catch (e) { log(`orchestrator[daemon]: dm reply failed: ${e}\n`) }
    },
    postProjectError: (text: string) => trySay(projectChannel, text),
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

  const tickOpts = { seed: false, dryRun: false }

  while (!stop) {
    const tickStart = Date.now()
    try {
      const next = await loadConfig(stateDir)
      assertRepoModeAll(plugins, await loadConfigBase(stateDir))
      config = next
    } catch (e) {
      log(`orchestrator[daemon]: config load failed: ${e}\n`)
    }

    let result: TickResult
    try {
      result = await runOneTick(stateDir, config, plugins, tickOpts, log)
    } catch (e) {
      const msg = String(e)
      log(`orchestrator[daemon]: tick failed: ${msg}\n`)
      trySay(projectChannel, `[dispatcher_error] ${msg}`)
      // Fall back to the config-only channel view so a transient GH/scrape
      // blip doesn't part every #issue-N until the next success.
      result = { messages: [], channels: bootChannels(plugins, config, projectChannel, log) }
    }

    // Reconcile IRC membership against plugins' desired set, then snapshot.
    // On reconcile failure, re-query so the snapshot reflects reality.
    const desired = new Set<string>(reconcileDesiredChannels(plugins, config, projectChannel, result.channels))
    let joined: string[] | null = null
    try {
      for (const ch of (await client.whoisChannels()) ?? []) {
        if (!desired.has(ch)) await client.leave(ch)
      }
      for (const ch of desired) {
        if (!client.isJoined(ch)) await client.join(ch)
      }
      joined = [...desired].sort()
    } catch (e) {
      log(`orchestrator[daemon]: channel sync failed: ${e}\n`)
    }
    try {
      await writeJoinedChannels(stateDir, joined ?? ((await client.whoisChannels()) ?? []).sort())
    } catch (e) {
      log(`orchestrator[daemon]: joined-channels snapshot failed: ${e}\n`)
    }

    if (result.messages.length) {
      try {
        await dispatchMessages(result.messages, client)
        log(`orchestrator[daemon]: tick dispatched ${result.messages.length} message(s) in ${((Date.now() - tickStart) / 1000).toFixed(1)}s\n`)
      } catch (e) {
        log(`orchestrator[daemon]: dispatch error: ${e}\n`)
        trySay(projectChannel, `[dispatcher_error] dispatch: ${e}`)
      }
    } else {
      log(`orchestrator[daemon]: tick clean, 0 events in ${((Date.now() - tickStart) / 1000).toFixed(1)}s\n`)
    }

    await sleepInterruptible(interval)
  }

  client.quit()
  await removeDispatcherPid(stateDir)
  logWriter.flush()
  log('orchestrator[daemon]: exited cleanly\n')
}

async function runDispatchIrc(stateDir: string, seed: boolean): Promise<void> {
  const { config, plugins, projectChannel } = await loadConfigWithPlugins(stateDir, defaultPluginLogger)
  const { nick, server, port } = requireIrcConfig(config, '--dispatch-irc')
  const channels = bootChannels(plugins, config, projectChannel)

  const client = newIrcClient(nick, channels)
  await connectAndWait(client, { host: server, port, nick }, channels)
  try {
    const result = await runOneTick(stateDir, config, plugins, { seed, dryRun: false }, defaultPluginLogger)
    if (result.messages.length) {
      await dispatchMessages(result.messages, client)
      process.stderr.write(`orchestrator[--dispatch-irc]: dispatched ${result.messages.length} message(s)\n`)
    } else {
      process.stderr.write('orchestrator[--dispatch-irc]: no messages to dispatch\n')
    }
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
