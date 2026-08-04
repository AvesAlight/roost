import type {
  LinearEvent,
  LinearStateEvent,
  LinearCommentEvent,
  LinearThreadReplyEvent,
  LinearLabelEvent,
  LinearGithubPrLinkedEvent,
  LinearSeedEvent,
} from './diff.js'

// linear_comment renders as three lines (header + body + url); the rest render
// as a single line.
const COMMENT_KINDS: ReadonlySet<string> = new Set([
  'linear_comment',
])

function formatStateChange(ev: LinearStateEvent): string {
  return `Issue ${ev.identifier} state: ${ev.fromType ?? '?'} → ${ev.toType ?? '?'} — ${ev.url ?? ''}`
}

function formatLabels(ev: LinearLabelEvent): string {
  const parts: string[] = []
  if (ev.added.length) parts.push('+' + ev.added.join(','))
  if (ev.removed.length) parts.push('-' + ev.removed.join(','))
  return `Issue ${ev.identifier} labels: ${parts.join(' ')}`
}

function formatPrLinked(ev: LinearGithubPrLinkedEvent): string {
  return `Issue ${ev.identifier} PR linked: ${ev.pr_repo}#${ev.pr_number} — ${ev.pr_url}`
}

function formatThreadReply(ev: LinearThreadReplyEvent): string {
  const author = ev.author ?? '?'
  const parent = ev.parent_author ?? '?'
  return `Issue ${ev.identifier} thread reply by ${author} on ${parent}'s comment — ${ev.comment_url}`
}

function formatDisappeared(ev: LinearSeedEvent): string {
  return (
    `WARN Issue ${ev.identifier} no longer accessible — dropping from watch. ` +
    `Re-watch with \`watch linear ${ev.identifier}\` if the issue is restored, ` +
    `or \`unwatch linear ${ev.identifier}\` to drop the channel.`
  )
}

// `linear_issue_added_to_watch` is normally formatted inline in
// `LinearIssuesPlugin.runTick` because its text references the routing
// channels (not present on the event). This branch is a defensive fallback
// for any out-of-band caller — keeps the format surface complete.
function formatAddedToWatch(ev: LinearSeedEvent): string {
  return `now watching linear issue ${ev.identifier}`
}

function formatBacklogSeed(ev: LinearSeedEvent): string {
  return `Issue ${ev.identifier} BACKLOG: ${ev.comment_count ?? 0} comments existed before watch — scan manually: ${ev.url ?? ''}`
}

function formatCommentHeader(ev: LinearCommentEvent): string {
  return `Issue ${ev.identifier} comment by ${ev.author ?? '?'}:`
}

export function formatLinearEvent(event: LinearEvent): string {
  const kind = event.kind
  if (kind === 'linear_state_changed') return formatStateChange(event as LinearStateEvent)
  if (kind === 'linear_labels_changed') return formatLabels(event as LinearLabelEvent)
  if (kind === 'linear_github_pr_linked') return formatPrLinked(event as LinearGithubPrLinkedEvent)
  if (kind === 'linear_thread_reply') return formatThreadReply(event as LinearThreadReplyEvent)
  if (kind === 'linear_issue_disappeared') return formatDisappeared(event as LinearSeedEvent)
  if (kind === 'linear_issue_has_existing_comments') return formatBacklogSeed(event as LinearSeedEvent)
  if (kind === 'linear_issue_added_to_watch') return formatAddedToWatch(event as LinearSeedEvent)
  return `[${kind}] ${JSON.stringify(event).slice(0, 280)}`
}

// Render one Linear event as the text of an IRC message. linear_comment becomes
// three lines (header + body + url); everything else is a single line from
// formatLinearEvent.
export function formatLinearMessage(event: LinearEvent): string {
  if (COMMENT_KINDS.has(event.kind)) {
    const ev = event as LinearCommentEvent
    return [
      formatCommentHeader(ev),
      ev.body ?? '',
      ev.comment_url ?? ev.url ?? '',
    ].join('\n')
  }
  return formatLinearEvent(event)
}
