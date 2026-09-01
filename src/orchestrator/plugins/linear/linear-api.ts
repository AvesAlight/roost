import type { PluginLogger } from '../../plugin.js'
import type { RateLimitInfo } from '../_rate-limit.js'

// Linear's GraphQL endpoint. Personal API keys use header `Authorization: <KEY>`
// (no `Bearer ` prefix; OAuth bearer tokens do use `Bearer`).
export const LINEAR_ENDPOINT = 'https://api.linear.app/graphql'

// Verbatim operator-facing messages — kept here so logs and thrown errors share
// a single source of truth. The dispatcher boot path copy-pastes these into
// daemon.log for operators to act on.
export const MISSING_KEY_MESSAGE =
  'LINEAR_API_KEY not set in env; export it before starting the dispatcher.'
export const REJECTED_KEY_MESSAGE =
  'LINEAR_API_KEY set but rejected by Linear (401). Verify the key is valid and hasn\'t been revoked.'

// Default per-call timeout. Tunable via deps for slice 2/3's per-tick budget.
const DEFAULT_TIMEOUT_MS = 30_000

// Header names are TBD until empirically confirmed (Linear's public docs don't
// pin them down). Best guesses, looked up case-insensitively; on the first
// response with none of these present, the client WARNs once so the silent
// "predictor never fires" failure mode is detectable.
const REMAINING_HEADERS = [
  'x-ratelimit-requests-remaining',
  'x-ratelimit-remaining',
]
const LIMIT_HEADERS = [
  'x-ratelimit-requests-limit',
  'x-ratelimit-limit',
]
const RESET_HEADERS = [
  'x-ratelimit-requests-reset',
  'x-ratelimit-reset',
]

// Network/fetch-shape errors we treat as transient. Mirror `spawnGh`'s
// stderr-string classifier but against the modern fetch error surface.
const TRANSIENT_FETCH_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\btimed out\b/i, label: 'timeout' },
  { re: /\bThe operation was aborted\b/i, label: 'timeout' },
  { re: /\bconnection refused\b/i, label: 'connection-refused' },
  { re: /\bconnection reset\b/i, label: 'connection-reset' },
  { re: /\bsocket hang up\b/i, label: 'connection-reset' },
  { re: /\bECONNREFUSED\b/, label: 'connection-refused' },
  { re: /\bECONNRESET\b/, label: 'connection-reset' },
  { re: /\bENOTFOUND\b/, label: 'dns' },
  { re: /\bEAI_AGAIN\b/, label: 'dns' },
  { re: /\bnetwork is unreachable\b/i, label: 'network-unreachable' },
  { re: /\bfailed to fetch\b/i, label: 'fetch-failed' },
]

export class LinearError extends Error {
  readonly status: number | null
  readonly code: string | null
  readonly body: string
  readonly attempts: number
  // Operator-facing label for the error shape (e.g. `ratelimited`, `http-401`).
  // Surfaced in the single catch-handler body log so ops can grep the shape
  // even after the bespoke per-branch prefixes were collapsed to one.
  readonly shape: string | null
  constructor(msg: string, opts: { status?: number | null; code?: string | null; body?: string; attempts?: number; shape?: string | null } = {}) {
    super(msg)
    this.name = 'LinearError'
    this.status = opts.status ?? null
    this.code = opts.code ?? null
    this.body = opts.body ?? ''
    this.attempts = opts.attempts ?? 1
    this.shape = opts.shape ?? null
  }
}

// HTTP 401 — surfaced as a distinct type so dispatcher boot can fatal cleanly:
// `catch (e) { if (e instanceof LinearAuthError) ... }`.
export class LinearAuthError extends LinearError {
  constructor(msg: string, opts: { status?: number | null; body?: string; shape?: string | null } = {}) {
    super(msg, opts)
    this.name = 'LinearAuthError'
  }
}

// HTTP 400 + `extensions.code == 'RATELIMITED'`. Non-transient — burns budget
// to retry. Callers log the raw body once + skip-tick.
export class LinearRateLimitedError extends LinearError {
  constructor(msg: string, opts: { status?: number | null; body?: string; shape?: string | null } = {}) {
    super(msg, { ...opts, code: 'RATELIMITED' })
    this.name = 'LinearRateLimitedError'
  }
}

