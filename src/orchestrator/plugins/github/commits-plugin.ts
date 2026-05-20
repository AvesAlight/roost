// Multi-repo commit feed. Polls a configured list of (repo, branch, path?)
// entries and announces new commits to per-entry channels (defaulting to the
// project channel). Built for the release-dance close-out — after a tag push
// the GH release workflow auto-commits a formula bump to the homebrew tap,
// and watching that commit closes the manual-poll gap for the APM.
//
// DM grammar: claims target=`repo`. Operators can `watch repo
// <owner>/<repo>[@<branch>[:<path>]] [#chan ...]` / `unwatch repo …`. The
// repo-spec shape mirrors the state key (`<repo>@<branch>[:<path>]`) so a
// canonical line in daemon.log copy-pastes into a DM.
//
// State slice: `{ commits: { "<key>": { last_sha } } }` where key is
// `<repo>@<branch>` (or `<repo>@<branch>:<path>` when a path filter is set).
// Seeding (prev === null) and new-entry first-observation (prev !== null but
// no prior key) both record the head sha without announcing — same pattern
// as github-new-issues.
//
// No `assertRepoMode` — every entry already requires `repo` statically
// (`CommitWatchEntry.repo: string`), and the use case is cross-repo by design
// (the tap-bump dance polls a different repo than the dispatcher's own). The
// per-watch plugins' single-vs-multi invariant does not apply here.

import type { Command } from '../../dispatcher-dm-handler.js'
import type { OrchestratorConfig } from '../../config.js'
import type { PluginTickResult, TaggedEvent } from '../../plugin.js'
import { resolveProjectChannel } from '../../naming.js'
import { trackedRefusal } from '../_shared.js'
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

// `commits` is carried forward across ticks intentionally — an entry removed
// from config keeps its watermark in state, so removing-then-readding doesn't
// re-announce historical commits. No prune.
export interface CommitsPluginState {
  commits: Record<string, { last_sha: string }>
}

// `main` covers ~all modern repos; operator can override per entry.
const DEFAULT_BRANCH = 'main'

// Bounds the per-tick poll. 20 is generous for the tap-bump use case (one
// commit per release); a sustained burst over this between ticks logs a
// WARN so the operator notices missed history.
const PER_PAGE = 20

function entryKey(entry: CommitWatchEntry): string {
  const branch = entry.branch ?? DEFAULT_BRANCH
  return entry.path ? `${entry.repo}@${branch}:${entry.path}` : `${entry.repo}@${branch}`
}

// Canonical display form for a `(repo, branch?, path?)` triple, matching
// the state-key shape. Always includes `@<branch>` (so the operator sees
// the default they got) and `:<path>` when set.
function formatRepoSpec(repo: string, branch: string | undefined | null, path: string | undefined | null): string {
  const b = branch ?? DEFAULT_BRANCH
  return path ? `repo ${repo}@${b}:${path}` : `repo ${repo}@${b}`
}

// Match key for DM watch/unwatch lookup. Two entries collide iff their
// `(repo, effective branch, path)` are identical — same shape as
// `entryKey` but on parsed cmd fields rather than a stored entry.
function matchesEntry(e: CommitWatchEntry, repo: string, branch: string | null, path: string | null): boolean {
  return e.repo === repo
    && (e.branch ?? DEFAULT_BRANCH) === (branch ?? DEFAULT_BRANCH)
    && (e.path ?? null) === path
}

function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

function firstLine(message: string): string {
  return (message.split('\n')[0] ?? '').trim()
}

