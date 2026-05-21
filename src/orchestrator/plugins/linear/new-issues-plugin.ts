// Per-team new-issue triage feed for Linear. Polls watched teams for open
// issues and announces the first time a given Linear ID is observed.
//
// DM grammar: claims target=`linear-team` — `watch linear-team <TEAM>
// [#chan ...]`. Team key must match `^[A-Z]+$`.
//
// State slice: `{ teams: Record<string, string[]> }`. Seeding (`prev===null`)
// and first-observation of a new team entry both capture without emitting.
// Removed entries are carried forward so remove-then-readd doesn't replay.
import type { Command } from '../../dispatcher-dm-handler.js'
import type { OrchestratorConfig } from '../../config.js'
import type { ParseResult, PluginTickResult, TaggedEvent } from '../../plugin.js'
import { BasePlugin, defaultPluginLogger, type PluginLogger } from '../../plugin.js'
import { resolveProjectChannel } from '../../naming.js'
import { addChannelsToEntry, applyUnwatchEntry, trackedRefusal } from '../_shared.js'
import { observeRateLimitFromInfo, type RateLimitStatics } from '../_rate-limit.js'
import { tryClaimPerLinearTeam, type PerLinearTeamCommand } from '../grammar.js'
import { LinearClient, type LinearIssueNode } from './linear-api.js'

export interface LinearNewIssuesWatchEntry {
  team: string
  channels?: string[]
}

interface LinearNewIssuesPluginConfig {
  watched?: LinearNewIssuesWatchEntry[]
}

export interface LinearNewIssuesPluginState {
  teams: Record<string, string[]>
}

export class LinearNewIssuesPlugin extends BasePlugin {
  readonly name = 'linear-new-issues'

  private readonly log: PluginLogger
  private readonly client: LinearClient
  private _rateLimitHistory: Array<{ remaining: number; ts: number }> = []

  private static readonly _statics: RateLimitStatics = { warnedAt: null }

  constructor(
    defaultChannel: string,
    log: PluginLogger = defaultPluginLogger,
    client?: LinearClient,
  ) {
    super(defaultChannel)
    this.log = log
    this.client = client ?? LinearClient.fromEnv(log)
  }

  parseCommand(line: string): ParseResult | null {
    return tryClaimPerLinearTeam('linear-team', line)
  }

  handleCommand(merged: OrchestratorConfig, local: OrchestratorConfig, cmd: Command): string | null {
    if (cmd.kind === 'list') return this.formatListSection(merged)
    if (cmd.kind === 'help') return this.formatHelpSection()
    if (cmd.kind === 'plugin' && cmd.plugin === this.name) {
      const c = cmd.cmd as PerLinearTeamCommand
      if (c.verb === 'watch') return this.applyWatch(merged, local, c.team, c.channels)
      return this.applyUnwatch(merged, local, c.team)
    }
    return null
  }

  private mergedWatched(config: OrchestratorConfig): LinearNewIssuesWatchEntry[] {
    return this.pluginConfig<LinearNewIssuesPluginConfig>(config)?.watched ?? []
  }

  private applyWatch(merged: OrchestratorConfig, local: OrchestratorConfig, team: string, channels: string[]): string {
    const labelStr = `linear-team ${team}`
    const match = (e: LinearNewIssuesWatchEntry) => e.team === team
    if (!this.mergedWatched(merged).some(match)) {
      const slice = this.localSlice<LinearNewIssuesPluginConfig>(local)
      slice.watched ??= []
      const entry: LinearNewIssuesWatchEntry = { team }
      if (channels.length) entry.channels = [...channels]
      slice.watched.push(entry)
      return channels.length ? `watching ${labelStr} + ${channels.join(' ')}` : `watching ${labelStr}`
    }
    const localEntry = (this.pluginConfig<LinearNewIssuesPluginConfig>(local)?.watched ?? []).find(match)
    if (!localEntry) return channels.length ? trackedRefusal(labelStr, 'add channels') : `already watching ${labelStr}`
    return addChannelsToEntry(localEntry, channels, labelStr)
  }

  private applyUnwatch(merged: OrchestratorConfig, local: OrchestratorConfig, team: string): string {
    return applyUnwatchEntry<LinearNewIssuesWatchEntry>(
      this.mergedWatched(merged),
      this.pluginConfig<LinearNewIssuesPluginConfig>(local)?.watched ?? [],
      e => e.team === team,
      `linear-team ${team}`,
    )
  }

