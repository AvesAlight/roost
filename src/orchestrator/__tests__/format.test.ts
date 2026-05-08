import { describe, it, expect } from 'bun:test'
import { formatEvent, formatCommentHeader, eventChannels } from '../format.js'
import type { OrchestratorEvent } from '../diff.js'

describe('eventChannels', () => {
  it('routes PR with no linked issues to its own channel', () => {
    expect(eventChannels({ kind: 'pr_merged', pr: 25 })).toEqual(['#issue-25'])
  })

  it('routes PR with linked issues to linked channels', () => {
    expect(eventChannels({ kind: 'pr_merged', pr: 25, linked_issues: [14, 7] })).toEqual(['#issue-14', '#issue-7'])
  })

  it('routes issue events to issue channel', () => {
    expect(eventChannels({ kind: 'issue_comment', issue: 14 })).toEqual(['#issue-14'])
  })

  it('returns empty for orphan events (no entity)', () => {
    expect(eventChannels({ kind: 'dispatcher_error' })).toEqual([])
  })

  it('routes PR with single linked issue to that issue channel', () => {
    expect(eventChannels({ kind: 'pr_merged', pr: 99, linked_issues: [3] })).toEqual(['#issue-3'])
  })
})

describe('formatEvent', () => {
  it('formats pr_review_comment with short body', () => {
    const ev: OrchestratorEvent = {
      kind: 'pr_review_comment',
      repo: 'org/repo', pr: 46, url: 'https://github.com/org/repo/pull/46',
      author: 'alice',
      body: 'Looks good', body_preview: 'Looks good',
      comment_url: 'https://github.com/org/repo/pull/46#issuecomment-111',
    } as OrchestratorEvent
    expect(formatEvent(ev)).toBe(
      'PR org/repo#46 comment by alice: Looks good — https://github.com/org/repo/pull/46#issuecomment-111'
    )
  })

  it('truncates long body at 160 chars with ellipsis', () => {
    const body = 'A'.repeat(161)
    const ev: OrchestratorEvent = {
      kind: 'pr_review_comment',
      repo: 'org/repo', pr: 46, url: 'https://github.com/org/repo/pull/46',
      author: 'alice',
      body, body_preview: body,
      comment_url: 'https://github.com/org/repo/pull/46#issuecomment-222',
    } as OrchestratorEvent
    expect(formatEvent(ev)).toBe(
      `PR org/repo#46 comment by alice: ${'A'.repeat(160)}… — https://github.com/org/repo/pull/46#issuecomment-222`
    )
  })

  it('adds ellipsis for multiline body', () => {
    const ev: OrchestratorEvent = {
      kind: 'pr_review_comment',
      repo: 'org/repo', pr: 46, url: 'https://github.com/org/repo/pull/46',
      author: 'alice', path: 'src/foo.ts', line: 10,
      body: 'Line one\nLine two', body_preview: 'Line one\nLine two',
      comment_url: 'https://github.com/org/repo/pull/46#pullrequestreview-333',
    } as OrchestratorEvent
    expect(formatEvent(ev)).toBe(
      'PR org/repo#46 comment by alice at src/foo.ts:10: Line one… — https://github.com/org/repo/pull/46#pullrequestreview-333'
    )
  })

  it('formats issue_comment', () => {
    const ev: OrchestratorEvent = {
      kind: 'issue_comment',
      repo: 'org/repo', issue: 47, url: 'https://github.com/org/repo/issues/47',
      author: 'carol',
      body: 'Hi there', body_preview: 'Hi there',
      comment_url: 'https://github.com/org/repo/issues/47#issuecomment-555',
    } as OrchestratorEvent
    expect(formatEvent(ev)).toBe(
      'Issue org/repo#47 comment by carol: Hi there — https://github.com/org/repo/issues/47#issuecomment-555'
    )
  })

  it('formats ci_transitioned', () => {
    const ev: OrchestratorEvent = {
      kind: 'ci_transitioned',
      repo: 'org/repo', pr: 10, url: 'https://github.com/org/repo/pull/10',
      from: 'PENDING', to: 'SUCCESS', head_oid: 'abc123',
    } as OrchestratorEvent
    expect(formatEvent(ev)).toBe('PR org/repo#10 CI: PENDING → SUCCESS')
  })

  it('formats labels_changed', () => {
    const ev: OrchestratorEvent = {
      kind: 'labels_changed',
      subject: 'pr',
      repo: 'org/repo', pr: 10, url: 'https://github.com/org/repo/pull/10',
      added: ['phase:review'], removed: [],
    } as OrchestratorEvent
    expect(formatEvent(ev)).toBe('org/repo#10 labels: +phase:review')
  })
})

describe('formatCommentHeader', () => {
  it('formats pr_review_comment header', () => {
    expect(formatCommentHeader({ kind: 'pr_review_comment', repo: 'org/repo', pr: 46, author: 'alice' } as OrchestratorEvent)).toBe('PR org/repo#46 comment by alice:')
  })

  it('formats pr_review_comment header with path', () => {
    expect(formatCommentHeader({ kind: 'pr_review_comment', repo: 'org/repo', pr: 46, author: 'alice', path: 'src/foo.ts', line: 10 } as OrchestratorEvent)).toBe('PR org/repo#46 comment by alice at src/foo.ts:10:')
  })

  it('formats issue_comment header', () => {
    expect(formatCommentHeader({ kind: 'issue_comment', repo: 'org/repo', issue: 47, author: 'carol' } as OrchestratorEvent)).toBe('Issue org/repo#47 comment by carol:')
  })

  it('formats pr_review_submitted header', () => {
    expect(formatCommentHeader({ kind: 'pr_review_submitted', repo: 'org/repo', pr: 46, author: 'dave', state: 'APPROVED' } as OrchestratorEvent)).toBe('PR org/repo#46 review by dave (APPROVED):')
  })
})
