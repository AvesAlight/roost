import type { OrchestratorConfig } from '../../config.js'
import { resolveRepoEntry } from '../../config.js'
import { channelSlug, defaultProject, issueChannel, resolveProjectChannel } from '../../naming.js'
import type { PluginTickResult, TaggedEvent } from '../../plugin.js'
import { GhBase } from './base.js'
import { snapshotIssueFromNode } from './scraper.js'
import { GhError, isRateLimitError, rateLimitKind, type BatchOutcome, type GhIssueNode } from './github-api.js'
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

  // Node → (snapshot, events) for one clean batch entry. A thin instance wrapper
  // over the pure scraper transform, kept as a seam so plugin-routing tests can
  // inject a controlled (snap, events) pair here without building a full GraphQL
  // node and running the diff. The node→snapshot mapping itself is covered
  // directly in the scraper/graphql tests.
  protected snapshotIssue(
    repo: string,
    number: number,
    node: GhIssueNode,
    prevIssue: IssueSnap | null | undefined,
    agentLogins: Set<string>,
  ): { snap: IssueSnap; events: OrchestratorEvent[] } {
    return snapshotIssueFromNode(repo, number, node, prevIssue, agentLogins)
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

    // Resolve every watched entry once. prevIssue: undefined = seed; null = new
    // entry; IssueSnap = normal diff. Degraded entries (past the read-failure
    // threshold, inside their probe cooldown) are omitted from the batch and
    // carried forward — probing them every tick is what we're throttling.
    const resolved = watched.map(entry => {
      const { repo, number, channels: entryChannels } = resolveRepoEntry(entry, defaultRepo)
      const key = `${repo}#${number}`
      return {
        key, repo, number, entryChannels,
        recoveryCmd: `unwatch ${number}${repo !== defaultRepo ? ` ${repo}` : ''}`,
        prevIssue: (prev === null ? undefined : (prev.issues[key] ?? null)) as IssueSnap | null | undefined,
      }
    })
    const toQuery = resolved.filter(e => !this.entryThrottled(e.key, now))

    // One batched GraphQL read over every non-throttled entry: one request per
    // tick regardless of watch count.
    let batch: Map<string, BatchOutcome<GhIssueNode>>
    try {
      batch = await this.client.fetchIssuesBatch(toQuery.map(e => ({ repo: e.repo, number: e.number })))
    } catch (e) {
      // Non-GhError = real infra/code bug — fail loud (don't swallow a defect).
      if (!(e instanceof GhError)) throw e
      // Rate-limit → back off the whole tick; discard partial work, preserve
      // prev. `kind` picks the schedule (secondary burst gets the ~1m floor).
      if (isRateLimitError(e)) return this.breakerTripResult(now, prevState ?? { issues: {} }, projectChannel, config, rateLimitKind(e))
      // Whole-batch transient failure isn't a per-entry condition, so it doesn't
      // spike per-entry counts. Preserve prev, replay channels, and surface one
      // throttled batch-level warn so a sustained outage doesn't go silent.
      const taggedEvents = this.recordBatchFailure(projectChannel, toQuery.length, e, now)
      return { state: prevState ?? { issues: {} }, taggedEvents, channels: this.skipChannels(config) }
    }
    this.breakerReset(now)
    this.clearBatchFailure()

    const curState: IssuePluginState = { issues: {} }
    const taggedEvents: TaggedEvent[] = []
    for (const { key, repo, number, entryChannels, recoveryCmd, prevIssue } of resolved) {
      const outcome = batch.get(key)
      // No outcome = throttled this tick; outcome.ok false = per-alias failure.
      // Both carry the prev snapshot forward. A per-alias miss also bumps the
      // failure counter and warns past the threshold; a throttle stays silent.
      if (!outcome || !outcome.ok) {
        if (outcome && !outcome.ok) {
          taggedEvents.push(...this.recordEntryFailure(key, [projectChannel], recoveryCmd, outcome.reason, outcome.logDetail, now))
        }
        if (prevIssue) curState.issues[key] = prevIssue
        continue
      }
      // Clean read → clear any prior failure state and build the snapshot.
      this.clearEntryFailure(key)
      const { snap, events } = this.snapshotIssue(repo, number, outcome.node, prevIssue, agentLogins)
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
