import type { PrSnap, IssueSnap, LinkedIssue } from './types.js'
import type { PrSnapInternal, IssueSnapInternal } from './scraper.js'
import type { GhComment, GhReview } from './github-api.js'

// ---- Event types -----------------------------------------------------------

export interface BaseEvent {
  kind: string
  repo?: string
  pr?: number
  issue?: number
  url?: string
  title?: string
  linked_issues?: LinkedIssue[]
}

export interface LabelEvent extends BaseEvent {
  kind: 'labels_changed'
  subject: 'pr' | 'issue'
  added: string[]
  removed: string[]
}

export interface CiEvent extends BaseEvent {
  kind: 'ci_transitioned'
  from: string | null
  to: string | null
  head_oid: string | null
}

export interface CommentEvent extends BaseEvent {
  kind: 'pr_review_comment' | 'pr_conversation_comment' | 'issue_comment'
  comment_id: number | undefined
  comment_url: string | undefined
  author: string | undefined
  is_worker_reply: boolean
  body: string
  body_preview: string
  path?: string
  line?: number
  review_url?: string
}

export interface ReviewEvent extends BaseEvent {
  kind: 'pr_review_submitted'
  review_id: number
  review_url: string | undefined
  author: string | undefined
  state: string
  body: string
  body_preview: string
  is_worker_reply: boolean
}

export interface StateChangeEvent extends BaseEvent {
  kind: 'issue_state_changed'
  from: string | null
  to: string | null
}

export interface SeedEvent extends BaseEvent {
  kind:
    | 'pr_added_to_watch'
    | 'issue_added_to_watch'
    | 'pr_has_existing_comments'
    | 'pr_has_existing_ci_state'
    | 'issue_has_existing_comments'
    | 'dispatcher_error'
    | 'pr_ready_for_review'
    | 'pr_returned_to_draft'
    | 'pr_merged'
    | 'pr_closed'
    | 'pr_no_linked_issues'
  review_comment_count?: number
  conversation_comment_count?: number
  comment_count?: number
  ci_state?: string | null
  stderr?: string
  tick_utc?: string
}

export type OrchestratorEvent = BaseEvent | LabelEvent | CiEvent | CommentEvent | ReviewEvent | StateChangeEvent | SeedEvent

// ---- Classification --------------------------------------------------------

const ALWAYS_PUSH_KINDS = new Set([
  'pr_ready_for_review',
  'pr_returned_to_draft',
  'pr_merged',
  'pr_closed',
  'pr_has_existing_comments',
  'pr_has_existing_ci_state',
  'issue_has_existing_comments',
  'dispatcher_error',
  'pr_no_linked_issues',
])
const MEANINGFUL_LABEL_PREFIXES = ['phase:', 'plan:']
const MEANINGFUL_LABELS_EXACT = new Set(['ready-for-merge'])

export function shouldPush(event: OrchestratorEvent): boolean {
  const kind = event.kind
  if (ALWAYS_PUSH_KINDS.has(kind)) return true
  if (['pr_review_comment', 'pr_conversation_comment', 'issue_comment', 'pr_review_submitted'].includes(kind)) return true
  if (kind === 'ci_transitioned') {
    const ev = event as CiEvent
    return ev.to === 'SUCCESS' || ev.to === 'FAILURE'
  }
  if (kind === 'labels_changed') {
    const ev = event as LabelEvent
    const changed = [...(ev.added ?? []), ...(ev.removed ?? [])]
    return changed.some(label =>
      MEANINGFUL_LABEL_PREFIXES.some(p => label.startsWith(p)) || MEANINGFUL_LABELS_EXACT.has(label)
    )
  }
  if (kind === 'issue_state_changed') {
    return (event as StateChangeEvent).to === 'closed'
  }
  return true
}

// ---- Comment event builder -------------------------------------------------

export function formatCommentEvent(
  c: GhComment,
  opts: {
    kind: CommentEvent['kind']
    repo?: string
    pr?: number
    issue?: number
    url: string
    agentLogins?: Set<string>
    linkedIssues?: LinkedIssue[]
  }
): CommentEvent {
  const author = c.user?.login
  const body = c.body ?? ''
  const isAgentAuthor = Boolean(opts.agentLogins?.size && author && opts.agentLogins.has(author))
  const stripped = body.trimStart()
  const hasAgentPrefix =
    stripped.startsWith('[worker-') ||
    stripped.startsWith('[lead-') ||
    stripped.startsWith('[reviewer-')
  const isWorker = isAgentAuthor || hasAgentPrefix

  const ev: CommentEvent = {
    kind: opts.kind,
    comment_id: c.id,
    comment_url: c.html_url,
    author,
    is_worker_reply: isWorker,
    body,
    body_preview: body.slice(0, 280),
  }
  if (opts.repo) ev.repo = opts.repo
  if (opts.pr != null) {
    ev.pr = opts.pr
    ev.url = opts.url
    if (opts.linkedIssues?.length) ev.linked_issues = opts.linkedIssues
  }
  if (opts.issue != null) {
    ev.issue = opts.issue
    ev.url = opts.url
  }
  if (c.path != null) {
    ev.path = c.path
    ev.line = c.line ?? c.original_line
  }
  return ev
}

// ---- PR diff ---------------------------------------------------------------

