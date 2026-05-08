import type { PrSnap, IssueSnap } from './types.js'
import {
  fetchPr,
  fetchPrReviewComments,
  fetchPrConversationComments,
  fetchPrReviews,
  fetchPrLinkedIssues,
  fetchIssue,
  fetchIssueComments,
  labelNames,
  type GhComment,
  type GhReview,
} from './github-api.js'

export interface PrSnapInternal extends PrSnap {
  _review_comments_by_id: Record<number, GhComment>
  _conversation_comments_by_id: Record<number, GhComment>
  _reviews_by_id: Record<number, GhReview>
}

export interface IssueSnapInternal extends IssueSnap {
  _comments_by_id: Record<number, GhComment>
}

export function stripInternals(snap: PrSnapInternal): PrSnap
export function stripInternals(snap: IssueSnapInternal): IssueSnap
export function stripInternals(snap: PrSnapInternal | IssueSnapInternal): PrSnap | IssueSnap {
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

export async function snapshotPr(
  repo: string,
  number: number,
  prevSnap?: PrSnap | null
): Promise<PrSnapInternal> {
  const view = await fetchPr(repo, number)
  const [reviewComments, convComments, reviews] = await Promise.all([
    fetchPrReviewComments(repo, number),
    fetchPrConversationComments(repo, number),
    fetchPrReviews(repo, number),
  ])

  const curHead = view.head_oid
  const linkedIssues =
    prevSnap && prevSnap.head_oid === curHead
      ? prevSnap.linked_issues ?? []
      : await fetchPrLinkedIssues(repo, number)

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

export async function snapshotIssue(repo: string, number: number): Promise<IssueSnapInternal> {
  const [issue, comments] = await Promise.all([
    fetchIssue(repo, number),
    fetchIssueComments(repo, number),
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
