// Per-team (optionally per-project) new-issue triage feed for Linear. Polls
// watched teams for open issues and announces the first time a given Linear
// ID is observed.
//
// DM grammar: claims target=`linear-team` — `watch linear-team <TEAM>
// [project:"<NAME>"] [#chan ...]`. Team key must match `^[A-Z]+$`.
//
// State slice: `{ teams: Record<string, string[]> }`, keyed by
// `entryKey(team, linearProject)` — bare team key when unscoped, `team::project`
// when scoped. Seeding (`prev===null`) and first-observation of a new watch
// entry both capture without emitting. Removed entries are carried forward so
// remove-then-readd doesn't replay.
import type { Command } from '../../dispatcher-dm-handler.js'
import type { OrchestratorConfig } from '../../config.js'
import type { ParseResult, PluginTickResult, TaggedEvent } from '../../plugin.js'
import { BasePlugin, defaultPluginLogger, type PluginLogger } from '../../plugin.js'
import { resolveProjectChannel } from '../../naming.js'
import { addChannelsToEntry, applyUnwatchEntry, trackedRefusal } from '../_shared.js'
import { observeRateLimitFromInfo, WARN_COOLDOWN_MS, type RateLimitStatics } from '../_rate-limit.js'
import { tryClaimPerLinearTeam, type PerLinearTeamCommand } from '../grammar.js'
import { LinearClient, type FetchTeamIssuesResult, type LinearIssueNode } from './linear-api.js'

export interface LinearNewIssuesWatchEntry {
  team: string
  // Optional Linear project name scoping this watch to one project within
  // `team`. Named `linearProject`, not `project` — `OrchestratorConfig.project`
  // already means the roost project/repo elsewhere in this codebase, and a
  // same-named field meaning something unrelated one file over invites drift.
  linearProject?: string
  channels?: string[]
}

