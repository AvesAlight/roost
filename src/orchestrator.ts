#!/usr/bin/env bun
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { mkdir } from 'node:fs/promises'
import {
  loadConfig,
  loadState,
  writeState,
  writeHeartbeat,
  writeLastError,
  clearLastError,
  coerceRepoEntry,
  SCHEMA_VERSION,
  type OrchestratorConfig,
  type OrchestratorState,
  type PrSnap,
  type IssueSnap,
} from './orchestrator/config.js'

import { type OrchestratorEvent } from './orchestrator/diff.js'
import { initialIrcChannels } from './orchestrator/format.js'
import { scrapePr, scrapeIssue } from './orchestrator/scraper.js'
import { dispatchEventsIrc, connectAndWait } from './orchestrator/dispatch.js'
import { RoostIrcClientImpl } from './irc-client-impl.js'

// ---- Path setup ------------------------------------------------------------

const REPO_ROOT = new URL('../', import.meta.url).pathname.replace(/\/$/, '')
const DEFAULT_STATE_DIR = join(REPO_ROOT, '.orchestrator')

// ---- Tick ------------------------------------------------------------------

async function runOneTick(
  stateDir: string,
  config: OrchestratorConfig,
  opts: { seed: boolean; dryRun: boolean }
): Promise<OrchestratorEvent[]> {
  const defaultRepo = config.repo
  const watchedPrs = config.watched_prs ?? []
  const watchedIssues = config.watched_issues ?? []
  const agentLogins = new Set(config.agent_logins ?? [])

  const prev = opts.seed ? null : await loadState(stateDir)
  const seeding = prev === null

  const curState: OrchestratorState = {
    schema_version: SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    prs: {},
    issues: {},
  }
  const events: OrchestratorEvent[] = []

  for (const entry of watchedPrs) {
    const [repo, number] = coerceRepoEntry(entry, defaultRepo)
    const key = `${repo}#${number}`
    // undefined = seeding tick (no events); null = new watch entry (emit seed events)
    const prevPr: PrSnap | null | undefined = seeding ? undefined : ((prev?.prs[key] as PrSnap | undefined) ?? null)
    const { snap, events: prEvents } = await scrapePr(repo, number, prevPr, agentLogins)
    events.push(...prEvents)
    curState.prs[key] = snap
  }

  for (const entry of watchedIssues) {
    const [repo, number] = coerceRepoEntry(entry, defaultRepo)
    const key = `${repo}#${number}`
    const prevIssue: IssueSnap | null | undefined = seeding ? undefined : ((prev?.issues[key] as IssueSnap | undefined) ?? null)
    const { snap, events: issueEvents } = await scrapeIssue(repo, number, prevIssue, agentLogins)
    events.push(...issueEvents)
    curState.issues[key] = snap
  }

  if (!opts.dryRun) {
    await writeState(stateDir, curState)
    await writeHeartbeat(stateDir)
    await clearLastError(stateDir)
  }

  return seeding ? [] : events
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

  let config = await loadConfig(stateDir)
  const ircCfg = config.irc ?? {}
  const nick = ircCfg.nick
  if (!nick) throw new Error('daemon mode requires irc.nick in config')
  const projectChannel = ircCfg.project_channel ?? '#general'
  const server = ircCfg.server ?? '127.0.0.1'
  const port = ircCfg.port ?? 6667
  const interval = Math.max(5, ircCfg.interval_seconds ?? 60) * 1000

  const state = await loadState(stateDir)
  const initialChannels = initialIrcChannels(config, projectChannel, state)
  log(`orchestrator[daemon]: starting nick=${nick} server=${server}:${port} channels=${initialChannels.join(',')} interval=${interval / 1000}s\n`)

  const client = new RoostIrcClientImpl({
    nick,
    autoJoin: initialChannels,
    historySize: 0,
    joinHistoryLines: 0,
    joinHistoryMinutes: 0,
  })

  await connectAndWait(client, { host: server, port, nick, autoReconnect: true }, initialChannels)
  log('orchestrator[daemon]: connected\n')

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

    const desired = new Set(initialIrcChannels(config, projectChannel, await loadState(stateDir)))
    const currentlyJoined = (await client.whoisChannels()) ?? []
    for (const ch of currentlyJoined) {
      if (!desired.has(ch)) await client.leave(ch)
    }
    for (const ch of desired) {
      if (!client.isJoined(ch)) await client.join(ch)
    }

    let events: OrchestratorEvent[] = []
    try {
      events = await runOneTick(stateDir, config, tickOpts)
    } catch (e) {
      const msg = String(e)
      log(`orchestrator[daemon]: tick failed: ${msg}\n`)
      try { client.say(projectChannel, `[dispatcher_error] ${msg}`) } catch { /* best-effort */ }
    }

    if (events.length) {
      try {
        await dispatchEventsIrc(events, client, projectChannel)
        log(`orchestrator[daemon]: tick dispatched ${events.length} event(s) in ${((Date.now() - tickStart) / 1000).toFixed(1)}s\n`)
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
  logWriter.flush()
  log('orchestrator[daemon]: exited cleanly\n')
}

// ---- One-shot dispatch -----------------------------------------------------

async function runDispatchIrc(stateDir: string, seed: boolean): Promise<void> {
  const config = await loadConfig(stateDir)
  const ircCfg = config.irc ?? {}
  const nick = ircCfg.nick
  if (!nick) throw new Error('--dispatch-irc requires irc.nick in config')
  const projectChannel = ircCfg.project_channel ?? '#general'
  const server = ircCfg.server ?? '127.0.0.1'
  const port = ircCfg.port ?? 6667

  const state = await loadState(stateDir)
  const channels = initialIrcChannels(config, projectChannel, state)

  const client = new RoostIrcClientImpl({
    nick,
    autoJoin: channels,
    historySize: 0,
    joinHistoryLines: 0,
    joinHistoryMinutes: 0,
  })

  await connectAndWait(client, { host: server, port, nick }, channels)
  try {
    const events = await runOneTick(stateDir, config, { seed, dryRun: false })
    if (events.length) {
      await dispatchEventsIrc(events, client, projectChannel)
      process.stderr.write(`orchestrator[--dispatch-irc]: dispatched ${events.length} event(s)\n`)
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
    const events = await runOneTick(stateDir, config, {
      seed: values['seed'] as boolean,
      dryRun: values['dry-run'] as boolean,
    })
    console.log(JSON.stringify(events, null, 2))
  } catch (e) {
    const tb = e instanceof Error ? e.stack ?? String(e) : String(e)
    process.stderr.write(tb + '\n')
    await writeLastError(stateDir, tb)
    process.exit(3)
  }
}

main()
