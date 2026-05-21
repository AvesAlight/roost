import { describe, it, expect } from 'bun:test'
import { LinearScraper, isLinearNotFoundError, type LinearGraphqlSurface } from '../scraper.js'
import { isTombstone, type LinearIssueSnap } from '../types.js'
import type { RawLinearIssue, LinearSeedEvent } from '../diff.js'
import { LinearError } from '../linear-api.js'

// Empirically-captured Linear not-found body shape — HTTP 200 + errors[]
// returned for issue(id:"C-99999"). Confirmed against api.linear.app.
const NOT_FOUND_BODY = JSON.stringify({
  errors: [{
    message: 'Entity not found: Issue',
    path: ['issue'],
    locations: [{ line: 1, column: 20 }],
    extensions: {
      type: 'invalid input',
      code: 'INPUT_ERROR',
      statusCode: 400,
      userError: true,
      userPresentableMessage: 'Could not find referenced Issue.',
    },
  }],
  data: null,
})

function notFoundError(): LinearError {
  return new LinearError('linear graphql returned errors[] (code=INPUT_ERROR)', {
    status: 200,
    code: 'INPUT_ERROR',
    body: NOT_FOUND_BODY,
  })
}

function mockClient(response: RawLinearIssue | null): LinearGraphqlSurface {
  return {
    graphql: async () => ({ issue: response }),
  }
}

function rawIssue(overrides: Partial<RawLinearIssue> = {}): RawLinearIssue {
  return {
    id: 'uuid-1',
    identifier: 'C-758',
    title: 't',
    url: 'https://linear.app/teakio/issue/C-758/t',
    state: { type: 'started', name: 'In Progress' },
    labels: { nodes: [] },
    comments: { nodes: [] },
    attachments: { nodes: [] },
    ...overrides,
  }
}

// ---- isLinearNotFoundError classifier ----------------------------------

describe('isLinearNotFoundError', () => {
  it('matches the empirically-captured not-found shape', () => {
    expect(isLinearNotFoundError(notFoundError())).toBe(true)
  })

  it('rejects unrelated errors', () => {
    expect(isLinearNotFoundError(new Error('boom'))).toBe(false)
    expect(isLinearNotFoundError(null)).toBe(false)
    expect(isLinearNotFoundError(undefined)).toBe(false)
  })

  it('rejects LinearError with a different code', () => {
    expect(isLinearNotFoundError(new LinearError('x', {
      code: 'AUTHENTICATION_ERROR',
      body: JSON.stringify({ errors: [{ message: 'Entity not found: Issue', path: ['issue'] }] }),
    }))).toBe(false)
  })

  it('rejects LinearError with INPUT_ERROR but wrong path (malformed query)', () => {
    expect(isLinearNotFoundError(new LinearError('x', {
      code: 'INPUT_ERROR',
      body: JSON.stringify({ errors: [{ message: 'Variable required', path: ['someOther'] }] }),
    }))).toBe(false)
  })

  it('rejects LinearError with unparseable body', () => {
    expect(isLinearNotFoundError(new LinearError('x', { code: 'INPUT_ERROR', body: 'not json' }))).toBe(false)
  })
})

