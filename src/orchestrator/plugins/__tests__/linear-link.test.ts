import { describe, it, expect } from 'bun:test'
import {
  LinearAttachmentResolver,
  makeBatchedAttachmentQuery,
  BATCHED_ATTACHMENTS_QUERY,
  ATTACHMENT_PAGE_SIZE,
  type AttachmentQuery,
  type AttachmentQueryResult,
  type RawIssueWithAttachments,
} from '../linear-link.js'

interface Call { team: string; numbers: number[] }

function stubQuery(responses: Record<string, AttachmentQueryResult>): { fn: AttachmentQuery; calls: Call[] } {
  const calls: Call[] = []
  const fn: AttachmentQuery = async (team, numbers) => {
    calls.push({ team, numbers: [...numbers] })
    return responses[team] ?? { nodes: [], hasNextPage: false }
  }
  return { fn, calls }
}

function issueNode(identifier: string, attachments: Array<{ id: string; sourceType: string | null; url: string | null }>): RawIssueWithAttachments {
  return { identifier, attachments: { nodes: attachments } }
}

function gh(url: string): { id: string; sourceType: string; url: string } {
  return { id: `att-${url}`, sourceType: 'github', url }
}

describe('LinearAttachmentResolver.resolve', () => {
  it('builds a map of "owner/repo#N" → [linear identifier] from github attachments', async () => {
    const { fn } = stubQuery({
      C: { nodes: [issueNode('C-758', [gh('https://github.com/AvesAlight/roost/pull/495')])], hasNextPage: false },
    })
    const map = await new LinearAttachmentResolver(fn).resolve(['C-758'])
    expect(map.get('AvesAlight/roost#495')).toEqual(['C-758'])
    expect(map.size).toBe(1)
  })

  it('ignores attachments with non-github sourceType', async () => {
    const { fn } = stubQuery({
      C: {
        nodes: [issueNode('C-1', [
          { id: 'a1', sourceType: 'slack', url: 'https://github.com/x/y/pull/1' },
          { id: 'a2', sourceType: 'githubCommit', url: 'https://github.com/x/y/commit/abc' },
          { id: 'a3', sourceType: null, url: 'https://github.com/x/y/pull/2' },
        ])],
        hasNextPage: false,
      },
    })
    const map = await new LinearAttachmentResolver(fn).resolve(['C-1'])
    expect(map.size).toBe(0)
  })

  it('ignores github attachments whose URL is not a well-formed pull/<N>', async () => {
    const { fn } = stubQuery({
      C: {
        nodes: [issueNode('C-1', [
          { id: 'a1', sourceType: 'github', url: 'https://github.com/x/y/issues/3' },
          { id: 'a2', sourceType: 'github', url: 'https://github.com/x/y/pulls/4' },
          { id: 'a3', sourceType: 'github', url: null },
        ])],
        hasNextPage: false,
      },
    })
    const map = await new LinearAttachmentResolver(fn).resolve(['C-1'])
    expect(map.size).toBe(0)
  })

  it('collects multiple Linear identifiers when the same PR is attached to several issues', async () => {
    const { fn } = stubQuery({
      C: {
        nodes: [
          issueNode('C-1', [gh('https://github.com/x/y/pull/42')]),
          issueNode('C-2', [gh('https://github.com/x/y/pull/42')]),
        ],
        hasNextPage: false,
      },
    })
    const map = await new LinearAttachmentResolver(fn).resolve(['C-1', 'C-2'])
    expect(map.get('x/y#42')).toEqual(['C-1', 'C-2'])
  })

  it('dedups when the same Linear issue has multiple github attachments pointing at the same PR', async () => {
    const { fn } = stubQuery({
      C: { nodes: [issueNode('C-1', [gh('https://github.com/x/y/pull/42'), gh('https://github.com/x/y/pull/42')])], hasNextPage: false },
    })
    const map = await new LinearAttachmentResolver(fn).resolve(['C-1'])
    expect(map.get('x/y#42')).toEqual(['C-1'])
  })

  it('skips the query entirely when the identifier list is empty', async () => {
    const { fn, calls } = stubQuery({})
    const map = await new LinearAttachmentResolver(fn).resolve([])
    expect(map.size).toBe(0)
    expect(calls).toHaveLength(0)
  })

  it('groups identifiers by team and issues one query per team (M teams = M round trips)', async () => {
    const { fn, calls } = stubQuery({
      C: { nodes: [issueNode('C-1', [gh('https://github.com/x/y/pull/1')])], hasNextPage: false },
      M: { nodes: [issueNode('M-7', [gh('https://github.com/x/y/pull/7')])], hasNextPage: false },
    })
    const map = await new LinearAttachmentResolver(fn).resolve(['C-1', 'M-7', 'C-2', 'C-3'])
    expect(calls).toHaveLength(2)
    const cByTeam = Object.fromEntries(calls.map(c => [c.team, c.numbers]))
    expect(cByTeam.C).toEqual([1, 2, 3])
    expect(cByTeam.M).toEqual([7])
    expect(map.get('x/y#1')).toEqual(['C-1'])
    expect(map.get('x/y#7')).toEqual(['M-7'])
  })

  it('issues exactly one query per team regardless of N identifiers in that team', async () => {
    const { fn, calls } = stubQuery({ C: { nodes: [], hasNextPage: false } })
    await new LinearAttachmentResolver(fn).resolve(['C-1', 'C-2', 'C-3', 'C-4', 'C-5'])
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({ team: 'C', numbers: [1, 2, 3, 4, 5] })
  })

  it('skips malformed identifiers without poisoning the batch + logs each', async () => {
    const logs: string[] = []
    const log = (msg: string) => { logs.push(msg) }
    const { fn, calls } = stubQuery({
      C: { nodes: [issueNode('C-1', [gh('https://github.com/x/y/pull/1')])], hasNextPage: false },
    })
    const map = await new LinearAttachmentResolver(fn, log).resolve(['noDash', '-758', 'C-', 'C-abc', 'C-1'])
    expect(calls).toHaveLength(1)
    expect(calls[0]?.numbers).toEqual([1])
    expect(logs.filter(m => m.includes('malformed Linear identifier'))).toHaveLength(4)
    expect(map.get('x/y#1')).toEqual(['C-1'])
  })

  it('returns an empty map and issues no query when every identifier is malformed', async () => {
    const logs: string[] = []
    const { fn, calls } = stubQuery({})
    const map = await new LinearAttachmentResolver(fn, (m) => { logs.push(m) }).resolve(['bogus', '-1', 'X-'])
    expect(calls).toHaveLength(0)
    expect(map.size).toBe(0)
    expect(logs.length).toBe(3)
  })

  it('logs a loud warn when a team result paginates (growth case guard)', async () => {
    const logs: string[] = []
    const log = (msg: string) => { logs.push(msg) }
    const { fn } = stubQuery({
      C: { nodes: [issueNode('C-1', [gh('https://github.com/x/y/pull/1')])], hasNextPage: true },
    })
    const map = await new LinearAttachmentResolver(fn, log).resolve(['C-1'])
    expect(map.get('x/y#1')).toEqual(['C-1'])
    const warn = logs.find(m => m.includes('paginated'))
    expect(warn).toBeDefined()
    expect(warn).toContain('team "C"')
    expect(warn).toContain(`>${ATTACHMENT_PAGE_SIZE}`)
  })

  it('handles an issue with null attachments cleanly', async () => {
    const { fn } = stubQuery({ C: { nodes: [{ identifier: 'C-1', attachments: null }], hasNextPage: false } })
    const map = await new LinearAttachmentResolver(fn).resolve(['C-1'])
    expect(map.size).toBe(0)
  })

  it('rejects construction without a query function', () => {
    expect(() => new LinearAttachmentResolver(undefined as unknown as AttachmentQuery)).toThrow(/query function required/)
  })
})

