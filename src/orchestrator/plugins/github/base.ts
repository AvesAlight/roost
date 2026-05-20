import type { Command } from '../../dispatcher-dm-handler.js'
import type { OrchestratorConfig, WatchedEntry } from '../../config.js'
import { assertEntryRepoMode, resolveRepoEntry } from '../../config.js'
import { channelSlug, defaultProject, isMultiRepo, issueChannel } from '../../naming.js'
import { BasePlugin, defaultPluginLogger, type PluginLogger, type TaggedEvent } from '../../plugin.js'
import { GhClient, fetchRateLimit, computeRateLimitWarning, RATE_LIMIT_WINDOW_MS, type RateLimitInfo } from './github-api.js'

// Thin shared base for any plugin that needs GhClient but not watch-list
// scaffolding. GhBase extends this; non-watching plugins (e.g.
// GitHubNewIssuesPlugin) extend it directly.
export abstract class GhPluginBase extends BasePlugin {
  protected readonly client: GhClient
  protected readonly log: PluginLogger

  // Per-instance: rolling history of rate limit observations (oldest first).
  private _rateLimitHistory: Array<{ remaining: number; ts: number }> = []

  // Shared across instances — one warning per 10 min regardless of which plugin fires.
  // 10 min: enough signals in a 60-min reset window without spamming.
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

