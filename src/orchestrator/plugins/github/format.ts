import type { OrchestratorEvent, CommentEvent, ReviewEvent, LabelEvent, CiEvent, StateChangeEvent, SeedEvent } from './diff.js'
import type { TaggedEventPayload } from '../../plugin.js'

const MULTILINE_COMMENT_KINDS: ReadonlySet<string> = new Set([
  'pr_review_comment',
  'pr_conversation_comment',
  'issue_comment',
  'pr_review_submitted',
])

function eventTag(event: OrchestratorEvent): string {
  const n = event.pr ?? event.issue
  const repo = event.repo
  if (n != null && repo) return `${repo}#${n}`
  if (n != null) return `#${n}`
  return ''
}

function commentSnippet(event: CommentEvent): { snippet: string; ellipsis: string; url: string } {
  const preview = (event.body_preview ?? '').trim()
  const lines = preview.split('\n')
  const snippet = (lines[0] ?? '').slice(0, 160)
  const ellipsis = preview.length > snippet.length || lines.length > 1 ? '…' : ''
  const url = event.comment_url ?? event.url ?? ''
  return { snippet, ellipsis, url }
}

export function formatCommentHeader(event: OrchestratorEvent): string {
  const tag = eventTag(event)
  const kind = event.kind
  if (kind === 'pr_review_comment' || kind === 'pr_conversation_comment') {
    const ev = event as CommentEvent
    const where = ev.path ? ` at ${ev.path}:${ev.line ?? ''}` : ''
    return `PR ${tag} comment by ${ev.author ?? '?'}${where}:`
  }
  if (kind === 'issue_comment') {
    return `Issue ${tag} comment by ${(event as CommentEvent).author ?? '?'}:`
  }
  if (kind === 'pr_review_submitted') {
    const ev = event as ReviewEvent
    return `PR ${tag} review by ${ev.author ?? '?'} (${ev.state}):`
  }
  return ''
}

export function formatEvent(event: OrchestratorEvent): string {
  const kind = event.kind
  const tag = eventTag(event)

  if (kind === 'pr_ready_for_review') return `PR ${tag} ready for review: ${event.title ?? ''} — ${event.url ?? ''}`
  if (kind === 'pr_returned_to_draft') return `PR ${tag} returned to draft: ${event.title ?? ''} — ${event.url ?? ''}`
  if (kind === 'pr_merged') return `PR ${tag} merged: ${event.title ?? ''} — ${event.url ?? ''}`
  if (kind === 'pr_closed') return `PR ${tag} closed (not merged): ${event.title ?? ''} — ${event.url ?? ''}`

  if (kind === 'pr_review_comment' || kind === 'pr_conversation_comment') {
    const ev = event as CommentEvent
    const where = ev.path ? ` at ${ev.path}:${ev.line ?? ''}` : ''
    const { snippet, ellipsis, url } = commentSnippet(ev)
    return `PR ${tag} comment by ${ev.author ?? '?'}${where}: ${snippet}${ellipsis} — ${url}`
  }

  if (kind === 'issue_comment') {
    const ev = event as CommentEvent
    const { snippet, ellipsis, url } = commentSnippet(ev)
    return `Issue ${tag} comment by ${ev.author ?? '?'}: ${snippet}${ellipsis} — ${url}`
  }

  if (kind === 'pr_review_submitted') {
    const ev = event as ReviewEvent
    const snippetLines = (ev.body_preview ?? '').trim().split('\n').slice(0, 1)
    const snippetStr = snippetLines.length && snippetLines[0] ? ': ' + snippetLines[0].slice(0, 160) : ''
    return `PR ${tag} review by ${ev.author ?? '?'} (${ev.state})${snippetStr} — ${ev.review_url ?? ev.url ?? ''}`
  }

  if (kind === 'ci_transitioned') {
    const ev = event as CiEvent
    return `PR ${tag} CI: ${ev.from} → ${ev.to}`
  }

  if (kind === 'labels_changed') {
    const ev = event as LabelEvent
    const parts: string[] = []
    if (ev.added?.length) parts.push('+' + ev.added.join(','))
    if (ev.removed?.length) parts.push('-' + ev.removed.join(','))
    return `${tag} labels: ${parts.join(' ')}`
  }

  if (kind === 'issue_state_changed') {
    const ev = event as StateChangeEvent
    return `Issue ${tag} state: ${ev.from} → ${ev.to}`
  }

  if (kind === 'pr_has_existing_comments') {
    const ev = event as SeedEvent
    return `PR ${tag} BACKLOG: ${ev.review_comment_count ?? 0} review + ${ev.conversation_comment_count ?? 0} conversation comments existed before watch — scan manually: ${event.url ?? ''}`
  }

  if (kind === 'pr_has_existing_ci_state') {
    const ev = event as SeedEvent
    return `PR ${tag} CI already terminal at watch time: ${ev.ci_state} — ${event.url ?? ''}`
  }

  if (kind === 'issue_has_existing_comments') {
    const ev = event as SeedEvent
    return `Issue ${tag} BACKLOG: ${ev.comment_count ?? 0} comments existed before watch — scan manually: ${event.url ?? ''}`
  }

  if (kind === 'pr_no_linked_issues') {
    return `WARN PR ${tag} has no linked issues — events won't be routed. Add Closes #<issue> (or Fixes/Resolves) to the PR body: ${event.url ?? ''}`
  }

  if (kind === 'dispatcher_error') {
    const ev = event as SeedEvent
    const tb = (ev.stderr ?? '').trim().split('\n')
    const first = tb[tb.length - 1] || '(no detail)'
    return `DISPATCHER ERROR at ${ev.tick_utc ?? ''}: ${first}`
  }

  return `[${kind}] ${JSON.stringify(event).slice(0, 280)}`
}

// Convert an event into a renderable payload. Comment-style kinds use the
// multiline form (header + body + url); everything else is a oneline.
export function formatPayload(event: OrchestratorEvent): TaggedEventPayload {
  if (MULTILINE_COMMENT_KINDS.has(event.kind)) {
    const ev = event as CommentEvent & { review_url?: string }
    return {
      kind: 'multiline',
      header: formatCommentHeader(event),
      body: ev.body ?? '',
      url: ev.comment_url ?? ev.review_url ?? event.url ?? '',
    }
  }
  return { kind: 'oneline', text: formatEvent(event) }
}
