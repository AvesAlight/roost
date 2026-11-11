// CircleCI pipeline feed. Follows the pipeline(s) CircleCI builds for a commit
// and reports workflow results and approval holds into IRC. Built for work that
// happens after a merge (terraform applies, AMI rolls, orb promotes), which has
// no PR for the PR plugins to watch.
//
// DM grammar: claims target=`pipeline` — `watch pipeline gh/<org>/<repo>@<sha>
// [#chan ...]`. A sha prefix of 7+ hex chars is accepted. Watches end on their
// own; `unwatch` is for stopping one early.
//
// Config slice: `{ watched: [{ slug, sha, channels?, started_at? }],
// failure_hint?: string }`. `started_at` (epoch ms) is stamped on DM-created
// entries; hand-edited entries fall back to the first tick that sees them.
// `failure_hint` is an optional template appended to a failed-workflow line;
// `{slug}` and `{job}` (the first failed job's number) are substituted.
//
// State slice: `{ watches: { "<slug>@<sha>": WatchState } }`. A finished watch
// stays in state marked `done` and makes no API calls. Its config entry is
// dropped from `config.local.json` on the plugin's next handleCommand, because
// runTick sees config read-only. State for a key that has left config is
// dropped on the next tick.
//
// There is no seeding: a watch that starts after a workflow finished, or while
// one is on hold, reports that state on its first poll.
import type { Command } from '../../dispatcher-dm-handler.js'
import type { OrchestratorConfig } from '../../config.js'
import type { ParseResult, PluginTickResult, PluginMessage } from '../../plugin.js'
import { BasePlugin, defaultPluginLogger, type PluginLogger } from '../../plugin.js'
import { resolveProjectChannel } from '../../naming.js'
import { addChannelsToEntry, applyUnwatchEntry, trackedRefusal } from '../_shared.js'
import { CooldownGate } from '../_rate-limit.js'
import { tryClaimPerPipeline, type PerPipelineCommand } from '../grammar.js'
import {
  CircleCiClient, CircleCiError, CircleCiAuthError, CircleCiMissingTokenError, CircleCiNotFoundError, CircleCiRateLimitError,
  CIRCLECI_APP, MISSING_TOKEN_MESSAGE, type CciJob, type CciPipeline, type CciWorkflow,
} from './circleci-api.js'

export interface PipelineWatchEntry {
  slug: string
  sha: string
  channels?: string[]
  started_at?: number
}

interface CircleCiPluginConfig {
  watched?: PipelineWatchEntry[]
  failure_hint?: string
}

interface WorkflowState {
  name: string
  status: string
  // The status for which this workflow's jobs were last fetched and reported.
  // Null until a job-bearing status (on_hold, failed, error) has been handled.
  handled_for: string | null
}

interface PipelineState {
  number: number
  state: string | null
  announced: boolean
  workflows: Record<string, WorkflowState>
}

export interface WatchState {
  started_at: number
  // The config entry's `started_at` this state was created against. A different
  // value on the entry means a re-watch, which starts from scratch.
  entry_started_at: number | null
  pipelines: Record<string, PipelineState>
  // Approval job ids already announced, so one hold is announced once.
  holds: string[]
  // Consecutive polls on which everything was terminal and nothing on hold.
  settled_ticks: number
  done?: { at: number; reason: EndReason }
}

export interface CircleCiPluginState {
  watches: Record<string, WatchState>
}

type EndReason = 'settled' | 'no-pipeline' | 'gave-up'

// Discovery runs for this long after the watch starts, so a later pipeline on
// the same sha (a rerun, a tag) is picked up.
export const DISCOVERY_WINDOW_MS = 15 * 60_000
export const GIVE_UP_MS = 24 * 60 * 60_000
// Consecutive all-terminal polls before a watch ends. One is not enough: a
// dynamic-config pipeline can create its second workflow just after the first
// one stops.
export const SETTLE_TICKS = 2
// Pipeline-list pages read per poll while nothing has matched yet.
export const MAX_LIST_PAGES = 3
// Failed polls in a row before a per-watch note is posted.
const FAILURE_NOTE_THRESHOLD = 3
const MAX_FAILED_JOBS_LISTED = 5

const TERMINAL_WORKFLOW = new Set(['success', 'failed', 'error', 'canceled', 'not_run', 'unauthorized'])
// Workflow statuses whose jobs are fetched, once per entry into the status.
const JOB_BEARING = new Set(['on_hold', 'failed', 'error'])
const FAILED_JOB = new Set(['failed', 'infrastructure_fail', 'timedout', 'terminated-unknown', 'unauthorized'])

