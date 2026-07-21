import type { Command } from '../../dispatcher-dm-handler.js'
import type { OrchestratorConfig, WatchedEntry } from '../../config.js'
import { assertEntryRepoMode, resolveRepoEntry } from '../../config.js'
import { channelSlug, defaultProject, issueChannel } from '../../naming.js'
import { BasePlugin, defaultPluginLogger, type ParseResult, type PluginLogger, type PluginTickResult, type TaggedEvent } from '../../plugin.js'
import { addChannelsToEntry, applyUnwatchEntry, trackedRefusal } from '../_shared.js'
import { tryClaimPerN, type PerNCommand } from '../grammar.js'
import { GhClient, GhError, describeReadFailure, fetchRateLimit, isRateLimitError, rateLimitKind } from './github-api.js'
import { observeRateLimitFromInfo, WARN_COOLDOWN_MS, type RateLimitInfo, type RateLimitStatics } from '../_rate-limit.js'
import { RateLimitBreaker, READ_FAILURE_THRESHOLD, SECONDARY_BACKOFF_SCHEDULE_MS, BACKOFF_SCHEDULE_MS, formatBackoffNotice, formatReadFailureNote, formatBatchFailureNote, type RateLimitKind } from './backoff.js'

// Per-entry read outcome. `readEntry` never throws the expected gh-error
// classes — it returns one of these so a caller's Promise.all over entries
// never abandons sibling reads (bun late-rejection footgun) on the first error.
export type ReadEntryResult<T> =
  | { ok: true; value: T }
  | { ok: false; rateLimited: true; kind: RateLimitKind }
  | { ok: false; rateLimited: false; events: TaggedEvent[] }

// Shared base for plugins needing GhClient. GhBase extends this for watch-list
// scaffolding; non-watching plugins (e.g. GitHubNewIssuesPlugin) extend directly.
export abstract class GhPluginBase extends BasePlugin {
  protected readonly client: GhClient
  protected readonly log: PluginLogger

  private _rateLimitHistory: Array<{ remaining: number; ts: number }> = []

  // Cross-instance cooldown handle — one warning per 10 min total.
  private static readonly _statics: RateLimitStatics = { warnedAt: null }

  // One breaker shared across every GH plugin — they poll one shared GH budget,
  // so a rate-limit on any of them should quiet all of them.
  private static readonly _breaker = new RateLimitBreaker()

  // Per-entry read-failure state (per instance — a per-watcher signal, unlike
  // the cross-instance rate-limit warn cooldown). Keyed by the entry's read key.
  //   consecutive — failing ticks in a row; reset to 0 on any clean read.
  //   warnedAt    — last time the IRC note fired (cooldown gate against spam).
  //   lastReadAt  — last time we actually attempted the read (throttle gate).
  private _readFailures = new Map<string, { consecutive: number; warnedAt: number; lastReadAt: number }>()

  // Cooldown gate for the whole-batch read-failure warn (per instance) — last
  // time the batch-level note fired; 0 = never / cleared by a clean batch.
  private _batchWarnedAt = 0

  // Last channel set this plugin returned from a clean tick — replayed while the
  // breaker is open so a multi-minute backoff doesn't PART the watched channels.
  private _lastChannels: string[] = []

  constructor(defaultChannel: string, log: PluginLogger = defaultPluginLogger) {
    super(defaultChannel)
    this.log = log
    this.client = new GhClient(log)
  }

  protected agentLogins(config: OrchestratorConfig): Set<string> {
    return new Set(config.agent_logins ?? [])
  }

  // Test-only: reset the shared breaker between cases. The breaker is a
  // class-static, so trip state would otherwise leak across tests.
  static resetBreakerForTest(): void {
    GhPluginBase._breaker.forceClose()
  }

  // ---- gh-call resilience (rate-limit breaker + per-entry transient skip) ---

  // True while the breaker is open — callers return `breakerSkipResult` and skip
  // all polling for the tick.
  protected breakerOpen(now: number): boolean {
    return GhPluginBase._breaker.shouldSkip(now)
  }

  // Silent skip while the breaker is open: preserve state, replay last channels.
  protected breakerSkipResult(prevState: unknown, config: OrchestratorConfig): PluginTickResult {
    return { state: prevState, taggedEvents: [], channels: this.skipChannels(config) }
  }

