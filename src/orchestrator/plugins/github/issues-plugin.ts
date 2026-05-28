import type { OrchestratorConfig } from '../../config.js'
import { resolveRepoEntry } from '../../config.js'
import { channelSlug, defaultProject, issueChannel, resolveProjectChannel } from '../../naming.js'
import type { PluginTickResult, TaggedEvent } from '../../plugin.js'
import { GhBase } from './base.js'
import { formatReadFailureNote } from './backoff.js'
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

  private static issueEventChannels(project: string, event: OrchestratorEvent, slug: string | undefined): string[] {
    return event.issue != null ? [issueChannel(project, event.issue, slug)] : []
  }

  async runTick(
    config: OrchestratorConfig,
    prevState: unknown
  ): Promise<PluginTickResult> {
    const project = defaultProject(config)
    const projectChannel = resolveProjectChannel(config)
    const defaultRepo = config.repo
    const watched = this.watched(config)
    // Nothing to poll: return before the breaker block. An idle plugin must not
    // reset the shared breaker — at half-open it would clear a sibling's
    // in-flight escalation every tick and pin the backoff at its first window.
    if (!watched.length) return { state: prevState ?? { issues: {} }, taggedEvents: [], channels: [] }
    const agentLogins = this.agentLogins(config)

    const prev = prevState as IssuePluginState | null
    const now = Date.now()
    if (this.breakerOpen(now)) return this.breakerSkipResult(prevState ?? { issues: {} }, config)

    const scraper = new GhScraper(this.client, agentLogins)

    // Scrape in parallel — entries are independent. Preserve config order.
    // prevIssue: undefined = seed; null = new entry; IssueSnap = normal diff.
    // readEntry returns a discriminated result instead of throwing, so a
    // rate-limit on one entry doesn't abandon its siblings mid-flight.
    const scraped = await Promise.all(watched.map(async entry => {
      const { repo, number, channels: entryChannels } = resolveRepoEntry(entry, defaultRepo)
      const key = `${repo}#${number}`
      const prevIssue: IssueSnap | null | undefined = prev === null ? undefined : (prev.issues[key] ?? null)
      const r = await this.readEntry(
        key,
        [projectChannel],
        formatReadFailureNote(this.name, key, `unwatch ${number}${repo !== defaultRepo ? ` ${repo}` : ''}`),
        () => scraper.scrapeIssue(repo, number, prevIssue),
        now,
      )
      return { key, prevIssue, entryChannels, r }
    }))

    // Any rate-limit → back off the whole tick; discard partial work, preserve prev.
    if (scraped.some(s => !s.r.ok && s.r.rateLimited)) {
      return this.breakerTripResult(now, prevState ?? { issues: {} }, projectChannel, config)
    }
    this.breakerReset(now)

    const curState: IssuePluginState = { issues: {} }
    const taggedEvents: TaggedEvent[] = []
    for (const { key, prevIssue, entryChannels, r } of scraped) {
      if (!r.ok) {
        if (r.rateLimited) continue  // unreachable: any rate-limit returned above; narrows the type
        // Transient skip: carry the prev snapshot forward, emit the cooldown note.
        if (prevIssue) curState.issues[key] = prevIssue
        taggedEvents.push(...r.events)
        continue
      }
      const { snap, events } = r.value
      curState.issues[key] = snap
      const slug = channelSlug(config, snap.repo)
      for (const event of events) {
        if (event.kind === 'issue_added_to_watch') {
          const routingChannels = this.resolveChannels(
            GitHubIssuesPlugin.issueEventChannels(project, event, slug),
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
          channels: this.resolveChannels(GitHubIssuesPlugin.issueEventChannels(project, event, slug), entryChannels),
          payload: formatPayload(event),
        })
      }
    }

    taggedEvents.push(...await this.observeRateLimit(projectChannel))
    return { state: curState, taggedEvents, channels: this.rememberChannels(this.desiredChannels(config)) }
  }
}
