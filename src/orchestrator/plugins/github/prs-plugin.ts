import type { OrchestratorConfig } from '../../config.js'
import { resolveRepoEntry } from '../../config.js'
import type { PluginTickResult, TaggedEvent } from '../../plugin.js'
import { GhBase } from './base.js'
import { scrapePr } from './scraper.js'
import { formatPayload } from './format.js'
import { shouldPush, type OrchestratorEvent } from './diff.js'
import type { PrSnap, PrPluginState } from './types.js'

export class GitHubPrsPlugin extends GhBase {
  readonly name = 'github-prs'

  desiredChannels(config: OrchestratorConfig): string[] {
    return this.entryChannels(config.watched_prs, config.repo)
  }

  // Auto-detected channels for a PR event: linked-issue channels, or its own
  // #issue-N if no linked issues.
  private static prEventChannels(event: OrchestratorEvent): string[] {
    const ev = event as { pr?: number; linked_issues?: number[] }
    if (ev.pr == null) return []
    const linked = ev.linked_issues ?? []
    return linked.length ? linked.map(n => `#issue-${n}`) : [`#issue-${ev.pr}`]
  }

  async runTick(
    config: OrchestratorConfig,
    prevState: unknown
  ): Promise<PluginTickResult> {
    const defaultRepo = config.repo
    const watched = config.watched_prs ?? []
    const agentLogins = this.agentLogins(config)

    const prev = prevState as PrPluginState | null
    const seeding = prev === null

    // Scrape all PRs in parallel — each entry is independent. Preserve config
    // order for taggedEvents so output is stable.
    const scraped = await Promise.all(watched.map(async entry => {
      const { repo, number, channels: entryChannels } = resolveRepoEntry(entry, defaultRepo)
      const key = `${repo}#${number}`
      const prevPr: PrSnap | null | undefined = seeding ? undefined : (prev?.prs[key] ?? null)
      const { snap, events } = await scrapePr(repo, number, prevPr, agentLogins)
      return { key, snap, events, entryChannels }
    }))

    const curState: PrPluginState = { prs: {} }
    const taggedEvents: TaggedEvent[] = []
    for (const { key, snap, events, entryChannels } of scraped) {
      curState.prs[key] = snap
      for (const event of events) {
        if (!shouldPush(event)) continue
        taggedEvents.push({
          channels: this.resolveChannels(GitHubPrsPlugin.prEventChannels(event), entryChannels),
          payload: formatPayload(event),
        })
      }
    }

    // Comprehensive channel set: static (config) + dynamic (linked-issues
    // discovered during scrape).
    const channels = new Set<string>(this.desiredChannels(config))
    for (const snap of Object.values(curState.prs)) {
      for (const n of snap.linked_issues ?? []) channels.add(`#issue-${n}`)
    }

    return { state: curState, taggedEvents, channels: [...channels] }
  }
}
