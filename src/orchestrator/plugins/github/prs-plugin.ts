import type { OrchestratorConfig } from '../../config.js'
import { resolveRepoEntry } from '../../config.js'
import { channelSlug, defaultProject, isMultiRepo, issueChannel, linearIssueChannel, resolveProjectChannel } from '../../naming.js'
import type { PluginLogger, PluginTickResult, TaggedEvent } from '../../plugin.js'
import { GhBase } from './base.js'
import { formatReadFailureNote } from './backoff.js'
import { GhScraper } from './scraper.js'
import { formatPayload } from './format.js'
import { shouldPush, type OrchestratorEvent } from './diff.js'
import type { LinkedIssue, PrSnap, PrPluginState } from './types.js'
import { LinearClient } from '../linear/linear-api.js'
import { LinearAttachmentResolver, makeBatchedAttachmentQuery, prKey, type AttachmentQuery } from '../linear-link.js'

interface LinearIssuesSliceShape {
  watched?: Array<{ identifier?: unknown }>
}

// Extract Linear identifiers from `config.plugins['linear-issues'].watched`.
// Trusts the existing linear-issues parser to have validated shape on write;
// defensive against operator hand-edits via the `typeof` filter.
function linearWatchedIdentifiers(config: OrchestratorConfig): string[] {
  const slice = config.plugins?.['linear-issues'] as LinearIssuesSliceShape | undefined
  const entries = slice?.watched ?? []
  const out: string[] = []
  const seen = new Set<string>()
  for (const e of entries) {
    if (typeof e?.identifier !== 'string') continue
    if (seen.has(e.identifier)) continue
    seen.add(e.identifier)
    out.push(e.identifier)
  }
  return out
}

export class GitHubPrsPlugin extends GhBase {
  readonly name = 'github-prs'
  protected readonly target = 'pr'
  protected readonly label = 'pr'

  // Lazy — the resolver pulls `LINEAR_API_KEY` from env via LinearClient.
  // Deferring construction until a non-empty Linear watch set is observed keeps
  // dispatcher boot working when no Linear plugin is enabled. Tests inject via
  // `_setLinearQueryForTest`.
  private _linearResolver: LinearAttachmentResolver | null = null

  // Test seam — wires an injected query function in place of the env-built
  // LinearClient. Used by github plugin tests that exercise cross-link routing
  // without standing up a real Linear API.
  _setLinearQueryForTest(query: AttachmentQuery | null): void {
    this._linearResolver = query ? new LinearAttachmentResolver(query, this.log) : null
  }

  private getLinearResolver(): LinearAttachmentResolver {
    if (this._linearResolver) return this._linearResolver
    const client = LinearClient.fromEnv(this.log)
    this._linearResolver = new LinearAttachmentResolver(makeBatchedAttachmentQuery(client), this.log)
    return this._linearResolver
  }

