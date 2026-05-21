import { describe, it, expect } from 'bun:test'
import type { LinearIssueSnap } from '../types.js'
import {
  buildLinearSnap,
  diffLinearIssue,
  parseGithubPrUrl,
  selectGithubAttachments,
  seedLinearIssue,
  type RawLinearIssue,
  type RawLinearComment,
  type LinearStateEvent,
  type LinearLabelEvent,
  type LinearCommentEvent,
  type LinearThreadReplyEvent,
  type LinearGithubPrLinkedEvent,
  type LinearSeedEvent,
} from '../diff.js'

function baseSnap(overrides: Partial<LinearIssueSnap> = {}): LinearIssueSnap {
  return {
    id: 'uuid-1',
    identifier: 'C-758',
    title: 'Test issue',
    url: 'https://linear.app/teakio/issue/C-758/test',
    status: 'In Progress',
    statusType: 'started',
    labels: [],
    seen_comment_ids: [],
    seen_github_attachment_ids: [],
    ...overrides,
  }
}

function rawIssue(overrides: Partial<RawLinearIssue> = {}): RawLinearIssue {
  return {
    id: 'uuid-1',
    identifier: 'C-758',
    title: 'Test issue',
    url: 'https://linear.app/teakio/issue/C-758/test',
    state: { type: 'started', name: 'In Progress' },
    labels: { nodes: [] },
    comments: { nodes: [] },
    attachments: { nodes: [] },
    ...overrides,
  }
}

// ---- parseGithubPrUrl ----------------------------------------------------

describe('parseGithubPrUrl (fail-closed)', () => {
  it('matches canonical pull/<N>', () => {
    expect(parseGithubPrUrl('https://github.com/GoCarrot/Carrot/pull/2000')).toEqual({
      repo: 'GoCarrot/Carrot',
      number: 2000,
    })
  })

  it('matches pull/<N> with trailing fragment', () => {
    expect(parseGithubPrUrl('https://github.com/Org/Repo/pull/1#discussion_r1')).toEqual({
      repo: 'Org/Repo',
      number: 1,
    })
  })

  it('rejects pulls/<N> (fail-closed per lead direction)', () => {
    expect(parseGithubPrUrl('https://github.com/Org/Repo/pulls/1')).toBeNull()
  })

  it('rejects non-github hosts', () => {
    expect(parseGithubPrUrl('https://example.com/Org/Repo/pull/1')).toBeNull()
  })

  it('rejects nulls and unrelated URLs', () => {
    expect(parseGithubPrUrl(null)).toBeNull()
    expect(parseGithubPrUrl('https://github.com/Org/Repo/issues/1')).toBeNull()
  })
})

describe('selectGithubAttachments', () => {
  it('picks github-sourceType + parses pull URL', () => {
    expect(selectGithubAttachments([
      { id: 'a1', sourceType: 'github', url: 'https://github.com/GoCarrot/Carrot/pull/2000', title: null },
      { id: 'a2', sourceType: 'figma', url: 'https://figma.com/x', title: null },
      { id: 'a3', sourceType: 'github', url: 'https://github.com/Org/Repo/issues/1', title: null },
    ])).toEqual([
      { id: 'a1', pr_repo: 'GoCarrot/Carrot', pr_number: 2000, pr_url: 'https://github.com/GoCarrot/Carrot/pull/2000' },
    ])
  })
})

// ---- buildLinearSnap -----------------------------------------------------

describe('buildLinearSnap', () => {
  it('builds a normalized snapshot from raw GraphQL', () => {
    const snap = buildLinearSnap(rawIssue({
      labels: { nodes: [{ name: 'urgent' }, { name: 'bug' }] },
      comments: { nodes: [
        { id: 'c1', body: 'hi', user: { name: 'alice' }, parent: null },
        { id: 'c2', body: 'reply', user: { name: 'bob' }, parent: { id: 'c1' } },
      ] },
      attachments: { nodes: [
        { id: 'a1', sourceType: 'github', url: 'https://github.com/Org/Repo/pull/5', title: null },
        { id: 'a2', sourceType: 'figma', url: 'https://figma.com/x', title: null },
      ] },
    }))
    expect(snap.identifier).toBe('C-758')
    expect(snap.labels).toEqual(['bug', 'urgent'])               // sorted
    expect(snap.seen_comment_ids.sort()).toEqual(['c1', 'c2'])  // both top + threaded
    expect(snap.seen_github_attachment_ids).toEqual(['a1'])      // figma excluded
  })
})

// ---- diffLinearIssue: state changes --------------------------------------

describe('diffLinearIssue — state', () => {
  it('emits linear_state_changed on statusType transition', () => {
    const prev = baseSnap({ statusType: 'started', status: 'In Progress' })
    const cur = baseSnap({ statusType: 'completed', status: 'Done' })
    const events = diffLinearIssue(prev, cur, { comments: [], githubAttachments: [] })
    const ev = events.find(e => e.kind === 'linear_state_changed') as LinearStateEvent | undefined
    expect(ev).toBeDefined()
    expect(ev?.fromType).toBe('started')
    expect(ev?.toType).toBe('completed')
    expect(ev?.fromStatus).toBe('In Progress')
    expect(ev?.toStatus).toBe('Done')
  })

  it('no-op when statusType is unchanged', () => {
    const prev = baseSnap({ statusType: 'started' })
    const cur = baseSnap({ statusType: 'started' })
    const events = diffLinearIssue(prev, cur, { comments: [], githubAttachments: [] })
    expect(events.find(e => e.kind === 'linear_state_changed')).toBeUndefined()
  })
})

// ---- diffLinearIssue: labels ---------------------------------------------

