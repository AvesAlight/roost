// Project-namespaced names for the roost conventions. Multi-project hygiene
// requires every per-project artifact (IRC nick, IRC channel, tmux session)
// to carry a project prefix so two projects sharing one ergo + one tmux do
// not collide. Single source of truth for the prefix shape.
//
// Format: project-first (`#<project>-leads`, `#<project>-issue-N`,
// `<project>-worker-N`). Project-first groups every channel for one project
// together in irssi/weechat `/list`, which is the dogfooding ergonomic.
//
// Multi-repo mode: when a dispatcher watches PRs/issues across multiple repos
// it sets no top-level `config.repo`. In that mode every per-issue artifact
// carries an additional `<slug>` segment derived from the entry's repo, so
// `#<project>-<slug>-issue-N` and `<project>-worker-<slug>-N`. Single-mode
// (with `config.repo` set) keeps the bare `<project>-issue-N` shape for
// backward compatibility.

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

// Falls back to the basename of `repo` if `project` is unset, so existing
// configs with `repo: "Owner/name"` keep working without a hand-edit.
// Multi-mode (no `config.repo`) requires `config.project` set explicitly —
// there is no inherit target.
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

// Returns true when the config is in multi-repo mode (no top-level repo).
export function isMultiRepo(config: OrchestratorConfig): boolean {
  return !config.repo
}

// Lowercased basename of `Owner/Repo`. Must match the project pattern (since
// the slug is interpolated into nicks/channels). Cross-org collisions
// (`Owner1/foo` + `Owner2/foo`) are a known footgun.
export function repoSlug(repo: string): string {
  const base = repo.split('/').pop()?.toLowerCase() ?? ''
  if (!PROJECT_PATTERN.test(base)) {
    throw new Error(
      `cannot derive slug from repo "${repo}": basename "${base}" must match ${PROJECT_PATTERN}`
    )
  }
  return base
}

// Returns the slug segment for an entry's repo in the active mode. `undefined`
// in single-repo mode (callers omit the segment); the lowercased basename in
// multi-repo mode.
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

export function leadsChannel(project: string): string {
  return `#${project}-leads`
}

export function workerNick(project: string, n: number, slug?: string): string {
  return slug ? `${project}-worker-${slug}-${n}` : `${project}-worker-${n}`
}

export function reviewerNick(project: string, n: number, slug?: string): string {
  return slug ? `${project}-reviewer-${slug}-${n}` : `${project}-reviewer-${n}`
}

export function leadPmNick(project: string): string {
  return `${project}-lead-pm`
}

export function apmNick(project: string): string {
  return `${project}-apm`
}

export function dispatcherNick(project: string): string {
  return `${project}-dispatcher`
}