  desiredChannels(config: OrchestratorConfig): string[] {
    const chans = new Set(this.entryChannels(config, this.watched(config)))
    // Static, config-only — every watched Linear identifier maps to its own
    // channel that github-prs may route events to. linear-issues already joins
    // these but joining is idempotent; declaring interest keeps the boot-time
    // channel union accurate.
    //
    // The try/catch around defaultProject is deliberate: desiredChannels runs
    // at boot, where a misconfigured project would orphan every plugin's join
    // list. linear-issues' own desiredChannels throws on the same misconfig
    // with a clearer message, so silently degrading here is safe — the real
    // error still surfaces. runTick (tick-time) calls defaultProject bare
    // because by then the config has been validated by at least one boot pass.
    const project = (() => {
      try { return defaultProject(config) } catch { return null }
    })()
    if (project) {
      for (const ident of linearWatchedIdentifiers(config)) {
        chans.add(linearIssueChannel(project, ident))
      }
    }
    return [...chans]
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
  // Linear channels (PRs cross-linked to Linear issues via attachments) are
  // additive — appended to the github routing for every event with a `pr`
  // number except the `pr_no_linked_issues` warning, which stays project-only.
  private static prEventChannels(
    config: OrchestratorConfig,
    project: string,
    event: OrchestratorEvent,
    projectChannel: string,
    prRepo: string,
    routable: LinkedIssue[],
    linearChannels: string[],
  ): string[] {
    if (event.pr == null) return []
    if (event.kind === 'pr_no_linked_issues') return [projectChannel]
    if (routable.length) {
      return [
        ...routable.map(li => issueChannel(project, li.number, channelSlug(config, li.repo))),
        ...linearChannels,
      ]
    }
    return [issueChannel(project, event.pr, channelSlug(config, prRepo)), ...linearChannels]
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

  // Best-effort cross-link lookup. A Linear API failure (auth, rate-limit,
  // network) returns an empty map rather than aborting the github tick —
  // github routing degrades to today's behavior, with a stderr log.
  private async resolveLinearCrossLinks(identifiers: string[]): Promise<Map<string, string[]>> {
    try {
      return await this.getLinearResolver().resolve(identifiers)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.log(`[github-prs] linear cross-link lookup failed (${identifiers.length} ids): ${msg}\n`)
      return new Map()
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
    // Nothing to poll: return before the breaker block. An idle plugin must not
    // reset the shared breaker — at half-open it would clear a sibling's
    // in-flight escalation every tick and pin the backoff at its first window.
    if (!watched.length) return { state: prevState ?? { prs: {} }, taggedEvents: [], channels: [] }
    const agentLogins = this.agentLogins(config)

    const prev = prevState as PrPluginState | null
    const now = Date.now()
    if (this.breakerOpen(now)) return this.breakerSkipResult(prevState ?? { prs: {} }, config)

    const scraper = new GhScraper(this.client, agentLogins)

    // Scrape in parallel — entries are independent. Preserve config order.
    // prevPr: undefined = seed; null = new entry; PrSnap = normal diff.
    // readEntry returns a discriminated result instead of throwing, so a
    // rate-limit on one entry doesn't abandon its siblings mid-flight.
    const scraped = await Promise.all(watched.map(async entry => {
      const { repo, number, channels: entryChannels } = resolveRepoEntry(entry, defaultRepo)
      const key = `${repo}#${number}`
      const prevPr: PrSnap | null | undefined = prev === null ? undefined : (prev.prs[key] ?? null)
      const r = await this.readEntry(
        key,
        [projectChannel],
        formatReadFailureNote(this.name, key, `unwatch pr ${number}${repo !== defaultRepo ? ` ${repo}` : ''}`),
        () => scraper.scrapePr(repo, number, prevPr),
        now,
      )
      return { key, prevPr, entryChannels, r }
    }))

    // Any rate-limit → back off the whole tick; discard partial work, preserve prev.
    if (scraped.some(s => !s.r.ok && s.r.rateLimited)) {
      return this.breakerTripResult(now, prevState ?? { prs: {} }, projectChannel, config)
    }
    this.breakerReset(now)

    // Cross-link lookup: one batched Linear query per tick, gated on a
    // non-empty linear-issues watch set. Empty-watched is the load-bearing
    // fast-path — no resolver constructed, no API call, no env-read.
    const linearIds = linearWatchedIdentifiers(config)
    const linkMap: Map<string, string[]> = linearIds.length
      ? await this.resolveLinearCrossLinks(linearIds)
      : new Map()

    const curState: PrPluginState = { prs: {} }
    const taggedEvents: TaggedEvent[] = []
    // Static (config) + dynamic (linked-issues from scrape). Each linked-issue
    // channel is slugged against its own repo (closures can cross repos).
    const channels = new Set<string>(this.desiredChannels(config))
    for (const { key, prevPr, entryChannels, r } of scraped) {
      if (!r.ok) {
        if (r.rateLimited) continue  // unreachable: any rate-limit returned above; narrows the type
        // Transient skip: carry the prev snapshot forward and re-add its dynamic
        // linked-issue/Linear channels so a flap doesn't PART them (the PR's own
        // #issue-N is already in desiredChannels). Emit the cooldown note.
        if (prevPr) {
          curState.prs[key] = prevPr
          const { routable } = GitHubPrsPlugin.partitionLinked(config, prevPr.repo, prevPr.linked_issues ?? [])
          for (const li of routable) channels.add(issueChannel(project, li.number, channelSlug(config, li.repo)))
          for (const ident of linkMap.get(prKey(prevPr.repo, prevPr.number)) ?? []) channels.add(linearIssueChannel(project, ident))
        }
        taggedEvents.push(...r.events)
        continue
      }
      const { snap, events } = r.value
      curState.prs[key] = snap
      const { routable, dropped } = GitHubPrsPlugin.partitionLinked(config, snap.repo, snap.linked_issues ?? [])
      for (const li of routable) channels.add(issueChannel(project, li.number, channelSlug(config, li.repo)))
      // Linear cross-link channels for this PR. A PR can be attached to
      // multiple Linear issues — all matched identifiers route. Key
      // normalization (via prKey) guards against casing drift between
      // gh CLI output and Linear's webhook-attachment URL.
      const linearMatches = linkMap.get(prKey(snap.repo, snap.number)) ?? []
      const linearChannels = linearMatches.map(ident => linearIssueChannel(project, ident))
      for (const ch of linearChannels) channels.add(ch)
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
          // Suppress only when there are neither github linked-issues nor
          // Linear cross-links — pr_no_linked_issues already fires that tick.
          // A Linear-only match is a real routing target and earns a heads-up.
          if (linked.length || linearChannels.length) {
            const routingChannels = this.resolveChannels(
              GitHubPrsPlugin.prEventChannels(config, project, event, projectChannel, snap.repo, routable, linearChannels),
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
          channels: this.resolveChannels(GitHubPrsPlugin.prEventChannels(config, project, event, projectChannel, snap.repo, routable, linearChannels), entryChannels),
          payload: formatPayload(event),
        })
      }
    }

    taggedEvents.push(...await this.observeRateLimit(projectChannel))
    return { state: curState, taggedEvents, channels: this.rememberChannels([...channels]) }
  }
}
