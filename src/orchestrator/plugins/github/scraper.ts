// Scraper helpers — one per GH entity type. Each fetches the current snapshot
// and computes what events to emit vs. the previous state.
//
// prevSnap meanings:
//   undefined → seeding tick (global --seed or no prior state); emit nothing
//   null      → entity is new to the watch list; emit seed/backlog events
//   PrSnap    → normal tick; diff against prev and emit change events
import type { PrSnap, IssueSnap } from './types.js'
import { snapshotPr, snapshotIssue, stripInternals } from './snapshot.js'
import type { PrSnapInternal, IssueSnapInternal } from './snapshot.js'
import { diffPr, diffIssue } from './diff.js'
import type { OrchestratorEvent } from './diff.js'

export interface ScrapeResult<T> {
  snap: T
  events: OrchestratorEvent[]
}

export function computePrEvents(
  snap: PrSnapInternal,
  prevSnap: PrSnap | null | undefined,
  agentLogins: Set<string>
): OrchestratorEvent[] {
  if (prevSnap === undefined) return []   // seeding tick — no events
  if (prevSnap !== null) return diffPr(prevSnap, snap, agentLogins)

  // New PR added to watch list
  const linked = snap.linked_issues ?? []
  const base = { repo: snap.repo, pr: snap.number, url: snap.url ?? '', title: snap.title ?? '', ...(linked.length ? { linked_issues: linked } : {}) }
  const events: OrchestratorEvent[] = [{ kind: 'pr_added_to_watch', ...base }]
  if (linked.length === 0) events.push({ kind: 'pr_no_linked_issues', ...base })
  const existingRev = snap.seen_review_comment_ids.length
  const existingConv = snap.seen_conversation_comment_ids.length
  if (existingRev || existingConv) {
    events.push({ kind: 'pr_has_existing_comments', review_comment_count: existingRev, conversation_comment_count: existingConv, ...base })
  }
  if (snap.ci_state === 'SUCCESS' || snap.ci_state === 'FAILURE') {
    events.push({ kind: 'pr_has_existing_ci_state', ci_state: snap.ci_state, ...base })
  }
  return events
}

export function computeIssueEvents(
  snap: IssueSnapInternal,
  prevIssue: IssueSnap | null | undefined,
  agentLogins: Set<string>
): OrchestratorEvent[] {
  if (prevIssue === undefined) return []  // seeding tick — no events
  if (prevIssue !== null) return diffIssue(prevIssue, snap, agentLogins)

  // New issue added to watch list
  const events: OrchestratorEvent[] = [
    { kind: 'issue_added_to_watch', repo: snap.repo, issue: snap.number, url: snap.url ?? '', title: snap.title ?? '' },
  ]
  if (snap.seen_comment_ids.length) {
    events.push({ kind: 'issue_has_existing_comments', repo: snap.repo, issue: snap.number, url: snap.url ?? '', title: snap.title ?? '', comment_count: snap.seen_comment_ids.length })
  }
  return events
}

export async function scrapePr(
  repo: string,
  number: number,
  prevSnap: PrSnap | null | undefined,
  agentLogins: Set<string>
): Promise<ScrapeResult<PrSnap>> {
  const snap = await snapshotPr(repo, number, prevSnap ?? undefined)
  const events = computePrEvents(snap, prevSnap, agentLogins)
  const stripped = stripInternals(snap) as PrSnap
  const linked = stripped.linked_issues ?? []
  if (linked.length > 0) {
    stripped.warned_no_linked = false
  } else if (events.some(e => e.kind === 'pr_no_linked_issues')) {
    stripped.warned_no_linked = true
  } else {
    stripped.warned_no_linked = prevSnap?.warned_no_linked ?? false
  }
  return { snap: stripped, events }
}

export async function scrapeIssue(
  repo: string,
  number: number,
  prevIssue: IssueSnap | null | undefined,
  agentLogins: Set<string>
): Promise<ScrapeResult<IssueSnap>> {
  const snap = await snapshotIssue(repo, number)
  return { snap: stripInternals(snap) as IssueSnap, events: computeIssueEvents(snap, prevIssue, agentLogins) }
}
