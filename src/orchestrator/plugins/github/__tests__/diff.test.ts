import { describe, it, expect } from 'bun:test'
import { diffPr, diffIssue, shouldPush, formatCommentEvent } from '../diff.js'
import type { PrSnap, IssueSnap } from '../types.js'
import type { PrSnapInternal, IssueSnapInternal } from '../snapshot.js'

function basePrSnap(overrides: Partial<PrSnapInternal> = {}): PrSnapInternal {
  return {
    repo: 'org/repo',
    number: 10,
    title: 'My PR',
    url: 'https://github.com/org/repo/pull/10',
    head_ref: 'feat/foo',
    head_oid: 'abc',
    is_draft: false,
    merged: false,
    state: 'OPEN',
    labels: [],
    ci_state: null,
    linked_issues: [],
    seen_review_comment_ids: [],
    seen_conversation_comment_ids: [],
    seen_review_ids: [],
    _review_comments_by_id: {},
    _conversation_comments_by_id: {},
    _reviews_by_id: {},
    ...overrides,
  }
}

function baseIssueSnap(overrides: Partial<IssueSnapInternal> = {}): IssueSnapInternal {
  return {
    repo: 'org/repo',
    number: 20,
    title: 'My Issue',
    url: 'https://github.com/org/repo/issues/20',
    state: 'open',
    labels: [],
    seen_comment_ids: [],
    _comments_by_id: {},
    ...overrides,
  }
}

describe('diffPr', () => {
  it('emits pr_ready_for_review when draft → ready', () => {
    const prev: PrSnap = { ...basePrSnap({ is_draft: true }) }
    const cur = basePrSnap({ is_draft: false })
    const events = diffPr(prev, cur)
    expect(events.some(e => e.kind === 'pr_ready_for_review')).toBe(true)
  })

  it('emits pr_merged when not merged → merged', () => {
    const prev: PrSnap = { ...basePrSnap() }
    const cur = basePrSnap({ merged: true })
    const events = diffPr(prev, cur)
    expect(events.some(e => e.kind === 'pr_merged')).toBe(true)
  })

  it('emits pr_closed when OPEN → CLOSED and not merged', () => {
    const prev: PrSnap = { ...basePrSnap({ state: 'OPEN' }) }
    const cur = basePrSnap({ state: 'CLOSED', merged: false })
    const events = diffPr(prev, cur)
    expect(events.some(e => e.kind === 'pr_closed')).toBe(true)
  })

  it('emits labels_changed for new labels', () => {
    const prev: PrSnap = { ...basePrSnap() }
    const cur = basePrSnap({ labels: ['phase:review'] })
    const events = diffPr(prev, cur)
    const ev = events.find(e => e.kind === 'labels_changed') as { added: string[] } | undefined
    expect(ev?.added).toEqual(['phase:review'])
  })

  it('emits ci_transitioned when CI changes without head change', () => {
    const prev: PrSnap = { ...basePrSnap({ ci_state: 'PENDING' }) }
    const cur = basePrSnap({ ci_state: 'SUCCESS', head_oid: 'abc' })
    const events = diffPr(prev, cur)
    const ev = events.find(e => e.kind === 'ci_transitioned') as { from: string; to: string } | undefined
    expect(ev?.from).toBe('PENDING')
    expect(ev?.to).toBe('SUCCESS')
  })

  it('emits ci_transitioned on new push with terminal CI', () => {
    const prev: PrSnap = { ...basePrSnap({ head_oid: 'abc', ci_state: 'SUCCESS' }) }
    const cur = basePrSnap({ head_oid: 'def', ci_state: 'SUCCESS' })
    const events = diffPr(prev, cur)
    const ev = events.find(e => e.kind === 'ci_transitioned') as { from: string; to: string } | undefined
    expect(ev).toBeDefined()
    expect(ev?.from).toBe('PENDING')
    expect(ev?.to).toBe('SUCCESS')
  })

  it('emits new review comments', () => {
    const prev: PrSnap = { ...basePrSnap() }
    const comment = { id: 1, html_url: 'https://example.com', user: { login: 'alice' }, body: 'nice' }
    const cur = basePrSnap({
      seen_review_comment_ids: [1],
      _review_comments_by_id: { 1: comment },
    })
    const events = diffPr(prev, cur)
    expect(events.some(e => e.kind === 'pr_review_comment')).toBe(true)
  })

  it('does not re-emit seen review comments', () => {
    const comment = { id: 1, html_url: 'https://example.com', user: { login: 'alice' }, body: 'nice' }
    const prev: PrSnap = { ...basePrSnap({ seen_review_comment_ids: [1] }) }
    const cur = basePrSnap({
      seen_review_comment_ids: [1],
      _review_comments_by_id: { 1: comment },
    })
    const events = diffPr(prev, cur)
    expect(events.some(e => e.kind === 'pr_review_comment')).toBe(false)
  })
})

