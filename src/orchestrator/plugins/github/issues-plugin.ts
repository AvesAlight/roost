import type { OrchestratorConfig } from '../../config.js'
import { resolveRepoEntry } from '../../config.js'
import { defaultProject, issueChannel, resolveProjectChannel } from '../../naming.js'
import type { PluginTickResult, TaggedEvent } from '../../plugin.js'
import { GhBase } from './base.js'
import { GhScraper } from './scraper.js'
import { formatPayload } from './format.js'
import { shouldPush, type OrchestratorEvent } from './diff.js'
import type { IssueSnap, IssuePluginState } from './types.js'

export class GitHubIssuesPlugin extends GhBase {
  readonly name = 'github-issues'
  protected readonly target = null
  protected readonly label = 'issue'

  desiredChannels(config: OrchestratorConfig): string[] {
    return this.entryChannels(config, this.watched(config))
  }

  // Auto-detected channel for an issue event: the issue's own channel.
  private static issueEventChannels(project: string, event: OrchestratorEvent): string[] {
    return event.issue != null ? [issueChannel(project, event.issue)] : []
  }

  async runTick(
    config: OrchestratorConfig,
    prevState: unknown
  ): Promise<PluginTickResult> {
    const project = defaultProject(config)
    const projectChannel = resolveProjectChannel(config)
    const defaultRepo = config.repo
    const watched = this.watched(config)
    const agentLogins = this.agentLogins(config)

    const prev = prevState as IssuePluginState | null
    const scraper = new GhScraper(this.client, agentLogins)

    // Scrape all issues in parallel — each entry is independent. Preserve
    // config order for taggedEvents so output is stable. prevIssue semantics:
    // undefined = seeding; null = new to watch list; IssueSnap = normal diff.
    const scraped = await Promise.all(watched.map(async entry => {
      const { repo, number, channels: entryChannels } = resolveRepoEntry(entry, defaultRepo)
      const key = `${repo}#${number}`
      const prevIssue: IssueSnap | null | undefined = prev === null ? undefined : (prev.issues[key] ?? null)
      const { snap, events } = await scraper.scrapeIssue(repo, number, prevIssue)
      return { key, snap, events, entryChannels }
    }))

    const curState: IssuePluginState = { issues: {} }
    const taggedEvents: TaggedEvent[] = []
    for (const { key, snap, events, entryChannels } of scraped) {
      curState.issues[key] = snap
      for (const event of events) {
        if (event.kind === 'issue_added_to_watch') {
          // Issues always get a confirmation — no no-linked-issues analogue here.
          const routingChannels = this.resolveChannels(
            GitHubIssuesPlugin.issueEventChannels(project, event),
            entryChannels
          ).filter(ch => ch !== projectChannel)
          taggedEvents.push({
            channels: [projectChannel],
            payload: { kind: 'oneline', text: `now watching issue ${key} — routing events to ${routingChannels.join(', ')}` },
          })
          continue
        }
        if (!shouldPush(event)) continue
        taggedEvents.push({
          channels: this.resolveChannels(GitHubIssuesPlugin.issueEventChannels(project, event), entryChannels),
          payload: formatPayload(event),
        })
      }
    }

    taggedEvents.push(...await this.observeRateLimit(projectChannel))
    return { state: curState, taggedEvents, channels: this.desiredChannels(config) }
  }
}
