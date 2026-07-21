// Project-namespaced names. Single source of truth for the prefix shape;
// operator-facing description lives in DISPATCHER.md.

import type { OrchestratorConfig } from './config.js'

export function resolveProjectChannel(config: OrchestratorConfig): string {
  return config.irc?.project_channel ?? leadsChannel(defaultProject(config))
}

const PROJECT_PATTERN = /^[a-z0-9][a-z0-9-]*$/

export function validateProject(project: string): void {
  if (!PROJECT_PATTERN.test(project)) {
    throw new Error(
      `invalid project name "${project}": must match ${PROJECT_PATTERN} (lowercase, digits, dashes; must start with a letter or digit)`
    )
  }
}

// Falls back to the basename of `repo` if `project` is unset. Multi-mode
// (no `config.repo`) requires `config.project` set — no inherit target.
export function defaultProject(config: OrchestratorConfig): string {
  if (config.project) {
    validateProject(config.project)
    return config.project
  }
  if (config.repo) {
    const base = config.repo.split('/').pop()?.toLowerCase() ?? ''
    if (PROJECT_PATTERN.test(base)) return base
  }
  throw new Error('no project: multi-repo mode (no `config.repo`) requires `config.project` set in config.json')
}

export function isMultiRepo(config: OrchestratorConfig): boolean {
  return !config.repo
}

// Lowercased basename of `Owner/Repo` — interpolated into nicks/channels, so
// must match the project pattern. Cross-org overlap (`Org1/foo` + `Org2/foo`)
// is a known footgun.
export function repoSlug(repo: string): string {
  const base = repo.split('/').pop()?.toLowerCase() ?? ''
  if (!PROJECT_PATTERN.test(base)) {
    throw new Error(
      `cannot derive slug from repo "${repo}": basename "${base}" must match ${PROJECT_PATTERN}`
    )
  }
  return base
}

// Slug segment for an entry's repo in the active mode — undefined in single-repo
// mode (callers omit the segment), repoSlug in multi-repo mode.
export function channelSlug(config: OrchestratorConfig, repo: string | undefined): string | undefined {
  if (!isMultiRepo(config)) return undefined
  if (!repo) {
    throw new Error('channelSlug: multi-repo mode requires repo on every entry/event')
  }
  return repoSlug(repo)
}

export function issueChannel(project: string, n: number, slug?: string): string {
  return slug ? `#${project}-${slug}-issue-${n}` : `#${project}-issue-${n}`
}

// Linear identifier (`<TEAM>-<N>`, uppercase team key) → per-issue channel.
// Team segment is always emitted (Linear identifiers always lead `[A-Z]+-`),
// which makes Linear channels uniquely shaped vs. bare github-issues channels.
export function linearIssueChannel(project: string, identifier: string): string {
  return `#${project}-issue-${identifier.toLowerCase()}`
}

export function leadsChannel(project: string): string {
  return `#${project}-leads`
}

export function workerNick(project: string, n: number, slug?: string): string {
  return slug ? `${project}-${slug}-worker-${n}` : `${project}-worker-${n}`
}

export function reviewerNick(project: string, n: number, slug?: string): string {
  return slug ? `${project}-${slug}-reviewer-${n}` : `${project}-reviewer-${n}`
}

export function pmNick(project: string): string {
  return `${project}-pm`
}

export function apmNick(project: string): string {
  return `${project}-apm`
}

export function dispatcherNick(project: string): string {
  return `${project}-dispatcher`
}
