import { describe, it, expect } from 'bun:test'
import { formatLinearEvent, formatLinearPayload } from '../format.js'
import type {
  LinearStateEvent,
  LinearLabelEvent,
  LinearGithubPrLinkedEvent,
  LinearThreadReplyEvent,
  LinearCommentEvent,
  LinearSeedEvent,
} from '../diff.js'

const url = 'https://linear.app/teakio/issue/C-758/test'

describe('formatLinearEvent — oneline shapes (issue body examples)', () => {
  it('formats linear_state_changed', () => {
    const ev: LinearStateEvent = {
      kind: 'linear_state_changed',
      identifier: 'C-758',
      url,
      fromType: 'started',
      toType: 'completed',
      fromStatus: 'In Progress',
      toStatus: 'Done',
    }
    expect(formatLinearEvent(ev)).toBe(`Issue C-758 state: started → completed — ${url}`)
  })

  it('formats linear_labels_changed', () => {
    const ev: LinearLabelEvent = {
      kind: 'linear_labels_changed',
      identifier: 'C-758',
      added: ['urgent'],
      removed: ['triage'],
    }
    expect(formatLinearEvent(ev)).toBe('Issue C-758 labels: +urgent -triage')
  })

  it('formats linear_github_pr_linked', () => {
    const ev: LinearGithubPrLinkedEvent = {
      kind: 'linear_github_pr_linked',
      identifier: 'C-758',
      attachment_id: 'a1',
      pr_repo: 'GoCarrot/Carrot',
      pr_number: 2000,
      pr_url: 'https://github.com/GoCarrot/Carrot/pull/2000',
    }
    expect(formatLinearEvent(ev)).toBe(
      'Issue C-758 PR linked: GoCarrot/Carrot#2000 — https://github.com/GoCarrot/Carrot/pull/2000'
    )
  })

  it('formats linear_issue_disappeared (matches issue example wording + unwatch hint)', () => {
    const ev: LinearSeedEvent = { kind: 'linear_issue_disappeared', identifier: 'C-758' }
    expect(formatLinearEvent(ev)).toBe(
      'WARN Issue C-758 no longer accessible — dropping from watch. ' +
      'Re-watch with `watch linear C-758` if the issue is restored, ' +
      'or `unwatch linear C-758` to drop the channel.'
    )
  })

  it('formats linear_thread_reply with parent context', () => {
    const ev: LinearThreadReplyEvent = {
      kind: 'linear_thread_reply',
      identifier: 'C-758',
      comment_id: 'c2',
      comment_url: `${url}#comment-c2`,
      parent_comment_id: 'c1',
      parent_author: 'bob',
      parent_comment_url: `${url}#comment-c1`,
      author: 'alice',
    }
    expect(formatLinearEvent(ev)).toBe(
      `Issue C-758 thread reply by alice on bob's comment — ${url}#comment-c2`
    )
  })

  it('formats linear_thread_reply with null parent_author (parent outside snapshot window)', () => {
    const ev: LinearThreadReplyEvent = {
      kind: 'linear_thread_reply',
      identifier: 'C-758',
      comment_id: 'c2',
      comment_url: `${url}#comment-c2`,
      parent_comment_id: 'c1',
      parent_author: null,
      parent_comment_url: null,
      author: 'alice',
    }
    expect(formatLinearEvent(ev)).toBe(
      `Issue C-758 thread reply by alice on ?'s comment — ${url}#comment-c2`
    )
  })

  it('formats linear_issue_disappeared with both re-watch and unwatch hints', () => {
    const ev: LinearSeedEvent = { kind: 'linear_issue_disappeared', identifier: 'C-758' }
    const out = formatLinearEvent(ev)
    expect(out).toContain('watch linear C-758')
    expect(out).toContain('unwatch linear C-758')
  })

  it('formats linear_issue_added_to_watch via the fallback branch (defensive)', () => {
    const ev: LinearSeedEvent = { kind: 'linear_issue_added_to_watch', identifier: 'C-758' }
    expect(formatLinearEvent(ev)).toBe('now watching linear issue C-758')
  })

  it('formats linear_issue_has_existing_comments', () => {
    const ev: LinearSeedEvent = {
      kind: 'linear_issue_has_existing_comments',
      identifier: 'C-758',
      url,
      comment_count: 3,
    }
    expect(formatLinearEvent(ev)).toBe(
      `Issue C-758 BACKLOG: 3 comments existed before watch — scan manually: ${url}`
    )
  })
})

describe('formatLinearPayload', () => {
  it('returns multiline shape for linear_comment', () => {
    const ev: LinearCommentEvent = {
      kind: 'linear_comment',
      identifier: 'C-758',
      url,
      comment_id: 'c1',
      comment_url: `${url}#comment-c1`,
      author: 'alice',
      body: 'looks good\nshipping',
      body_preview: 'looks good\nshipping',
    }
    const payload = formatLinearPayload(ev)
    expect(payload.kind).toBe('multiline')
    if (payload.kind !== 'multiline') throw new Error('expected multiline')
    expect(payload.header).toBe('Issue C-758 comment by alice:')
    expect(payload.body).toBe('looks good\nshipping')
    expect(payload.url).toBe(`${url}#comment-c1`)
  })

  it('returns oneline shape for non-comment events', () => {
    const ev: LinearLabelEvent = { kind: 'linear_labels_changed', identifier: 'C-758', added: ['x'], removed: [] }
    const payload = formatLinearPayload(ev)
    expect(payload.kind).toBe('oneline')
  })
})