  // A rate-limit surfaced this tick: open/escalate the breaker, emit one notice
  // when it actually advanced, preserve state and channels. `kind` picks the
  // backoff schedule — secondary (burst) clears fast so it gets a ~1m floor;
  // primary (budget) waits out the longer reset window.
  protected breakerTripResult(
    now: number,
    prevState: unknown,
    projectChannel: string,
    config: OrchestratorConfig,
    kind: RateLimitKind = 'primary',
  ): PluginTickResult {
    const schedule = kind === 'secondary' ? SECONDARY_BACKOFF_SCHEDULE_MS : BACKOFF_SCHEDULE_MS
    const window = GhPluginBase._breaker.trip(now, schedule)
    const taggedEvents: TaggedEvent[] = window != null
      ? [{ channels: [projectChannel], payload: { kind: 'oneline', text: formatBackoffNotice(window, kind) } }]
      : []
    return { state: prevState, taggedEvents, channels: this.skipChannels(config) }
  }

  // Close the breaker after a clean tick (half-open recovery).
  protected breakerReset(now: number): void {
    GhPluginBase._breaker.reset(now)
  }

  // Record the channels a clean tick is returning, for breaker-open replay.
  protected rememberChannels(channels: string[]): string[] {
    this._lastChannels = channels
    return channels
  }

  // Channel set to replay while a tick can't produce a fresh one (breaker open,
  // or a whole-batch read failure) so a transient blip doesn't PART the watched
  // channels. Last clean tick's set, or the config-static set before any.
  protected skipChannels(config: OrchestratorConfig): string[] {
    return this._lastChannels.length ? this._lastChannels : this.desiredChannels(config)
  }

  // Run one watched entry's read. Returns a discriminated result instead of
  // throwing, so one bad entry never aborts the tick's Promise.all (which would
  // drop every sibling plugin's work — the dispatcher runs all runTicks together):
  //   - success      → { ok: true, value }  (clears the entry's failure state)
  //   - rate-limit   → { ok: false, rateLimited: true }  (caller trips the breaker)
  //   - any GhError  → { ok: false, rateLimited: false, events } (skip the entry, warn)
  //   - non-GhError  → re-thrown (a real infra/code bug, e.g. a spawn crash — fail loud)
  // A watched entry erroring is a per-entry condition (401/404/403/422/network);
  // only a genuine non-GhError defect should take the whole tick down.
  //
  // A per-entry consecutive-failure count drives two threshold behaviors off the
  // one signal (see READ_FAILURE_THRESHOLD):
  //   warn   — the IRC note fires only once the entry has failed THRESHOLD ticks
  //            in a row, so a one-off flap (404/401/5xx that clears next tick)
  //            never pings the channel. Past the threshold it repeats per cooldown.
  //   throttle — once past the threshold the entry is likely dead, not flapping,
  //            so we stop re-reading it every tick (each read is ~3 in-call gh
  //            retries); we probe once per cooldown instead. A clean probe resets
  //            the count and the entry recovers to every-tick reads.
  // WARN_COOLDOWN_MS does double duty here: the warn-repeat gate and the probe
  // cadence are the same window, so a degraded entry's note and re-probe align.
  // `recoveryCmd` is the verbatim dispatcher DM to stop watching; `noteChannels`
  // route the note. readEntry builds the note (it holds the error → the reason).
  protected async readEntry<T>(
    cooldownKey: string,
    noteChannels: string[],
    recoveryCmd: string,
    body: () => Promise<T>,
    now = Date.now(),
  ): Promise<ReadEntryResult<T>> {
    // Throttle: a degraded entry probes once per cooldown, not every tick.
    if (this.entryThrottled(cooldownKey, now)) return { ok: false, rateLimited: false, events: [] }
    try {
      const value = await body()
      this.clearEntryFailure(cooldownKey)  // clean read → not failing
      return { ok: true, value }
    } catch (e) {
      if (!(e instanceof GhError)) throw e
      if (isRateLimitError(e)) return { ok: false, rateLimited: true, kind: rateLimitKind(e) }
      const events = this.recordEntryFailure(
        cooldownKey, noteChannels, recoveryCmd, describeReadFailure(e.stderr), e.message, now,
      )
      return { ok: false, rateLimited: false, events }
    }
  }

