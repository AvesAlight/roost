// Linear scraper — fetch a single issue snapshot and diff against the previous
// one. Mirrors the github scraper's shape: pure event computation + a
// per-tick handle (`LinearScraper`) that bundles the client.
//
// prevSnap meanings (parallel to github):
//   undefined → seeding (global seed or first daemon run); emit nothing
//   null      → new to watch list; emit seed/backlog events
//   LinearIssueSnap → normal tick; diff and emit change events
//   LinearIssueTombstone → already-disappeared; skip fetch + re-emit
import type { LinearIssueSnap, LinearIssueState } from './types.js'
import { isTombstone } from './types.js'
import { LinearError } from './linear-api.js'
import {
  buildLinearSnap,
  diffLinearIssue,
  disappearedLinearIssue,
  seedLinearIssue,
  selectGithubAttachments,
  type RawLinearIssue,
  type LinearEvent,
  type ScrapeContext,
} from './diff.js'

// Caller surface: scrapeIssue returns the next state entry + events to emit
// for that entry this tick. `next === null` is unused — we always return a
// LinearIssueSnap or a tombstone.
export interface ScrapeResult {
  next: LinearIssueState
  events: LinearEvent[]
}

// `parent { id }` is equivalent to the spec's flat `parentId` — Linear's
// GraphQL accepts either form for thread-reply linkage.
export const ISSUE_QUERY = `query LinearIssue($id: String!) {
  issue(id: $id) {
    id
    identifier
    title
    url
    state { type name }
    labels { nodes { name } }
    comments { nodes { id body user { name } parent { id } } }
    attachments { nodes { id sourceType url title } }
  }
}`

export interface LinearGraphqlSurface {
  graphql(query: string, variables?: Record<string, unknown>): Promise<unknown>
}

// Linear's not-found shape — HTTP 200 with errors[]:
//   { message: "Entity not found: Issue", path: ["issue"],
//     extensions: { code: "INPUT_ERROR", type: "invalid input" } }
// Empirically confirmed against api.linear.app. The LinearClient turns the
// errors[] envelope into a LinearError with .code='INPUT_ERROR' and the raw
// body in .body — re-parse the body to disambiguate not-found from other
// INPUT_ERROR causes (malformed query, bad variables, etc.).
export function isLinearNotFoundError(e: unknown): boolean {
  if (!(e instanceof LinearError)) return false
  if (e.code !== 'INPUT_ERROR') return false
  let parsed: { errors?: Array<{ message?: string; path?: unknown[] }> }
  try {
    parsed = JSON.parse(e.body || '{}')
  } catch { return false }
  const errs = parsed.errors ?? []
  return errs.some(err =>
    typeof err.message === 'string'
    && err.message.startsWith('Entity not found')
    && Array.isArray(err.path)
    && err.path[0] === 'issue'
  )
}

// Per-tick handle. Constructor takes the client so tests can inject a mock
// (mirrors `GhScraper(client, agentLogins)`). The client argument is typed
// against the minimal `LinearGraphqlSurface` so unit tests don't have to
// stand up a full `LinearClient` instance.
export class LinearScraper {
  constructor(private readonly client: LinearGraphqlSurface) {}

  async scrapeIssue(identifier: string, prev: LinearIssueState | null | undefined): Promise<ScrapeResult> {
    // Already-disappeared: pass the tombstone through, emit nothing. Never
    // re-fetch — the issue is gone; the operator drops it via `unwatch`.
    if (isTombstone(prev)) {
      return { next: prev, events: [] }
    }

    let raw: RawLinearIssue | null | undefined
    try {
      const data = (await this.client.graphql(ISSUE_QUERY, { id: identifier })) as
        | { issue: RawLinearIssue | null }
        | null
        | undefined
      raw = data?.issue
    } catch (e) {
      // Linear's not-found shape is HTTP 200 + errors[], which LinearClient
      // rethrows as LinearError. Translate to the disappeared path; rethrow
      // anything else (auth, rate-limit, network, real graphql errors).
      if (!isLinearNotFoundError(e)) throw e
      raw = null
    }

    if (!raw) {
      // 404 / inaccessible. Mute on subsequent ticks by storing a tombstone.
      // Seeding (prev === undefined) suppresses the event but still seats the
      // tombstone so a later tick doesn't re-emit.
      const tombstone: LinearIssueState = { identifier, disappeared: true }
      if (prev === undefined) return { next: tombstone, events: [] }
      return { next: tombstone, events: [disappearedLinearIssue(identifier)] }
    }

    const snap = buildLinearSnap(raw)
    const ctx: ScrapeContext = {
      comments: raw.comments?.nodes ?? [],
      githubAttachments: selectGithubAttachments(raw.attachments?.nodes ?? []),
    }

    if (prev === undefined) return { next: snap, events: [] }
    if (prev === null) return { next: snap, events: seedLinearIssue(snap) }
    // Tombstone branch handled above — prev is a LinearIssueSnap here.
    return { next: snap, events: diffLinearIssue(prev as LinearIssueSnap, snap, ctx) }
  }
}

// Re-export for the plugin's runTick.
export type { LinearEvent } from './diff.js'
