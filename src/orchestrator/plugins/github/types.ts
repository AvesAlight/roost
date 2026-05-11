export interface PrSnap {
  repo: string
  number: number
  title: string | null
  url: string | null
  head_ref: string | null
  head_oid: string | null
  is_draft: boolean
  merged: boolean
  state: string | null
  labels: string[]
  ci_state: string | null
  linked_issues: number[]
  seen_review_comment_ids: number[]
  seen_conversation_comment_ids: number[]
  seen_review_ids: number[]
  // Mute flag: set after pr_no_linked_issues warning, cleared when
  // linked_issues becomes non-empty so a subsequent loss re-warns.
  // Absent in old snapshots (pre-upgrade) — !undefined is true, so upgrade
  // path warns on first tick without any special handling.
  warned_no_linked?: boolean
}

export interface IssueSnap {
  repo: string
  number: number
  title: string | null
  url: string | null
  state: string | null
  labels: string[]
  seen_comment_ids: number[]
}

export interface PrPluginState {
  prs: Record<string, PrSnap>
}

export interface IssuePluginState {
  issues: Record<string, IssueSnap>
}