  private formatListSection(merged: OrchestratorConfig): string {
    const entries = this.mergedWatched(merged)
    const byTeam = new Map<string, Set<string>>()
    const order: string[] = []
    for (const e of entries) {
      let chans = byTeam.get(e.team)
      if (!chans) {
        chans = new Set<string>()
        byTeam.set(e.team, chans)
        order.push(e.team)
      }
      for (const c of e.channels ?? []) chans.add(c)
    }
    const header = `${this.name} (${byTeam.size}):`
    if (!byTeam.size) return `${header}\n  (none)`
    const lines = order.map(t => {
      const chans = byTeam.get(t)!
      const chansStr = chans.size ? ` + ${[...chans].join(' ')}` : ''
      return `  ${t}${chansStr}`
    })
    return [header, ...lines].join('\n')
  }

  private formatHelpSection(): string {
    return [
      `${this.name} commands (DM only):`,
      `  watch linear-team <TEAM> [#chan ...]   — watch new-issues feed for TEAM`,
      `  unwatch linear-team <TEAM>             — stop watching new-issues feed`,
      `  watch list                             — include this plugin's watched teams in the reply`,
    ].join('\n')
  }

  desiredChannels(config: OrchestratorConfig): string[] {
    const slice = this.pluginConfig<LinearNewIssuesPluginConfig>(config) ?? {}
    const chans = new Set<string>()
    for (const entry of slice.watched ?? []) {
      for (const c of entry.channels ?? []) chans.add(c)
    }
    return [...chans]
  }

  async runTick(config: OrchestratorConfig, prevState: unknown): Promise<PluginTickResult> {
    const slice = this.pluginConfig<LinearNewIssuesPluginConfig>(config) ?? {}
    const watchEntries = slice.watched ?? []
    if (!watchEntries.length) return { state: prevState ?? { teams: {} }, taggedEvents: [], channels: [] }

    // Re-seed cleanly from older shapes (no `teams` key).
    const prev = (prevState != null && typeof prevState === 'object' && 'teams' in prevState)
      ? prevState as LinearNewIssuesPluginState
      : null

    const taggedEvents: TaggedEvent[] = []
    const nextTeams: Record<string, string[]> = prev ? { ...prev.teams } : {}

    for (const entry of watchEntries) {
      const { team, channels } = entry
      const announcementChannels = channels?.length
        ? [...channels]
        : [resolveProjectChannel(config)]

      let issues: LinearIssueNode[]
      try {
        issues = await this.client.fetchTeamOpenIssues(team)
      } catch (e) {
        this.log(`linear-new-issues: error fetching team ${team}: ${e instanceof Error ? e.message : String(e)}\n`)
        continue
      }

      if (!issues.length && !(prev?.teams[team])) {
        // Team not found on first observation — log and skip but don't block other teams.
        this.log(`linear-new-issues: team ${team} not found or has no open issues; entry kept in config\n`)
      }

      // First observation of this team (or full re-seed): capture without emitting.
      const isFirstForTeam = prev === null || prev.teams[team] === undefined
      const seen = new Set<string>(prev?.teams[team] ?? [])

      if (!isFirstForTeam) {
        const newIssues = issues
          .filter(i => !seen.has(i.identifier))
          .sort((a, b) => linearIdNum(a.identifier) - linearIdNum(b.identifier))
        for (const issue of newIssues) {
          taggedEvents.push({
            channels: [...announcementChannels],
            payload: { kind: 'oneline', text: formatNewLinearIssue(issue) },
          })
        }
      }

      for (const i of issues) seen.add(i.identifier)
      nextTeams[team] = [...seen].sort((a, b) => linearIdNum(a) - linearIdNum(b))
    }

    taggedEvents.push(...this.observeLinearRateLimit(resolveProjectChannel(config)))
    const state: LinearNewIssuesPluginState = { teams: nextTeams }
    return { state, taggedEvents, channels: [] }
  }

  private observeLinearRateLimit(projectChannel: string): TaggedEvent[] {
    const info = this.client.getLastRateLimit()
    if (!info) return []
    const { events, history } = observeRateLimitFromInfo(info, this._rateLimitHistory, LinearNewIssuesPlugin._statics, this.log, projectChannel, 'Linear')
    this._rateLimitHistory = history
    return events
  }
}

// Numeric sort key from `<TEAM>-<N>` identifier — splits on the last dash and
// parses the tail as int. Keeps numeric announcement order matching github-new-issues.
function linearIdNum(identifier: string): number {
  const dash = identifier.lastIndexOf('-')
  return dash >= 0 ? parseInt(identifier.slice(dash + 1), 10) || 0 : 0
}

export function formatNewLinearIssue(issue: LinearIssueNode): string {
  const title = issue.title ?? ''
  const labelNames = (issue.labels?.nodes ?? []).map(l => l.name).filter(Boolean)
  const labelStr = labelNames.length ? ` [${labelNames.join(', ')}]` : ''
  const url = issue.url ?? ''
  return `new linear issue ${issue.identifier}: ${title}${labelStr} — ${url}`
}
