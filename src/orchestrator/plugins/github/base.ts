import type { Command } from '../../dispatcher-dm-handler.js'
import type { OrchestratorConfig, WatchedEntry } from '../../config.js'
import { assertEntryRepoMode, resolveRepoEntry } from '../../config.js'
import { channelSlug, defaultProject, issueChannel } from '../../naming.js'
import { BasePlugin, defaultPluginLogger, type ParseResult, type PluginLogger, type TaggedEvent } from '../../plugin.js'
import { addChannelsToEntry, applyUnwatchEntry, trackedRefusal } from '../_shared.js'
import { tryClaimPerN, type PerNCommand } from '../grammar.js'
import { GhClient, fetchRateLimit, computeRateLimitWarning, RATE_LIMIT_WINDOW_MS, type RateLimitInfo } from './github-api.js'

// Shared base for plugins needing GhClient. GhBase extends this for watch-list
// scaffolding; non-watching plugins (e.g. GitHubNewIssuesPlugin) extend directly.
export abstract class GhPluginBase extends BasePlugin {
  protected readonly client: GhClient
  protected readonly log: PluginLogger

  private _rateLimitHistory: Array<{ remaining: number; ts: number }> = []

  // Cross-instance — one warning per 10 min total. 60-min reset window means
  // ~6 signals max, enough without spamming.
  private static _warnedAt: number | null = null
  private static readonly WARN_COOLDOWN_MS = 10 * 60_000

  constructor(defaultChannel: string, log: PluginLogger = defaultPluginLogger) {
    super(defaultChannel)
    this.log = log
    this.client = new GhClient(log)
  }

  protected agentLogins(config: OrchestratorConfig): Set<string> {
    return new Set(config.agent_logins ?? [])
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

    const now = Date.now()
    const cutoff = now - RATE_LIMIT_WINDOW_MS
    this._rateLimitHistory = this._rateLimitHistory.filter(h => h.ts >= cutoff)

    const prev = this._rateLimitHistory.length > 0
      ? this._rateLimitHistory[this._rateLimitHistory.length - 1]
      : null
    const delta = prev != null ? prev.remaining - info.remaining : null
    const deltaStr = delta != null ? ` (Δ=${delta} since prev sample)` : ''
    const resetMin = Math.round((info.resetAt * 1000 - now) / 60_000)
    this.log(`[ratelimit] remaining=${info.remaining}/${info.limit}${deltaStr} reset_in=${resetMin}m\n`)

    const warning = computeRateLimitWarning(info, this._rateLimitHistory, now)
    this._rateLimitHistory.push({ remaining: info.remaining, ts: now })
    if (!warning) return []

    const cooldownElapsed = GhPluginBase._warnedAt == null || now - GhPluginBase._warnedAt > GhPluginBase.WARN_COOLDOWN_MS
    if (!cooldownElapsed) return []

    GhPluginBase._warnedAt = now
    return [{ channels: [projectChannel], payload: { kind: 'oneline', text: warning } }]
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
  protected entryChannels(config: OrchestratorConfig, entries: WatchedEntry[] | undefined): string[] {
    if (!entries?.length) return []
    const project = defaultProject(config)
    const chans = new Set<string>()
    for (const entry of entries) {
      const { repo, number, channels } = resolveRepoEntry(entry, config.repo)
      chans.add(issueChannel(project, number, channelSlug(config, repo)))
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
