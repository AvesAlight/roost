// Project-level issue triage feed. Polls the repo for open issues and emits a
// oneline announcement to the project channel the first time a given issue
// number is observed. Sibling to `github-issues`: that plugin routes activity
// for hand-watched issues; this one surfaces brand-new issues so the team
// doesn't have to notice them manually. Issue #342.
//
// State slice: `{ seen_issue_numbers: number[] }`. Seeding (`prev===null`)
// captures the current open set without emitting — only ticks after seed
// announce. Closed issues that re-open will re-announce only if they were
// pruned from `seen` (we don't prune today, so closed-then-reopened is
// silently suppressed; that's fine, the operator can `watch <N>` for it).
import type { OrchestratorConfig } from '../../config.js'
import { BasePlugin, type PluginLogger, type PluginTickResult, type TaggedEvent, defaultPluginLogger } from '../../plugin.js'
import { resolveProjectChannel } from '../../naming.js'
import { GhClient, labelNames, type GhRepoIssue } from './github-api.js'

interface NewIssuesPluginConfig {
  repo?: string
  channels?: string[]
}

export interface NewIssuesPluginState {
  seen_issue_numbers: number[]
}

export class GitHubNewIssuesPlugin extends BasePlugin {
  readonly name = 'github-new-issues'

  // Owns the GhClient the same way GhBase does — see #338/#348 for the
  // refactor. Not extending GhBase because that scaffolding is built around
  // a per-entry `watched` slice and this plugin doesn't have one. A thinner
  // shared base could be a future cleanup if more GhClient-only plugins land.
  protected readonly client: GhClient

  constructor(defaultChannel: string, log: PluginLogger = defaultPluginLogger) {
    super(defaultChannel)
    this.client = new GhClient(log)
  }

  // Project channel is unioned in by the orchestrator, so the default case
  // returns []. An explicit slice.channels override is surfaced here so those
  // channels join at boot.
  desiredChannels(config: OrchestratorConfig): string[] {
    const slice = this.pluginConfig<NewIssuesPluginConfig>(config) ?? {}
    return slice.channels?.length ? [...slice.channels] : []
  }

  async runTick(config: OrchestratorConfig, prevState: unknown): Promise<PluginTickResult> {
    const slice = this.pluginConfig<NewIssuesPluginConfig>(config) ?? {}
    const repo = slice.repo ?? config.repo
    if (!repo) throw new Error('github-new-issues: no repo (set `repo` at top level or under plugins.github-new-issues)')

    const announcementChannels = slice.channels?.length
      ? [...slice.channels]
      : [resolveProjectChannel(config)]

    const issues = await this.client.fetchRepoOpenIssues(repo)
    const currentNumbers = issues
      .map(i => i.number)
      .filter((n): n is number => n != null)
      .sort((a, b) => a - b)

    const prev = prevState as NewIssuesPluginState | null
    const seen = new Set<number>(prev?.seen_issue_numbers ?? [])
    const taggedEvents: TaggedEvent[] = []

    if (prev !== null) {
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

    // Always merge — even on seed — so seen accumulates from tick 1.
    for (const n of currentNumbers) seen.add(n)

    const state: NewIssuesPluginState = { seen_issue_numbers: [...seen].sort((a, b) => a - b) }
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
