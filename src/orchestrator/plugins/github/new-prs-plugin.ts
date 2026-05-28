// Project-level new-PR triage feed. Polls watched repos for open PRs
// and announces the first time a given (repo, number) is observed.
// PRs authored by agent_logins are suppressed — those are already tracked
// by the per-watch github-prs plugin; this plugin surfaces external contributions.
//
// DM grammar: claims target=`new-prs` — `watch new-prs <owner>/<repo>
// [#chan ...]`. `@branch`/`:path` are rejected (entries are repo-only).
//
// State slice: `{ repos: Record<string, number[]> }`. Seeding (`prev===null`)
// and first-observation of a new repo entry both capture without emitting.
// All open PR numbers (including agent-authored) are seeded into state to
// prevent replay if agent_logins later changes. Removed entries are carried
// forward so remove-then-readd doesn't replay.
import type { Command } from '../../dispatcher-dm-handler.js'
import type { OrchestratorConfig } from '../../config.js'
import { assertEntryRepoMode } from '../../config.js'
import type { ParseResult, PluginTickResult, TaggedEvent } from '../../plugin.js'
import { resolveProjectChannel } from '../../naming.js'
import { addChannelsToEntry, applyUnwatchEntry, trackedRefusal } from '../_shared.js'
import { tryClaimPerRepo, type PerRepoCommand } from '../grammar.js'
import { labelNames, type GhRepoPr } from './github-api.js'
import { GhPluginBase } from './base.js'
import { formatReadFailureNote } from './backoff.js'

export interface NewPrsWatchEntry {
  repo: string
  channels?: string[]
}

interface NewPrsPluginConfig {
  watched?: NewPrsWatchEntry[]
}

export interface NewPrsPluginState {
  repos: Record<string, number[]>
}

export class GitHubNewPrsPlugin extends GhPluginBase {
  readonly name = 'github-new-prs'

  parseCommand(line: string): ParseResult | null {
    return tryClaimPerRepo('new-prs', line)
  }

  handleCommand(merged: OrchestratorConfig, local: OrchestratorConfig, cmd: Command): string | null {
    if (cmd.kind === 'list') return this.formatListSection(merged)
    if (cmd.kind === 'help') return this.formatHelpSection()
    if (cmd.kind === 'plugin' && cmd.plugin === this.name) {
      const c = cmd.cmd as PerRepoCommand
      if (c.branch !== null || c.path !== null) {
        const verb = c.verb
        return `error: new-prs does not support @branch or :path — try \`${verb} new-prs ${c.repo}\``
      }
      if (c.verb === 'watch') return this.applyWatch(merged, local, c.repo, c.channels)
      return this.applyUnwatch(merged, local, c.repo)
    }
    return null
  }

  private mergedWatched(config: OrchestratorConfig): NewPrsWatchEntry[] {
    return this.pluginConfig<NewPrsPluginConfig>(config)?.watched ?? []
  }

  private applyWatch(merged: OrchestratorConfig, local: OrchestratorConfig, repo: string, channels: string[]): string {
    const labelStr = `new-prs ${repo}`
    const match = (e: NewPrsWatchEntry) => e.repo === repo
    if (!this.mergedWatched(merged).some(match)) {
      const slice = this.localSlice<NewPrsPluginConfig>(local)
      slice.watched ??= []
      const entry: NewPrsWatchEntry = { repo }
      if (channels.length) entry.channels = [...channels]
      slice.watched.push(entry)
      return channels.length ? `watching ${labelStr} + ${channels.join(' ')}` : `watching ${labelStr}`
    }
    const localEntry = (this.pluginConfig<NewPrsPluginConfig>(local)?.watched ?? []).find(match)
    if (!localEntry) return channels.length ? trackedRefusal(labelStr, 'add channels') : `already watching ${labelStr}`
    return addChannelsToEntry(localEntry, channels, labelStr)
  }

  private applyUnwatch(merged: OrchestratorConfig, local: OrchestratorConfig, repo: string): string {
    return applyUnwatchEntry<NewPrsWatchEntry>(
      this.mergedWatched(merged),
      this.pluginConfig<NewPrsPluginConfig>(local)?.watched ?? [],
      e => e.repo === repo,
      `new-prs ${repo}`,
    )
  }

  private formatListSection(merged: OrchestratorConfig): string {
    const entries = this.mergedWatched(merged)
    const byRepo = new Map<string, Set<string>>()
    const order: string[] = []
    for (const e of entries) {
      let chans = byRepo.get(e.repo)
      if (!chans) {
        chans = new Set<string>()
        byRepo.set(e.repo, chans)
        order.push(e.repo)
      }
      for (const c of e.channels ?? []) chans.add(c)
    }
    const header = `${this.name} (${byRepo.size}):`
    if (!byRepo.size) return `${header}\n  (none)`
    const lines = order.map(r => {
      const chans = byRepo.get(r)!
      const chansStr = chans.size ? ` + ${[...chans].join(' ')}` : ''
      return `  ${r}${chansStr}`
    })
    return [header, ...lines].join('\n')
  }

