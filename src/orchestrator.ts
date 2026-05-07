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
import { snapshotPr, snapshotIssue, stripInternals } from './orchestrator/snapshot.js'
import { diffPr, diffIssue, type OrchestratorEvent } from './orchestrator/diff.js'
import { formatEvent, formatCommentHeader, eventChannels, initialIrcChannels } from './orchestrator/format.js'
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
    const prevPr = (!seeding && prev?.prs[key]) ? prev.prs[key] as PrSnap : null
    const snap = await snapshotPr(repo, number, prevPr)
    if (!seeding) {
      if (prevPr) {
        events.push(...diffPr(prevPr, snap, agentLogins))
      } else {
        const linked = snap.linked_issues ?? []
        const seedBase = { repo, pr: number, url: snap.url ?? '', title: snap.title ?? '', ...(linked.length ? { linked_issues: linked } : {}) }
        events.push({ kind: 'pr_added_to_watch', ...seedBase })
        const existingRev = snap.seen_review_comment_ids.length
        const existingConv = snap.seen_conversation_comment_ids.length
        if (existingRev || existingConv) {
          events.push({ kind: 'pr_has_existing_comments', review_comment_count: existingRev, conversation_comment_count: existingConv, ...seedBase })
        }
        if (snap.ci_state === 'SUCCESS' || snap.ci_state === 'FAILURE') {
          events.push({ kind: 'pr_has_existing_ci_state', ci_state: snap.ci_state, ...seedBase })
        }
      }
    }
    curState.prs[key] = stripInternals(snap) as PrSnap
  }

  for (const entry of watchedIssues) {
    const [repo, number] = coerceRepoEntry(entry, defaultRepo)
    const key = `${repo}#${number}`
    const snap = await snapshotIssue(repo, number)
    if (!seeding) {
      const prevIssue = prev?.issues[key] as IssueSnap | undefined
      if (prevIssue) {
        events.push(...diffIssue(prevIssue, snap, agentLogins))
      } else {
        const existingCmts = snap.seen_comment_ids.length
        events.push({ kind: 'issue_added_to_watch', repo, issue: number, url: snap.url ?? '', title: snap.title ?? '' })
        if (existingCmts) {
          events.push({ kind: 'issue_has_existing_comments', repo, issue: number, url: snap.url ?? '', title: snap.title ?? '', comment_count: existingCmts })
        }
      }
    }
    curState.issues[key] = stripInternals(snap) as IssueSnap
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

// ---- Self-test -------------------------------------------------------------

function runSelfTest(): boolean {
  const failures: string[] = []
  let total = 0

  function check(name: string, got: unknown, want: unknown): void {
    total++
    const g = JSON.stringify(got)
    const w = JSON.stringify(want)
    if (g !== w) failures.push(`FAIL ${name}: got ${g}, want ${w}`)
  }

  check('pr_no_linked', eventChannels({ kind: 'pr_merged', pr: 25 }, '#proj'), ['#issue-25'])
  check('pr_with_linked', eventChannels({ kind: 'pr_merged', pr: 25, linked_issues: [14, 7] }, '#proj'), ['#issue-14', '#issue-7'])
  check('issue_event', eventChannels({ kind: 'issue_comment', issue: 14 }, '#proj'), ['#issue-14'])
  check('fallback', eventChannels({ kind: 'dispatcher_error' }, '#proj'), ['#proj'])
  check('pr_single_linked', eventChannels({ kind: 'pr_merged', pr: 99, linked_issues: [3] }, '#proj'), ['#issue-3'])

  const fakeState: OrchestratorState = {
    schema_version: SCHEMA_VERSION,
    generated_at: '2026-01-01T00:00:00Z',
    prs: {
      'MyOrg/repo#25': {
        repo: 'MyOrg/repo', number: 25, title: null, url: null, head_ref: null, head_oid: null,
        is_draft: false, merged: false, state: null, labels: [], ci_state: null,
        linked_issues: [14, 7], seen_review_comment_ids: [], seen_conversation_comment_ids: [], seen_review_ids: [],
      },
    },
    issues: {},
  }
  check('initial_channels_linked',
    initialIrcChannels({ repo: 'MyOrg/repo', watched_prs: [25], watched_issues: [] }, '#proj', fakeState),
    ['#issue-14', '#issue-25', '#issue-7', '#proj'].sort()
  )
  check('initial_channels_no_state',
    initialIrcChannels({ repo: 'MyOrg/repo', watched_prs: [25], watched_issues: [14] }, '#proj', null),
    ['#issue-14', '#issue-25', '#proj'].sort()
  )

  check('format_pr_review_comment',
    formatEvent({ kind: 'pr_review_comment', repo: 'org/repo', pr: 46, url: 'https://github.com/org/repo/pull/46', author: 'alice', body: 'Looks good', body_preview: 'Looks good', comment_url: 'https://github.com/org/repo/pull/46#issuecomment-111' } as OrchestratorEvent),
    'PR org/repo#46 comment by alice: Looks good — https://github.com/org/repo/pull/46#issuecomment-111'
  )

  const longBody = 'A'.repeat(161)
  check('format_pr_review_comment_truncated',
    formatEvent({ kind: 'pr_review_comment', repo: 'org/repo', pr: 46, url: 'https://github.com/org/repo/pull/46', author: 'alice', body: longBody, body_preview: longBody, comment_url: 'https://github.com/org/repo/pull/46#issuecomment-222' } as OrchestratorEvent),
    `PR org/repo#46 comment by alice: ${'A'.repeat(160)}… — https://github.com/org/repo/pull/46#issuecomment-222`
  )

  check('format_pr_review_comment_multiline',
    formatEvent({ kind: 'pr_review_comment', repo: 'org/repo', pr: 46, url: 'https://github.com/org/repo/pull/46', author: 'alice', path: 'src/foo.ts', line: 10, body: 'Line one\nLine two', body_preview: 'Line one\nLine two', comment_url: 'https://github.com/org/repo/pull/46#pullrequestreview-333' } as OrchestratorEvent),
    'PR org/repo#46 comment by alice at src/foo.ts:10: Line one… — https://github.com/org/repo/pull/46#pullrequestreview-333'
  )

  check('format_issue_comment',
    formatEvent({ kind: 'issue_comment', repo: 'org/repo', issue: 47, url: 'https://github.com/org/repo/issues/47', author: 'carol', body: 'Hi there', body_preview: 'Hi there', comment_url: 'https://github.com/org/repo/issues/47#issuecomment-555' } as OrchestratorEvent),
    'Issue org/repo#47 comment by carol: Hi there — https://github.com/org/repo/issues/47#issuecomment-555'
  )

  check('header_pr_review_comment',
    formatCommentHeader({ kind: 'pr_review_comment', repo: 'org/repo', pr: 46, author: 'alice' } as OrchestratorEvent),
    'PR org/repo#46 comment by alice:'
  )

  check('header_pr_review_comment_path',
    formatCommentHeader({ kind: 'pr_review_comment', repo: 'org/repo', pr: 46, author: 'alice', path: 'src/foo.ts', line: 10 } as OrchestratorEvent),
    'PR org/repo#46 comment by alice at src/foo.ts:10:'
  )

  check('header_issue_comment',
    formatCommentHeader({ kind: 'issue_comment', repo: 'org/repo', issue: 47, author: 'carol' } as OrchestratorEvent),
    'Issue org/repo#47 comment by carol:'
  )

  check('header_pr_review_submitted',
    formatCommentHeader({ kind: 'pr_review_submitted', repo: 'org/repo', pr: 46, author: 'dave', state: 'APPROVED' } as OrchestratorEvent),
    'PR org/repo#46 review by dave (APPROVED):'
  )

  if (failures.length) {
    for (const f of failures) process.stderr.write(f + '\n')
    return false
  }
  process.stdout.write(`self-test: ${total}/${total} passed\n`)
  return true
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
      'self-test': { type: 'boolean', default: false },
      'config-dir': { type: 'string' },
    },
  })

  const stateDir = values['config-dir']
    ? values['config-dir'] as string
    : DEFAULT_STATE_DIR

  try {
    if (values['self-test']) {
      process.exit(runSelfTest() ? 0 : 1)
    }

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
