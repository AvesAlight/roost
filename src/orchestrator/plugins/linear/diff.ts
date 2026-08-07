import type { LinearIssueSnap } from './types.js'

// ---- Event types -----------------------------------------------------------

export interface BaseLinearEvent {
  kind: string
  identifier: string
  url?: string
  title?: string
}

export interface LinearStateEvent extends BaseLinearEvent {
  kind: 'linear_state_changed'
  fromType: string | null
  toType: string | null
  fromStatus: string | null
  toStatus: string | null
}

export interface LinearCommentEvent extends BaseLinearEvent {
  kind: 'linear_comment'
  comment_id: string
  comment_url: string
  author: string | null
  body: string
  body_preview: string
}

export interface LinearThreadReplyEvent extends BaseLinearEvent {
  kind: 'linear_thread_reply'
  comment_id: string
  comment_url: string
  parent_comment_id: string
  parent_author: string | null
  parent_comment_url: string | null
  author: string | null
}

export interface LinearLabelEvent extends BaseLinearEvent {
  kind: 'linear_labels_changed'
  added: string[]
  removed: string[]
}

export interface LinearGithubPrLinkedEvent extends BaseLinearEvent {
  kind: 'linear_github_pr_linked'
  attachment_id: string
  pr_repo: string
  pr_number: number
  pr_url: string
}

export interface LinearSeedEvent extends BaseLinearEvent {
  kind:
    | 'linear_issue_added_to_watch'
    | 'linear_issue_has_existing_comments'
    | 'linear_issue_disappeared'
  // Backlog dump framing: total pre-watch comments found, and how many were
  // actually posted (total > posted means the rest were elided by the cap).
  backlog_total?: number
  backlog_posted?: number
}

export type LinearEvent =
  | BaseLinearEvent
  | LinearStateEvent
  | LinearCommentEvent
  | LinearThreadReplyEvent
  | LinearLabelEvent
  | LinearGithubPrLinkedEvent
  | LinearSeedEvent

// All linear events currently reach IRC — there's no equivalent of the github
// filter (skip-noisy labels, skip non-terminal CI). Drop the wrapper for now;
// if a future event needs gating, add it back with the predicate inline.

// Most pre-watch comments to post inline when a Linear issue is newly watched.
// Backlog is a one-time dump at watch time, so this only bites on large
// pre-watch histories; the typical linkback case (a handful of comments)
// always posts in full. When elided, the most recent K are kept (the
// actionable tail of an active thread) and the framing line points to the
// URL for earlier history.
export const BACKLOG_COMMENT_CAP = 20

// ---- GraphQL shape -------------------------------------------------------

// Trimmed view of Linear's `issue` response — only fields we read. Tests
// build mocks against this shape; runtime ignores extra fields.
export interface RawLinearComment {
  id: string
  body: string | null
  user?: { name: string | null } | null
  parent?: { id: string } | null
}

export interface RawLinearAttachment {
  id: string
  sourceType: string | null
  url: string | null
  title: string | null
}

export interface RawLinearIssue {
  id: string
  identifier: string
  title: string | null
  url: string | null
  state: { type: string | null; name: string | null } | null
  labels: { nodes: Array<{ name: string }> } | null
  comments: { nodes: RawLinearComment[] } | null
  attachments: { nodes: RawLinearAttachment[] } | null
}

// ---- Pure helpers --------------------------------------------------------

function labelDiff(prev: string[] | undefined, cur: string[] | undefined): { added: string[]; removed: string[] } {
  const prevS = new Set(prev ?? [])
  const curS = new Set(cur ?? [])
  return {
    added: [...curS].filter(l => !prevS.has(l)).sort(),
    removed: [...prevS].filter(l => !curS.has(l)).sort(),
  }
}