function entryKey(e: { slug: string; sha: string }): string {
  return `${e.slug}@${e.sha.toLowerCase()}`
}

function label(slug: string, sha: string): string {
  return `pipeline ${slug}@${sha}`
}

function sameWatch(e: PipelineWatchEntry, slug: string, sha: string): boolean {
  return e.slug === slug && e.sha.toLowerCase() === sha
}

function pipelineLink(slug: string, number: number): string {
  return `${CIRCLECI_APP}/pipelines/${slug}/${number}`
}

function workflowLink(slug: string, number: number, workflowId: string): string {
  return `${pipelineLink(slug, number)}/workflows/${workflowId}`
}

function revisionMatches(p: CciPipeline, sha: string): boolean {
  return typeof p.vcs?.revision === 'string' && p.vcs.revision.toLowerCase().startsWith(sha)
}

function formatHint(template: string | undefined, slug: string, jobNumber: number | undefined): string {
  if (!template || jobNumber === undefined) return ''
  return ` — ${template.split('{slug}').join(slug).split('{job}').join(String(jobNumber))}`
}

// One watch's entries, merged: the base and local config can both carry the
// same (slug, sha), and a re-watch of a finished sha leaves a done entry beside
// the fresh one.
interface GroupedEntry {
  slug: string
  sha: string
  channels: Set<string>
  started_at: number | null
}

function groupEntries(entries: PipelineWatchEntry[]): Map<string, GroupedEntry> {
  const byKey = new Map<string, GroupedEntry>()
  for (const e of entries) {
    const key = entryKey(e)
    let g = byKey.get(key)
    if (!g) {
      g = { slug: e.slug, sha: e.sha.toLowerCase(), channels: new Set(), started_at: null }
      byKey.set(key, g)
    }
    for (const c of e.channels ?? []) g.channels.add(c)
    if (g.started_at === null && typeof e.started_at === 'number') g.started_at = e.started_at
  }
  return byKey
}

interface PollOutcome {
  ws: WatchState
  messages: PluginMessage[]
  // First per-watch error this poll. Tick-wide errors (rate limit, auth,
  // missing token) are thrown instead and discard the poll.
  error: unknown
}

export class CircleCiPlugin extends BasePlugin {
  readonly name = 'circleci'

  private readonly log: PluginLogger
  private readonly client: CircleCiClient
  private readonly now: () => number

  // Finished watches as of the last tick: key -> the entry `started_at` they ran
  // under. handleCommand reads this because it has no access to state.
  private doneWatches = new Map<string, number | null>()
  // No calls until this time, after a 429.
  private retryUntil = 0
  private tokenNoted = false
  private readonly authGate = new CooldownGate()
  private readonly failureGate = new CooldownGate()
  private readonly failures = new Map<string, number>()

  constructor(
    defaultChannel: string,
    log: PluginLogger = defaultPluginLogger,
    client?: CircleCiClient,
    now: () => number = Date.now,
  ) {
    super(defaultChannel)
    this.log = log
    this.client = client ?? new CircleCiClient({ log })
    this.now = now
  }

  parseCommand(line: string): ParseResult | null {
    return tryClaimPerPipeline('pipeline', line)
  }

  // ---- DM command handling --------------------------------------------

  handleCommand(merged: OrchestratorConfig, local: OrchestratorConfig, cmd: Command): string | null {
    this.pruneDone(local)
    if (cmd.kind === 'list') return this.formatListSection(merged)
    if (cmd.kind === 'help') return this.formatHelpSection()
    if (cmd.kind === 'plugin' && cmd.plugin === this.name) {
      const c = cmd.cmd as PerPipelineCommand
      if (c.verb === 'watch') return this.applyWatch(merged, local, c.slug, c.sha, c.channels)
      return this.applyUnwatch(merged, local, c.slug, c.sha)
    }
    return null
  }

  private isDone(e: PipelineWatchEntry): boolean {
    const key = entryKey(e)
    return this.doneWatches.has(key) && this.doneWatches.get(key) === (e.started_at ?? null)
  }

  // Finished entries drop out of the local overlay. Only a write DM persists
  // this; list/help read-only batches discard it, so list filters too.
  private pruneDone(local: OrchestratorConfig): void {
    const slice = this.pluginConfig<CircleCiPluginConfig>(local)
    if (!slice?.watched?.length) return
    slice.watched = slice.watched.filter(e => !this.isDone(e))
  }

  private liveWatched(config: OrchestratorConfig): PipelineWatchEntry[] {
    return (this.pluginConfig<CircleCiPluginConfig>(config)?.watched ?? []).filter(e => !this.isDone(e))
  }

