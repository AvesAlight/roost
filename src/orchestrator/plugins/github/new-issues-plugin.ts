// Project-level issue triage feed. Polls a configured list of repos for open
// issues and emits a oneline announcement to the per-entry channels the first
// time a given issue number is observed in that repo. Sibling to
// `github-issues`: that plugin routes activity for hand-watched issues; this
// one surfaces brand-new issues so the team doesn't have to notice them
// manually.
//
// Enabled by an explicit `plugins.github-new-issues` slice in config.
// Empty or absent `watched` is a no-op (matches commits-plugin). `bin/roost
// init` writes one for new projects; existing projects need an operator edit
// (or the example.json refresh) to pick this up.
//
// State slice: `{ repos: Record<string, number[]> }` keyed by repo slug.
// Seeding (`prev===null`) and first-observation of a new repo entry
// (`prev.repos[repo]===undefined`) both capture the current open set without
// emitting — only ticks after seed announce. Removed entries are carried
// forward in state (matches commits-plugin) so remove-then-readd doesn't
// replay history. Closed issues that re-open will re-announce only if pruned
// from `seen` (we don't prune today; the operator can `watch <N>` for it).
import type { OrchestratorConfig } from '../../config.js'
import type { PluginTickResult, TaggedEvent } from '../../plugin.js'
import { resolveProjectChannel } from '../../naming.js'
import { labelNames, type GhRepoIssue } from './github-api.js'
import { GhPluginBase } from './base.js'

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

  // Project channel is unioned in by the orchestrator. Explicit per-entry
  // channels are surfaced here so they join at boot.
  desiredChannels(config: OrchestratorConfig): string[] {
    const slice = this.pluginConfig<NewIssuesPluginConfig>(config) ?? {}
    const chans = new Set<string>()
    for (const entry of slice.watched ?? []) {
      for (const c of entry.channels ?? []) chans.add(c)
    }
    return [...chans]
  }

  async runTick(config: OrchestratorConfig, prevState: unknown): Promise<PluginTickResult> {
    const slice = this.pluginConfig<NewIssuesPluginConfig>(config) ?? {}
    const watchEntries = slice.watched ?? []
    // Empty or absent watched is a no-op — matches commits-plugin semantics so
    // an init-stub `{ "watched": [] }` is harmless.
    if (!watchEntries.length) return { state: prevState ?? { repos: {} }, taggedEvents: [], channels: [] }

    // State migration: old flat format (`seen_issue_numbers` present, `repos` absent) re-seeds cleanly.
    const prev = (prevState != null && typeof prevState === 'object' && 'repos' in prevState)
      ? prevState as NewIssuesPluginState
      : null

    const taggedEvents: TaggedEvent[] = []
    // Carry forward all repos from prev (matches commits-plugin state retention:
    // remove-then-readd doesn't replay history).
    const nextRepos: Record<string, number[]> = prev ? { ...prev.repos } : {}

    for (const entry of watchEntries) {
      const { repo, channels } = entry
      const announcementChannels = channels?.length
        ? [...channels]
        : [resolveProjectChannel(config)]

      const issues = await this.client.fetchRepoOpenIssues(repo)
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
            // Per-event copy so a downstream mutation of one event's channel
            // list can't leak into siblings.
            channels: [...announcementChannels],
            payload: { kind: 'oneline', text: formatNewIssue(repo, issue) },
          })
        }
      }

      for (const n of currentNumbers) seen.add(n)
      nextRepos[repo] = [...seen].sort((a, b) => a - b)
    }

    const state: NewIssuesPluginState = { repos: nextRepos }
    taggedEvents.push(...await this.observeRateLimit(resolveProjectChannel(config)))
    return { state, taggedEvents, channels: [] }
  }
}

function formatNewIssue(repo: string, issue: GhRepoIssue): string {
  const tag = `${repo}#${issue.number}`
  const title = issue.title ?? ''
  const labels = labelNames(issue.labels)
  const labelStr = labels.length ? ` [${labels.join(', ')}]` : ''
  const url = issue.html_url ?? ''
  return `new issue ${tag}: ${title}${labelStr} — ${url}`
}
