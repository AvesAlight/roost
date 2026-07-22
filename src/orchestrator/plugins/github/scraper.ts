// Scraper — build a PR/issue snapshot from a batched GraphQL node and diff it
// against the previous one. Public surface: `snapshotPrFromNode` /
// `snapshotIssueFromNode` (node → snapshot + events, called by the plugins),
// `computePrEvents` / `computeIssueEvents` (tested directly), `*Internal`
// snapshot types (diff.ts).
//
// prevSnap meanings:
//   undefined → seeding (global --seed or no prior state); emit nothing
//   null      → new to watch list; emit seed/backlog events
//   PrSnap    → normal tick; diff and emit change events
import type { PrSnap, IssueSnap } from './types.js'
import type { GhComment, GhReview, GhPrNode, GhIssueNode } from './github-api.js'
import { labelNames, rollupToCiState } from './github-api.js'
import { diffPr, diffIssue, type OrchestratorEvent } from './diff.js'

// ---- Snapshot types & helpers ---------------------------------------------

export interface PrSnapInternal extends PrSnap {
  _review_comments_by_id: Record<number, GhComment>
  _conversation_comments_by_id: Record<number, GhComment>
  _reviews_by_id: Record<number, GhReview>
}

export interface IssueSnapInternal extends IssueSnap {
  _comments_by_id: Record<number, GhComment>
}

function stripInternals(snap: PrSnapInternal): PrSnap
function stripInternals(snap: IssueSnapInternal): IssueSnap
function stripInternals(snap: PrSnapInternal | IssueSnapInternal): PrSnap | IssueSnap {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(snap)) {
    if (!k.startsWith('_')) out[k] = v
  }
  return out as unknown as PrSnap | IssueSnap
}

function sortedIds<T extends { id?: number }>(items: T[]): number[] {
  return items.filter(c => c.id != null).map(c => c.id as number).sort((a, b) => a - b)
}

function indexById<T extends { id?: number }>(items: T[]): Record<number, T> {
  const out: Record<number, T> = {}
  for (const item of items) {
    if (item.id != null) out[item.id] = item
  }
  return out
}

// ---- GraphQL node → snapshot (pure) ---------------------------------------
//
// The batched GraphQL read (GhClient.fetchPrsBatch/fetchIssuesBatch) returns raw
// nodes; these rebuild the REST-shaped internal snapshots the diff consumes.
// GraphQL databaseId maps to the numeric ids the diff keys on, so PrSnap/
// IssueSnap and diff.ts stay unchanged (no state migration).

export function buildPrSnapshot(repo: string, number: number, node: GhPrNode): PrSnapInternal {
  const reviewComments: GhComment[] = (node.reviewThreads?.nodes ?? [])
    .flatMap(t => t.comments?.nodes ?? [])
    .map(c => ({
      id: c.databaseId,
      html_url: c.url,
      user: { login: c.author?.login },
      body: c.body,
      path: c.path ?? undefined,
      line: c.line ?? undefined,
      original_line: c.originalLine ?? undefined,
    }))
  const convComments: GhComment[] = (node.comments?.nodes ?? []).map(c => ({
    id: c.databaseId,
    html_url: c.url,
    user: { login: c.author?.login },
    body: c.body,
  }))
  const reviews: GhReview[] = (node.reviews?.nodes ?? []).map(r => ({
    id: r.databaseId,
    html_url: r.url,
    user: { login: r.author?.login },
    body: r.body,
    state: r.state,
  }))
  // closingIssuesReferences can cross repos; sort by (repo, number) for a stable
  // routing order (the diff and channel fan-out key on it).
  const linkedIssues = (node.closingIssuesReferences?.nodes ?? [])
    .filter(n => n.number != null && n.repository?.nameWithOwner)
    .map(n => ({ repo: n.repository!.nameWithOwner as string, number: n.number as number }))
    .sort((a, b) => a.repo === b.repo ? a.number - b.number : a.repo.localeCompare(b.repo))
  const rollup = node.statusRollup?.nodes?.[0]?.commit?.statusCheckRollup?.state
  return {
    repo,
    number,
    title: node.title ?? null,
    url: node.url ?? null,
    head_ref: node.headRefName ?? null,
    head_oid: node.headRefOid ?? null,
    is_draft: Boolean(node.isDraft),
    merged: Boolean(node.merged),
    // Kept uppercase to preserve the REST-shaped value diff.ts keys on: it tests
    // `state === 'CLOSED'` gated by the `merged` boolean (never 'MERGED') and
    // nothing renders state to a channel, so GraphQL's extra MERGED — which REST
    // never emitted — changes nothing.
    state: node.state ?? null,
    labels: labelNames(node.labels?.nodes),
    ci_state: rollupToCiState(rollup),
    linked_issues: linkedIssues,
    seen_review_comment_ids: sortedIds(reviewComments),
    seen_conversation_comment_ids: sortedIds(convComments),
    seen_review_ids: sortedIds(reviews),
    _review_comments_by_id: indexById(reviewComments),
    _conversation_comments_by_id: indexById(convComments),
    _reviews_by_id: indexById(reviews),
  }
}