describe('makeBatchedAttachmentQuery', () => {
  it('wraps a LinearClient.graphql call with the batched-attachments query + per-team variables', async () => {
    const calls: Array<{ query: string; variables: Record<string, unknown> | undefined }> = []
    const client = {
      graphql: async (query: string, variables?: Record<string, unknown>) => {
        calls.push({ query, variables })
        return {
          issues: {
            pageInfo: { hasNextPage: false },
            nodes: [issueNode('C-1', [gh('https://github.com/x/y/pull/9')])],
          },
        }
      },
    }
    const query = makeBatchedAttachmentQuery(client)
    const result = await query('C', [1, 2])
    expect(calls).toHaveLength(1)
    expect(calls[0]?.query).toBe(BATCHED_ATTACHMENTS_QUERY)
    expect(calls[0]?.variables).toEqual({ teamKey: 'C', numbers: [1, 2], first: ATTACHMENT_PAGE_SIZE })
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0]?.identifier).toBe('C-1')
    expect(result.hasNextPage).toBe(false)
  })

  it('returns empty + hasNextPage=false without calling graphql when numbers is empty', async () => {
    let called = 0
    const client = { graphql: async () => { called++; return null } }
    const result = await makeBatchedAttachmentQuery(client)('C', [])
    expect(result.nodes).toEqual([])
    expect(result.hasNextPage).toBe(false)
    expect(called).toBe(0)
  })

  it('reads hasNextPage from the response pageInfo', async () => {
    const client = {
      graphql: async () => ({ issues: { pageInfo: { hasNextPage: true }, nodes: [] } }),
    }
    const result = await makeBatchedAttachmentQuery(client)('C', [1])
    expect(result.hasNextPage).toBe(true)
  })

  it('returns empty + hasNextPage=false when the graphql response is null or missing issues', async () => {
    const nullClient = { graphql: async () => null }
    const r1 = await makeBatchedAttachmentQuery(nullClient)('C', [1])
    expect(r1).toEqual({ nodes: [], hasNextPage: false })
    const emptyClient = { graphql: async () => ({ issues: null }) }
    const r2 = await makeBatchedAttachmentQuery(emptyClient)('C', [1])
    expect(r2).toEqual({ nodes: [], hasNextPage: false })
  })
})
