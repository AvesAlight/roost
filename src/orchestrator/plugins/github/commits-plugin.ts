// Multi-repo commit feed. Polls a configured list of (repo, branch, path?)
// entries and announces new commits to per-entry channels (defaulting to the
// project channel). Built for the release-dance close-out — after a tag push
// the GH release workflow auto-commits a formula bump to the homebrew tap,
// and watching that commit closes the manual-poll gap for the APM.
//
// Static config only. No DM grammar — the parser is verb+number-shaped and
// commits have no number; for the set-and-forget tap case operator config-edit
// is fine.
//
// State slice: `{ commits: { "<key>": { last_sha } } }` where key is
// `<repo>@<branch>` (or `<repo>@<branch>:<path>` when a path filter is set).
// Seeding (prev === null) and new-entry first-observation (prev !== null but
// no prior key) both record the head sha without announcing — same pattern
// as github-new-issues.

import type { OrchestratorConfig } from '../../config.js'
import type { PluginTickResult, TaggedEvent } from '../../plugin.js'
import { resolveProjectChannel } from '../../naming.js'
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
