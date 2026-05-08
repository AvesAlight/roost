import type { OrchestratorConfig } from '../../config.js'
import { resolveRepoEntry } from '../../config.js'
import type { PluginTickResult, TaggedEvent } from '../../plugin.js'
import { GhBase } from './base.js'
import { scrapeIssue } from './scraper.js'
import { formatPayload } from './format.js'
import { shouldPush, type OrchestratorEvent } from './diff.js'
import type { IssueSnap, IssuePluginState } from './types.js'

export class GitHubIssuesPlugin extends GhBase {
  readonly name = 'github-issues'

  desiredChannels(config: OrchestratorConfig): string[] {
    return this.entryChannels(config.watched_issues, config.repo)
  }

  // Auto-detected channel for an issue event: the issue's own channel.
  private static issueEventChannels(event: OrchestratorEvent): string[] {
    return event.issue != null ? [`#issue-${event.issue}`] : []
  }

  async runTick(
    config: OrchestratorConfig,
    prevState: unknown
  ): Promise<PluginTickResult> {
    const defaultRepo = config.repo
    const watched = config.watched_issues ?? []
    const agentLogins = this.agentLogins(config)

    const prev = prevState as IssuePluginState | null

    // Scrape all issues in parallel — each entry is independent. Preserve
    // config order for taggedEvents so output is stable. prevIssue semantics:
    // undefined = seeding; null = new to watch list; IssueSnap = normal diff.
    const scraped = await Promise.all(watched.map(async entry => {
      const { repo, number, channels: entryChannels } = resolveRepoEntry(entry, defaultRepo)
      const key = `${repo}#${number}`
      const prevIssue: IssueSnap | null | undefined = prev === null ? undefined : (prev.issues[key] ?? null)
      const { snap, events } = await scrapeIssue(repo, number, prevIssue, agentLogins)
      return { key, snap, events, entryChannels }
    }))

    const curState: IssuePluginState = { issues: {} }
    const taggedEvents: TaggedEvent[] = []
    for (const { key, snap, events, entryChannels } of scraped) {
      curState.issues[key] = snap
      for (const event of events) {
        if (!shouldPush(event)) continue
        taggedEvents.push({
          channels: this.resolveChannels(GitHubIssuesPlugin.issueEventChannels(event), entryChannels),
          payload: formatPayload(event),
        })
      }
    }

    return { state: curState, taggedEvents, channels: this.desiredChannels(config) }
  }
}
