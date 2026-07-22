import { describe, it, expect } from 'bun:test'
import { diffPr, diffIssue, shouldPush, formatCommentEvent } from '../diff.js'
import { computePrEvents } from '../scraper.js'
import type { PrSnap, IssueSnap } from '../types.js'
import type { PrSnapInternal, IssueSnapInternal } from '../scraper.js'

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
    const ev = events.find(e => e.kind === 'ci_transitioned') as { from: string; to: string; head_oid?: string | null } | undefined
    expect(ev?.from).toBe('PENDING')
    expect(ev?.to).toBe('SUCCESS')
    expect(ev?.head_oid).toBe('abc')
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

describe('diffPr — pr_no_linked_issues', () => {
  it('emits pr_no_linked_issues when linked_issues is empty and not yet warned', () => {
    const prev: PrSnap = { ...basePrSnap({ linked_issues: [], warned_no_linked: false }) }
    const cur = basePrSnap({ linked_issues: [] })
    const events = diffPr(prev, cur)
    expect(events.some(e => e.kind === 'pr_no_linked_issues')).toBe(true)
  })

  it('does not re-emit pr_no_linked_issues when already warned', () => {
    const prev: PrSnap = { ...basePrSnap({ linked_issues: [], warned_no_linked: true }) }
    const cur = basePrSnap({ linked_issues: [] })
    const events = diffPr(prev, cur)
    expect(events.some(e => e.kind === 'pr_no_linked_issues')).toBe(false)
  })

  it('does not emit pr_no_linked_issues when linked_issues is non-empty', () => {
    const prev: PrSnap = { ...basePrSnap({ linked_issues: [] }) }
    const cur = basePrSnap({ linked_issues: [{ repo: 'org/repo', number: 42 }] })
    const events = diffPr(prev, cur)
    expect(events.some(e => e.kind === 'pr_no_linked_issues')).toBe(false)
  })

  it('warns again after linked_issues cleared ([N] → [] transition)', () => {
    // prev had linked issues so warned_no_linked was reset to false
    const prev: PrSnap = { ...basePrSnap({ linked_issues: [{ repo: 'org/repo', number: 42 }], warned_no_linked: false }) }
    const cur = basePrSnap({ linked_issues: [] })
    const events = diffPr(prev, cur)
    expect(events.some(e => e.kind === 'pr_no_linked_issues')).toBe(true)
  })

  it('treats absent warned_no_linked as false (warns on upgrade)', () => {
    const prev: PrSnap = { ...basePrSnap({ linked_issues: [] }) }
    // warned_no_linked is undefined (absent from old snapshot)
    delete (prev as Partial<PrSnap>).warned_no_linked
    const cur = basePrSnap({ linked_issues: [] })
    const events = diffPr(prev, cur)
    expect(events.some(e => e.kind === 'pr_no_linked_issues')).toBe(true)
  })
})

describe('computePrEvents — pr_no_linked_issues', () => {
  it('emits pr_no_linked_issues and sets nextWarnedNoLinked for new PR with empty linked_issues', () => {
    const snap = basePrSnap({ linked_issues: [] })
    const { events, nextWarnedNoLinked } = computePrEvents(snap, null, new Set())
    expect(events.some(e => e.kind === 'pr_no_linked_issues')).toBe(true)
    expect(nextWarnedNoLinked).toBe(true)
  })

  it('does not emit pr_no_linked_issues and clears flag for new PR with linked issues', () => {
    const snap = basePrSnap({ linked_issues: [{ repo: 'org/repo', number: 5 }] })
    const { events, nextWarnedNoLinked } = computePrEvents(snap, null, new Set())
    expect(events.some(e => e.kind === 'pr_no_linked_issues')).toBe(false)
    expect(nextWarnedNoLinked).toBe(false)
  })

  it('does not emit for seeding tick (prevSnap undefined), nextWarnedNoLinked false', () => {
    const snap = basePrSnap({ linked_issues: [] })
    const { events, nextWarnedNoLinked } = computePrEvents(snap, undefined, new Set())
    expect(events).toHaveLength(0)
    expect(nextWarnedNoLinked).toBe(false)
  })
})

describe('shouldPush — pr_no_linked_issues', () => {
  it('pushes pr_no_linked_issues', () => {
    expect(shouldPush({ kind: 'pr_no_linked_issues', pr: 5 })).toBe(true)
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
