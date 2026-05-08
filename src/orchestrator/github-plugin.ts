// GitHub plugin — wraps PR + issue scrapers behind the Plugin seam (#116).
// Owns its own state slice (`state.plugins.github = { prs, issues }`) and
// routes each emitted event to: union(auto-detected, watch-entry channels).
import type { OrchestratorConfig, PrSnap, IssueSnap, WatchedEntry } from './config.js'
import { resolveRepoEntry } from './config.js'
import { scrapePr, scrapeIssue } from './scraper.js'
import { eventChannels } from './format.js'
import { BasePlugin, type PluginTickResult, type PluginTickOpts, type TaggedEvent } from './plugin.js'

export interface GitHubPluginState {
  prs: Record<string, PrSnap>
  issues: Record<string, IssueSnap>
}

export class GitHubPlugin extends BasePlugin {
  readonly name = 'github'

  desiredChannels(config: OrchestratorConfig): string[] {
    const chans = new Set<string>()
    const defaultRepo = config.repo
    const collect = (entry: WatchedEntry) => {
      const { number, channels } = resolveRepoEntry(entry, defaultRepo)
      chans.add(`#issue-${number}`)
      for (const c of channels) chans.add(c)
    }
    for (const entry of config.watched_prs ?? []) collect(entry)
    for (const entry of config.watched_issues ?? []) collect(entry)
    return [...chans]
  }

  async runTick(
    config: OrchestratorConfig,
    prevState: unknown,
    opts: PluginTickOpts
  ): Promise<PluginTickResult> {
    const defaultRepo = config.repo
    const watchedPrs = config.watched_prs ?? []
    const watchedIssues = config.watched_issues ?? []
    const agentLogins = new Set(config.agent_logins ?? [])

    const prev = opts.seed ? null : (prevState as GitHubPluginState | null)
    const seeding = prev === null

    const curState: GitHubPluginState = { prs: {}, issues: {} }
    const taggedEvents: TaggedEvent[] = []

    for (const entry of watchedPrs) {
      const { repo, number, channels: entryChannels } = resolveRepoEntry(entry, defaultRepo)
      const key = `${repo}#${number}`
      const prevPr: PrSnap | null | undefined = seeding ? undefined : (prev?.prs[key] ?? null)
      const { snap, events } = await scrapePr(repo, number, prevPr, agentLogins)
      curState.prs[key] = snap
      for (const event of events) {
        taggedEvents.push({ event, channels: this.resolveChannels(eventChannels(event), entryChannels) })
      }
    }

    for (const entry of watchedIssues) {
      const { repo, number, channels: entryChannels } = resolveRepoEntry(entry, defaultRepo)
      const key = `${repo}#${number}`
      const prevIssue: IssueSnap | null | undefined = seeding ? undefined : (prev?.issues[key] ?? null)
      const { snap, events } = await scrapeIssue(repo, number, prevIssue, agentLogins)
      curState.issues[key] = snap
      for (const event of events) {
        taggedEvents.push({ event, channels: this.resolveChannels(eventChannels(event), entryChannels) })
      }
    }

    // Comprehensive channel set: static (config) + dynamic (PR linked-issues
    // discovered during scrape). Orchestrator uses this to sync IRC membership.
    const channels = new Set<string>(this.desiredChannels(config))
    for (const snap of Object.values(curState.prs)) {
      for (const n of snap.linked_issues ?? []) channels.add(`#issue-${n}`)
    }

    return { state: curState, taggedEvents: seeding ? [] : taggedEvents, channels: [...channels] }
  }
}