describe('diffLinearIssue — labels', () => {
  it('emits +/- correctly', () => {
    const prev = baseSnap({ labels: ['triage', 'urgent'] })
    const cur = baseSnap({ labels: ['urgent', 'shipped'] })
    const events = diffLinearIssue(prev, cur, { comments: [], githubAttachments: [] })
    const ev = events.find(e => e.kind === 'linear_labels_changed') as LinearLabelEvent | undefined
    expect(ev?.added).toEqual(['shipped'])
    expect(ev?.removed).toEqual(['triage'])
  })

  it('no event when labels unchanged', () => {
    const prev = baseSnap({ labels: ['a', 'b'] })
    const cur = baseSnap({ labels: ['a', 'b'] })
    const events = diffLinearIssue(prev, cur, { comments: [], githubAttachments: [] })
    expect(events.find(e => e.kind === 'linear_labels_changed')).toBeUndefined()
  })
})

// ---- diffLinearIssue: comments & thread replies --------------------------

describe('diffLinearIssue — comments', () => {
  it('emits linear_comment for top-level (parent==null)', () => {
    const prev = baseSnap({ seen_comment_ids: [] })
    const cur = baseSnap({ seen_comment_ids: ['c1'] })
    const comments: RawLinearComment[] = [{ id: 'c1', body: 'hello', user: { name: 'alice' }, parent: null }]
    const events = diffLinearIssue(prev, cur, { comments, githubAttachments: [] })
    const ev = events.find(e => e.kind === 'linear_comment') as LinearCommentEvent | undefined
    expect(ev).toBeDefined()
    expect(ev?.author).toBe('alice')
    expect(ev?.body).toBe('hello')
    expect(ev?.comment_url).toMatch(/#comment-c1$/)
  })

  it('emits linear_thread_reply for parent != null (option a chosen)', () => {
    const prev = baseSnap({ seen_comment_ids: ['c1'] })
    const cur = baseSnap({ seen_comment_ids: ['c1', 'c2'] })
    const comments: RawLinearComment[] = [
      { id: 'c1', body: 'parent', user: { name: 'bob' }, parent: null },
      { id: 'c2', body: 'reply', user: { name: 'alice' }, parent: { id: 'c1' } },
    ]
    const events = diffLinearIssue(prev, cur, { comments, githubAttachments: [] })
    const ev = events.find(e => e.kind === 'linear_thread_reply') as LinearThreadReplyEvent | undefined
    expect(ev).toBeDefined()
    expect(ev?.author).toBe('alice')
    expect(ev?.parent_author).toBe('bob')
    expect(ev?.parent_comment_id).toBe('c1')
    expect(ev?.parent_comment_url).toMatch(/#comment-c1$/)
    expect(ev?.comment_url).toMatch(/#comment-c2$/)
  })

  it('thread reply carries parent_author=null when parent comment dropped from snapshot', () => {
    // Edge: parent older than the comment window the API returned. The reply
    // event still fires; parent_author goes null.
    const prev = baseSnap({ seen_comment_ids: [] })
    const cur = baseSnap({ seen_comment_ids: ['c2'] })
    const comments: RawLinearComment[] = [
      { id: 'c2', body: 'reply', user: { name: 'alice' }, parent: { id: 'c-missing' } },
    ]
    const events = diffLinearIssue(prev, cur, { comments, githubAttachments: [] })
    const ev = events.find(e => e.kind === 'linear_thread_reply') as LinearThreadReplyEvent | undefined
    expect(ev?.parent_author).toBeNull()
    expect(ev?.parent_comment_url).toBeNull()
  })
})

// ---- diffLinearIssue: github PR linked -----------------------------------

describe('diffLinearIssue — github PR linked', () => {
  it('emits linear_github_pr_linked once per new attachment id', () => {
    const prev = baseSnap({ seen_github_attachment_ids: [] })
    const cur = baseSnap({ seen_github_attachment_ids: ['a1'] })
    const ctx = {
      comments: [],
      githubAttachments: [{ id: 'a1', pr_repo: 'GoCarrot/Carrot', pr_number: 2000, pr_url: 'https://github.com/GoCarrot/Carrot/pull/2000' }],
    }
    const events = diffLinearIssue(prev, cur, ctx)
    const ev = events.find(e => e.kind === 'linear_github_pr_linked') as LinearGithubPrLinkedEvent | undefined
    expect(ev).toBeDefined()
    expect(ev?.pr_repo).toBe('GoCarrot/Carrot')
    expect(ev?.pr_number).toBe(2000)
    expect(ev?.pr_url).toBe('https://github.com/GoCarrot/Carrot/pull/2000')
  })

  it('does NOT re-fire on next tick (attachment id stays in seen set)', () => {
    const prev = baseSnap({ seen_github_attachment_ids: ['a1'] })
    const cur = baseSnap({ seen_github_attachment_ids: ['a1'] })
    const events = diffLinearIssue(prev, cur, {
      comments: [],
      githubAttachments: [{ id: 'a1', pr_repo: 'X/Y', pr_number: 1, pr_url: 'https://github.com/X/Y/pull/1' }],
    })
    expect(events.find(e => e.kind === 'linear_github_pr_linked')).toBeUndefined()
  })
})

// ---- seedLinearIssue -----------------------------------------------------

describe('seedLinearIssue', () => {
  it('emits added_to_watch with no comments', () => {
    const events = seedLinearIssue(baseSnap())
    expect(events.map(e => e.kind)).toEqual(['linear_issue_added_to_watch'])
  })

  it('emits has_existing_comments when backlog present', () => {
    const events = seedLinearIssue(baseSnap({ seen_comment_ids: ['c1', 'c2', 'c3'] }))
    const backlog = events.find(e => e.kind === 'linear_issue_has_existing_comments') as LinearSeedEvent | undefined
    expect(backlog?.comment_count).toBe(3)
  })
})