describe('diffIssue', () => {
  it('emits issue_state_changed when state changes', () => {
    const prev: IssueSnap = { ...baseIssueSnap({ state: 'open' }) }
    const cur = baseIssueSnap({ state: 'closed' })
    const events = diffIssue(prev, cur)
    const ev = events.find(e => e.kind === 'issue_state_changed') as { from: string; to: string } | undefined
    expect(ev?.from).toBe('open')
    expect(ev?.to).toBe('closed')
  })

  it('emits new issue comments', () => {
    const prev: IssueSnap = { ...baseIssueSnap() }
    const comment = { id: 5, html_url: 'https://example.com', user: { login: 'bob' }, body: 'hello' }
    const cur = baseIssueSnap({
      seen_comment_ids: [5],
      _comments_by_id: { 5: comment },
    })
    const events = diffIssue(prev, cur)
    expect(events.some(e => e.kind === 'issue_comment')).toBe(true)
  })

  it('does not re-emit seen comments', () => {
    const comment = { id: 5, html_url: 'https://example.com', user: { login: 'bob' }, body: 'hello' }
    const prev: IssueSnap = { ...baseIssueSnap({ seen_comment_ids: [5] }) }
    const cur = baseIssueSnap({
      seen_comment_ids: [5],
      _comments_by_id: { 5: comment },
    })
    const events = diffIssue(prev, cur)
    expect(events.some(e => e.kind === 'issue_comment')).toBe(false)
  })
})

describe('shouldPush', () => {
  it('skips pr_added_to_watch', () => {
    expect(shouldPush({ kind: 'pr_added_to_watch' })).toBe(false)
  })

  it('pushes pr_merged', () => {
    expect(shouldPush({ kind: 'pr_merged' })).toBe(true)
  })

  it('pushes ci_transitioned to SUCCESS', () => {
    expect(shouldPush({ kind: 'ci_transitioned', from: 'PENDING', to: 'SUCCESS', head_oid: null })).toBe(true)
  })

  it('does not push ci_transitioned to PENDING', () => {
    expect(shouldPush({ kind: 'ci_transitioned', from: null, to: 'PENDING', head_oid: null })).toBe(false)
  })

  it('pushes labels_changed with meaningful label prefix', () => {
    expect(shouldPush({ kind: 'labels_changed', subject: 'pr', added: ['phase:review'], removed: [] })).toBe(true)
  })

  it('does not push labels_changed with unmeaningful label', () => {
    expect(shouldPush({ kind: 'labels_changed', subject: 'pr', added: ['bug'], removed: [] })).toBe(false)
  })

  it('pushes issue_state_changed to closed', () => {
    expect(shouldPush({ kind: 'issue_state_changed', from: 'open', to: 'closed' })).toBe(true)
  })

  it('does not push issue_state_changed to open', () => {
    expect(shouldPush({ kind: 'issue_state_changed', from: 'closed', to: 'open' })).toBe(false)
  })
})

describe('formatCommentEvent', () => {
  it('includes full body field', () => {
    const c = { id: 1, html_url: 'https://example.com', user: { login: 'alice' }, body: 'Line one\nLine two' }
    const ev = formatCommentEvent(c, { kind: 'issue_comment', repo: 'org/repo', issue: 47, url: 'https://example.com/i/47' })
    expect(ev.body).toBe('Line one\nLine two')
    expect(ev.body_preview).toBe('Line one\nLine two')
  })

  it('detects worker prefix in body', () => {
    const c = { id: 2, body: '[worker-154] doing stuff', user: { login: 'human' } }
    const ev = formatCommentEvent(c, { kind: 'issue_comment', url: 'https://example.com' })
    expect(ev.is_worker_reply).toBe(true)
  })

  it('detects agent login', () => {
    const c = { id: 3, body: 'hello', user: { login: 'TeakBuilds' } }
    const ev = formatCommentEvent(c, { kind: 'issue_comment', url: 'https://example.com', agentLogins: new Set(['TeakBuilds']) })
    expect(ev.is_worker_reply).toBe(true)
  })
})