export function buildIssueSnapshot(repo: string, number: number, node: GhIssueNode): IssueSnapInternal {
  const comments: GhComment[] = (node.comments?.nodes ?? []).map(c => ({
    id: c.databaseId,
    html_url: c.url,
    user: { login: c.author?.login },
    body: c.body,
  }))
  return {
    repo,
    number,
    title: node.title ?? null,
    url: node.url ?? null,
    // Lower-cased to the REST-shaped 'open'/'closed' the diff and shouldPush
    // (to === 'closed') compare against.
    state: node.state ? node.state.toLowerCase() : null,
    labels: labelNames(node.labels?.nodes),
    seen_comment_ids: sortedIds(comments),
    _comments_by_id: indexById(comments),
  }
}

// ---- Event computation (pure; tested directly) ----------------------------

interface ScrapeResult<T> {
  snap: T
  events: OrchestratorEvent[]
}

export function computePrEvents(
  snap: PrSnapInternal,
  prevSnap: PrSnap | null | undefined,
  agentLogins: Set<string>
): { events: OrchestratorEvent[], nextWarnedNoLinked: boolean } {
  const linked = snap.linked_issues ?? []

  if (prevSnap === undefined) return { events: [], nextWarnedNoLinked: false }  // seeding
  if (prevSnap !== null) return { events: diffPr(prevSnap, snap, agentLogins), nextWarnedNoLinked: !linked.length }

  // New PR added to watch list
  const base = { repo: snap.repo, pr: snap.number, url: snap.url ?? '', title: snap.title ?? '', ...(linked.length ? { linked_issues: linked } : undefined) }
  const events: OrchestratorEvent[] = [{ kind: 'pr_added_to_watch', ...base }]
  if (!linked.length) events.push({ kind: 'pr_no_linked_issues', ...base })
  const existingRev = snap.seen_review_comment_ids.length
  const existingConv = snap.seen_conversation_comment_ids.length
  if (existingRev || existingConv) {
    events.push({ kind: 'pr_has_existing_comments', review_comment_count: existingRev, conversation_comment_count: existingConv, ...base })
  }
  if (snap.ci_state === 'SUCCESS' || snap.ci_state === 'FAILURE') {
    events.push({ kind: 'pr_has_existing_ci_state', ci_state: snap.ci_state, head_oid: snap.head_oid, ...base })
  }
  return { events, nextWarnedNoLinked: !linked.length }
}

export function computeIssueEvents(
  snap: IssueSnapInternal,
  prevIssue: IssueSnap | null | undefined,
  agentLogins: Set<string>
): OrchestratorEvent[] {
  if (prevIssue === undefined) return []  // seeding — no events
  if (prevIssue !== null) return diffIssue(prevIssue, snap, agentLogins)

  // New to watch list
  const base = { repo: snap.repo, issue: snap.number, url: snap.url ?? '', title: snap.title ?? '' }
  const events: OrchestratorEvent[] = [{ kind: 'issue_added_to_watch', ...base }]
  if (snap.seen_comment_ids.length) {
    events.push({ kind: 'issue_has_existing_comments', comment_count: snap.seen_comment_ids.length, ...base })
  }
  return events
}

// ---- Node → snapshot + events (pure) --------------------------------------
//
// The batched read hands each entry's raw node here. agentLogins can drift
// between ticks (operator config edit), so the plugin passes a fresh set per
// runTick. prevSnap meaning matches computePrEvents: undefined = seed,
// null = new watch entry, snapshot = normal diff.

export function snapshotPrFromNode(
  repo: string,
  number: number,
  node: GhPrNode,
  prevSnap: PrSnap | null | undefined,
  agentLogins: Set<string>,
): ScrapeResult<PrSnap> {
  const snap = buildPrSnapshot(repo, number, node)
  const { events, nextWarnedNoLinked } = computePrEvents(snap, prevSnap, agentLogins)
  const stripped = stripInternals(snap)
  stripped.warned_no_linked = nextWarnedNoLinked
  return { snap: stripped, events }
}

export function snapshotIssueFromNode(
  repo: string,
  number: number,
  node: GhIssueNode,
  prevIssue: IssueSnap | null | undefined,
  agentLogins: Set<string>,
): ScrapeResult<IssueSnap> {
  const snap = buildIssueSnapshot(repo, number, node)
  return { snap: stripInternals(snap), events: computeIssueEvents(snap, prevIssue, agentLogins) }
}