describe('LinearScraper.scrapeIssue', () => {
  it('seeding (prev=undefined): produces snap, no events', async () => {
    const s = new LinearScraper(mockClient(rawIssue()))
    const r = await s.scrapeIssue('C-758', undefined)
    expect(isTombstone(r.next)).toBe(false)
    expect(r.events).toEqual([])
  })

  it('new-to-watch (prev=null): emits added_to_watch', async () => {
    const s = new LinearScraper(mockClient(rawIssue()))
    const r = await s.scrapeIssue('C-758', null)
    expect(r.events.map(e => e.kind)).toEqual(['linear_issue_added_to_watch'])
  })

  it('new-to-watch with pre-existing comments emits backlog seed', async () => {
    const s = new LinearScraper(mockClient(rawIssue({
      comments: { nodes: [
        { id: 'c1', body: 'old', user: null, parent: null },
        { id: 'c2', body: 'old', user: null, parent: null },
      ] },
    })))
    const r = await s.scrapeIssue('C-758', null)
    expect(r.events.map(e => e.kind)).toEqual([
      'linear_issue_added_to_watch',
      'linear_issue_has_existing_comments',
    ])
    const backlog = r.events.find(e => e.kind === 'linear_issue_has_existing_comments') as LinearSeedEvent
    expect(backlog.comment_count).toBe(2)
  })

  it('normal diff: emits change events vs. prev snap', async () => {
    const prev: LinearIssueSnap = {
      id: 'uuid-1', identifier: 'C-758', title: 't', url: 'https://x', status: 'In Progress',
      statusType: 'started', labels: [], seen_comment_ids: [], seen_github_attachment_ids: [],
    }
    const s = new LinearScraper(mockClient(rawIssue({
      state: { type: 'completed', name: 'Done' },
    })))
    const r = await s.scrapeIssue('C-758', prev)
    expect(r.events.map(e => e.kind)).toContain('linear_state_changed')
  })

  it('disappeared on prev=normal: emits disappeared event + tombstone next', async () => {
    const prev: LinearIssueSnap = {
      id: 'uuid-1', identifier: 'C-758', title: 't', url: 'https://x', status: 'In Progress',
      statusType: 'started', labels: [], seen_comment_ids: [], seen_github_attachment_ids: [],
    }
    const s = new LinearScraper(mockClient(null))
    const r = await s.scrapeIssue('C-758', prev)
    expect(isTombstone(r.next)).toBe(true)
    expect(r.events.map(e => e.kind)).toEqual(['linear_issue_disappeared'])
  })

  it('disappeared on prev=null (new watch, immediately 404): emits once + tombstone next', async () => {
    const s = new LinearScraper(mockClient(null))
    const r = await s.scrapeIssue('C-9999', null)
    expect(isTombstone(r.next)).toBe(true)
    expect(r.events.map(e => e.kind)).toEqual(['linear_issue_disappeared'])
  })

  it('disappeared on prev=undefined (seeding): tombstone next, NO event (silent during seed)', async () => {
    const s = new LinearScraper(mockClient(null))
    const r = await s.scrapeIssue('C-9999', undefined)
    expect(isTombstone(r.next)).toBe(true)
    expect(r.events).toEqual([])
  })

  it('prev=tombstone: no fetch, no event, passes through', async () => {
    let calls = 0
    const c: LinearGraphqlSurface = {
      graphql: async () => { calls++; return { issue: null } },
    }
    const s = new LinearScraper(c)
    const r = await s.scrapeIssue('C-758', { identifier: 'C-758', disappeared: true })
    expect(calls).toBe(0)
    expect(isTombstone(r.next)).toBe(true)
    expect(r.events).toEqual([])
  })

  it('disappeared via thrown LinearError (real Linear shape — HTTP 200 + errors[]): emits + tombstone', async () => {
    const prev: LinearIssueSnap = {
      id: 'uuid-1', identifier: 'C-99999', title: 't', url: 'https://x', status: null,
      statusType: 'started', labels: [], seen_comment_ids: [], seen_github_attachment_ids: [],
    }
    const client: LinearGraphqlSurface = {
      graphql: async () => { throw notFoundError() },
    }
    const s = new LinearScraper(client)
    const r = await s.scrapeIssue('C-99999', prev)
    expect(isTombstone(r.next)).toBe(true)
    expect(r.events.map(e => e.kind)).toEqual(['linear_issue_disappeared'])
  })

  it('disappeared-via-error during seeding: tombstone, no event', async () => {
    const client: LinearGraphqlSurface = {
      graphql: async () => { throw notFoundError() },
    }
    const s = new LinearScraper(client)
    const r = await s.scrapeIssue('C-99999', undefined)
    expect(isTombstone(r.next)).toBe(true)
    expect(r.events).toEqual([])
  })

  it('rethrows non-not-found LinearErrors (auth/network/real graphql errors)', async () => {
    // INPUT_ERROR with a non-issue path is a malformed-query failure, not 404.
    const wrongShape = new LinearError('linear graphql returned errors[]', {
      status: 200,
      code: 'INPUT_ERROR',
      body: JSON.stringify({ errors: [{ message: 'Variable $id is required', path: ['someOther'] }] }),
    })
    const client: LinearGraphqlSurface = { graphql: async () => { throw wrongShape } }
    const s = new LinearScraper(client)
    await expect(s.scrapeIssue('C-1', null)).rejects.toThrow(LinearError)
  })

  it('sends issue identifier as the `id` variable', async () => {
    let captured: Record<string, unknown> | undefined
    const c: LinearGraphqlSurface = {
      graphql: async (_q, vars) => { captured = vars; return { issue: rawIssue() } },
    }
    const s = new LinearScraper(c)
    await s.scrapeIssue('ENG-42', null)
    expect(captured).toEqual({ id: 'ENG-42' })
  })
})
