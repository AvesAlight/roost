import { describe, it, expect } from 'bun:test'
import { computePrEvents, computeIssueEvents } from '../scraper.js'
import type { PrSnap, IssueSnap } from '../types.js'
import type { PrSnapInternal, IssueSnapInternal } from '../scraper.js'

function basePrInternal(overrides: Partial<PrSnapInternal> = {}): PrSnapInternal {
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

function baseIssueInternal(overrides: Partial<IssueSnapInternal> = {}): IssueSnapInternal {
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

describe('computePrEvents — seeding tick (prevSnap = undefined)', () => {
  it('returns no events on a seeding tick', () => {
    const { events, nextWarnedNoLinked } = computePrEvents(basePrInternal(), undefined, new Set())
    expect(events).toEqual([])
    expect(nextWarnedNoLinked).toBe(false)
  })
})

describe('computePrEvents — new watch entry (prevSnap = null)', () => {
  it('emits pr_added_to_watch', () => {
    const { events } = computePrEvents(basePrInternal(), null, new Set())
    expect(events.some(e => e.kind === 'pr_added_to_watch')).toBe(true)
  })

  it('includes linked_issues in seed event when present', () => {
    const snap = basePrInternal({ linked_issues: [{ repo: 'org/repo', number: 5 }, { repo: 'org/repo', number: 6 }] })
    const { events } = computePrEvents(snap, null, new Set())
    const ev = events.find(e => e.kind === 'pr_added_to_watch') as { linked_issues?: Array<{ repo: string; number: number }> } | undefined
    expect(ev?.linked_issues).toEqual([{ repo: 'org/repo', number: 5 }, { repo: 'org/repo', number: 6 }])
  })

  it('emits pr_has_existing_comments when review comments exist', () => {
    const snap = basePrInternal({ seen_review_comment_ids: [1, 2] })
    const { events } = computePrEvents(snap, null, new Set())
    const ev = events.find(e => e.kind === 'pr_has_existing_comments') as { review_comment_count?: number } | undefined
    expect(ev?.review_comment_count).toBe(2)
  })

  it('emits pr_has_existing_comments when conversation comments exist', () => {
    const snap = basePrInternal({ seen_conversation_comment_ids: [3] })
    const { events } = computePrEvents(snap, null, new Set())
    const ev = events.find(e => e.kind === 'pr_has_existing_comments') as { conversation_comment_count?: number } | undefined
    expect(ev?.conversation_comment_count).toBe(1)
  })

  it('does not emit pr_has_existing_comments when no existing comments', () => {
    const { events } = computePrEvents(basePrInternal(), null, new Set())
    expect(events.some(e => e.kind === 'pr_has_existing_comments')).toBe(false)
  })

  it('emits pr_has_existing_ci_state for terminal CI', () => {
    const snap = basePrInternal({ ci_state: 'SUCCESS' })
    const { events } = computePrEvents(snap, null, new Set())
    expect(events.some(e => e.kind === 'pr_has_existing_ci_state')).toBe(true)
  })

  it('does not emit pr_has_existing_ci_state for PENDING CI', () => {
    const snap = basePrInternal({ ci_state: 'PENDING' })
    const { events } = computePrEvents(snap, null, new Set())
    expect(events.some(e => e.kind === 'pr_has_existing_ci_state')).toBe(false)
  })
})

describe('computePrEvents — normal diff (prevSnap = PrSnap)', () => {
  it('delegates to diffPr and returns change events', () => {
    const prev: PrSnap = { ...basePrInternal(), is_draft: true }
    const cur = basePrInternal({ is_draft: false })
    const { events } = computePrEvents(cur, prev, new Set())
    expect(events.some(e => e.kind === 'pr_ready_for_review')).toBe(true)
  })
})

describe('computeIssueEvents — seeding tick (prevIssue = undefined)', () => {
  it('returns no events on a seeding tick', () => {
    expect(computeIssueEvents(baseIssueInternal(), undefined, new Set())).toEqual([])
  })
})

describe('computeIssueEvents — new watch entry (prevIssue = null)', () => {
  it('emits issue_added_to_watch', () => {
    const events = computeIssueEvents(baseIssueInternal(), null, new Set())
    expect(events.some(e => e.kind === 'issue_added_to_watch')).toBe(true)
  })

  it('emits issue_has_existing_comments when comments exist', () => {
    const snap = baseIssueInternal({ seen_comment_ids: [1, 2, 3] })
    const events = computeIssueEvents(snap, null, new Set())
    const ev = events.find(e => e.kind === 'issue_has_existing_comments') as { comment_count?: number } | undefined
    expect(ev?.comment_count).toBe(3)
  })

  it('does not emit issue_has_existing_comments when no comments', () => {
    const events = computeIssueEvents(baseIssueInternal(), null, new Set())
    expect(events.some(e => e.kind === 'issue_has_existing_comments')).toBe(false)
  })
})

describe('computeIssueEvents — normal diff (prevIssue = IssueSnap)', () => {
  it('delegates to diffIssue and returns change events', () => {
    const prev: IssueSnap = { ...baseIssueInternal(), state: 'open' }
    const cur = baseIssueInternal({ state: 'closed' })
    const events = computeIssueEvents(cur, prev, new Set())
    expect(events.some(e => e.kind === 'issue_state_changed')).toBe(true)
  })
})