export interface LinearGraphqlResponse {
  data?: unknown
  errors?: Array<{ message?: string; extensions?: { code?: string } }>
}

// Result of a single graphql call: parsed body + observed rate-limit telemetry
// (null when no recognized headers were present) + a snapshot of response
// headers so the caller can WARN-once with concrete header names on the
// silent-predictor failure mode.
export interface LinearGraphqlResult {
  body: LinearGraphqlResponse
  rateLimit: RateLimitInfo | null
  headers: Record<string, string>
}

export interface LinearSpawnDeps {
  log: PluginLogger
  sleep?: (ms: number) => Promise<void>
  attempts?: number          // total tries; default 3
  baseMs?: number            // first backoff; default 1000
  jitterFraction?: number    // backoff *= 1 + random()*jitterFraction; default 0.5
  random?: () => number      // 0..1; default Math.random
  timeoutMs?: number         // per-attempt fetch timeout; default 30s
  fetch?: typeof fetch       // injectable for tests
}

const defaultSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

function classifyTransient(message: string): string | null {
  for (const { re, label } of TRANSIENT_FETCH_PATTERNS) {
    if (re.test(message)) return label
  }
  return null
}

function headerLookup(headers: Headers, names: string[]): string | null {
  for (const n of names) {
    const v = headers.get(n)
    if (v != null) return v
  }
  return null
}

function parseRateLimit(headers: Headers): RateLimitInfo | null {
  const remaining = headerLookup(headers, REMAINING_HEADERS)
  const limit = headerLookup(headers, LIMIT_HEADERS)
  const reset = headerLookup(headers, RESET_HEADERS)
  if (remaining == null || limit == null || reset == null) return null
  const r = Number(remaining), l = Number(limit), rs = Number(reset)
  if (!Number.isFinite(r) || !Number.isFinite(l) || !Number.isFinite(rs)) return null
  // Linear's reset header is milliseconds since epoch (empirically confirmed
  // against a live response: `x-ratelimit-requests-reset: 1779379756696` —
  // a 13-digit value, ~20 minutes ahead of the probe time). RateLimitInfo's
  // contract is `resetAt: unix seconds` so computeRateLimitWarning's math
  // works for both APIs; convert here. Heuristic guards a future Linear
  // change to seconds: values > 1e11 are ms, anything smaller is seconds.
  const resetAt = rs > 1e11 ? Math.floor(rs / 1000) : Math.floor(rs)
  return { remaining: r, limit: l, resetAt }
}

function headersToObject(headers: Headers): Record<string, string> {
  const obj: Record<string, string> = {}
  headers.forEach((v, k) => { obj[k] = v })
  return obj
}

// Restrict the missing-headers WARN dump to rate-limit-shaped header keys so a
// `set-cookie` (or any future sensitive header on the GraphQL endpoint) can't
// leak into daemon.log. The whole point of the WARN is to surface unknown
// rate-limit header shapes; arbitrary headers don't help.
const RATE_LIMIT_KEY_RE = /rate.?limit|complexity|retry.?after/i
function filterRateLimitHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    if (RATE_LIMIT_KEY_RE.test(k)) out[k] = v
  }
  return out
}

// Emit a single `linear-error:` line with the response body verbatim. One prefix
// + one `shape=` field keeps the verbatim-body shape identical across every throw
// site so ops can grep a single label and still distinguish shapes.
function logErrorBody(log: PluginLogger, cmd: string, status: number | null, code: string | null, shape: string | null, body: string) {
  log(`linear-error: ${cmd} status=${status} code=${code ?? 'unknown'} shape=${shape ?? 'unknown'} — response body verbatim:\n${body}\n`)
}

