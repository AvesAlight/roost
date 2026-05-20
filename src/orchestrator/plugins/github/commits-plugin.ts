// Multi-repo commit feed. Polls (repo, branch, path?) entries and announces
// new commits. Built for the release-dance close-out (watching the homebrew
// tap formula bump after a tag push).
//
// DM grammar: claims target=`repo` — `watch repo <owner>/<repo>[@<branch>
// [:<path>]] [#chan ...]`. Spec shape mirrors the state key so a daemon.log
// line copy-pastes into a DM.
//
// State slice: `{ commits: { "<key>": { last_sha } } }`, key `<repo>@<branch>`
// (or `<repo>@<branch>:<path>` with a path filter). Seeding and new-entry
// first-observation both record head without announcing.
//
// No `assertRepoMode` — every entry statically requires `repo`, and the
// use case is cross-repo by design.

import type { Command } from '../../dispatcher-dm-handler.js'
import type { OrchestratorConfig } from '../../config.js'
import type { PluginTickResult, TaggedEvent } from '../../plugin.js'
import { resolveProjectChannel } from '../../naming.js'
import { addChannelsToEntry, applyUnwatchEntry, trackedRefusal } from '../_shared.js'
import type { GhCommit } from './github-api.js'
import { GhPluginBase } from './base.js'

export interface CommitWatchEntry {
  repo: string
  branch?: string
  path?: string
  channels?: string[]
}

interface CommitsPluginConfig {
  watched?: CommitWatchEntry[]
}

// `commits` carries forward across ticks — a removed entry keeps its watermark
// so remove-then-readd doesn't replay history.
export interface CommitsPluginState {
  commits: Record<string, { last_sha: string }>
}

const DEFAULT_BRANCH = 'main'

// Per-tick poll cap. A sustained burst over this between ticks logs a WARN.
const PER_PAGE = 20

function entryKey(entry: CommitWatchEntry): string {
  const branch = entry.branch ?? DEFAULT_BRANCH
  return entry.path ? `${entry.repo}@${branch}:${entry.path}` : `${entry.repo}@${branch}`
}

// Canonical display form, matching the state-key shape.
function formatRepoSpec(repo: string, branch: string | undefined | null, path: string | undefined | null): string {
  const b = branch ?? DEFAULT_BRANCH
  return path ? `repo ${repo}@${b}:${path}` : `repo ${repo}@${b}`
}

function matchesEntry(e: CommitWatchEntry, repo: string, branch: string | null, path: string | null): boolean {
  return e.repo === repo
    && (e.branch ?? DEFAULT_BRANCH) === (branch ?? DEFAULT_BRANCH)
    && (e.path ?? null) === path
}

// Caller guards `commit.sha` before formatting; sha is passed narrowed.
function formatCommit(entry: CommitWatchEntry, commit: GhCommit, sha: string): string {
  const branch = entry.branch ?? DEFAULT_BRANCH
  const subject = (commit.commit?.message ?? '(no message)').split('\n')[0]?.trim() ?? ''
  const pathSuffix = entry.path ? ` [${entry.path}]` : ''
  const url = commit.html_url ?? ''
  return `commit ${entry.repo}@${branch}${pathSuffix} ${sha.slice(0, 7)}: ${subject} — ${url}`
}

export class GitHubCommitsPlugin extends GhPluginBase {
  readonly name = 'github-commits'

  handleCommand(merged: OrchestratorConfig, local: OrchestratorConfig, cmd: Command): string | null {
    if (cmd.kind === 'list') return this.formatListSection(merged)
    if (cmd.kind === 'help') return this.formatHelpSection()
    if (cmd.kind === 'watch-repo') {
      if (cmd.target !== 'repo') return null
      return this.applyWatchRepo(merged, local, cmd.repo, cmd.branch, cmd.path, cmd.channels)
    }
    if (cmd.kind === 'unwatch-repo') {
      if (cmd.target !== 'repo') return null
      return this.applyUnwatchRepo(merged, local, cmd.repo, cmd.branch, cmd.path)
    }
    return null
  }

  private mergedWatched(config: OrchestratorConfig): CommitWatchEntry[] {
    return this.pluginConfig<CommitsPluginConfig>(config)?.watched ?? []
  }

  private applyWatchRepo(merged: OrchestratorConfig, local: OrchestratorConfig, repo: string, branch: string | null, path: string | null, channels: string[]): string {
    const labelStr = formatRepoSpec(repo, branch, path)
    const match = (e: CommitWatchEntry) => matchesEntry(e, repo, branch, path)
    if (!this.mergedWatched(merged).some(match)) {
      const slice = this.localSlice<CommitsPluginConfig>(local)
      slice.watched ??= []
      const entry: CommitWatchEntry = { repo }
      // Only pin branch on the entry when explicit — leaves the default
      // (`main`) implicit so a future DEFAULT_BRANCH bump propagates.
      if (branch !== null) entry.branch = branch
      if (path !== null) entry.path = path
      if (channels.length) entry.channels = [...channels]
      slice.watched.push(entry)
      return channels.length ? `watching ${labelStr} + ${channels.join(' ')}` : `watching ${labelStr}`
    }
    const localEntry = (this.pluginConfig<CommitsPluginConfig>(local)?.watched ?? []).find(match)
    if (!localEntry) return channels.length ? trackedRefusal(labelStr, 'add channels') : `already watching ${labelStr}`
    return addChannelsToEntry(localEntry, channels, labelStr)
  }