  private applyWatch(merged: OrchestratorConfig, local: OrchestratorConfig, slug: string, sha: string, channels: string[]): string {
    const labelStr = label(slug, sha)
    const match = (e: PipelineWatchEntry) => sameWatch(e, slug, sha)
    if (!this.liveWatched(merged).some(match)) {
      const slice = this.localSlice<CircleCiPluginConfig>(local)
      slice.watched ??= []
      const entry: PipelineWatchEntry = { slug, sha, started_at: this.now() }
      if (channels.length) entry.channels = [...channels]
      slice.watched.push(entry)
      return channels.length ? `watching ${labelStr} + ${channels.join(' ')}` : `watching ${labelStr}`
    }
    const localEntry = (this.pluginConfig<CircleCiPluginConfig>(local)?.watched ?? []).find(match)
    if (!localEntry) return channels.length ? trackedRefusal(labelStr, 'add channels') : `already watching ${labelStr}`
    return addChannelsToEntry(localEntry, channels, labelStr)
  }

  private applyUnwatch(merged: OrchestratorConfig, local: OrchestratorConfig, slug: string, sha: string): string {
    return applyUnwatchEntry<PipelineWatchEntry>(
      this.liveWatched(merged),
      this.pluginConfig<CircleCiPluginConfig>(local)?.watched ?? [],
      e => sameWatch(e, slug, sha),
      label(slug, sha),
    )
  }

  private formatListSection(merged: OrchestratorConfig): string {
    const groups = groupEntries(this.liveWatched(merged))
    const header = `${this.name} (${groups.size}):`
    if (!groups.size) return `${header}\n  (none)`
    const lines = [...groups.values()].map(g => {
      const chans = g.channels.size ? ` + ${[...g.channels].join(' ')}` : ''
      return `  ${g.slug}@${g.sha}${chans}`
    })
    return [header, ...lines].join('\n')
  }

  private formatHelpSection(): string {
    return [
      `${this.name} commands (DM only):`,
      `  watch pipeline gh/<org>/<repo>@<sha> [#chan ...]  — follow the CircleCI pipeline for a commit (sha prefix of 7+ chars)`,
      `  unwatch pipeline gh/<org>/<repo>@<sha>            — stop following it`,
      `  watch list                                       — include this plugin's pipeline watches in the reply`,
    ].join('\n')
  }

  desiredChannels(config: OrchestratorConfig): string[] {
    const chans = new Set<string>()
    for (const e of this.liveWatched(config)) {
      for (const c of e.channels ?? []) chans.add(c)
    }
    return [...chans]
  }

  // ---- tick -------------------------------------------------------------

  async runTick(config: OrchestratorConfig, prevState: unknown): Promise<PluginTickResult> {
    const slice = this.pluginConfig<CircleCiPluginConfig>(config) ?? {}
    const prev = prevState as CircleCiPluginState | null
    const projectChannel = resolveProjectChannel(config)
    const groups = groupEntries(slice.watched ?? [])
    const state: CircleCiPluginState = { watches: {} }
    const messages: PluginMessage[] = []
    const now = this.now()

    if (groups.size === 0) {
      this.doneWatches = new Map()
      return { state, messages, channels: [] }
    }

    const carry = (key: string) => {
      const p = prev?.watches?.[key]
      if (p && !(key in state.watches)) state.watches[key] = p
    }

    let tokenMissing = false
    if (now < this.retryUntil) {
      for (const key of groups.keys()) carry(key)
    } else {
      // Sequential: one token and one rate budget, and a watch count in the
      // single digits. Each watch is isolated so one failing never drops the rest.
      for (const [key, g] of groups) {
        let ws: WatchState | undefined = prev?.watches?.[key]
        // A different entry stamp means a re-watch: discard the old state.
        if (ws && g.started_at !== null && ws.entry_started_at !== g.started_at) ws = undefined
        if (ws?.done) {
          state.watches[key] = ws
          continue
        }
        const channels = g.channels.size ? [...g.channels] : [projectChannel]
        try {
          const out = await this.pollWatch(g, ws, channels, slice.failure_hint, now)
          state.watches[key] = out.ws
          messages.push(...out.messages)
          if (out.error) messages.push(...this.noteFailure(key, g, channels, out.error, now))
          else this.clearFailure(key)
        } catch (e) {
          if (e instanceof CircleCiRateLimitError) {
            this.retryUntil = now + e.retryAfterMs
            this.log(`[circleci] rate-limited; no calls for ${Math.round(e.retryAfterMs / 1000)}s\n`)
            break
          }
          if (e instanceof CircleCiMissingTokenError) {
            tokenMissing = true
            if (!this.tokenNoted) {
              this.tokenNoted = true
              messages.push({ channels: [projectChannel], text: `circleci: ${MISSING_TOKEN_MESSAGE} ${groups.size} pipeline watch(es) paused until one is set.` })
            }
            break
          }
          if (e instanceof CircleCiAuthError) {
            this.log(`[circleci] ${e.message}\n`)
            if (this.authGate.claim('auth', now)) messages.push({ channels: [projectChannel], text: `circleci: ${e.message}` })
            break
          }
          // A defect, not an API condition. Keep this watch's state and move on.
          this.log(`[circleci] poll crashed for ${key}: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`)
          if (ws) state.watches[key] = ws
        }
      }
      for (const key of groups.keys()) carry(key)
    }
    if (!tokenMissing) this.tokenNoted = false

    this.doneWatches = new Map()
    for (const [key, ws] of Object.entries(state.watches)) {
      if (ws.done) this.doneWatches.set(key, ws.entry_started_at)
    }
    return { state, messages, channels: this.desiredChannels(config) }
  }