// Sole call site for `fetch` against Linear's GraphQL endpoint. Mirrors
// `spawnGh`'s retry/backoff shape; classifier diverges (HTTP status + GraphQL
// extensions.code instead of `gh` stderr strings).
export async function spawnLinear(
  apiKey: string,
  query: string,
  variables: Record<string, unknown> | undefined,
  deps: LinearSpawnDeps,
): Promise<LinearGraphqlResult> {
  const sleep = deps.sleep ?? defaultSleep
  const log = deps.log
  const totalAttempts = deps.attempts ?? 3
  const baseMs = deps.baseMs ?? 1000
  const jitterFraction = deps.jitterFraction ?? 0.5
  const random = deps.random ?? Math.random
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const fetchImpl = deps.fetch ?? fetch

  const cmd = `linear graphql (${query.slice(0, 40).replace(/\s+/g, ' ').trim()}...)`

  for (let i = 0; i < totalAttempts; i++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const resp = await fetchImpl(LINEAR_ENDPOINT, {
        method: 'POST',
        headers: {
          'Authorization': apiKey,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({ query, variables: variables ?? {} }),
        signal: controller.signal,
      })
      const rateLimit = parseRateLimit(resp.headers)
      const headers = headersToObject(resp.headers)
      const rawText = await resp.text()

      // HTTP 401 — bad/revoked key. Non-transient, fatal.
      if (resp.status === 401) {
        throw new LinearAuthError(REJECTED_KEY_MESSAGE, { status: 401, body: rawText, shape: 'http-401' })
      }

      // HTTP 5xx / 429 — transient. Retry if attempts remain.
      if (resp.status >= 500 || resp.status === 429) {
        const label = resp.status === 429 ? 'http-429-rate-limit' : 'http-5xx'
        const attemptNum = i + 1
        if (attemptNum >= totalAttempts) {
          log(`linear-retry: ${cmd} exhausted ${totalAttempts} attempts (matched=${label}, status=${resp.status})\n`)
          throw new LinearError(`linear graphql failed: HTTP ${resp.status} (after ${totalAttempts} retries)`, { status: resp.status, body: rawText, attempts: totalAttempts, shape: label })
        }
        const backoff = Math.round(baseMs * Math.pow(2, i) * (1 + random() * jitterFraction))
        log(`linear-retry: ${cmd} attempt ${attemptNum}/${totalAttempts} matched=${label} status=${resp.status}, backoff ${backoff}ms before next try\n`)
        await sleep(backoff)
        continue
      }

      // Parse body. JSON-shape errors are non-transient: a corrupt response
      // here probably means we hit a non-Linear endpoint (proxy, DNS mishap).
      let body: LinearGraphqlResponse
      try {
        body = JSON.parse(rawText) as LinearGraphqlResponse
      } catch {
        throw new LinearError(`linear graphql returned non-JSON (status=${resp.status})`, { status: resp.status, body: rawText, shape: 'non-json' })
      }

      // HTTP 400 + extensions.code == RATELIMITED is the documented shape.
      // Log the raw body verbatim on first hit so we learn the actual envelope
      // shape (the design doc flagged this as un-empirically-verified).
      if (resp.status === 400) {
        const code = body.errors?.[0]?.extensions?.code ?? null
        if (code === 'RATELIMITED') {
          throw new LinearRateLimitedError('linear graphql rate-limited (HTTP 400 RATELIMITED) — skip tick', { status: 400, body: rawText, shape: 'ratelimited' })
        }
        // Some other 400 — non-transient, surface the extensions.code so callers
        // can branch without re-parsing the body.
        throw new LinearError(`linear graphql failed: HTTP 400 (code=${code ?? 'unknown'})`, { status: 400, code, body: rawText, shape: 'http-400' })
      }

      // HTTP 2xx but `errors[]` populated — GraphQL-layer failure. Default to
      // non-transient; the raw body is logged so unknown transient codes can
      // be added to the classifier in a follow-up.
      if (resp.status >= 200 && resp.status < 300 && body.errors && body.errors.length > 0) {
        const code = body.errors[0]?.extensions?.code ?? null
        throw new LinearError(`linear graphql returned errors[] (code=${code ?? 'unknown'})`, { status: resp.status, code, body: rawText, shape: 'graphql-errors' })
      }

      // Any other non-2xx not classified above — non-transient surface.
      if (resp.status < 200 || resp.status >= 300) {
        throw new LinearError(`linear graphql failed: HTTP ${resp.status}`, { status: resp.status, body: rawText, shape: 'http-other' })
      }

      return { body, rateLimit, headers }
    } catch (e) {
      // Single body-logging site: every response-carrying throw carries a
      // non-empty body, so log it once here before rethrowing. A future throw
      // path can't forget it (the failure mode this PR exists to fix). The
      // body-guard means fetch failures (no body) skip.
      if (e instanceof LinearError && e.body) {
        logErrorBody(log, cmd, e.status, e.code, e.shape, e.body)
      }
      if (e instanceof LinearError) throw e
      // fetch threw — network/timeout/dns. Classify against the message.
      const msg = e instanceof Error ? e.message : String(e)
      const matched = classifyTransient(msg)
      if (!matched) {
        // Unrecognized fetch failure — surface as a LinearError so callers
        // get a single catch surface.
        throw new LinearError(`linear fetch failed: ${msg}`)
      }
      const attemptNum = i + 1
      if (attemptNum >= totalAttempts) {
        log(`linear-retry: ${cmd} exhausted ${totalAttempts} attempts (matched=${matched}) — message verbatim:\n${msg}\n`)
        throw new LinearError(`linear fetch failed: ${msg} (after ${totalAttempts} retries)`, { attempts: totalAttempts })
      }
      const backoff = Math.round(baseMs * Math.pow(2, i) * (1 + random() * jitterFraction))
      log(`linear-retry: ${cmd} attempt ${attemptNum}/${totalAttempts} matched=${matched}, backoff ${backoff}ms before next try\n`)
      await sleep(backoff)
    } finally {
      clearTimeout(timer)
    }
  }
  // Unreachable — the loop always returns or throws.
  throw new LinearError(`spawnLinear: loop exited without result for ${cmd}`)
}