  private applyUnwatchRepo(merged: OrchestratorConfig, local: OrchestratorConfig, repo: string, branch: string | null, path: string | null): string {
    return applyUnwatchEntry<CommitWatchEntry>(
      this.mergedWatched(merged),
      this.pluginConfig<CommitsPluginConfig>(local)?.watched ?? [],
      e => matchesEntry(e, repo, branch, path),
      formatRepoSpec(repo, branch, path),
    )
  }

  private formatListSection(merged: OrchestratorConfig): string {
    // Dedup by (repo, effective branch, path) — matches scrape behavior.
    const entries = this.mergedWatched(merged)
    const byKey = new Map<string, { repo: string; branch: string; path: string | null; channels: Set<string> }>()
    const order: string[] = []
    for (const e of entries) {
      const key = entryKey(e)
      let bucket = byKey.get(key)
      if (!bucket) {
        bucket = { repo: e.repo, branch: e.branch ?? DEFAULT_BRANCH, path: e.path ?? null, channels: new Set<string>() }
        byKey.set(key, bucket)
        order.push(key)
      }
      for (const c of e.channels ?? []) bucket.channels.add(c)
    }
    const header = `${this.name} (${byKey.size}):`
    if (!byKey.size) return `${header}\n  (none)`
    const lines = order.map(k => {
      const b = byKey.get(k)!
      const id = b.path ? `${b.repo}@${b.branch}:${b.path}` : `${b.repo}@${b.branch}`
      const chans = b.channels.size ? ` + ${[...b.channels].join(' ')}` : ''
      return `  ${id}${chans}`
    })
    return [header, ...lines].join('\n')
  }

  private formatHelpSection(): string {
    return [
      `${this.name} commands (DM only):`,
      `  watch repo <owner>/<repo>[@<branch>[:<path>]] [#chan ...]  — watch commit feed`,
      `  unwatch repo <owner>/<repo>[@<branch>[:<path>]]            — stop watching commit feed`,
      `  watch list                                                — include this plugin's watched repos in the reply`,
    ].join('\n')
  }

  desiredChannels(config: OrchestratorConfig): string[] {
    const slice = this.pluginConfig<CommitsPluginConfig>(config) ?? {}
    const chans = new Set<string>()
    for (const e of slice.watched ?? []) {
      for (const c of e.channels ?? []) chans.add(c)
    }
    return [...chans]
  }

  async runTick(config: OrchestratorConfig, prevState: unknown): Promise<PluginTickResult> {
    const slice = this.pluginConfig<CommitsPluginConfig>(config) ?? {}
    const watched = slice.watched ?? []
    const prev = prevState as CommitsPluginState | null
    const projectChannel = resolveProjectChannel(config)

    // Carry forward prior watermarks; mutate only keys touched this tick.
    const state: CommitsPluginState = { commits: { ...(prev?.commits ?? {}) } }
    const taggedEvents: TaggedEvent[] = []

    if (watched.length === 0) {
      return { state, taggedEvents, channels: [] }
    }

    // Sequential — typical configs have <5 entries; serializing keeps WARN
    // log lines next to the entry they're about.
    for (const entry of watched) {
      const key = entryKey(entry)
      const branch = entry.branch ?? DEFAULT_BRANCH
      const channels = entry.channels?.length ? [...entry.channels] : [projectChannel]

      let commits: GhCommit[]
      try {
        commits = await this.client.fetchRepoCommits(entry.repo, branch, entry.path, PER_PAGE)
      } catch (e) {
        this.log(`github-commits: fetch failed for ${key}: ${e}\n`)
        continue
      }

      if (commits.length === 0) continue
      const newest = commits[0]
      if (!newest.sha) continue

      const prevSha = prev?.commits?.[key]?.last_sha

      // Full-config seed OR new entry — record head without announcing; first
      // diff comes on next tick.
      if (prev === null || prevSha == null) {
        state.commits[key] = { last_sha: newest.sha }
        continue
      }

      // gh returns newest first. Everything before the watermark is new.
      const idx = commits.findIndex(c => c.sha === prevSha)
      let newCommits: GhCommit[]
      if (idx < 0) {
        // Watermark missing. Full page → likely missed history (force-push or
        // burst beyond PER_PAGE) → WARN. Partial page → genuine history rewrite.
        if (commits.length >= PER_PAGE) {
          this.log(
            `github-commits: ${key} watermark ${prevSha.slice(0, 7)} not in page of ` +
            `${commits.length} commits (cap=${PER_PAGE}); some commits may have been missed\n`
          )
        }
        newCommits = commits
      } else {
        newCommits = commits.slice(0, idx)
      }

      if (newCommits.length === 0) continue

      // Reverse to chronological order so multi-commit batches read top-down.
      for (const commit of [...newCommits].reverse()) {
        if (!commit.sha) continue
        taggedEvents.push({
          channels: [...channels],
          payload: { kind: 'oneline', text: formatCommit(entry, commit, commit.sha) },
        })
      }
      state.commits[key] = { last_sha: newest.sha }
    }

    taggedEvents.push(...await this.observeRateLimit(projectChannel))
    return { state, taggedEvents, channels: this.desiredChannels(config) }
  }
}
