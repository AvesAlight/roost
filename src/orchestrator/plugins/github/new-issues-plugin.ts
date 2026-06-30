// Project-level new-issue triage feed. Polls watched repos for open issues
// and announces the first time a given (repo, number) is observed.
//
// DM grammar: claims target=`new-issues` — `watch new-issues <owner>/<repo>
// [#chan ...]`. `@branch`/`:path` are rejected (entries are repo-only).
//
// State slice: `{ repos: Record<string, number[]> }`. Seeding (`prev===null`)
// and first-observation of a new repo entry both capture without emitting.
// Removed entries are carried forward so remove-then-readd doesn't replay.
import type { Command } from '../../dispatcher-dm-handler.js'
import type { OrchestratorConfig } from '../../config.js'
import { assertEntryRepoMode } from '../../config.js'
import type { ParseResult, PluginTickResult, TaggedEvent } from '../../plugin.js'
import { resolveProjectChannel } from '../../naming.js'
import { addChannelsToEntry, applyUnwatchEntry, trackedRefusal } from '../_shared.js'
import { tryClaimPerRepo, type PerRepoCommand } from '../grammar.js'
import { labelNames, type GhRepoIssue } from './github-api.js'
import { GhPluginBase } from './base.js'
import { formatReadFailureNote } from './backoff.js'

export interface NewIssuesWatchEntry {
  repo: string
  channels?: string[]
}

interface NewIssuesPluginConfig {
  watched?: NewIssuesWatchEntry[]
}

export interface NewIssuesPluginState {
  repos: Record<string, number[]>
}

export class GitHubNewIssuesPlugin extends GhPluginBase {
  readonly name = 'github-new-issues'

  parseCommand(line: string): ParseResult | null {
    return tryClaimPerRepo('new-issues', line)
  }

  handleCommand(merged: OrchestratorConfig, local: OrchestratorConfig, cmd: Command): string | null {
    if (cmd.kind === 'list') return this.formatListSection(merged)
    if (cmd.kind === 'help') return this.formatHelpSection()
    if (cmd.kind === 'plugin' && cmd.plugin === this.name) {
      const c = cmd.cmd as PerRepoCommand
      if (c.branch !== null || c.path !== null) {
        const verb = c.verb
        return `error: new-issues does not support @branch or :path — try \`${verb} new-issues ${c.repo}\``
      }
      if (c.verb === 'watch') return this.applyWatch(merged, local, c.repo, c.channels)
      return this.applyUnwatch(merged, local, c.repo)
    }
    return null
  }

  private mergedWatched(config: OrchestratorConfig): NewIssuesWatchEntry[] {
    return this.pluginConfig<NewIssuesPluginConfig>(config)?.watched ?? []
  }

  private applyWatch(merged: OrchestratorConfig, local: OrchestratorConfig, repo: string, channels: string[]): string {
    const labelStr = `new-issues ${repo}`
    const match = (e: NewIssuesWatchEntry) => e.repo === repo
    if (!this.mergedWatched(merged).some(match)) {
      const slice = this.localSlice<NewIssuesPluginConfig>(local)
      slice.watched ??= []
      const entry: NewIssuesWatchEntry = { repo }
      if (channels.length) entry.channels = [...channels]
      slice.watched.push(entry)
      return channels.length ? `watching ${labelStr} + ${channels.join(' ')}` : `watching ${labelStr}`
    }
    const localEntry = (this.pluginConfig<NewIssuesPluginConfig>(local)?.watched ?? []).find(match)
    if (!localEntry) return channels.length ? trackedRefusal(labelStr, 'add channels') : `already watching ${labelStr}`
    return addChannelsToEntry(localEntry, channels, labelStr)
  }

  private applyUnwatch(merged: OrchestratorConfig, local: OrchestratorConfig, repo: string): string {
    return applyUnwatchEntry<NewIssuesWatchEntry>(
      this.mergedWatched(merged),
      this.pluginConfig<NewIssuesPluginConfig>(local)?.watched ?? [],
      e => e.repo === repo,
      `new-issues ${repo}`,
    )
  }

  private formatListSection(merged: OrchestratorConfig): string {
    const entries = this.mergedWatched(merged)
    const byRepo = new Map<string, Set<string>>()
    const order: string[] = []
    for (const e of entries) {
      let chans = byRepo.get(e.repo)
      if (!chans) {
        chans = new Set<string>()
        byRepo.set(e.repo, chans)
        order.push(e.repo)
      }
      for (const c of e.channels ?? []) chans.add(c)
    }
    const header = `${this.name} (${byRepo.size}):`
    if (!byRepo.size) return `${header}\n  (none)`
    const lines = order.map(r => {
      const chans = byRepo.get(r)!
      const chansStr = chans.size ? ` + ${[...chans].join(' ')}` : ''
      return `  ${r}${chansStr}`
    })
    return [header, ...lines].join('\n')
  }

