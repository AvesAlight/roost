#!/usr/bin/env bun
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { mkdir } from 'node:fs/promises'
import {
  loadConfig,
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

import { dispatchTaggedEvents, connectAndWait } from './orchestrator/dispatch.js'
import { defaultPluginLogger, type Plugin, type TaggedEvent } from './orchestrator/plugin.js'
import './orchestrator/registry.js'
import { buildPlugins } from './orchestrator/build-plugins.js'
import { resolveProjectChannel } from './orchestrator/naming.js'
import { handleDm } from './orchestrator/dispatcher-dm-handler.js'
import { RoostIrcClientImpl } from './irc-client-impl.js'

// ---- Path setup ------------------------------------------------------------

const DEFAULT_STATE_DIR = join(process.cwd(), '.orchestrator')

// ---- Tick ------------------------------------------------------------------

interface TickResult {
  taggedEvents: TaggedEvent[]
  channels: string[]
}

async function runOneTick(
  stateDir: string,
  config: OrchestratorConfig,
  plugins: Plugin[],
  opts: { seed: boolean; dryRun: boolean }
): Promise<TickResult> {
  const prev = opts.seed ? null : await loadState(stateDir)
  const curState: OrchestratorState = {
    schema_version: SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    plugins: {},
  }

  const allTagged: TaggedEvent[] = []
  const allChannels = new Set<string>()

  // Plugins are independent — share GH rate limits but no in-process state —
  // so parallel execution is safe and useful for any N≥2. Seeding is signaled
  // by `prev === null` (loadState skipped above when opts.seed).
  const results = await Promise.all(
    plugins.map(async plugin => ({
      plugin,
      result: await plugin.runTick(config, getPluginState<unknown>(prev, plugin.name)),
    }))
  )
  for (const { plugin, result } of results) {
    curState.plugins[plugin.name] = result.state
    allTagged.push(...result.taggedEvents)
    for (const c of result.channels) allChannels.add(c)
  }

  if (!opts.dryRun) {
    await writeState(stateDir, curState)
    await writeHeartbeat(stateDir)
    await clearLastError(stateDir)
  }

  return { taggedEvents: allTagged, channels: [...allChannels] }
}

function bootChannels(plugins: Plugin[], config: OrchestratorConfig, projectChannel: string): string[] {
  const chans = new Set<string>([projectChannel])
  for (const plugin of plugins) {
    for (const c of plugin.desiredChannels(config)) chans.add(c)
  }
  return [...chans].sort()
}

// ---- Daemon ----------------------------------------------------------------

async function runDaemon(stateDir: string): Promise<void> {
  await mkdir(stateDir, { recursive: true })
  const logFile = Bun.file(join(stateDir, 'daemon.log'))
  const logWriter = logFile.writer()
  const log = (msg: string) => {
    process.stderr.write(msg)
    logWriter.write(msg)
    logWriter.flush()
  }

  // The in-daemon claim is the source of truth for "this dispatcher owns
  // this stateDir" — exclusive-create on the PID file. bin/start-dispatcher
  // has its own mkdir lock that serves as the cheap front-door check.
  const pidInfo = await writeDispatcherPid(stateDir)
  log(`orchestrator[daemon]: pid ${pidInfo.pid} written to ${stateDir}/dispatcher.pid\n`)

  let config = await loadConfig(stateDir)
  const ircCfg = config.irc ?? {}
  const nick = ircCfg.nick
  if (!nick) throw new Error('daemon mode requires irc.nick in config')
  const projectChannel = resolveProjectChannel(config)
  const server = ircCfg.server ?? '127.0.0.1'
  const port = ircCfg.port ?? 6667
  const interval = Math.max(5, ircCfg.interval_seconds ?? 60) * 1000

  const plugins = buildPlugins(config, projectChannel, log)
  const initialChannels = bootChannels(plugins, config, projectChannel)
  log(`orchestrator[daemon]: starting nick=${nick} server=${server}:${port} channels=${initialChannels.join(',')} interval=${interval / 1000}s\n`)

  const client = new RoostIrcClientImpl({
    nick,
    autoJoin: initialChannels,
    historySize: 0,
    joinHistoryLines: 0,
    joinHistoryMinutes: 0,
  })

  await connectAndWait(client, { host: server, port, nick, autoReconnect: true, autoReconnectMaxRetries: 30 }, initialChannels)
  log('orchestrator[daemon]: connected\n')

  // DM command handler. Channel messages are ignored; DMs flow through
  // the allowlist + parser + mutateConfig pipeline in dispatcher-dm-handler.ts.
  const dmHandlerDeps = {
    stateDir,
    plugins,
    dm: (nick: string, text: string) => {
      try { client.say(nick, text) } catch (e) { log(`orchestrator[daemon]: dm reply failed: ${e}\n`) }
    },
    postProjectError: (text: string) => {
      try { client.say(projectChannel, text) } catch { /* best-effort */ }
    },
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
      config = await loadConfig(stateDir)
    } catch (e) {
      log(`orchestrator[daemon]: config load failed: ${e}\n`)
    }

    let result: TickResult
    try {
      result = await runOneTick(stateDir, config, plugins, tickOpts)
    } catch (e) {
      const msg = String(e)
      log(`orchestrator[daemon]: tick failed: ${msg}\n`)
      try { client.say(projectChannel, `[dispatcher_error] ${msg}`) } catch { /* best-effort */ }
      // Fall back to the config-only channel view so a transient GH/scrape
      // blip doesn't part every #issue-N until the next success.
      result = { taggedEvents: [], channels: bootChannels(plugins, config, projectChannel) }
    }

    // Sync IRC membership against the plugin's reported desired set + project channel.
    const desired = new Set<string>([projectChannel, ...result.channels])
    let joinedSnapshot: string[] | null = null
    try {
      const currentlyJoined = (await client.whoisChannels()) ?? []
      for (const ch of currentlyJoined) {
        if (!desired.has(ch)) await client.leave(ch)
      }
      for (const ch of desired) {
        if (!client.isJoined(ch)) await client.join(ch)
      }
      // Reconcile succeeded — `desired` is what we should be in. Avoid a
      // second whoisChannels round-trip just to snapshot.
      joinedSnapshot = [...desired].sort()
    } catch (e) {
      log(`orchestrator[daemon]: channel sync failed: ${e}\n`)
    }

    // Snapshot of channels we believe we're joined to, for operator
    // readiness checks. Freshness is "last successful tick", not "now".
    // On reconcile failure, re-query so the snapshot reflects reality.
    try {
      const joined = joinedSnapshot ?? ((await client.whoisChannels()) ?? []).sort()
      await writeJoinedChannels(stateDir, joined)
    } catch (e) {
      log(`orchestrator[daemon]: joined-channels snapshot failed: ${e}\n`)
    }

    if (result.taggedEvents.length) {
      try {
        await dispatchTaggedEvents(result.taggedEvents, client)
        log(`orchestrator[daemon]: tick dispatched ${result.taggedEvents.length} event(s) in ${((Date.now() - tickStart) / 1000).toFixed(1)}s\n`)
      } catch (e) {
        log(`orchestrator[daemon]: dispatch error: ${e}\n`)
        try { client.say(projectChannel, `[dispatcher_error] dispatch: ${e}`) } catch { /* best-effort */ }
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

// ---- One-shot dispatch -----------------------------------------------------

async function runDispatchIrc(stateDir: string, seed: boolean): Promise<void> {
  const config = await loadConfig(stateDir)
  const ircCfg = config.irc ?? {}
  const nick = ircCfg.nick
  if (!nick) throw new Error('--dispatch-irc requires irc.nick in config')
  const projectChannel = resolveProjectChannel(config)
  const server = ircCfg.server ?? '127.0.0.1'
  const port = ircCfg.port ?? 6667

  const plugins = buildPlugins(config, projectChannel, defaultPluginLogger)
  const channels = bootChannels(plugins, config, projectChannel)

  const client = new RoostIrcClientImpl({
    nick,
    autoJoin: channels,
    historySize: 0,
    joinHistoryLines: 0,
    joinHistoryMinutes: 0,
  })

  await connectAndWait(client, { host: server, port, nick }, channels)
  try {
    const result = await runOneTick(stateDir, config, plugins, { seed, dryRun: false })
    if (result.taggedEvents.length) {
      await dispatchTaggedEvents(result.taggedEvents, client)
      process.stderr.write(`orchestrator[--dispatch-irc]: dispatched ${result.taggedEvents.length} event(s)\n`)
    } else {
      process.stderr.write('orchestrator[--dispatch-irc]: no events to dispatch\n')
    }
  } finally {
    client.quit()
  }
}

// ---- Main ------------------------------------------------------------------

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

  const stateDir = values['config-dir']
    ? values['config-dir'] as string
    : DEFAULT_STATE_DIR

  try {
    if (values['daemon']) {
      await runDaemon(stateDir)
      process.exit(0)
    }

    if (values['dispatch-irc']) {
      await runDispatchIrc(stateDir, values['seed'] as boolean)
      process.exit(0)
    }

    // One-shot: fetch + diff, print events JSON
    const config = await loadConfig(stateDir)
    const projectChannel = resolveProjectChannel(config)
    const plugins = buildPlugins(config, projectChannel, defaultPluginLogger)
    const result = await runOneTick(stateDir, config, plugins, {
      seed: values['seed'] as boolean,
      dryRun: values['dry-run'] as boolean,
    })
    console.log(JSON.stringify(result.taggedEvents, null, 2))
  } catch (e) {
    const tb = e instanceof Error ? e.stack ?? String(e) : String(e)
    process.stderr.write(tb + '\n')
    await writeLastError(stateDir, tb)
    process.exit(3)
  }
}

main()
