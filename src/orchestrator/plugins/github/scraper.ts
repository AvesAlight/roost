// Scraper — fetches a PR/issue snapshot and diffs it against the previous one
// to produce events. Snapshot construction (fetch + index for diff lookups)
// is module-private here; the only public surfaces are `GhScraper` (the
// per-tick handle plugins use), `computePrEvents`/`computeIssueEvents` (pure
// event computation tested directly), and the `*Internal` snapshot types that
// `diff.ts` consumes.
//
// prevSnap meanings:
//   undefined → seeding tick (global --seed or no prior state); emit nothing
//   null      → entity is new to the watch list; emit seed/backlog events
//   PrSnap    → normal tick; diff against prev and emit change events
import type { PrSnap, IssueSnap } from './types.js'
import type { GhClient, GhComment, GhReview } from './github-api.js'
import { labelNames } from './github-api.js'
import { diffPr, diffIssue, type OrchestratorEvent } from './diff.js'

// ---- Snapshot types & helpers (module-private outside the *Internal types,
// which diff.ts imports) ----------------------------------------------------

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

async function snapshotPr(
  client: GhClient,
  repo: string,
  number: number,
  prevSnap?: PrSnap | null
): Promise<PrSnapInternal> {
  const view = await client.fetchPr(repo, number)
  const [reviewComments, convComments, reviews] = await Promise.all([
    client.fetchPrReviewComments(repo, number),
    client.fetchPrConversationComments(repo, number),
    client.fetchPrReviews(repo, number),
  ])

  const curHead = view.head_oid
  const linkedIssues =
    prevSnap && prevSnap.head_oid === curHead
      ? prevSnap.linked_issues ?? []
      : await client.fetchPrLinkedIssues(repo, number)

  return {
    repo,
    number,
    title: view.title,
    url: view.url,
    head_ref: view.head_ref,
    head_oid: curHead,
    is_draft: view.is_draft,
    merged: view.merged_at != null,
    state: view.state,
    labels: labelNames(view.labels),
    ci_state: view.ci_state,
    linked_issues: linkedIssues,
    seen_review_comment_ids: sortedIds(reviewComments),
    seen_conversation_comment_ids: sortedIds(convComments),
    seen_review_ids: sortedIds(reviews),
    _review_comments_by_id: indexById(reviewComments),
    _conversation_comments_by_id: indexById(convComments),
    _reviews_by_id: indexById(reviews),
  }
}

async function snapshotIssue(client: GhClient, repo: string, number: number): Promise<IssueSnapInternal> {
  const [issue, comments] = await Promise.all([
    client.fetchIssue(repo, number),
    client.fetchIssueComments(repo, number),
  ])
  return {
    repo,
    number,
    title: issue.title ?? null,
    url: issue.html_url ?? null,
    state: issue.state ?? null,
    labels: labelNames(issue.labels),
    seen_comment_ids: sortedIds(comments),
    _comments_by_id: indexById(comments),
  }
}

// ---- Event computation (pure; tested directly) ----------------------------

export interface ScrapeResult<T> {
  snap: T
  events: OrchestratorEvent[]
}

export function computePrEvents(
  snap: PrSnapInternal,
  prevSnap: PrSnap | null | undefined,
  agentLogins: Set<string>
): { events: OrchestratorEvent[], nextWarnedNoLinked: boolean } {
  const linked = snap.linked_issues ?? []

  if (prevSnap === undefined) return { events: [], nextWarnedNoLinked: false }  // seeding tick

  if (prevSnap !== null) {
    return { events: diffPr(prevSnap, snap, agentLogins), nextWarnedNoLinked: linked.length === 0 }
  }

  // New PR added to watch list
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
  return { events, nextWarnedNoLinked: linked.length === 0 }
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

// ---- GhScraper — per-tick handle bundling client + agentLogins ------------
//
// Plugins construct one per `runTick` (agentLogins can drift between ticks
// when an operator edits config), then call `scrapePr`/`scrapeIssue` per
// watched entry. Replaces threading `client` and `agentLogins` through every
// scrape callsite.

export class GhScraper {
  constructor(
    private readonly client: GhClient,
    private readonly agentLogins: Set<string>,
  ) {}

  async scrapePr(
    repo: string,
    number: number,
    prevSnap: PrSnap | null | undefined,
  ): Promise<ScrapeResult<PrSnap>> {
    const snap = await snapshotPr(this.client, repo, number, prevSnap ?? undefined)
    const { events, nextWarnedNoLinked } = computePrEvents(snap, prevSnap, this.agentLogins)
    const stripped = stripInternals(snap) as PrSnap
    stripped.warned_no_linked = nextWarnedNoLinked
    return { snap: stripped, events }
  }

  async scrapeIssue(
    repo: string,
    number: number,
    prevIssue: IssueSnap | null | undefined,
  ): Promise<ScrapeResult<IssueSnap>> {
    const snap = await snapshotIssue(this.client, repo, number)
    return { snap: stripInternals(snap) as IssueSnap, events: computeIssueEvents(snap, prevIssue, this.agentLogins) }
  }
}
