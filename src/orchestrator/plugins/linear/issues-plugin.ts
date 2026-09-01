import type { Command } from '../../dispatcher-dm-handler.js'
import type { OrchestratorConfig } from '../../config.js'
import { defaultProject, linearIssueChannel, resolveProjectChannel } from '../../naming.js'
import {
  BasePlugin,
  defaultPluginLogger,
  type ParseResult,
  type PluginLogger,
  type PluginTickResult,
  type PluginMessage,
} from '../../plugin.js'
import { addChannelsToEntry, applyUnwatchEntry, trackedRefusal } from '../_shared.js'
import { tryClaimPerLinearId, type PerLinearIdCommand } from '../grammar.js'
import { observeRateLimitFromInfo, WARN_COOLDOWN_MS, type RateLimitInfo, type RateLimitStatics } from '../_rate-limit.js'
import { LinearClient } from './linear-api.js'
import { LinearScraper } from './scraper.js'
import { formatLinearMessage } from './format.js'
import { isTombstone, type LinearIssuePluginState, type LinearIssueState, type LinearWatchedEntry } from './types.js'

interface LinearIssuesPluginConfig {
  watched?: LinearWatchedEntry[]
}

// Minimal client surface used by the plugin — graphql() + rate-limit telemetry.
// Both the real `LinearClient` and unit-test mocks implement this.
export interface LinearClientLike {
  graphql(query: string, variables?: Record<string, unknown>): Promise<unknown>
  getLastRateLimit(): RateLimitInfo | null
}

export class LinearIssuesPlugin extends BasePlugin {
  readonly name = 'linear-issues'
  protected readonly log: PluginLogger
  private _client: LinearClientLike | null
  private _envClient: LinearClient | null = null

  private _rateLimitHistory: Array<{ remaining: number; ts: number }> = []
  private static readonly _statics: RateLimitStatics = { warnedAt: null }
  // Per-entry hard-error cooldown slot (issue #735). Keyed by the watched
  // identifier, cooldown-gated so a persistent fetch failure posts once per
  // WARN_COOLDOWN_MS rather than every tick. Distinct from the rate-limit
  // statics (cross-instance) — this is a per-watcher signal.
  private _fetchFailWarnedAt = new Map<string, number>()

  constructor(
    defaultChannel: string,
    log: PluginLogger = defaultPluginLogger,
    injectedClient: LinearClientLike | null = null,
  ) {
    super(defaultChannel)
    this.log = log
    this._client = injectedClient
  }

  // Lazy env-read so dispatcher boot doesn't fail when LINEAR_API_KEY isn't
  // set but the plugin has no watches yet. First tick with a watched entry
  // will throw cleanly via LinearClient.fromEnv if the key is missing.
  private getClient(): LinearClientLike {
    if (this._client) return this._client
    if (!this._envClient) this._envClient = LinearClient.fromEnv(this.log)
    return this._envClient
  }

  protected watched(config: OrchestratorConfig): LinearWatchedEntry[] {
    return this.pluginConfig<LinearIssuesPluginConfig>(config)?.watched ?? []
  }

  desiredChannels(config: OrchestratorConfig): string[] {
    const entries = this.watched(config)
    if (!entries.length) return []
    const project = defaultProject(config)
    const chans = new Set<string>()
    for (const e of entries) {
      chans.add(linearIssueChannel(project, e.identifier))
      for (const c of e.channels ?? []) chans.add(c)
    }
    return [...chans]
  }

  // ---- DM command handling --------------------------------------------

  parseCommand(line: string): ParseResult | null {
    return tryClaimPerLinearId(line)
  }

  handleCommand(merged: OrchestratorConfig, local: OrchestratorConfig, cmd: Command): string | null {
    if (cmd.kind === 'list') return this.formatListSection(merged)
    if (cmd.kind === 'help') return this.formatHelpSection()
    if (cmd.kind === 'plugin' && cmd.plugin === this.name) {
      const c = cmd.cmd as PerLinearIdCommand
      if (c.verb === 'watch') return this.applyWatch(merged, local, c.identifier, c.channels)
      return this.applyUnwatch(merged, local, c.identifier)
    }
    return null
  }

  private matchEntry(identifier: string): (e: LinearWatchedEntry) => boolean {
    return e => e.identifier === identifier
  }

  private applyWatch(merged: OrchestratorConfig, local: OrchestratorConfig, identifier: string, channels: string[]): string {
    const labelStr = `linear issue ${identifier}`
    const match = this.matchEntry(identifier)
    if (!this.watched(merged).some(match)) {
      const slice = this.localSlice<LinearIssuesPluginConfig>(local)
      slice.watched ??= []
      const entry: LinearWatchedEntry = { identifier }
      if (channels.length) entry.channels = [...channels]
      slice.watched.push(entry)
      return channels.length ? `watching ${labelStr} + ${channels.join(' ')}` : `watching ${labelStr}`
    }
    const localEntry = (this.pluginConfig<LinearIssuesPluginConfig>(local)?.watched ?? []).find(match)
    if (!localEntry) return channels.length ? trackedRefusal(labelStr, 'add channels') : `already watching ${labelStr}`
    return addChannelsToEntry(localEntry, channels, labelStr)
  }

  private applyUnwatch(merged: OrchestratorConfig, local: OrchestratorConfig, identifier: string): string {
    return applyUnwatchEntry<LinearWatchedEntry>(
      this.watched(merged),
      this.pluginConfig<LinearIssuesPluginConfig>(local)?.watched ?? [],
      this.matchEntry(identifier),
      `linear issue ${identifier}`,
    )
  }