  // ---- per-entry failure state (shared by readEntry and the batch path) -----
  //
  // The single-call readEntry and the batched PR/issue plugins share one
  // consecutive-failure counter per entry (keyed by read key), driving the same
  // two threshold behaviors (see READ_FAILURE_THRESHOLD): warn-after-N and
  // read-throttle. The batch path can't use readEntry's try/around-a-body shape
  // (one call fetches every entry), so it drives these three primitives directly.

  // True when the entry is degraded and inside its probe cooldown — the caller
  // should skip it (omit from the batch query) and carry its prev snapshot
  // forward. The `<` matches recordEntryFailure's warn gate so re-probe and
  // re-warn share one window exactly.
  protected entryThrottled(key: string, now: number): boolean {
    const st = this._readFailures.get(key)
    return !!st && st.consecutive >= READ_FAILURE_THRESHOLD && now - st.lastReadAt < WARN_COOLDOWN_MS
  }

  // A clean read → the entry isn't failing.
  protected clearEntryFailure(key: string): void {
    this._readFailures.delete(key)
  }

  // Bump the consecutive-failure counter and return the cooldown-gated warn note
  // (empty below the threshold, or when a warn already fired this cooldown).
  // `reason` (from describeReadFailure / describeGraphqlAliasError) names the
  // operator action; `logDetail` is the verbose line for daemon.log.
  protected recordEntryFailure(
    key: string,
    noteChannels: string[],
    recoveryCmd: string,
    reason: string,
    logDetail: string,
    now: number,
  ): TaggedEvent[] {
    const fail = this._readFailures.get(key) ?? { consecutive: 0, warnedAt: 0, lastReadAt: 0 }
    fail.consecutive += 1
    fail.lastReadAt = now
    this._readFailures.set(key, fail)
    this.log(`[${this.name}] read failing for ${key} (${fail.consecutive} in a row): ${logDetail}\n`)
    if (fail.consecutive < READ_FAILURE_THRESHOLD) return []
    const warnedRecently = fail.warnedAt !== 0 && now - fail.warnedAt < WARN_COOLDOWN_MS
    if (warnedRecently) return []
    fail.warnedAt = now
    const noteText = formatReadFailureNote(this.name, key, recoveryCmd, reason)
    return [{ channels: [...noteChannels], payload: { kind: 'oneline', text: noteText } }]
  }

  // ---- whole-batch failure warn (batched PR/issue plugins) ------------------
  //
  // A whole-batch read failure took the entire query down (a persistent 5xx or a
  // top-level GraphQL error), not one bad alias — so it isn't a per-entry
  // condition and never touches the per-entry counters. Surface a single
  // throttled project-channel warn so a sustained batch-wide outage doesn't leave
  // the feed dark, without the N-entry flood a per-entry path would produce: the
  // note repeats at most once per cooldown, and a clean batch clears the gate
  // (clearBatchFailure) so the next outage warns immediately.
  protected recordBatchFailure(projectChannel: string, entryCount: number, err: GhError, now: number): TaggedEvent[] {
    this.log(`[${this.name}] batch read failed (${entryCount} entries): ${err.message}\n`)
    const warnedRecently = this._batchWarnedAt !== 0 && now - this._batchWarnedAt < WARN_COOLDOWN_MS
    if (warnedRecently) return []
    this._batchWarnedAt = now
    const noteText = formatBatchFailureNote(this.name, entryCount, describeReadFailure(err.stderr))
    return [{ channels: [projectChannel], payload: { kind: 'oneline', text: noteText } }]
  }

  // A clean batch → the outage cleared; reset the warn gate so the next one warns
  // on its first tick rather than waiting out a stale cooldown.
  protected clearBatchFailure(): void {
    this._batchWarnedAt = 0
  }