  // Call at the end of runTick (after all gh scraping) to log the current rate
  // limit budget and, if trajectory predicts exhaustion before reset, emit an
  // IRC warning to the project channel. Returns the warning as a TaggedEvent[]
  // (empty when no warning or rate limit fetch failed).
  //
  // Runs even when the tick's own scraping failed — we want to observe the budget
  // through failures since a failing tick is often a symptom of exhaustion.
  protected async observeRateLimit(
    projectChannel: string,
    _fetch: (log: PluginLogger) => Promise<RateLimitInfo | null> = fetchRateLimit,
  ): Promise<TaggedEvent[]> {
    const info = await _fetch(this.log)
    if (!info) return []

    const now = Date.now()

    // Prune history to the rolling window before computing rate.
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

// Shared phrasing for "this watch lives in the tracked file; the dispatcher
// won't touch it". Centralized so a rename of config.json (or a future
// path knob) only flips one string.
const trackedRefusal = (label: string, n: number, action: string) =>
  `${label} #${n} in tracked config.json — hand-edit to ${action}`

// Watch-list scaffolding for the two GitHub plugins (PRs, issues). Owns the
// `<issue-channel> + entry.channels` collector, `{ watched?: WatchedEntry[] }`
// slice convention, and `handleCommand` for watch/unwatch/list/help.
// Each subclass declares the target keyword it claims and a singular label.
export abstract class GhBase extends GhPluginBase {
  // Target keyword this plugin claims for watch/unwatch. `null` = no keyword
  // (bare `watch <N>`). The dispatcher's parser is target-agnostic; plugins
  // declare which keyword (if any) they own here.
  protected abstract readonly target: string | null
  // Singular noun used in reply lines (e.g. "issue", "pr"). Plural is the
  // plugin name slice.
  protected abstract readonly label: string

  // The plugin's `watched` list from `config.plugins[name].watched` — the
  // shared shape for every GhBase plugin.
  protected watched(config: OrchestratorConfig): WatchedEntry[] {
    return this.pluginConfig<GhPluginConfig>(config)?.watched ?? []
  }

  // Each watched entry must respect the active repo mode. In single mode an
  // entry's repo (when set) must equal config.repo; in multi mode every entry
  // must carry its own repo. The dispatcher calls this after every config
  // load — boot, tick reload, and DM snapshot.
  assertRepoMode(config: OrchestratorConfig): void {
    const topRepo = config.repo
    for (const entry of this.watched(config)) {
      const id = typeof entry.number === 'number' ? `#${entry.number}` : '(unknown)'
      assertEntryRepoMode(this.name, id, entry.repo, topRepo)
    }
  }

  // No watches → no project lookup (avoids requiring `project`/`repo` on
  // minimal configs).
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

  // Inbound DM command surface. The dispatcher (dispatcher-dm-handler.ts) calls this
  // once per parsed command inside its mutateConfig pass. Reads consult
  // `merged` (config.json + config.local.json union); writes target `local`
  // — config.json is read-only from the dispatcher. Returns the reply line
  // when we handle the command, null when it isn't ours. Never throws.
  handleCommand(merged: OrchestratorConfig, local: OrchestratorConfig, cmd: Command): string | null {
    if (cmd.kind === 'list') return this.formatListSection(merged)
    if (cmd.kind === 'help') return this.formatHelpSection()
    if (cmd.kind === 'watch') {
      if (cmd.target !== this.target) return null
      return this.applyWatch(merged, local, cmd.number, cmd.channels)
    }
    if (cmd.kind === 'unwatch') {
      if (cmd.target !== this.target) return null
      return this.applyUnwatch(merged, local, cmd.number)
    }
    return null
  }

  // Read-or-create the typed slice under `local.plugins[name]`. Plugins
  // own their slice shape; this is the one mutation seam.
  private localSlice(local: OrchestratorConfig): GhPluginConfig {
    local.plugins ??= {}
    const existing = local.plugins[this.name]
    if (existing && typeof existing === 'object') return existing as GhPluginConfig
    const fresh: GhPluginConfig = {}
    local.plugins[this.name] = fresh
    return fresh
  }

  private applyWatch(merged: OrchestratorConfig, local: OrchestratorConfig, number: number, channels: string[]): string {
    // Multi-repo mode has no inherit target for entry.repo — the bare DM
    // grammar can't disambiguate, so reject it. A cross-repo DM grammar is
    // a known followup; until then, edit the watched list in config.json.
    if (isMultiRepo(merged)) {
      return `error: cannot watch ${this.label} #${number} in multi-repo mode (no config.repo) — bare \`watch <N>\` has no repo; cross-repo DM grammar is a known followup`
    }
    const mergedEntries = this.watched(merged)
    const inMerged = mergedEntries.find(e => e.number === number)
    if (!inMerged) {
      const slice = this.localSlice(local)
      slice.watched ??= []
      const entry: WatchedEntry = { number }
      if (channels.length) entry.channels = [...channels]
      slice.watched.push(entry)
      return channels.length
        ? `watching ${this.label} #${number} + ${channels.join(' ')}`
        : `watching ${this.label} #${number}`
    }
    if (!channels.length) return `already watching ${this.label} #${number}`
    // Adding channels: only the local-overlay entry is writable. If the
    // number lives only in tracked config.json, surface the hand-edit
    // requirement instead of silently failing.
    const localEntries = this.pluginConfig<GhPluginConfig>(local)?.watched ?? []
    const localEntry = localEntries.find(e => e.number === number)
    if (!localEntry) {
      return trackedRefusal(this.label, number, 'add channels')
    }
    const existing = new Set(localEntry.channels ?? [])
    const added: string[] = []
    for (const c of channels) if (!existing.has(c)) { existing.add(c); added.push(c) }
    if (!added.length) return `${this.label} #${number} channels unchanged`
    localEntry.channels = [...existing]
    return `${this.label} #${number} + ${added.join(' ')}`
  }

  private applyUnwatch(merged: OrchestratorConfig, local: OrchestratorConfig, number: number): string {
    // Same multi-repo restriction as applyWatch: bare `unwatch <N>` is
    // ambiguous when N can live in multiple repos.
    if (isMultiRepo(merged)) {
      return `error: cannot unwatch ${this.label} #${number} in multi-repo mode (no config.repo) — bare \`unwatch <N>\` has no repo; cross-repo DM grammar is a known followup`
    }
    const localEntries = this.pluginConfig<GhPluginConfig>(local)?.watched ?? []
    const localIdx = localEntries.findIndex(e => e.number === number)
    if (localIdx >= 0) {
      localEntries.splice(localIdx, 1)
      return `unwatched ${this.label} #${number}`
    }
    const inMerged = this.watched(merged).some(e => e.number === number)
    if (inMerged) {
      return trackedRefusal(this.label, number, 'remove')
    }
    return `not watching ${this.label} #${number}`
  }

  private formatListSection(merged: OrchestratorConfig): string {
    const entries = this.watched(merged)
    const header = `${this.name} (${entries.length}):`
    if (!entries.length) return `${header}\n  (none)`
    const lines = entries.map(e => {
      const chans = e.channels?.length ? ` + ${e.channels.join(' ')}` : ''
      return `  #${e.number}${chans}`
    })
    return [header, ...lines].join('\n')
  }

  private formatHelpSection(): string {
    const t = this.target ? `${this.target} ` : ''
    return [
      `${this.name} commands (DM only):`,
      `  watch ${t}<N> [#chan ...]    — watch ${this.label} N, route extra channels`,
      `  unwatch ${t}<N>              — stop watching ${this.label} N`,
      `  watch list                  — include this plugin's watched ${this.name} in the reply`,
    ].join('\n')
  }
}
