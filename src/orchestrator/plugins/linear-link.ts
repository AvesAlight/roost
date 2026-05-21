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
// Query shape (empirically verified against api.linear.app):
//   IssueFilter has no `identifier` field — filter by `team.key + number.in`.
//   One round trip per active team per tick (typically 1; M-teams = M trips).
//   Each call requests `first: 250` (Linear's per-page max) and reads
//   `pageInfo.hasNextPage`. A truthy hasNextPage means a team has > 250
//   watched issues — a loud warn surfaces this growth case before silent loss.
//
// Constructor takes an injectable query function so tests stub at the query
// seam rather than mocking LinearClient wholesale.

import type { PluginLogger } from '../plugin.js'
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

export interface AttachmentQueryResult {
  nodes: RawIssueWithAttachments[]
  hasNextPage: boolean
}

// Per-team query. `numbers` is the slice of watched issue numbers in this team.
export type AttachmentQuery = (teamKey: string, numbers: number[]) => Promise<AttachmentQueryResult>

// Linear's per-page max. Above this we silently lose the tail without a guard
// — the resolver logs a loud warn if a team's response paginates.
export const ATTACHMENT_PAGE_SIZE = 250

export const BATCHED_ATTACHMENTS_QUERY = `query LinearAttachmentsByTeam($teamKey: String!, $numbers: [Float!]!, $first: Int!) {
  issues(filter: { team: { key: { eq: $teamKey } }, number: { in: $numbers } }, first: $first) {
    pageInfo { hasNextPage }
    nodes {
      identifier
      attachments { nodes { id sourceType url } }
    }
  }
}`

// Minimal client surface for makeBatchedAttachmentQuery — matches LinearClient
// and the LinearGraphqlSurface used by linear/scraper.ts.
export interface LinearGraphqlSurface {
  graphql(query: string, variables?: Record<string, unknown>): Promise<unknown>
}

export function makeBatchedAttachmentQuery(client: LinearGraphqlSurface): AttachmentQuery {
  return async (teamKey, numbers) => {
    if (!numbers.length) return { nodes: [], hasNextPage: false }
    const data = (await client.graphql(BATCHED_ATTACHMENTS_QUERY, {
      teamKey,
      numbers,
      first: ATTACHMENT_PAGE_SIZE,
    })) as
      | { issues?: { nodes?: RawIssueWithAttachments[]; pageInfo?: { hasNextPage?: boolean } } | null }
      | null
      | undefined
    return {
      nodes: data?.issues?.nodes ?? [],
      hasNextPage: data?.issues?.pageInfo?.hasNextPage === true,
    }
  }
}

// Parse "<TEAM>-<N>" into its parts. Returns null on shapes that can't address
// a Linear issue: missing dash, empty team segment, non-positive number.
function parseLinearIdentifier(identifier: string): { team: string; number: number } | null {
  const dash = identifier.lastIndexOf('-')
  if (dash <= 0) return null
  const team = identifier.slice(0, dash)
  const num = parseInt(identifier.slice(dash + 1), 10)
  if (!team || !Number.isFinite(num) || num <= 0) return null
  return { team, number: num }
}

export class LinearAttachmentResolver {
  constructor(
    private readonly query: AttachmentQuery,
    private readonly log: PluginLogger = () => {},
  ) {
    if (typeof query !== 'function') {
      throw new Error('LinearAttachmentResolver: query function required')
    }
  }

  // Returns a map keyed on "owner/repo#N", values are Linear identifiers whose
  // attachments include that PR. A single PR can be attached to multiple Linear
  // issues — the value is a list (unique, insertion-ordered). Empty input
  // skips the query entirely; empty server response returns an empty map.
  //
  // Malformed identifiers (no `-`, empty team/number) are logged and skipped —
  // a typo in `watch linear` shouldn't poison the whole batch.
  async resolve(identifiers: string[]): Promise<Map<string, string[]>> {
    if (!identifiers.length) return new Map()
    const byTeam = new Map<string, number[]>()
    for (const id of identifiers) {
      const parsed = parseLinearIdentifier(id)
      if (!parsed) {
        this.log(`[linear-link] skipping malformed Linear identifier "${id}" — expected <TEAM>-<N>\n`)
        continue
      }
      const numbers = byTeam.get(parsed.team)
      if (numbers) numbers.push(parsed.number)
      else byTeam.set(parsed.team, [parsed.number])
    }
    if (!byTeam.size) return new Map()

    // Parallel per-team queries. The query shape can't batch across teams (the
    // `team.key.eq` filter is per-call); M teams = M round trips. Typical case
    // is M=1 in single-team workspaces.
    const teamResults = await Promise.all(
      [...byTeam.entries()].map(async ([team, numbers]) => ({
        team,
        result: await this.query(team, numbers),
      })),
    )

    const map = new Map<string, string[]>()
    for (const { team, result } of teamResults) {
      if (result.hasNextPage) {
        // Growth case: the team has > ATTACHMENT_PAGE_SIZE issues matching the
        // number-in filter (or Linear paginated for another reason). The tail
        // is silently dropped on this call — warn loudly so an operator
        // notices before workers miss PR events.
        this.log(
          `[linear-link] WARN: team "${team}" attachment query paginated ` +
          `(>${ATTACHMENT_PAGE_SIZE} matches) — Linear cross-link routing will miss the tail. ` +
          `Reduce watched-issue count per team or bump ATTACHMENT_PAGE_SIZE.\n`,
        )
      }
      for (const issue of result.nodes) {
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
    }
    return map
  }
}