// ---- New-issues shape -----------------------------------------------------

export interface LinearIssueNode {
  id: string           // UUID
  identifier: string   // "C-758"
  title: string | null
  labels: { nodes: Array<{ name: string }> } | null
  url: string | null
}

function isLabelsShape(v: unknown): v is { nodes: Array<{ name: string }> } {
  if (v == null || typeof v !== 'object') return false
  const nodes = (v as Record<string, unknown>).nodes
  return Array.isArray(nodes)
}

// Linear's GraphQL connections default to `first: 50` when the arg is
// omitted, so both queries below pass `first`/`after` explicitly and
// `fetchTeamOpenIssues` walks `pageInfo` until exhausted.
const TEAM_OPEN_ISSUES_QUERY = `query($teamKey: String!, $first: Int!, $after: String) {
  teams(filter: { key: { eq: $teamKey } }) {
    nodes {
      issues(filter: { state: { type: { nin: ["completed", "canceled"] } } }, first: $first, after: $after) {
        nodes { id identifier title labels { nodes { name } } url }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`

// Project-scoped variant — the project-existence check rides the same round
// trip as each issue page, and the connection pages like the unscoped query.
const TEAM_PROJECT_OPEN_ISSUES_QUERY = `query($teamKey: String!, $projectName: String!, $first: Int!, $after: String) {
  teams(filter: { key: { eq: $teamKey } }) {
    nodes {
      projects(filter: { name: { eq: $projectName } }) {
        nodes { id }
      }
      issues(filter: { state: { type: { nin: ["completed", "canceled"] } }, project: { name: { eq: $projectName } } }, first: $first, after: $after) {
        nodes { id identifier title labels { nodes { name } } url }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`

// Linear's per-page max; matches `ATTACHMENT_PAGE_SIZE` in linear-link.ts.
const TEAM_ISSUES_PAGE_SIZE = 250

// Backstop against a stuck/repeating cursor spinning a dispatcher tick
// forever against the API. `fetchTeamOpenIssues` warns and stops paginating
// if this is exceeded — 100 pages at TEAM_ISSUES_PAGE_SIZE is 25,000 issues,
// far past any real team.
export const MAX_ISSUE_PAGES = 100

// Result of `fetchTeamOpenIssues`. `team-not-found`/`project-not-found` are
// distinct so callers can emit the right "renamed or deleted?" warning text —
// a team typo and a project typo look the same to a user staring at silence.
export type FetchTeamIssuesResult =
  | { kind: 'team-not-found' }
  | { kind: 'project-not-found' }
  | { kind: 'ok'; issues: LinearIssueNode[] }