// Caller (emission loop) guards `commit.sha` before formatting, so sha is
// passed in narrowed — no fallback to mask a missing value.
function formatCommit(entry: CommitWatchEntry, commit: GhCommit, sha: string): string {
  const branch = entry.branch ?? DEFAULT_BRANCH
  const subject = firstLine(commit.commit?.message ?? '(no message)')
  const pathSuffix = entry.path ? ` [${entry.path}]` : ''
  const url = commit.html_url ?? ''
  return `commit ${entry.repo}@${branch}${pathSuffix} ${shortSha(sha)}: ${subject} — ${url}`
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

  private localSlice(local: OrchestratorConfig): CommitsPluginConfig {
    local.plugins ??= {}
    const existing = local.plugins[this.name]
    if (existing && typeof existing === 'object') return existing as CommitsPluginConfig
    const fresh: CommitsPluginConfig = {}
    local.plugins[this.name] = fresh
    return fresh
  }

  private mergedWatched(config: OrchestratorConfig): CommitWatchEntry[] {
    return this.pluginConfig<CommitsPluginConfig>(config)?.watched ?? []
  }

  private applyWatchRepo(merged: OrchestratorConfig, local: OrchestratorConfig, repo: string, branch: string | null, path: string | null, channels: string[]): string {
    const labelStr = formatRepoSpec(repo, branch, path)
    const inMerged = this.mergedWatched(merged).find(e => matchesEntry(e, repo, branch, path))
    if (!inMerged) {
      const slice = this.localSlice(local)
      slice.watched ??= []
      const entry: CommitWatchEntry = { repo }
      // Only pin branch on the entry when explicit — leaves the default
      // (`main`) implicit so a future DEFAULT_BRANCH bump propagates.
      if (branch !== null) entry.branch = branch
      if (path !== null) entry.path = path
      if (channels.length) entry.channels = [...channels]
      slice.watched.push(entry)
      return channels.length
        ? `watching ${labelStr} + ${channels.join(' ')}`
        : `watching ${labelStr}`
    }
    if (!channels.length) return `already watching ${labelStr}`
    const localEntries = this.pluginConfig<CommitsPluginConfig>(local)?.watched ?? []
    const localEntry = localEntries.find(e => matchesEntry(e, repo, branch, path))
    if (!localEntry) {
      return trackedRefusal(labelStr, 'add channels')
    }
    const existing = new Set(localEntry.channels ?? [])
    const added: string[] = []
    for (const c of channels) if (!existing.has(c)) { existing.add(c); added.push(c) }
    if (!added.length) return `${labelStr} channels unchanged`
    localEntry.channels = [...existing]
    return `${labelStr} + ${added.join(' ')}`
  }

  private applyUnwatchRepo(merged: OrchestratorConfig, local: OrchestratorConfig, repo: string, branch: string | null, path: string | null): string {
    const labelStr = formatRepoSpec(repo, branch, path)
    const localEntries = this.pluginConfig<CommitsPluginConfig>(local)?.watched ?? []
    const localIdx = localEntries.findIndex(e => matchesEntry(e, repo, branch, path))
    if (localIdx >= 0) {
      localEntries.splice(localIdx, 1)
      return `unwatched ${labelStr}`
    }
    if (this.mergedWatched(merged).some(e => matchesEntry(e, repo, branch, path))) {
      return trackedRefusal(labelStr, 'remove')
    }
    return `not watching ${labelStr}`
  }

  private formatListSection(merged: OrchestratorConfig): string {
    // Dedup by (repo, effective branch, path) across the concat-merged
    // base+local lists — matches scrape behavior.
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

    // Carry forward prior state so a removed-then-readded entry keeps its
    // watermark; we only mutate keys we touch this tick.
    const state: CommitsPluginState = { commits: { ...(prev?.commits ?? {}) } }
    const taggedEvents: TaggedEvent[] = []

    // Empty watched: no gh calls, no events. Keeps the default-off init config
    // harmless.
    if (watched.length === 0) {
      return { state, taggedEvents, channels: [] }
    }

    // Sequential per entry — typical configs have < 5 entries, and serializing
    // keeps the WARN log lines next to the entry they're about.
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

      // Seed: full-config seed OR an entry the operator just added. Either
      // way, record the head without announcing — first announcement comes on
      // the next real diff.
      if (prev === null || prevSha == null) {
        state.commits[key] = { last_sha: newest.sha }
        continue
      }

      // gh returns newest first. Find the watermark; everything before it is new.
      const idx = commits.findIndex(c => c.sha === prevSha)
      let newCommits: GhCommit[]
      if (idx < 0) {
        // Watermark missing. If the page is full we've likely missed history
        // (commits beyond PER_PAGE since last tick, or a force-push); WARN and
        // emit what we have. If the page isn't full, the watermark is genuinely
        // gone (history rewrite) — same behavior, no warning needed.
        if (commits.length >= PER_PAGE) {
          this.log(
            `github-commits: ${key} watermark ${shortSha(prevSha)} not in page of ` +
            `${commits.length} commits (cap=${PER_PAGE}); some commits may have been missed\n`
          )
        }
        newCommits = commits
      } else {
        newCommits = commits.slice(0, idx)
      }

      if (newCommits.length === 0) continue

      // Reverse to chronological order so a multi-commit batch reads top-down.
      for (const commit of [...newCommits].reverse()) {
        if (!commit.sha) continue
        taggedEvents.push({
          // Per-event copy so a downstream mutation can't leak across sibling events.
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