  private async pollWatch(
    g: GroupedEntry,
    prevWs: WatchState | undefined,
    channels: string[],
    hint: string | undefined,
    now: number,
  ): Promise<PollOutcome> {
    const ws: WatchState = prevWs
      ? structuredClone(prevWs)
      : { started_at: g.started_at ?? now, entry_started_at: g.started_at, pipelines: {}, holds: [], settled_ticks: 0 }
    const messages: PluginMessage[] = []
    const emit = (text: string) => messages.push({ channels: [...channels], text })
    const watchLabel = `${g.slug}@${g.sha}`
    let error: unknown = null
    // Rate limit, auth and token errors abort the whole tick; everything else is
    // this watch's problem and the poll carries on with what it can still do.
    const fail = (e: unknown) => {
      if (e instanceof CircleCiRateLimitError || e instanceof CircleCiAuthError || e instanceof CircleCiMissingTokenError) throw e
      if (!(e instanceof CircleCiError)) throw e
      error ??= e
    }

    if (now >= ws.started_at + GIVE_UP_MS) {
      emit(`gave up watching ${watchLabel} after 24h: ${this.summarize(g.slug, ws)}`)
      return { ws: this.finish(ws, 'gave-up', now), messages, error: null }
    }

    const windowClosed = now >= ws.started_at + DISCOVERY_WINDOW_MS
    if (!windowClosed || Object.keys(ws.pipelines).length === 0) {
      try {
        await this.discover(g, ws)
      } catch (e) { fail(e) }
    }

    for (const [pid, p] of Object.entries(ws.pipelines)) {
      let workflows: CciWorkflow[]
      try {
        workflows = (await this.client.listWorkflows(pid)).items
      } catch (e) { fail(e); continue }
      if (!p.announced) {
        p.announced = true
        const names = workflows.map(w => w.name).join(', ') || 'none yet'
        emit(`pipeline #${p.number} found for ${watchLabel} (workflows: ${names}) — ${pipelineLink(g.slug, p.number)}`)
      }
      for (const wf of workflows) {
        try {
          await this.followWorkflow(g, ws, p, wf, hint, emit)
        } catch (e) { fail(e) }
      }
    }

    if (error) {
      ws.settled_ticks = 0
      return { ws, messages, error }
    }

    const pipelines = Object.values(ws.pipelines)
    if (pipelines.length === 0) {
      // Reaching here means this poll's listing succeeded: any error returned above.
      if (windowClosed) {
        emit(`no pipeline for ${watchLabel} after 15m`)
        return { ws: this.finish(ws, 'no-pipeline', now), messages, error: null }
      }
      return { ws, messages, error: null }
    }
    const settled = pipelines.every(p => {
      const wfs = Object.values(p.workflows)
      if (wfs.length === 0) return p.state === 'errored' || windowClosed
      return wfs.every(w => TERMINAL_WORKFLOW.has(w.status))
    })
    ws.settled_ticks = settled ? ws.settled_ticks + 1 : 0
    if (ws.settled_ticks >= SETTLE_TICKS) {
      emit(`watch ended ${watchLabel}: ${this.summarize(g.slug, ws)}`)
      return { ws: this.finish(ws, 'settled', now), messages, error: null }
    }
    return { ws, messages, error: null }
  }