function parseIssueNodes(nodes: unknown[]): LinearIssueNode[] {
  return nodes
    .filter((n): n is Record<string, unknown> => n != null && typeof n === 'object')
    .map(n => ({
      id: typeof n.id === 'string' ? n.id : '',
      identifier: typeof n.identifier === 'string' ? n.identifier : '',
      title: typeof n.title === 'string' ? n.title : null,
      labels: isLabelsShape(n.labels) ? n.labels : null,
      url: typeof n.url === 'string' ? n.url : null,
    }))
    .filter(n => n.id && n.identifier)
}

// ---- Probe shape ----------------------------------------------------------

export interface LinearProbeResult {
  viewer: { id: string; name: string | null; email: string | null }
  organization: { name: string; urlKey: string | null }
  teams: Array<{ id: string; key: string }>
}

const PROBE_QUERY = `query {
  viewer { id name email }
  organization { name urlKey }
  teams(first: 50) { nodes { id key } }
}`

// Per-plugin handle owning the PluginLogger. All HTTP traffic lands in
// `spawnLinear` via `graphql()`, so retry stays universal. Slices 2/3 inject
// `apiKey` via DI; the env-read lives in the `fromEnv` factory.
export class LinearClient {
  private _lastRateLimit: RateLimitInfo | null = null
  // First response without recognized rate-limit headers triggers a WARN so
  // the silent-predictor failure mode is detectable. Cleared once a recognized
  // shape arrives — a later regression in header detection still WARNs.
  private _missingHeadersWarned = false

  constructor(
    private readonly apiKey: string,
    private readonly log: PluginLogger,
    private readonly deps: Omit<LinearSpawnDeps, 'log'> = {},
  ) {
    if (!apiKey) {
      throw new LinearError(`LinearClient: apiKey required (caller passed empty string)`)
    }
  }

  // Factory: read `LINEAR_API_KEY` from env. Single env-touching path so
  // env-coupling lives in one place (consumers + tests construct via
  // `new LinearClient(key, log)` directly).
  static fromEnv(log: PluginLogger, deps: Omit<LinearSpawnDeps, 'log'> = {}): LinearClient {
    const key = process.env.LINEAR_API_KEY
    if (!key) throw new LinearError(MISSING_KEY_MESSAGE)
    return new LinearClient(key, log, deps)
  }

  getLastRateLimit(): RateLimitInfo | null {
    return this._lastRateLimit
  }

  async graphql(query: string, variables?: Record<string, unknown>): Promise<unknown> {
    const result = await spawnLinear(this.apiKey, query, variables, { log: this.log, ...this.deps })
    if (result.rateLimit) {
      this._lastRateLimit = result.rateLimit
      this._missingHeadersWarned = false
    } else if (!this._missingHeadersWarned) {
      this._missingHeadersWarned = true
      this.log(
        `[ratelimit] WARN: linear response had no recognized rate-limit headers — predictor will not fire. ` +
        `Inspect observed headers and update REMAINING_HEADERS/LIMIT_HEADERS/RESET_HEADERS in linear-api.ts. ` +
        `Observed rate-limit-shaped headers: ${JSON.stringify(filterRateLimitHeaders(result.headers))}\n`,
      )
    }
    return result.body.data
  }