  private formatListSection(merged: OrchestratorConfig): string {
    const entries = this.watched(merged)
    // Dedup by identifier with channel union — concat-merge can carry the
    // same id from tracked + overlay slices.
    const byKey = new Map<string, { identifier: string; channels: Set<string> }>()
    const order: string[] = []
    for (const e of entries) {
      let bucket = byKey.get(e.identifier)
      if (!bucket) {
        bucket = { identifier: e.identifier, channels: new Set<string>() }
        byKey.set(e.identifier, bucket)
        order.push(e.identifier)
      }
      for (const c of e.channels ?? []) bucket.channels.add(c)
    }
    const header = `${this.name} (${byKey.size}):`
    if (!byKey.size) return `${header}\n  (none)`
    const lines = order.map(k => {
      const bucket = byKey.get(k)!
      const chans = bucket.channels.size ? ` + ${[...bucket.channels].join(' ')}` : ''
      return `  ${bucket.identifier}${chans}`
    })
    return [header, ...lines].join('\n')
  }

  private formatHelpSection(): string {
    return [
      `${this.name} commands (DM only):`,
      `  watch linear <TEAM>-<N> [#chan ...]   — watch Linear issue (e.g. watch linear C-758)`,
      `  unwatch linear <TEAM>-<N>             — stop watching Linear issue`,
      `  watch list                            — include this plugin's watched issues in the reply`,
    ].join('\n')
  }

  // ---- Tick ------------------------------------------------------------

  async runTick(config: OrchestratorConfig, prevState: unknown): Promise<PluginTickResult> {
    const project = defaultProject(config)
    const projectChannel = resolveProjectChannel(config)
    const watched = this.watched(config)
    const prev = prevState as LinearIssuePluginState | null

    if (!watched.length) {
      // No watches → no client needed → no rate-limit telemetry either.
      return { state: { issues: {} }, messages: [], channels: [] }
    }

    const client = this.getClient()
    const scraper = new LinearScraper(client)

    const scraped = await Promise.all(watched.map(async entry => {
      const key = entry.identifier
      const prevEntry: LinearIssueState | null | undefined =
        prev === null ? undefined : (prev.issues[key] ?? null)
      try {
        const { next, events } = await scraper.scrapeIssue(entry.identifier, prevEntry)
        this._fetchFailWarnedAt.delete(key)  // clean fetch → clear the hard-error cooldown slot
        return { kind: 'ok' as const, key, next, events, entryChannels: entry.channels ?? [] }
      } catch (e) {
        // Per-entry isolation: a hard error is rethrown out of scrapeIssue, so
        // catch here. One entry failing must not reject the whole Promise.all
        // and drop every sibling entry's events for the tick — the #602 shape.
        return { kind: 'error' as const, key, entryChannels: entry.channels ?? [], error: e }
      }
    }))

    const curState: LinearIssuePluginState = { issues: {} }
    const messages: PluginMessage[] = []
    for (const item of scraped) {
      if (item.kind === 'error') {
        // Preserve the prior watermark so a recovered tick doesn't re-seed the
        // entry (which would replay the now-watching + backlog events).
        if (prev != null) curState.issues[item.key] = prev.issues[item.key]
        const detail = item.error instanceof Error ? item.error.message : String(item.error)
        this.log(`linear-issues: error fetching issue ${item.key}: ${detail}\n`)
        const now = Date.now()
        const lastWarnedAt = this._fetchFailWarnedAt.get(item.key) ?? 0
        if (now - lastWarnedAt > WARN_COOLDOWN_MS) {
          this._fetchFailWarnedAt.set(item.key, now)
          const issueChan = linearIssueChannel(defaultProject(config), item.key)
          messages.push({
            channels: this.resolveChannels([issueChan], item.entryChannels),
            text: `[linear-issues] issue ${item.key} fetch failing: ${detail}`,
          })
        }
        continue
      }
      curState.issues[item.key] = item.next
      for (const event of item.events) {
        if (event.kind === 'linear_issue_added_to_watch') {
          const issueChan = linearIssueChannel(project, item.key)
          const routingChannels = [issueChan, ...item.entryChannels].filter(ch => ch !== projectChannel)
          messages.push({
            channels: [projectChannel],
            text: `now watching linear issue ${item.key} — routing events to ${routingChannels.join(', ')}`,
          })
          continue
        }
        if (event.kind === 'linear_issue_disappeared') {
          // Project-channel only — the per-issue channel will be orphaned and
          // the operator needs the heads-up where they read leads traffic.
          messages.push({
            channels: [projectChannel],
            text: formatLinearMessage(event),
          })
          continue
        }
        const issueChan = linearIssueChannel(project, item.key)
        messages.push({
          channels: this.resolveChannels([issueChan], item.entryChannels),
          text: formatLinearMessage(event),
        })
      }
    }

    messages.push(...this.observeRateLimit(projectChannel))
    return { state: curState, messages, channels: this.desiredChannels(config) }
  }

  // End-of-tick threshold check — reads `getLastRateLimit()` from the client
  // (already populated by each successful call). Only called after a
  // watched-entry tick, so `getClient()` is guaranteed to have been seeded.
  protected observeRateLimit(projectChannel: string): PluginMessage[] {
    const info = this.getClient().getLastRateLimit()
    if (!info) return []
    const { events, history } = observeRateLimitFromInfo(info, this._rateLimitHistory, LinearIssuesPlugin._statics, this.log, projectChannel, 'Linear')
    this._rateLimitHistory = history
    return events
  }
}

// Re-export so tests can verify tombstone behavior without importing types.js.
export { isTombstone }
