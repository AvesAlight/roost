// Cross-link resolver: Linear `Issue.attachments` → "owner/repo#N" → Linear
// identifiers. github-prs uses this to add Linear-issue channels to its event
// routing when a watched Linear issue has a github attachment for the PR.
//
// gitBranchName rejected as a cross-link source:
//   1. Linear's branch template is per-issue/per-workspace overridable, so
//      a `feature/<team>-<N>-…` regex match isn't load-bearing.
//   2. A branch can exist before the PR opens (timing-unreliable); attachments
//      only land after GitHub recognizes the PR↔issue link, which makes
//      attachments the deterministic cross-link source.
//
// Single batched query per tick (one round trip regardless of N watched
// identifiers). Constructor takes an injectable query function so tests stub
// at the query seam rather than mocking LinearClient wholesale.

import { parseGithubPrUrl } from './linear/diff.js'

// Thinner projection of `RawLinearAttachment` from `linear/diff.ts` — the
// batched attachments query doesn't request `title` so the runtime shape is
// narrower. Sister surface for the github-attachment filter lives in
// `selectGithubAttachments`; keep the two in sync on attachment-shape tweaks.
export interface RawAttachmentNode {
  id: string
  sourceType: string | null
  url: string | null
}

// Partial-issue projection — only `identifier` + `attachments`, distinct from
// `RawLinearIssue` (which carries title/state/labels/comments for the per-issue
// scraper).
export interface RawIssueWithAttachments {
  identifier: string
  attachments: { nodes: RawAttachmentNode[] } | null
}

export const BATCHED_ATTACHMENTS_QUERY = `query LinearAttachmentsBatch($ids: [String!]!) {
  issues(filter: { identifier: { in: $ids } }) {
    nodes {
      identifier
      attachments { nodes { id sourceType url } }
    }
  }
}`

export type AttachmentQuery = (identifiers: string[]) => Promise<RawIssueWithAttachments[]>

// Minimal client surface for makeBatchedAttachmentQuery — matches LinearClient
// and the LinearGraphqlSurface used by linear/scraper.ts.
export interface LinearGraphqlSurface {
  graphql(query: string, variables?: Record<string, unknown>): Promise<unknown>
}

export function makeBatchedAttachmentQuery(client: LinearGraphqlSurface): AttachmentQuery {
  return async (identifiers: string[]) => {
    if (!identifiers.length) return []
    const data = (await client.graphql(BATCHED_ATTACHMENTS_QUERY, { ids: identifiers })) as
      | { issues?: { nodes?: RawIssueWithAttachments[] } | null }
      | null
      | undefined
    return data?.issues?.nodes ?? []
  }
}

export class LinearAttachmentResolver {
  constructor(private readonly query: AttachmentQuery) {
    if (typeof query !== 'function') {
      throw new Error('LinearAttachmentResolver: query function required')
    }
  }

  // Returns a map keyed on "owner/repo#N", values are Linear identifiers whose
  // attachments include that PR. A single PR can be attached to multiple Linear
  // issues — the value is a list (unique, insertion-ordered). Empty input
  // skips the query entirely; empty server response returns an empty map.
  async resolve(identifiers: string[]): Promise<Map<string, string[]>> {
    if (!identifiers.length) return new Map()
    const nodes = await this.query(identifiers)
    const map = new Map<string, string[]>()
    for (const issue of nodes) {
      const ident = issue.identifier
      if (!ident) continue
      const atts = issue.attachments?.nodes ?? []
      // Sister surface: `linear/diff.ts:selectGithubAttachments` runs the
      // same `sourceType === 'github' && parseGithubPrUrl(url)` filter on the
      // per-issue scraper path. Below the 3-surface canonicalize threshold;
      // keep the two filters aligned when attachment shape evolves.
      for (const a of atts) {
        if (a.sourceType !== 'github') continue
        const parsed = parseGithubPrUrl(a.url)
        if (!parsed) continue
        const key = `${parsed.repo}#${parsed.number}`
        const list = map.get(key)
        if (list) {
          if (!list.includes(ident)) list.push(ident)
        } else {
          map.set(key, [ident])
        }
      }
    }
    return map
  }
}
