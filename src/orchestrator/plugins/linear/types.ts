// Snapshot of a watched Linear issue. `seen_comment_ids` covers both
// top-level and threaded comments — Linear doesn't allow moving comments
// between the two, so a single set prevents double-emit on re-classification.
// `seen_github_attachment_ids` is restricted to attachments with
// `sourceType == 'github'`; the PR-linked event fires once per attachment id.
export interface LinearIssueSnap {
  identifier: string
  id: string
  title: string | null
  url: string | null
  status: string | null
  statusType: string | null
  labels: string[]
  seen_comment_ids: string[]
  seen_github_attachment_ids: string[]
}

// Tombstone for an issue that was watched then became 404 / inaccessible. Held
// in state so the disappeared event fires exactly once. Cleared only via
// `unwatch`. Distinguished from `LinearIssueSnap` by the literal `disappeared:
// true` discriminant; consumers use `isTombstone()` rather than truthy checks.
export interface LinearIssueTombstone {
  identifier: string
  disappeared: true
}

export type LinearIssueState = LinearIssueSnap | LinearIssueTombstone

export function isTombstone(s: LinearIssueState | null | undefined): s is LinearIssueTombstone {
  return s != null && 'disappeared' in s && s.disappeared === true
}

export interface LinearIssuePluginState {
  issues: Record<string, LinearIssueState>
}

// Watch-list entry — `identifier` is the spec-required uppercase Linear id
// (e.g. `C-758`). Channels are optional extra routing targets, unioned with
// the per-issue channel at event time.
export interface LinearWatchedEntry {
  identifier: string
  channels?: string[]
}