function linkedSpread(linked: LinkedIssue[]): { linked_issues?: LinkedIssue[] } {
  return linked.length ? { linked_issues: linked } : {}
}

function labelDiff(prev: string[] | undefined, cur: string[] | undefined): { added: string[]; removed: string[] } {
  const prevS = new Set(prev ?? [])
  const curS = new Set(cur ?? [])
  return {
    added: [...curS].filter(l => !prevS.has(l)).sort(),
    removed: [...prevS].filter(l => !curS.has(l)).sort(),
  }
}

// New ids in `cur` not present in `prev`, sorted ascending. Used for all
// three comment/review feeds — PRs (review+conversation+reviews) and issues.
function newIds(prev: number[] | undefined, cur: Record<number, unknown>): number[] {
  const prevSet = new Set(prev ?? [])
  return Object.keys(cur).map(Number).filter(id => !prevSet.has(id)).sort((a, b) => a - b)
}

export function diffPr(
  prev: PrSnap,
  cur: PrSnapInternal,
  agentLogins?: Set<string>
): OrchestratorEvent[] {
  const events: OrchestratorEvent[] = []
  const n = cur.number
  const repo = cur.repo
  const linked = cur.linked_issues ?? []
  const base = { repo, pr: n, url: cur.url ?? '', title: cur.title ?? '', ...linkedSpread(linked) }

  if (linked.length === 0 && !prev.warned_no_linked) events.push({ kind: 'pr_no_linked_issues', ...base })

  if (prev.is_draft && !cur.is_draft) events.push({ kind: 'pr_ready_for_review', ...base })
  if (!prev.is_draft && cur.is_draft) events.push({ kind: 'pr_returned_to_draft', ...base })
  if (!prev.merged && cur.merged) events.push({ kind: 'pr_merged', ...base })
  else if (prev.state === 'OPEN' && cur.state === 'CLOSED' && !cur.merged) events.push({ kind: 'pr_closed', ...base })

  const { added, removed } = labelDiff(prev.labels, cur.labels)
  if (added.length || removed.length) {
    events.push({ kind: 'labels_changed', subject: 'pr', added, removed, ...base } as LabelEvent)
  }

  const curHead = cur.head_oid
  const headChanged = prev.head_oid !== curHead
  const prevCi = prev.ci_state
  const curCi = cur.ci_state
  const ciBase = { repo, pr: n, url: cur.url ?? '', head_oid: curHead, ...linkedSpread(linked) }
  if (headChanged && (curCi === 'SUCCESS' || curCi === 'FAILURE')) {
    events.push({ kind: 'ci_transitioned', from: 'PENDING', to: curCi, ...ciBase } as CiEvent)
  } else if (!headChanged && prevCi !== curCi) {
    events.push({ kind: 'ci_transitioned', from: prevCi, to: curCi, ...ciBase } as CiEvent)
  }

  const commentOpts = { repo, pr: n, url: cur.url ?? '', agentLogins, linkedIssues: linked }
  for (const cid of newIds(prev.seen_review_comment_ids, cur._review_comments_by_id)) {
    events.push(formatCommentEvent(cur._review_comments_by_id[cid] as GhComment, { kind: 'pr_review_comment', ...commentOpts }))
  }
  for (const cid of newIds(prev.seen_conversation_comment_ids, cur._conversation_comments_by_id)) {
    events.push(formatCommentEvent(cur._conversation_comments_by_id[cid] as GhComment, { kind: 'pr_conversation_comment', ...commentOpts }))
  }

  for (const rid of newIds(prev.seen_review_ids, cur._reviews_by_id)) {
    const review = cur._reviews_by_id[rid] as GhReview
    const reviewAuthor = review.user?.login
    events.push({
      kind: 'pr_review_submitted',
      repo, pr: n, url: cur.url ?? '',
      review_id: rid,
      review_url: review.html_url,
      author: reviewAuthor,
      state: (review.state ?? '').toUpperCase(),
      body: review.body ?? '',
      body_preview: (review.body ?? '').slice(0, 280),
      is_worker_reply: Boolean(agentLogins?.size && reviewAuthor && agentLogins.has(reviewAuthor)),
      ...linkedSpread(linked),
    } as ReviewEvent)
  }

  return events
}

// ---- Issue diff ------------------------------------------------------------

export function diffIssue(
  prev: IssueSnap,
  cur: IssueSnapInternal,
  agentLogins?: Set<string>
): OrchestratorEvent[] {
  const events: OrchestratorEvent[] = []
  const n = cur.number
  const repo = cur.repo
  const url = cur.url ?? ''

  if (prev.state !== cur.state) {
    events.push({ kind: 'issue_state_changed', repo, issue: n, url, from: prev.state, to: cur.state } as StateChangeEvent)
  }

  const { added, removed } = labelDiff(prev.labels, cur.labels)
  if (added.length || removed.length) {
    events.push({ kind: 'labels_changed', subject: 'issue', added, removed, repo, issue: n, url } as LabelEvent)
  }

  for (const cid of newIds(prev.seen_comment_ids, cur._comments_by_id)) {
    events.push(formatCommentEvent(cur._comments_by_id[cid] as GhComment, { kind: 'issue_comment', repo, issue: n, url, agentLogins }))
  }

  return events
}
