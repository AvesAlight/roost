import type { OrchestratorConfig } from '../../config.js'
import { resolveRepoEntry } from '../../config.js'
import { channelSlug, defaultProject, issueChannel, resolveProjectChannel } from '../../naming.js'
import type { PluginTickResult, TaggedEvent } from '../../plugin.js'
import { GhBase } from './base.js'
import { GhScraper } from './scraper.js'
import { formatPayload } from './format.js'
import { shouldPush, type OrchestratorEvent } from './diff.js'
import type { PrSnap, PrPluginState } from './types.js'

export class GitHubPrsPlugin extends GhBase {
  readonly name = 'github-prs'
  protected readonly target = 'pr'
  protected readonly label = 'pr'

  desiredChannels(config: OrchestratorConfig): string[] {
    return this.entryChannels(config, this.watched(config))
  }

  // Auto-detected channels for a PR event: linked-issue channels, project
  // channel for no-linked-issues warnings, or PR's own issue channel as fallback.
  // `slug` is the multi-repo slug (undefined in single-repo mode). Linked issues
  // are assumed to live in the same repo as the PR — cross-repo closures
  // (gh's `closingIssuesReferences` supports them) would route to a wrong-slug
  // channel; flagged as a known footgun.
  private static prEventChannels(
    project: string,
    event: OrchestratorEvent,
    projectChannel: string,
    slug: string | undefined,
  ): string[] {
    if (event.pr == null) return []
    if (event.kind === 'pr_no_linked_issues') return [projectChannel]
    const linked = event.linked_issues ?? []
    return linked.length
      ? linked.map(n => issueChannel(project, n, slug))
      : [issueChannel(project, event.pr, slug)]
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

    const prev = prevState as PrPluginState | null
    const scraper = new GhScraper(this.client, agentLogins)

    // Scrape all PRs in parallel — each entry is independent. Preserve config
    // order for taggedEvents so output is stable. prevPr semantics for the
    // scraper: undefined = seeding (no prior state at all); null = entry is
    // new to the watch list; PrSnap = normal diff.
    const scraped = await Promise.all(watched.map(async entry => {
      const { repo, number, channels: entryChannels } = resolveRepoEntry(entry, defaultRepo)
      const key = `${repo}#${number}`
      const prevPr: PrSnap | null | undefined = prev === null ? undefined : (prev.prs[key] ?? null)
      const { snap, events } = await scraper.scrapePr(repo, number, prevPr)
      return { key, snap, events, entryChannels }
    }))

    const curState: PrPluginState = { prs: {} }
    const taggedEvents: TaggedEvent[] = []
    for (const { key, snap, events, entryChannels } of scraped) {
      curState.prs[key] = snap
      const slug = channelSlug(config, snap.repo)
      for (const event of events) {
        if (event.kind === 'pr_added_to_watch') {
          const linked = event.linked_issues ?? []
          // Suppress when no linked issues — pr_no_linked_issues already fires
          // with the clearer "events won't be routed" message on the same tick.
          if (linked.length) {
            const routingChannels = this.resolveChannels(
              GitHubPrsPlugin.prEventChannels(project, event, projectChannel, slug),
              entryChannels
            ).filter(ch => ch !== projectChannel)
            taggedEvents.push({
              channels: [projectChannel],
              payload: { kind: 'oneline', text: `now watching PR ${key} — routing events to ${routingChannels.join(', ')}` },
            })
          }
          continue
        }
        if (!shouldPush(event)) continue
        taggedEvents.push({
          channels: this.resolveChannels(GitHubPrsPlugin.prEventChannels(project, event, projectChannel, slug), entryChannels),
          payload: formatPayload(event),
        })
      }
    }

    // Comprehensive channel set: static (config) + dynamic (linked-issues
    // discovered during scrape). Slug each linked-issue channel against the
    // PR's own repo — same-repo assumption as prEventChannels.
    const channels = new Set<string>(this.desiredChannels(config))
    for (const snap of Object.values(curState.prs)) {
      const slug = channelSlug(config, snap.repo)
      for (const n of snap.linked_issues ?? []) channels.add(issueChannel(project, n, slug))
    }

    taggedEvents.push(...await this.observeRateLimit(projectChannel))
    return { state: curState, taggedEvents, channels: [...channels] }
  }
}
