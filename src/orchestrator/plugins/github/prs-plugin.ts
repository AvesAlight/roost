import type { OrchestratorConfig } from '../../config.js'
import { resolveRepoEntry } from '../../config.js'
import { channelSlug, defaultProject, isMultiRepo, issueChannel, resolveProjectChannel } from '../../naming.js'
import type { PluginLogger, PluginTickResult, TaggedEvent } from '../../plugin.js'
import { GhBase } from './base.js'
import { GhScraper } from './scraper.js'
import { formatPayload } from './format.js'
import { shouldPush, type OrchestratorEvent } from './diff.js'
import type { LinkedIssue, PrSnap, PrPluginState } from './types.js'

export class GitHubPrsPlugin extends GhBase {
  readonly name = 'github-prs'
  protected readonly target = 'pr'
  protected readonly label = 'pr'

  desiredChannels(config: OrchestratorConfig): string[] {
    return this.entryChannels(config, this.watched(config))
  }

  // Routable = same-repo in single-mode, everything in multi-mode. Dropped =
  // foreign-repo in single-mode. One partition per scrape, threaded everywhere.
  private static partitionLinked(
    config: OrchestratorConfig,
    prRepo: string,
    linked: LinkedIssue[],
  ): { routable: LinkedIssue[]; dropped: LinkedIssue[] } {
    if (isMultiRepo(config)) return { routable: linked, dropped: [] }
    const routable: LinkedIssue[] = []
    const dropped: LinkedIssue[] = []
    for (const li of linked) {
      if (li.repo === prRepo) routable.push(li)
      else dropped.push(li)
    }
    return { routable, dropped }
  }

  // Channels for a PR event: linked-issue channels (each slugged per its own
  // repo), project channel for no-linked-issues warnings, PR channel fallback.
  private static prEventChannels(
    config: OrchestratorConfig,
    project: string,
    event: OrchestratorEvent,
    projectChannel: string,
    prRepo: string,
    routable: LinkedIssue[],
  ): string[] {
    if (event.pr == null) return []
    if (event.kind === 'pr_no_linked_issues') return [projectChannel]
    if (routable.length) {
      return routable.map(li => issueChannel(project, li.number, channelSlug(config, li.repo)))
    }
    return [issueChannel(project, event.pr, channelSlug(config, prRepo))]
  }

  // Stderr-only — operator-visible in daemon.log without IRC noise.
  private static logDroppedLinked(
    log: PluginLogger,
    prRepo: string,
    prNumber: number,
    dropped: LinkedIssue[],
  ): void {
    for (const li of dropped) {
      log(
        `[github-prs] PR ${prRepo}#${prNumber} closes ${li.repo}#${li.number} ` +
        `but dispatcher is single-mode on ${prRepo}; cross-repo closure not routed. ` +
        `add ${li.repo} to config or switch to multi-repo mode.\n`
      )
    }
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

    // Scrape in parallel — entries are independent. Preserve config order.
    // prevPr: undefined = seed; null = new entry; PrSnap = normal diff.
    const scraped = await Promise.all(watched.map(async entry => {
      const { repo, number, channels: entryChannels } = resolveRepoEntry(entry, defaultRepo)
      const key = `${repo}#${number}`
      const prevPr: PrSnap | null | undefined = prev === null ? undefined : (prev.prs[key] ?? null)
      const { snap, events } = await scraper.scrapePr(repo, number, prevPr)
      return { key, snap, events, entryChannels }
    }))

    const curState: PrPluginState = { prs: {} }
    const taggedEvents: TaggedEvent[] = []
    // Static (config) + dynamic (linked-issues from scrape). Each linked-issue
    // channel is slugged against its own repo (closures can cross repos).
    const channels = new Set<string>(this.desiredChannels(config))
    for (const { key, snap, events, entryChannels } of scraped) {
      curState.prs[key] = snap
      const { routable, dropped } = GitHubPrsPlugin.partitionLinked(config, snap.repo, snap.linked_issues ?? [])
      for (const li of routable) channels.add(issueChannel(project, li.number, channelSlug(config, li.repo)))
      // Cross-repo drop warning debounced per head_oid (force-push re-triggers).
      const prevWarnedOid = prev?.prs[key]?.warned_drops_for_oid ?? null
      if (dropped.length) {
        if (prevWarnedOid !== snap.head_oid) {
          GitHubPrsPlugin.logDroppedLinked(this.log, snap.repo, snap.number, dropped)
        }
        snap.warned_drops_for_oid = snap.head_oid
      }
      for (const event of events) {
        if (event.kind === 'pr_added_to_watch') {
          const linked = event.linked_issues ?? []
          // Suppress when no linked issues — pr_no_linked_issues already fires this tick.
          if (linked.length) {
            const routingChannels = this.resolveChannels(
              GitHubPrsPlugin.prEventChannels(config, project, event, projectChannel, snap.repo, routable),
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
          channels: this.resolveChannels(GitHubPrsPlugin.prEventChannels(config, project, event, projectChannel, snap.repo, routable), entryChannels),
          payload: formatPayload(event),
        })
      }
    }

    taggedEvents.push(...await this.observeRateLimit(projectChannel))
    return { state: curState, taggedEvents, channels: [...channels] }
  }
}
