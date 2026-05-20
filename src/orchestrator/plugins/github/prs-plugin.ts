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

  // Partition linked issues into those routable in the current mode (same-repo
  // in single-mode; everything in multi-mode) and those dropped (foreign-repo
  // in single-mode). Returning both halves lets the caller emit a stderr
  // warning for drops without re-running the partition.
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

  // Auto-detected channels for a PR event: linked-issue channels (slugged per
  // each linked issue's own repo — closures can cross repos), project channel
  // for no-linked-issues warnings, or PR's own issue channel as fallback.
  // In single-repo mode, cross-repo linked issues are dropped here (the
  // caller has already logged a stderr warning for them).
  private static prEventChannels(
    config: OrchestratorConfig,
    project: string,
    event: OrchestratorEvent,
    projectChannel: string,
    prRepo: string,
  ): string[] {
    if (event.pr == null) return []
    if (event.kind === 'pr_no_linked_issues') return [projectChannel]
    const linked = event.linked_issues ?? []
    const { routable } = GitHubPrsPlugin.partitionLinked(config, prRepo, linked)
    if (routable.length) {
      return routable.map(li => issueChannel(project, li.number, channelSlug(config, li.repo)))
    }
    return [issueChannel(project, event.pr, channelSlug(config, prRepo))]
  }

  // Emit a stderr warning for each cross-repo linked issue dropped in
  // single-repo mode. Operator-visible (the dispatcher log) without IRC noise.
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
      // Log dropped cross-repo links once per scrape (not per event) — the
      // surfacing is operator-facing, not per-IRC-message.
      const { dropped } = GitHubPrsPlugin.partitionLinked(config, snap.repo, snap.linked_issues ?? [])
      GitHubPrsPlugin.logDroppedLinked(this.log, snap.repo, snap.number, dropped)
      for (const event of events) {
        if (event.kind === 'pr_added_to_watch') {
          const linked = event.linked_issues ?? []
          // Suppress when no linked issues — pr_no_linked_issues already fires
          // with the clearer "events won't be routed" message on the same tick.
          if (linked.length) {
            const routingChannels = this.resolveChannels(
              GitHubPrsPlugin.prEventChannels(config, project, event, projectChannel, snap.repo),
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
          channels: this.resolveChannels(GitHubPrsPlugin.prEventChannels(config, project, event, projectChannel, snap.repo), entryChannels),
          payload: formatPayload(event),
        })
      }
    }

    // Comprehensive channel set: static (config) + dynamic (linked-issues
    // discovered during scrape). Slug each linked-issue channel against its
    // *own* repo — `closingIssuesReferences` crosses repos, so the PR's slug
    // is not the right answer.
    const channels = new Set<string>(this.desiredChannels(config))
    for (const snap of Object.values(curState.prs)) {
      const { routable } = GitHubPrsPlugin.partitionLinked(config, snap.repo, snap.linked_issues ?? [])
      for (const li of routable) channels.add(issueChannel(project, li.number, channelSlug(config, li.repo)))
    }

    taggedEvents.push(...await this.observeRateLimit(projectChannel))
    return { state: curState, taggedEvents, channels: [...channels] }
  }
}
