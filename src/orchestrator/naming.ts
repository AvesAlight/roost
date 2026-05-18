// Project-namespaced names for the roost conventions. Multi-project hygiene
// requires every per-project artifact (IRC nick, IRC channel, tmux session)
// to carry a project prefix so two projects sharing one ergo + one tmux do
// not collide. Single source of truth for the prefix shape.
//
// Format: project-first (`#<project>-leads`, `#<project>-issue-N`,
// `<project>-worker-N`). Project-first groups every channel for one project
// together in irssi/weechat `/list`, which is the dogfooding ergonomic.

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
export function defaultProject(config: OrchestratorConfig): string {
  if (config.project) {
    validateProject(config.project)
    return config.project
  }
  if (config.repo) {
    const base = config.repo.split('/').pop()?.toLowerCase() ?? ''
    if (PROJECT_PATTERN.test(base)) return base
  }
  throw new Error('no project: set `project` (or a parseable `repo`) in config.json')
}

export function issueChannel(project: string, n: number): string {
  return `#${project}-issue-${n}`
}

export function leadsChannel(project: string): string {
  return `#${project}-leads`
}

export function workerNick(project: string, n: number): string {
  return `${project}-worker-${n}`
}

export function reviewerNick(project: string, n: number): string {
  return `${project}-reviewer-${n}`
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