  // List pipelines newest first (no branch filter: tag pipelines have none) and
  // track every one whose revision matches. Reads page 1 always, and further
  // pages only while nothing is tracked yet.
  private async discover(g: GroupedEntry, ws: WatchState): Promise<void> {
    let token: string | undefined
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const r = await this.client.listPipelines(g.slug, token)
      for (const p of r.items) {
        if (typeof p?.id !== 'string' || typeof p.number !== 'number' || !revisionMatches(p, g.sha)) continue
        const known = ws.pipelines[p.id]
        if (known) known.state = p.state ?? known.state
        else ws.pipelines[p.id] = { number: p.number, state: p.state ?? null, announced: false, workflows: {} }
      }
      if (Object.keys(ws.pipelines).length > 0 || !r.nextPageToken) break
      token = r.nextPageToken
    }
  }

  // Diff one workflow against what was last seen and emit what changed. State
  // is only updated once the events for the new status are decided, so a failed
  // jobs call leaves the workflow untouched and the next poll retries it.
  private async followWorkflow(
    g: GroupedEntry,
    ws: WatchState,
    p: PipelineState,
    wf: CciWorkflow,
    hint: string | undefined,
    emit: (text: string) => void,
  ): Promise<void> {
    const prev = p.workflows[wf.id]
    const status = wf.status
    const needJobs = JOB_BEARING.has(status) && prev?.handled_for !== status
    const link = workflowLink(g.slug, p.number, wf.id)
    const where = `in ${g.slug}@${g.sha} (pipeline #${p.number})`

    let jobs: CciJob[] = []
    if (needJobs) jobs = (await this.client.listJobs(wf.id)).items

    if (status === 'on_hold' && needJobs) {
      for (const job of jobs) {
        const id = job.id ?? job.approval_request_id
        if (job.type !== 'approval' || job.status !== 'on_hold' || !id || ws.holds.includes(id)) continue
        ws.holds.push(id)
        emit(`waiting on human: ${job.name} — workflow ${wf.name} ${where} — ${link}`)
      }
    }

    if (TERMINAL_WORKFLOW.has(status) && prev?.status !== status) {
      let failedPart = ''
      let hintPart = ''
      if (needJobs) {
        const failed = jobs.filter(j => FAILED_JOB.has(j.status))
        const shown = failed.slice(0, MAX_FAILED_JOBS_LISTED)
          .map(j => j.job_number === undefined ? j.name : `${j.name} (#${j.job_number})`)
        const more = failed.length > shown.length ? ` +${failed.length - shown.length} more` : ''
        failedPart = ` — failed jobs: ${shown.join(', ') || 'none listed'}${more}`
        hintPart = formatHint(hint, g.slug, failed.find(j => j.job_number !== undefined)?.job_number)
      }
      emit(`workflow ${wf.name} ${status} ${where}${failedPart} — ${link}${hintPart}`)
    }

    p.workflows[wf.id] = {
      name: wf.name,
      status,
      handled_for: needJobs ? status : (prev?.status === status ? prev.handled_for : null),
    }
  }

  private summarize(slug: string, ws: WatchState): string {
    const parts = Object.values(ws.pipelines).map(p => {
      const wfs = Object.values(p.workflows).map(w => `${w.name} ${w.status}`).join(', ') || 'no workflows'
      return `#${p.number} ${wfs} (${pipelineLink(slug, p.number)})`
    })
    return parts.join('; ') || 'no pipelines'
  }

  private finish(ws: WatchState, reason: EndReason, now: number): WatchState {
    return { ...ws, pipelines: {}, holds: [], settled_ticks: 0, done: { at: now, reason } }
  }

  // ---- per-watch failure notes -------------------------------------------

  private clearFailure(key: string): void {
    this.failures.delete(key)
    this.failureGate.clear(key)
  }

  // 404 means a typo or a project the token can't see, so it is reported on the
  // first poll. Anything else may be a blip and waits for a few in a row.
  private noteFailure(key: string, g: GroupedEntry, channels: string[], err: unknown, now: number): PluginMessage[] {
    const detail = err instanceof Error ? err.message : String(err)
    const count = (this.failures.get(key) ?? 0) + 1
    this.failures.set(key, count)
    this.log(`[circleci] poll failing for ${key} (${count} in a row): ${detail}\n`)
    const immediate = err instanceof CircleCiNotFoundError
    if (!immediate && count < FAILURE_NOTE_THRESHOLD) return []
    if (!this.failureGate.claim(key, now)) return []
    const reason = immediate ? `CircleCI returned 404: check the project slug and that the token can read it` : detail
    return [{ channels, text: `circleci: cannot poll ${label(g.slug, g.sha)}: ${reason}. To stop: unwatch pipeline ${g.slug}@${g.sha}` }]
  }
}