  private formatHelpSection(): string {
    return [
      `${this.name} commands (DM only):`,
      `  watch new-issues <owner>/<repo> [#chan ...]   — watch new-issues feed`,
      `  unwatch new-issues <owner>/<repo>             — stop watching new-issues feed`,
      `  watch list                                   — include this plugin's watched repos in the reply`,
    ].join('\n')
  }

  // Project channel is unioned in by the orchestrator; per-entry channels join at boot.
  desiredChannels(config: OrchestratorConfig): string[] {
    const slice = this.pluginConfig<NewIssuesPluginConfig>(config) ?? {}
    const chans = new Set<string>()
    for (const entry of slice.watched ?? []) {
      for (const c of entry.channels ?? []) chans.add(c)
    }
    return [...chans]
  }

  // Tracked-only; see `Plugin.assertRepoMode` for rationale. The repo field
  // is statically required, so the multi-mode missing-repo branch never fires.
  assertRepoMode(base: OrchestratorConfig): void {
    const slice = this.pluginConfig<NewIssuesPluginConfig>(base) ?? {}
    const topRepo = base.repo
    for (const entry of slice.watched ?? []) {
      assertEntryRepoMode(this.name, `(repo=${entry.repo})`, entry.repo, topRepo)
    }
  }

  async runTick(config: OrchestratorConfig, prevState: unknown): Promise<PluginTickResult> {
    const slice = this.pluginConfig<NewIssuesPluginConfig>(config) ?? {}
    const watchEntries = slice.watched ?? []
    if (!watchEntries.length) return { state: prevState ?? { repos: {} }, taggedEvents: [], channels: [] }

    const projectChannel = resolveProjectChannel(config)
    const now = Date.now()
    if (this.breakerOpen(now)) return this.breakerSkipResult(prevState ?? { repos: {} }, config)

    // Re-seed cleanly from older shapes (no `repos` key).
    const prev = (prevState != null && typeof prevState === 'object' && 'repos' in prevState)
      ? prevState as NewIssuesPluginState
      : null

    const taggedEvents: TaggedEvent[] = []
    const nextRepos: Record<string, number[]> = prev ? { ...prev.repos } : {}

    for (const entry of watchEntries) {
      const { repo, channels } = entry
      const announcementChannels = channels?.length
        ? [...channels]
        : [projectChannel]

      const r = await this.readEntry(
        repo,
        announcementChannels,
        formatReadFailureNote(this.name, repo, `unwatch new-issues ${repo}`),
        () => this.client.fetchRepoOpenIssues(repo),
        now,
      )
      // Rate-limit discards this tick's partial work and preserves prev state —
      // the next clean tick re-reads and announces what's genuinely new.
      if (!r.ok && r.rateLimited) return this.breakerTripResult(now, prevState ?? { repos: {} }, projectChannel, config)
      if (!r.ok) {
        taggedEvents.push(...r.events)
        continue
      }
      const issues = r.value
      const currentNumbers = issues
        .map(i => i.number)
        .filter((n): n is number => n != null)
        .sort((a, b) => a - b)

      // First observation of this repo (or full re-seed): capture without emitting.
      const isFirstForRepo = prev === null || prev.repos[repo] === undefined
      const seen = new Set<number>(prev?.repos[repo] ?? [])

      if (!isFirstForRepo) {
        const newIssues = issues
          .filter(i => i.number != null && !seen.has(i.number))
          .sort((a, b) => (a.number ?? 0) - (b.number ?? 0))
        for (const issue of newIssues) {
          taggedEvents.push({
            // Per-event copy so a downstream mutation can't leak across siblings.
            channels: [...announcementChannels],
            payload: { kind: 'oneline', text: formatNewIssue(repo, issue) },
          })
        }
      }

      for (const n of currentNumbers) seen.add(n)
      nextRepos[repo] = [...seen].sort((a, b) => a - b)
    }

    this.breakerReset(now)
    const state: NewIssuesPluginState = { repos: nextRepos }
    taggedEvents.push(...await this.observeRateLimit(projectChannel))
    // [] (not rememberChannels): membership is config-static (per-entry channels
    // join at boot, project channel unioned by the orchestrator), so there's
    // nothing dynamic to replay — skipChannels falls back to desiredChannels
    // while the breaker is open.
    return { state, taggedEvents, channels: [] }
  }
}

// The `<owner>/<repo>#<N>` token in this function's output is consumed by
// the triage agent's trigger matcher — keep that token stable if you
// re-edit the wording.
function formatNewIssue(repo: string, issue: GhRepoIssue): string {
  const tag = `${repo}#${issue.number}`
  const title = issue.title ?? ''
  const labels = labelNames(issue.labels)
  const labelStr = labels.length ? ` [${labels.join(', ')}]` : ''
  const url = issue.html_url ?? ''
  return `new issue ${tag}: ${title}${labelStr} — ${url}`
}
