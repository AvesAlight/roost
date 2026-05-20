import type { Command } from '../../dispatcher-dm-handler.js'
import type { OrchestratorConfig, WatchedEntry } from '../../config.js'
import { assertEntryRepoMode, resolveRepoEntry } from '../../config.js'
import { channelSlug, defaultProject, issueChannel } from '../../naming.js'
import { BasePlugin, defaultPluginLogger, type PluginLogger, type TaggedEvent } from '../../plugin.js'
import { trackedRefusal } from '../_shared.js'
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

// Format a `<label> #<N>` or `<label> <owner>/<repo>#<N>` string. Bare `#N`
// when the entry's effective repo is the same as `config.repo`; cross-repo
// when it differs (including all multi-repo entries, where `defaultRepo`
// is undefined). Same shape used in success, idempotent, and refusal
// replies so a future grep finds them all.
function formatEntryLabel(label: string, number: number, repo: string | undefined, defaultRepo: string | undefined): string {
  const isCross = repo != null && repo !== defaultRepo
  return isCross ? `${label} ${repo}#${number}` : `${label} #${number}`
}

// "Effective" repo for an entry — the value `resolveRepoEntry` would
// produce. Used for dedup and reply formatting; returns null when the
// entry has no repo and there's no default (multi-mode bare-watch),
// which the caller rejects before dedup.
function effectiveRepo(entryRepo: string | undefined, defaultRepo: string | undefined): string | null {
  return entryRepo ?? defaultRepo ?? null
}

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
  //
  // The repo-mode invariant runs only against tracked `config.json` entries
  // — local-overlay entries (DM-driven) bypass it because the DM parser
  // validates OWNER/REPO shape at write time, leaving the overlay
  // parser-clean by construction.
  assertRepoMode(base: OrchestratorConfig): void {
    const topRepo = base.repo
    for (const entry of this.watched(base)) {
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
      return this.applyWatch(merged, local, cmd.number, cmd.repo, cmd.channels)
    }
    if (cmd.kind === 'unwatch') {
      if (cmd.target !== this.target) return null
      return this.applyUnwatch(merged, local, cmd.number, cmd.repo)
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

  private applyWatch(merged: OrchestratorConfig, local: OrchestratorConfig, number: number, repo: string | null, channels: string[]): string {
    // Resolve the entry's effective repo. Bare `watch <N>` in multi-repo
    // mode has no inherit target — the DM grammar now lets the operator
    // supply `<owner>/<repo>` to disambiguate, so the rejection points at
    // that fix.
    const defaultRepo = merged.repo
    const effective = effectiveRepo(repo ?? undefined, defaultRepo)
    if (effective === null) {
      const verbForm = this.target ? `watch ${this.target} <N>` : 'watch <N>'
      return `error: cannot watch ${this.label} #${number} in multi-repo mode (no config.repo) — bare \`${verbForm}\` has no repo; supply \`${verbForm} <owner>/<repo>\``
    }
    // Dedup by (number, effective repo) — `watch pr 5` and `watch pr 5
    // org/other` are distinct entries in single-repo mode.
    const inMerged = this.watched(merged).find(e => e.number === number && effectiveRepo(e.repo, defaultRepo) === effective)
    const labelStr = formatEntryLabel(this.label, number, effective, defaultRepo)
    if (!inMerged) {
      const slice = this.localSlice(local)
      slice.watched ??= []
      const entry: WatchedEntry = { number }
      // Only pin entry.repo when it'd differ from config.repo — otherwise
      // leave it bare so a future config.repo change inherits cleanly.
      if (effective !== defaultRepo) entry.repo = effective
      if (channels.length) entry.channels = [...channels]
      slice.watched.push(entry)
      return channels.length
        ? `watching ${labelStr} + ${channels.join(' ')}`
        : `watching ${labelStr}`
    }
    if (!channels.length) return `already watching ${labelStr}`
    // Adding channels: only the local-overlay entry is writable. If the
    // matched entry lives only in tracked config.json, surface the
    // hand-edit requirement instead of silently failing.
    const localEntries = this.pluginConfig<GhPluginConfig>(local)?.watched ?? []
    const localEntry = localEntries.find(e => e.number === number && effectiveRepo(e.repo, defaultRepo) === effective)
    if (!localEntry) {
      return trackedRefusal(labelStr, 'add channels')
    }
    const existing = new Set(localEntry.channels ?? [])
    const added: string[] = []
    for (const c of channels) if (!existing.has(c)) { existing.add(c); added.push(c) }
    if (!added.length) return `${labelStr} channels unchanged`
    localEntry.channels = [...existing]
    return `${labelStr} + ${added.join(' ')}`
  }

  private applyUnwatch(merged: OrchestratorConfig, local: OrchestratorConfig, number: number, repo: string | null): string {
    const defaultRepo = merged.repo
    const effective = effectiveRepo(repo ?? undefined, defaultRepo)
    if (effective === null) {
      const verbForm = this.target ? `unwatch ${this.target} <N>` : 'unwatch <N>'
      return `error: cannot unwatch ${this.label} #${number} in multi-repo mode (no config.repo) — bare \`${verbForm}\` has no repo; supply \`${verbForm} <owner>/<repo>\``
    }
    const labelStr = formatEntryLabel(this.label, number, effective, defaultRepo)
    const localEntries = this.pluginConfig<GhPluginConfig>(local)?.watched ?? []
    const localIdx = localEntries.findIndex(e => e.number === number && effectiveRepo(e.repo, defaultRepo) === effective)
    if (localIdx >= 0) {
      localEntries.splice(localIdx, 1)
      return `unwatched ${labelStr}`
    }
    const inMerged = this.watched(merged).some(e => e.number === number && effectiveRepo(e.repo, defaultRepo) === effective)
    if (inMerged) {
      return trackedRefusal(labelStr, 'remove')
    }
    return `not watching ${labelStr}`
  }

  private formatListSection(merged: OrchestratorConfig): string {
    // Concat-merged watched lists can carry the same (number, repo) from
    // both base and local (e.g. post-upgrade reconcile). Dedup by the
    // (effective-repo, number) tuple with a channel union so the
    // operator-visible reply matches what's actually being scraped.
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