  // Fetch open (not completed, not canceled) issues for a team identified by
  // key (e.g. "C", "MAR"), optionally scoped to a Linear project name within
  // that team. `team-not-found` covers a renamed/deleted team key;
  // `project-not-found` covers a renamed/deleted/typo'd project name within
  // an otherwise-valid team; `ok` (possibly with an empty `issues` array)
  // covers everything resolving cleanly.
  async fetchTeamOpenIssues(teamKey: string, linearProject?: string): Promise<FetchTeamIssuesResult> {
    type TeamNode = { projects?: { nodes?: unknown[] }; issues?: { nodes?: unknown[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } } }
    const query = linearProject ? TEAM_PROJECT_OPEN_ISSUES_QUERY : TEAM_OPEN_ISSUES_QUERY
    const baseVars: Record<string, unknown> = linearProject ? { teamKey, projectName: linearProject } : { teamKey }

    const allNodes: unknown[] = []
    let after: string | undefined
    for (let page = 0; page < MAX_ISSUE_PAGES; page++) {
      const data = (await this.graphql(query, { ...baseVars, first: TEAM_ISSUES_PAGE_SIZE, after })) as {
        teams?: { nodes?: TeamNode[] }
      } | undefined | null
      const teamNode = data?.teams?.nodes?.[0]
      // A not-found verdict is only trustworthy on the first page — mid-walk,
      // a vanished team node or an empty projects list is a transient
      // anomaly, not a renamed/deleted team or project. Treating it as
      // not-found there would both discard the pages already collected and
      // tell an operator to unwatch something healthy.
      if (!teamNode) {
        if (page === 0) return { kind: 'team-not-found' }
        this.log(`[linear-new-issues] WARN: team "${teamKey}" issues query lost the team node mid-pagination (page ${page + 1}) — stopping with a partial result.\n`)
        break
      }
      if (linearProject && (teamNode.projects?.nodes ?? []).length === 0) {
        if (page === 0) return { kind: 'project-not-found' }
        this.log(`[linear-new-issues] WARN: team "${teamKey}" project "${linearProject}" query lost the project mid-pagination (page ${page + 1}) — stopping with a partial result.\n`)
        break
      }
      allNodes.push(...(teamNode.issues?.nodes ?? []))
      const pageInfo = teamNode.issues?.pageInfo
      if (!pageInfo?.hasNextPage) break
      if (!pageInfo.endCursor) {
        // `hasNextPage: true` with no cursor to follow it — the same silent-
        // truncation shape as the original bug (an incomplete issue set that
        // looks complete). Warn loudly rather than return a partial set
        // unremarked; see linear-link.ts's ATTACHMENT_PAGE_SIZE warn for the
        // house pattern.
        this.log(`[linear-new-issues] WARN: team "${teamKey}" issues query returned hasNextPage=true with no endCursor (page ${page + 1}) — stopping with a partial result.\n`)
        break
      }
      after = pageInfo.endCursor
      if (page === MAX_ISSUE_PAGES - 1) {
        this.log(`[linear-new-issues] WARN: team "${teamKey}" issues query exceeded ${MAX_ISSUE_PAGES} pages — stopping with a partial result.\n`)
      }
    }
    return { kind: 'ok', issues: parseIssueNodes(allNodes) }
  }

  // Boot probe: confirms auth + identifies the workspace and teams. Throws
  // `LinearAuthError` on 401 so the dispatcher boot can fatal cleanly. The
  // success log shape is intentional — `<name> (<email>) in <org>, teams:[...]`
  // lets operators spot wrong-key-but-valid-auth (service account matching the
  // wrong user). `name` may be null in Linear; the email-in-log refinement
  // guards against that.
  async probe(): Promise<LinearProbeResult> {
    const data = (await this.graphql(PROBE_QUERY)) as {
      viewer?: { id?: string; name?: string | null; email?: string | null }
      organization?: { name?: string; urlKey?: string | null }
      teams?: { nodes?: Array<{ id?: string; key?: string }> }
    } | undefined | null
    const viewer = data?.viewer
    const organization = data?.organization
    const teamNodes = data?.teams?.nodes ?? []
    if (!viewer?.id || !organization?.name) {
      throw new LinearError('linear probe returned unexpected shape (missing viewer.id or organization.name)')
    }
    const teams = teamNodes
      .filter(n => n.id && n.key)
      .map(n => ({ id: n.id as string, key: n.key as string }))
    const result: LinearProbeResult = {
      viewer: { id: viewer.id, name: viewer.name ?? null, email: viewer.email ?? null },
      organization: { name: organization.name, urlKey: organization.urlKey ?? null },
      teams,
    }
    const nameStr = result.viewer.name ?? '(no name)'
    const emailStr = result.viewer.email ?? '(no email)'
    const teamKeys = result.teams.map(t => t.key).sort().join(', ')
    this.log(`linear: authenticated as ${nameStr} (${emailStr}) in ${result.organization.name}, teams: [${teamKeys}]\n`)
    return result
  }
}