  private formatHelpSection(): string {
    return [
      `${this.name} commands (DM only):`,
      `  watch new-prs <owner>/<repo> [#chan ...]   — watch new-prs feed`,
      `  unwatch new-prs <owner>/<repo>             — stop watching new-prs feed`,
      `  watch list                                 — include this plugin's watched repos in the reply`,
    ].join('\n')
  }

  // Project channel is unioned in by the orchestrator; per-entry channels join at boot.
  desiredChannels(config: OrchestratorConfig): string[] {
    const slice = this.pluginConfig<NewPrsPluginConfig>(config) ?? {}
    const chans = new Set<string>()
    for (const entry of slice.watched ?? []) {
      for (const c of entry.channels ?? []) chans.add(c)
    }
    return [...chans]
  }

  // Tracked-only; see `Plugin.assertRepoMode` for rationale. The repo field
  // is statically required, so the multi-mode missing-repo branch never fires.
  assertRepoMode(base: OrchestratorConfig): void {
    const slice = this.pluginConfig<NewPrsPluginConfig>(base) ?? {}
    const topRepo = base.repo
    for (const entry of slice.watched ?? []) {
      assertEntryRepoMode(this.name, `(repo=${entry.repo})`, entry.repo, topRepo)
    }
  }

  async runTick(config: OrchestratorConfig, prevState: unknown): Promise<PluginTickResult> {
    const slice = this.pluginConfig<NewPrsPluginConfig>(config) ?? {}
    const watchEntries = slice.watched ?? []
    if (!watchEntries.length) return { state: prevState ?? { repos: {} }, taggedEvents: [], channels: [] }

    const projectChannel = resolveProjectChannel(config)
    const now = Date.now()
    if (this.breakerOpen(now)) return this.breakerSkipResult(prevState ?? { repos: {} }, config)

    // Re-seed cleanly from older shapes (no `repos` key).
    const prev = (prevState != null && typeof prevState === 'object' && 'repos' in prevState)
      ? prevState as NewPrsPluginState
      : null

    const agentLogins = this.agentLogins(config)
    const taggedEvents: TaggedEvent[] = []
    const nextRepos: Record<string, number[]> = prev ? { ...prev.repos } : {}

    for (const entry of watchEntries) {
      const { repo, channels } = entry
      const announcementChannels = channels?.length
        ? [...channels]
        : [projectChannel]

      const r = await this.readEntry(
        repo,
        announcementChannels,
        formatReadFailureNote(this.name, repo, `unwatch new-prs ${repo}`),
        () => this.client.fetchRepoOpenPrs(repo),
        now,
      )
      // Rate-limit discards this tick's partial work and preserves prev state —
      // the next clean tick re-reads and announces what's genuinely new.
      if (!r.ok && r.rateLimited) return this.breakerTripResult(now, prevState ?? { repos: {} }, projectChannel, config)
      if (!r.ok) {
        taggedEvents.push(...r.events)
        continue
      }
      const prs = r.value

      // All open PR numbers go into state — prevents replay if agent_logins changes.
      const currentNumbers = prs
        .map(p => p.number)
        .filter((n): n is number => n != null)
        .sort((a, b) => a - b)

      // First observation of this repo (or full re-seed): capture without emitting.
      const isFirstForRepo = prev === null || prev.repos[repo] === undefined
      const seen = new Set<number>(prev?.repos[repo] ?? [])

      if (!isFirstForRepo) {
        const newPrs = prs
          .filter(p => {
            if (p.number == null || seen.has(p.number)) return false
            const login = p.user?.login
            // Conservative: no login = external (announce). Known agent login = suppress.
            return !login || !agentLogins.has(login)
          })
          .sort((a, b) => (a.number ?? 0) - (b.number ?? 0))
        for (const pr of newPrs) {
          taggedEvents.push({
            // Per-event copy so a downstream mutation can't leak across siblings.
            channels: [...announcementChannels],
            payload: { kind: 'oneline', text: formatNewPr(repo, pr) },
          })
        }
      }

      for (const n of currentNumbers) seen.add(n)
      nextRepos[repo] = [...seen].sort((a, b) => a - b)
    }

    this.breakerReset(now)
    const state: NewPrsPluginState = { repos: nextRepos }
    taggedEvents.push(...await this.observeRateLimit(projectChannel))
    return { state, taggedEvents, channels: this.rememberChannels([]) }
  }
}

function formatNewPr(repo: string, pr: GhRepoPr): string {
  const tag = `${repo}#${pr.number}`
  const title = pr.title ?? ''
  const labels = labelNames(pr.labels)
  const labelStr = labels.length ? ` [${labels.join(', ')}]` : ''
  const url = pr.html_url ?? ''
  return `new PR ${tag}: ${title}${labelStr} — ${url}`
}