  // End-of-tick: log current GH rate budget and emit an IRC warning to the
  // project channel when the rolling rate predicts exhaustion before reset.
  // Runs even when scrapes failed — a failing tick is often a symptom of exhaustion.
  protected async observeRateLimit(
    projectChannel: string,
    _fetch: (log: PluginLogger) => Promise<RateLimitInfo | null> = fetchRateLimit,
  ): Promise<TaggedEvent[]> {
    const info = await _fetch(this.log)
    if (!info) return []
    const { events, history } = observeRateLimitFromInfo(info, this._rateLimitHistory, GhPluginBase._statics, this.log, projectChannel, 'GH')
    this._rateLimitHistory = history
    return events
  }
}

interface GhPluginConfig {
  watched?: WatchedEntry[]
}

// Bare `#N` when the entry's effective repo matches `config.repo`; full
// `<owner>/<repo>#N` when it diverges (or in multi-repo mode).
function formatEntryLabel(label: string, number: number, repo: string | undefined, defaultRepo: string | undefined): string {
  const isCross = repo != null && repo !== defaultRepo
  return isCross ? `${label} ${repo}#${number}` : `${label} #${number}`
}

// Effective repo — what `resolveRepoEntry` would produce. Null in multi-mode
// bare-watch (caller rejects before dedup).
function effectiveRepo(entryRepo: string | undefined, defaultRepo: string | undefined): string | null {
  return entryRepo ?? defaultRepo ?? null
}

// Watch-list scaffolding for the two per-N github plugins (PRs, issues).
// Owns the `{ watched?: WatchedEntry[] }` slice convention and the
// watch/unwatch/list/help command surface.
export abstract class GhBase extends GhPluginBase {
  // Target keyword for watch/unwatch — `null` = bare `watch <N>`. Each
  // subclass declares what it claims; `parseCommand` below delegates to
  // `tryClaimPerN(this.target, line)`.
  protected abstract readonly target: string | null
  // Singular noun in reply lines (e.g. "issue", "pr").
  protected abstract readonly label: string

  protected watched(config: OrchestratorConfig): WatchedEntry[] {
    return this.pluginConfig<GhPluginConfig>(config)?.watched ?? []
  }

  // Tracked-only; see `Plugin.assertRepoMode` for rationale.
  assertRepoMode(base: OrchestratorConfig): void {
    const topRepo = base.repo
    for (const entry of this.watched(base)) {
      const id = typeof entry.number === 'number' ? `#${entry.number}` : '(unknown)'
      assertEntryRepoMode(this.name, id, entry.repo, topRepo)
    }
  }

  // No watches → no project lookup (avoids requiring `project`/`repo` on minimal configs).
  // Per-entry try/catch: a slug-derivation failure on one entry (e.g. an
  // unrepresentable repo basename) must not drop every sibling entry's
  // channel — log and skip just the bad one.
  protected entryChannels(config: OrchestratorConfig, entries: WatchedEntry[] | undefined): string[] {
    if (!entries?.length) return []
    const project = defaultProject(config)
    const chans = new Set<string>()
    for (const entry of entries) {
      const { repo, number, channels } = resolveRepoEntry(entry, config.repo)
      try {
        chans.add(issueChannel(project, number, channelSlug(config, repo)))
      } catch (e) {
        this.log(`[${this.name}] skipping auto-derived channel for ${repo}#${number}: ${e}\n`)
      }
      for (const c of channels) chans.add(c)
    }
    return [...chans]
  }

  // ---- DM command handling --------------------------------------------

  parseCommand(line: string): ParseResult | null {
    return tryClaimPerN(this.target, line)
  }

  handleCommand(merged: OrchestratorConfig, local: OrchestratorConfig, cmd: Command): string | null {
    if (cmd.kind === 'list') return this.formatListSection(merged)
    if (cmd.kind === 'help') return this.formatHelpSection()
    if (cmd.kind === 'plugin' && cmd.plugin === this.name) {
      const c = cmd.cmd as PerNCommand
      if (c.verb === 'watch') return this.applyWatch(merged, local, c.number, c.repo, c.channels)
      return this.applyUnwatch(merged, local, c.number, c.repo)
    }
    return null
  }

  // Multi-mode bare-watch error — DM grammar lets the operator supply
  // `<owner>/<repo>` to disambiguate; the message points at that fix.
  private bareError(verb: 'watch' | 'unwatch', number: number): string {
    const verbForm = this.target ? `${verb} ${this.target} <N>` : `${verb} <N>`
    return `error: cannot ${verb} ${this.label} #${number} in multi-repo mode (no config.repo) — bare \`${verbForm}\` has no repo; supply \`${verbForm} <owner>/<repo>\``
  }

