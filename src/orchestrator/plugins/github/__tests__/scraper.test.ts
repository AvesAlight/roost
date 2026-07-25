import { describe, it, expect } from 'bun:test'
import { computePrEvents, computeIssueEvents, buildPrSnapshot, buildIssueSnapshot } from '../scraper.js'
import { BACKLOG_COMMENT_CAP } from '../diff.js'
import type { PrSnap, IssueSnap } from '../types.js'
import type { PrSnapInternal, IssueSnapInternal } from '../scraper.js'
import type { GhPrNode, GhIssueNode } from '../github-api.js'

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

  it('posts pre-watch review comments as real comment events, framed by pr_has_existing_comments', () => {
    const snap = basePrInternal({
      seen_review_comment_ids: [1, 2],
      _review_comments_by_id: {
        1: { id: 1, html_url: 'rc/1', user: { login: 'alice' }, body: 'nit one', path: 'a.ts', line: 10 },
        2: { id: 2, html_url: 'rc/2', user: { login: 'bob' }, body: 'nit two', path: 'b.ts', line: 20 },
      },
    })
    const { events } = computePrEvents(snap, null, new Set())
    const framing = events.find(e => e.kind === 'pr_has_existing_comments') as { backlog_total?: number; backlog_posted?: number } | undefined
    expect(framing?.backlog_total).toBe(2)
    expect(framing?.backlog_posted).toBe(2)
    const comments = events.filter(e => e.kind === 'pr_review_comment') as Array<{ body: string; comment_url?: string; author?: string }>
    expect(comments).toHaveLength(2)
    expect(comments.map(c => c.body)).toEqual(['nit one', 'nit two'])
    expect(comments.every(c => c.comment_url?.startsWith('rc/'))).toBe(true)
  })

  it('posts pre-watch conversation comments as real comment events', () => {
    const snap = basePrInternal({
      seen_conversation_comment_ids: [3],
      _conversation_comments_by_id: { 3: { id: 3, html_url: 'c/3', user: { login: 'carol' }, body: 'hello' } },
    })
    const { events } = computePrEvents(snap, null, new Set())
    const framing = events.find(e => e.kind === 'pr_has_existing_comments') as { backlog_total?: number } | undefined
    expect(framing?.backlog_total).toBe(1)
    const comments = events.filter(e => e.kind === 'pr_conversation_comment') as Array<{ body: string }>
    expect(comments.map(c => c.body)).toEqual(['hello'])
  })

  it('emits the framing line before the backlog comment events (header-then-dump)', () => {
    const snap = basePrInternal({
      seen_conversation_comment_ids: [3],
      _conversation_comments_by_id: { 3: { id: 3, html_url: 'c/3', user: { login: 'carol' }, body: 'hello' } },
    })
    const { events } = computePrEvents(snap, null, new Set())
    const framingIdx = events.findIndex(e => e.kind === 'pr_has_existing_comments')
    const firstCommentIdx = events.findIndex(e => e.kind === 'pr_conversation_comment')
    expect(framingIdx).toBeGreaterThanOrEqual(0)
    expect(framingIdx).toBeLessThan(firstCommentIdx)
  })

  it('merges review/conversation/review backlog by id ascending (chronological)', () => {
    // ids interleaved across types: review comment 100, conversation 200, review 300
    const snap = basePrInternal({
      seen_review_comment_ids: [100],
      seen_conversation_comment_ids: [200],
      seen_review_ids: [300],
      _review_comments_by_id: { 100: { id: 100, html_url: 'rc/100', user: { login: 'a' }, body: 'rc' } },
      _conversation_comments_by_id: { 200: { id: 200, html_url: 'c/200', user: { login: 'b' }, body: 'conv' } },
      _reviews_by_id: { 300: { id: 300, html_url: 'r/300', user: { login: 'c' }, body: 'rev', state: 'APPROVED' } },
    })
    const { events } = computePrEvents(snap, null, new Set())
    const backlogKinds = ['pr_review_comment', 'pr_conversation_comment', 'pr_review_submitted']
    const order = events.filter(e => backlogKinds.includes(e.kind)).map(e => e.kind)
    expect(order).toEqual(['pr_review_comment', 'pr_conversation_comment', 'pr_review_submitted'])
    const framing = events.find(e => e.kind === 'pr_has_existing_comments') as { backlog_total?: number } | undefined
    expect(framing?.backlog_total).toBe(3)
  })

  it('does not emit pr_has_existing_comments or backlog events when none', () => {
    const { events } = computePrEvents(basePrInternal(), null, new Set())
    expect(events.some(e => e.kind === 'pr_has_existing_comments')).toBe(false)
    expect(events.some(e => ['pr_review_comment', 'pr_conversation_comment', 'pr_review_submitted'].includes(e.kind))).toBe(false)
  })

  it('caps the backlog to most-recent-K and records elision on the framing line', () => {
    const total = BACKLOG_COMMENT_CAP + 5
    const ids = Array.from({ length: total }, (_, i) => i + 1)
    const byId: Record<number, { id: number; html_url: string; user: { login: string }; body: string }> = {}
    for (const id of ids) byId[id] = { id, html_url: `c/${id}`, user: { login: 'u' }, body: `body ${id}` }
    const snap = basePrInternal({ seen_conversation_comment_ids: ids, _conversation_comments_by_id: byId })
    const { events } = computePrEvents(snap, null, new Set())
    const framing = events.find(e => e.kind === 'pr_has_existing_comments') as { backlog_total?: number; backlog_posted?: number } | undefined
    expect(framing?.backlog_total).toBe(total)
    expect(framing?.backlog_posted).toBe(BACKLOG_COMMENT_CAP)
    const comments = events.filter(e => e.kind === 'pr_conversation_comment') as Array<{ body: string }>
    expect(comments).toHaveLength(BACKLOG_COMMENT_CAP)
    // most-recent-K: the kept ids are the last BACKLOG_COMMENT_CAP, in ascending order
    const keptBodies = comments.map(c => c.body)
    const expectedFirst = `body ${ids[total - BACKLOG_COMMENT_CAP]}`
    expect(keptBodies[0]).toBe(expectedFirst)
    expect(keptBodies[keptBodies.length - 1]).toBe(`body ${ids[ids.length - 1]}`)
  })

  it('emits pr_has_existing_ci_state for terminal CI', () => {
    const snap = basePrInternal({ ci_state: 'SUCCESS' })
    const { events } = computePrEvents(snap, null, new Set())
    expect(events.some(e => e.kind === 'pr_has_existing_ci_state')).toBe(true)
  })

  it('carries head_oid on pr_has_existing_ci_state', () => {
    const snap = basePrInternal({ ci_state: 'SUCCESS', head_oid: 'deadbeef' })
    const { events } = computePrEvents(snap, null, new Set())
    const ev = events.find(e => e.kind === 'pr_has_existing_ci_state') as { head_oid?: string | null } | undefined
    expect(ev?.head_oid).toBe('deadbeef')
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

  it('posts pre-watch issue comments as real comment events, framed by issue_has_existing_comments', () => {
    const snap = baseIssueInternal({
      seen_comment_ids: [1, 2, 3],
      _comments_by_id: {
        1: { id: 1, html_url: 'c/1', user: { login: 'x' }, body: 'a' },
        2: { id: 2, html_url: 'c/2', user: { login: 'y' }, body: 'b' },
        3: { id: 3, html_url: 'c/3', user: { login: 'z' }, body: 'c' },
      },
    })
    const events = computeIssueEvents(snap, null, new Set())
    const framing = events.find(e => e.kind === 'issue_has_existing_comments') as { backlog_total?: number; backlog_posted?: number } | undefined
    expect(framing?.backlog_total).toBe(3)
    expect(framing?.backlog_posted).toBe(3)
    const comments = events.filter(e => e.kind === 'issue_comment') as Array<{ body: string; comment_url?: string }>
    expect(comments.map(c => c.body)).toEqual(['a', 'b', 'c'])
    expect(comments.every(c => c.comment_url?.startsWith('c/'))).toBe(true)
  })

  it('does not emit issue_has_existing_comments or backlog events when no comments', () => {
    const events = computeIssueEvents(baseIssueInternal(), null, new Set())
    expect(events.some(e => e.kind === 'issue_has_existing_comments')).toBe(false)
    expect(events.some(e => e.kind === 'issue_comment')).toBe(false)
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

// The batched GraphQL read hands raw nodes to buildPrSnapshot/buildIssueSnapshot,
// which must reproduce the REST-shaped internal snapshot the diff keys on — so
// PrSnap/IssueSnap and diff.ts stay unchanged (no state migration). These pin the
// load-bearing field mappings: GraphQL databaseId → the numeric ids diff keys on,
// author.login → user.login, url → html_url, rollup → ci_state, and issue state
// lower-cased to the REST 'open'/'closed' the diff and shouldPush compare against.
describe('buildPrSnapshot — GraphQL node → internal snapshot', () => {
  const node: GhPrNode = {
    number: 10, title: 'PR ten', url: 'https://github.com/org/repo/pull/10',
    isDraft: true, merged: false, state: 'OPEN', headRefName: 'feat/x', headRefOid: 'sha1',
    labels: { nodes: [{ name: 'bug' }, { name: 'area/api' }] },
    statusRollup: { nodes: [{ commit: { statusCheckRollup: { state: 'ERROR' } } }] },
    closingIssuesReferences: { nodes: [
      { number: 7, repository: { nameWithOwner: 'org/repo' } },
      { number: 3, repository: { nameWithOwner: 'org/other' } },
    ] },
    reviews: { totalCount: 1, nodes: [{ databaseId: 900, url: 'r/900', author: { login: 'rev' }, body: 'lgtm', state: 'APPROVED' }] },
    comments: { totalCount: 1, nodes: [{ databaseId: 500, url: 'c/500', author: { login: 'carol' }, body: 'hi' }] },
    reviewThreads: { totalCount: 1, nodes: [{ comments: { nodes: [
      { databaseId: 100, url: 'rc/100', author: { login: 'alice' }, body: 'nit', path: 'a.ts', line: 12, originalLine: 11 },
    ] } }] },
  }

  it('maps identifiers, CI rollup, and linked issues onto the REST-shaped snapshot', () => {
    const snap = buildPrSnapshot('org/repo', 10, node)
    expect(snap.repo).toBe('org/repo')
    expect(snap.number).toBe(10)
    expect(snap.is_draft).toBe(true)
    expect(snap.merged).toBe(false)
    expect(snap.state).toBe('OPEN')  // GraphQL PR state stays uppercase — the REST-shaped value diff.ts keys on
    expect(snap.head_ref).toBe('feat/x')
    expect(snap.head_oid).toBe('sha1')
    expect(snap.labels).toEqual(['area/api', 'bug'])  // sorted
    expect(snap.ci_state).toBe('FAILURE')  // rollup ERROR folds into FAILURE
    // closingIssuesReferences sorted by (repo, number).
    expect(snap.linked_issues).toEqual([{ repo: 'org/other', number: 3 }, { repo: 'org/repo', number: 7 }])
  })

  it('maps databaseId → the numeric seen-ids the diff keys on, across all three comment streams', () => {
    const snap = buildPrSnapshot('org/repo', 10, node) as PrSnapInternal
    expect(snap.seen_review_comment_ids).toEqual([100])
    expect(snap.seen_conversation_comment_ids).toEqual([500])
    expect(snap.seen_review_ids).toEqual([900])
    // Internal indexes carry the REST-shaped fields (databaseId → id, url → html_url, author.login → user.login).
    expect(snap._review_comments_by_id[100]).toMatchObject({ id: 100, html_url: 'rc/100', user: { login: 'alice' }, path: 'a.ts', line: 12, original_line: 11 })
    expect(snap._conversation_comments_by_id[500]).toMatchObject({ id: 500, user: { login: 'carol' } })
    expect(snap._reviews_by_id[900]).toMatchObject({ id: 900, state: 'APPROVED', user: { login: 'rev' } })
  })

  it('an empty node yields empty streams and a null CI state (no false terminal)', () => {
    const snap = buildPrSnapshot('org/repo', 1, { number: 1, state: 'OPEN' })
    expect(snap.ci_state).toBeNull()
    expect(snap.linked_issues).toEqual([])
    expect(snap.seen_review_comment_ids).toEqual([])
  })
})

describe('buildIssueSnapshot — GraphQL node → internal snapshot', () => {
  it('lower-cases state to the REST value and maps comment databaseIds', () => {
    const node: GhIssueNode = {
      number: 20, title: 'Issue', url: 'https://github.com/org/repo/issues/20',
      state: 'CLOSED', labels: { nodes: [{ name: 'wontfix' }] },
      comments: { totalCount: 2, nodes: [
        { databaseId: 11, url: 'c/11', author: { login: 'x' }, body: 'a' },
        { databaseId: 22, url: 'c/22', author: { login: 'y' }, body: 'b' },
      ] },
    }
    const snap = buildIssueSnapshot('org/repo', 20, node) as IssueSnapInternal
    expect(snap.state).toBe('closed')  // lower-cased to match REST 'open'/'closed' the diff + shouldPush compare
    expect(snap.labels).toEqual(['wontfix'])
    expect(snap.seen_comment_ids).toEqual([11, 22])
    expect(snap._comments_by_id[22]).toMatchObject({ id: 22, user: { login: 'y' } })
  })
})