// Identity key for a watch entry: (team, linearProject) pair, not team alone —
// `watch linear-team C` and `watch linear-team C project:"X"` are independent
// watches that coexist. Unscoped entries key on the bare team so on-disk state
// from before project filtering existed keeps matching without a migration.
function entryKey(team: string, linearProject?: string | null): string {
  return linearProject ? `${team}::${linearProject}` : team
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
  // Per-instance Map (vs class-static _statics for rate-limit) — not-found is a
  // per-watcher signal, rate-limit is per-API-budget shared across instances.
  // Keyed by `entryKey(team, linearProject)`, not bare team — two scoped
  // watches on the same team with different (typo'd) project names each get
  // their own cooldown slot, so one doesn't suppress the other's warning.
  private _notFoundWarnedAt = new Map<string, number>()

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
      if (c.verb === 'watch') return this.applyWatch(merged, local, c.team, c.project, c.channels)
      return this.applyUnwatch(merged, local, c.team, c.project)
    }
    return null
  }

  private mergedWatched(config: OrchestratorConfig): LinearNewIssuesWatchEntry[] {
    return this.pluginConfig<LinearNewIssuesPluginConfig>(config)?.watched ?? []
  }

  private applyWatch(
    merged: OrchestratorConfig,
    local: OrchestratorConfig,
    team: string,
    project: string | null,
    channels: string[],
  ): string {
    const labelStr = project ? `linear-team ${team} project:"${project}"` : `linear-team ${team}`
    const match = (e: LinearNewIssuesWatchEntry) => entryKey(e.team, e.linearProject) === entryKey(team, project)
    if (!this.mergedWatched(merged).some(match)) {
      const slice = this.localSlice<LinearNewIssuesPluginConfig>(local)
      slice.watched ??= []
      const entry: LinearNewIssuesWatchEntry = { team }
      if (project) entry.linearProject = project
      if (channels.length) entry.channels = [...channels]
      slice.watched.push(entry)
      return channels.length ? `watching ${labelStr} + ${channels.join(' ')}` : `watching ${labelStr}`
    }
    const localEntry = (this.pluginConfig<LinearNewIssuesPluginConfig>(local)?.watched ?? []).find(match)
    if (!localEntry) return channels.length ? trackedRefusal(labelStr, 'add channels') : `already watching ${labelStr}`
    return addChannelsToEntry(localEntry, channels, labelStr)
  }

  private applyUnwatch(merged: OrchestratorConfig, local: OrchestratorConfig, team: string, project: string | null): string {
    const labelStr = project ? `linear-team ${team} project:"${project}"` : `linear-team ${team}`
    return applyUnwatchEntry<LinearNewIssuesWatchEntry>(
      this.mergedWatched(merged),
      this.pluginConfig<LinearNewIssuesPluginConfig>(local)?.watched ?? [],
      e => entryKey(e.team, e.linearProject) === entryKey(team, project),
      labelStr,
    )
  }

  private formatListSection(merged: OrchestratorConfig): string {
    const entries = this.mergedWatched(merged)
    const byKey = new Map<string, { team: string; project: string | null; chans: Set<string> }>()
    const order: string[] = []
    for (const e of entries) {
      const key = entryKey(e.team, e.linearProject)
      let g = byKey.get(key)
      if (!g) {
        g = { team: e.team, project: e.linearProject ?? null, chans: new Set<string>() }
        byKey.set(key, g)
        order.push(key)
      }
      for (const c of e.channels ?? []) g.chans.add(c)
    }
    const header = `${this.name} (${byKey.size}):`
    if (!byKey.size) return `${header}\n  (none)`
    const lines = order.map(k => {
      const g = byKey.get(k)!
      const projStr = g.project ? ` project:"${g.project}"` : ''
      const chansStr = g.chans.size ? ` + ${[...g.chans].join(' ')}` : ''
      return `  ${g.team}${projStr}${chansStr}`
    })
    return [header, ...lines].join('\n')
  }

  private formatHelpSection(): string {
    return [
      `${this.name} commands (DM only):`,
      `  watch linear-team <TEAM> [project:"<NAME>"] [#chan ...]   — watch new-issues feed for TEAM, optionally scoped to a project`,
      `  unwatch linear-team <TEAM> [project:"<NAME>"]              — stop watching new-issues feed`,
      `  watch list                                                 — include this plugin's watched teams in the reply`,
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
      const { team, linearProject, channels } = entry
      const key = entryKey(team, linearProject)
      const watchLabel = linearProject ? `team ${team} project "${linearProject}"` : `team ${team}`
      const unwatchCmd = linearProject ? `unwatch linear-team ${team} project:"${linearProject}"` : `unwatch linear-team ${team}`
      const announcementChannels = channels?.length
        ? [...channels]
        : [resolveProjectChannel(config)]

      let result: FetchTeamIssuesResult
      try {
        result = await this.client.fetchTeamOpenIssues(team, linearProject)
      } catch (e) {
        this.log(`linear-new-issues: error fetching ${watchLabel}: ${e instanceof Error ? e.message : String(e)}\n`)
        continue
      }

      if (result.kind !== 'ok') {
        const now = Date.now()
        const lastWarnedAt = this._notFoundWarnedAt.get(key) ?? 0
        if (now - lastWarnedAt > WARN_COOLDOWN_MS) {
          this._notFoundWarnedAt.set(key, now)
          const reason = result.kind === 'team-not-found'
            ? `team ${team} not found`
            : `project "${linearProject}" not found in team ${team}`
          taggedEvents.push({
            channels: [...announcementChannels],
            payload: { kind: 'oneline', text: `[linear-new-issues] ${reason} — renamed or deleted? Unwatch with: \`${unwatchCmd}\`` },
          })
        }
        continue
      }
      const issues = result.issues

      // First observation of this watch (or full re-seed): capture without emitting.
      const isFirstForKey = prev === null || prev.teams[key] === undefined
      const seen = new Set<string>(prev?.teams[key] ?? [])

      if (!isFirstForKey) {
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
      nextTeams[key] = [...seen].sort((a, b) => linearIdNum(a) - linearIdNum(b))
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