  private matchEntry(defaultRepo: string | undefined, effective: string, number: number): (e: WatchedEntry) => boolean {
    return e => e.number === number && effectiveRepo(e.repo, defaultRepo) === effective
  }

  private applyWatch(merged: OrchestratorConfig, local: OrchestratorConfig, number: number, repo: string | null, channels: string[]): string {
    const defaultRepo = merged.repo
    const effective = effectiveRepo(repo ?? undefined, defaultRepo)
    if (effective === null) return this.bareError('watch', number)
    const match = this.matchEntry(defaultRepo, effective, number)
    const labelStr = formatEntryLabel(this.label, number, effective, defaultRepo)
    if (!this.watched(merged).some(match)) {
      const slice = this.localSlice<GhPluginConfig>(local)
      slice.watched ??= []
      const entry: WatchedEntry = { number }
      // Only pin entry.repo when it diverges from config.repo — leave bare so
      // a future config.repo change inherits cleanly.
      if (effective !== defaultRepo) entry.repo = effective
      if (channels.length) entry.channels = [...channels]
      slice.watched.push(entry)
      return channels.length ? `watching ${labelStr} + ${channels.join(' ')}` : `watching ${labelStr}`
    }
    const localEntry = (this.pluginConfig<GhPluginConfig>(local)?.watched ?? []).find(match)
    if (!localEntry) return channels.length ? trackedRefusal(labelStr, 'add channels') : `already watching ${labelStr}`
    return addChannelsToEntry(localEntry, channels, labelStr)
  }

  private applyUnwatch(merged: OrchestratorConfig, local: OrchestratorConfig, number: number, repo: string | null): string {
    const defaultRepo = merged.repo
    const effective = effectiveRepo(repo ?? undefined, defaultRepo)
    if (effective === null) return this.bareError('unwatch', number)
    return applyUnwatchEntry<WatchedEntry>(
      this.watched(merged),
      this.pluginConfig<GhPluginConfig>(local)?.watched ?? [],
      this.matchEntry(defaultRepo, effective, number),
      formatEntryLabel(this.label, number, effective, defaultRepo),
    )
  }

  private formatListSection(merged: OrchestratorConfig): string {
    // Concat-merged list can carry the same (number, repo) from base + local;
    // dedup by (effective-repo, number) with channel union.
    const defaultRepo = merged.repo
    const entries = this.watched(merged)
    const byKey = new Map<string, { number: number; repo: string | null; channels: Set<string> }>()
    const order: string[] = []
    for (const e of entries) {
      const eff = effectiveRepo(e.repo, defaultRepo)
      const key = `${eff ?? '<no-repo>'}#${e.number}`
      let bucket = byKey.get(key)
      if (!bucket) {
        bucket = { number: e.number, repo: eff, channels: new Set<string>() }
        byKey.set(key, bucket)
        order.push(key)
      }
      for (const c of e.channels ?? []) bucket.channels.add(c)
    }
    const header = `${this.name} (${byKey.size}):`
    if (!byKey.size) return `${header}\n  (none)`
    const lines = order.map(k => {
      const bucket = byKey.get(k)!
      const isCross = bucket.repo != null && bucket.repo !== defaultRepo
      const idStr = isCross ? `${bucket.repo}#${bucket.number}` : `#${bucket.number}`
      const chans = bucket.channels.size ? ` + ${[...bucket.channels].join(' ')}` : ''
      return `  ${idStr}${chans}`
    })
    return [header, ...lines].join('\n')
  }

  private formatHelpSection(): string {
    const t = this.target ? `${this.target} ` : ''
    return [
      `${this.name} commands (DM only):`,
      `  watch ${t}<N> [<owner>/<repo>] [#chan ...]   — watch ${this.label} N (optionally in a non-default repo)`,
      `  unwatch ${t}<N> [<owner>/<repo>]             — stop watching ${this.label} N`,
      `  watch list                                  — include this plugin's watched ${this.name} in the reply`,
    ].join('\n')
  }
}