// Strict github PR URL matcher — `pull/<N>` only. `pulls/<N>` (an API alias)
// and other variants are intentionally ignored: design spec is authoritative
// and matching observed-but-unspecified shapes risks ambiguous-source bugs.
const GITHUB_PR_URL_RE = /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*)\/pull\/(\d+)(?:[/?#].*)?$/

export function parseGithubPrUrl(url: string | null | undefined): { repo: string; number: number } | null {
  if (!url) return null
  const m = url.match(GITHUB_PR_URL_RE)
  if (!m) return null
  return { repo: m[1], number: Number(m[2]) }
}

// Snapshot a top-level subset of attachments (sourceType=github with a
// well-formed pull/<N> URL). Returned ids drive the seen-set; the parsed
// repo+number pair feeds the linked event when the id is new.
export interface GithubAttachmentEntry {
  id: string
  pr_repo: string
  pr_number: number
  pr_url: string
}

export function selectGithubAttachments(atts: RawLinearAttachment[]): GithubAttachmentEntry[] {
  const out: GithubAttachmentEntry[] = []
  for (const a of atts) {
    if (a.sourceType !== 'github') continue
    const parsed = parseGithubPrUrl(a.url)
    if (!parsed) continue
    // parseGithubPrUrl short-circuits on falsy URL, so `a.url` is truthy here.
    out.push({ id: a.id, pr_repo: parsed.repo, pr_number: parsed.number, pr_url: a.url as string })
  }
  return out
}

// Stable-sorted ids — mirrors `sortedIds(...)` at github/scraper.ts:36.
function sortedStringIds<T extends { id: string }>(items: T[]): string[] {
  return items.map(i => i.id).sort()
}

// ---- Snapshot builder ----------------------------------------------------

// Build a snap from a raw Linear `issue` response. Pure — no I/O. Caller
// handles the null-issue (disappeared) path before getting here.
export function buildLinearSnap(raw: RawLinearIssue): LinearIssueSnap {
  const labels = (raw.labels?.nodes ?? []).map(n => n.name).sort()
  const comments = raw.comments?.nodes ?? []
  const githubAtts = selectGithubAttachments(raw.attachments?.nodes ?? [])
  return {
    id: raw.id,
    identifier: raw.identifier,
    title: raw.title ?? null,
    url: raw.url ?? null,
    status: raw.state?.name ?? null,
    statusType: raw.state?.type ?? null,
    labels,
    seen_comment_ids: sortedStringIds(comments),
    seen_github_attachment_ids: sortedStringIds(githubAtts),
  }
}

// ---- Diff ----------------------------------------------------------------

// Index comments and attachments by id so the diff can look up parent / pr
// metadata for the ids that landed this tick.
export interface ScrapeContext {
  comments: RawLinearComment[]
  githubAttachments: GithubAttachmentEntry[]
}

function indexComments(comments: RawLinearComment[]): Record<string, RawLinearComment> {
  const out: Record<string, RawLinearComment> = {}
  for (const c of comments) out[c.id] = c
  return out
}

function indexGithubAtts(atts: GithubAttachmentEntry[]): Record<string, GithubAttachmentEntry> {
  const out: Record<string, GithubAttachmentEntry> = {}
  for (const a of atts) out[a.id] = a
  return out
}

function newIds(prev: string[] | undefined, cur: string[]): string[] {
  const prevSet = new Set(prev ?? [])
  return cur.filter(id => !prevSet.has(id))
}

function commentBase(snap: LinearIssueSnap): Pick<BaseLinearEvent, 'identifier' | 'url' | 'title'> {
  return { identifier: snap.identifier, url: snap.url ?? '', title: snap.title ?? '' }
}

function formatCommentEvent(
  c: RawLinearComment,
  snap: LinearIssueSnap,
  parentLookup: Record<string, RawLinearComment>,
): LinearCommentEvent | LinearThreadReplyEvent {
  const body = c.body ?? ''
  const author = c.user?.name ?? null
  // Linear comment permalinks: <issue.url>#comment-<id>.
  const commentUrl = `${snap.url ?? ''}#comment-${c.id}`
  if (c.parent?.id) {
    const parent = parentLookup[c.parent.id]
    const parentAuthor = parent?.user?.name ?? null
    return {
      kind: 'linear_thread_reply',
      ...commentBase(snap),
      comment_id: c.id,
      comment_url: commentUrl,
      parent_comment_id: c.parent.id,
      parent_author: parentAuthor,
      parent_comment_url: parent ? `${snap.url ?? ''}#comment-${c.parent.id}` : null,
      author,
    }
  }
  return {
    kind: 'linear_comment',
    ...commentBase(snap),
    comment_id: c.id,
    comment_url: commentUrl,
    author,
    body,
    body_preview: body.slice(0, 280),
  }
}

export function diffLinearIssue(
  prev: LinearIssueSnap,
  cur: LinearIssueSnap,
  ctx: ScrapeContext,
): LinearEvent[] {
  const events: LinearEvent[] = []
  const base = commentBase(cur)

  if (prev.statusType !== cur.statusType) {
    events.push({
      kind: 'linear_state_changed',
      ...base,
      fromType: prev.statusType,
      toType: cur.statusType,
      fromStatus: prev.status,
      toStatus: cur.status,
    } as LinearStateEvent)
  }

  const { added, removed } = labelDiff(prev.labels, cur.labels)
  if (added.length || removed.length) {
    events.push({ kind: 'linear_labels_changed', ...base, added, removed } as LinearLabelEvent)
  }

  const commentLookup = indexComments(ctx.comments)
  for (const cid of newIds(prev.seen_comment_ids, cur.seen_comment_ids)) {
    const c = commentLookup[cid]
    if (!c) continue
    events.push(formatCommentEvent(c, cur, commentLookup))
  }

  const attLookup = indexGithubAtts(ctx.githubAttachments)
  for (const aid of newIds(prev.seen_github_attachment_ids, cur.seen_github_attachment_ids)) {
    const a = attLookup[aid]
    if (!a) continue
    events.push({
      kind: 'linear_github_pr_linked',
      ...base,
      attachment_id: a.id,
      pr_repo: a.pr_repo,
      pr_number: a.pr_number,
      pr_url: a.pr_url,
    } as LinearGithubPrLinkedEvent)
  }

  return events
}

// Seed events emitted when a snap is new to the watch list (prevSnap === null).
// The backlog dump (pre-watch comments) is built separately by
// `backlogLinearIssueEvents` and appended by the scraper, which holds the raw
// comment bodies — this function only emits the added-to-watch notice.
export function seedLinearIssue(snap: LinearIssueSnap): LinearEvent[] {
  const base = commentBase(snap)
  return [{ kind: 'linear_issue_added_to_watch', ...base }]
}

// ---- Backlog dump (newly-watched issue) ------------------------------------
//
// When a Linear issue is first watched, pre-watch comments already exist.
// These builders emit the actual items as the same event kinds the live diff
// uses, so they route and render identically to fresh comments.
//
// Ordering: Linear comment ids are UUIDs, not monotonic like GitHub
// databaseIds, so id-sort is meaningless. `ctx.comments` arrives in creation
// order from the API, so the dump iterates that array order and the
// most-recent-K cap slices the tail of it. This is a deliberate deviation
// from the github backlog's id-merge (which relies on monotonic ids).
//
// Formatting is deferred to a thunk per item so only the kept K are formatted
// — the cap exists to bound the work for a large pre-watch history, and
// formatting every item then discarding the tail would defeat that.

interface BacklogItem {
  format: () => LinearEvent
}

function pickMostRecentK(items: BacklogItem[], cap: number): BacklogItem[] {
  const start = Math.max(0, items.length - cap)
  return items.slice(start)
}

export function backlogLinearIssueEvents(
  snap: LinearIssueSnap,
  comments: RawLinearComment[],
  cap: number = BACKLOG_COMMENT_CAP,
): { events: LinearEvent[]; total: number; posted: number } {
  const parentLookup = indexComments(comments)
  const items: BacklogItem[] = comments.map(c => ({
    format: () => formatCommentEvent(c, snap, parentLookup),
  }))
  const posted = pickMostRecentK(items, cap)
  return { events: posted.map(i => i.format()), total: items.length, posted: posted.length }
}

export function disappearedLinearIssue(identifier: string): LinearSeedEvent {
  return { kind: 'linear_issue_disappeared', identifier }
}
