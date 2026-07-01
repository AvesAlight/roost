import type { PluginLogger } from '../../plugin.js'
import type { RateLimitInfo } from '../_rate-limit.js'
import type { RateLimitKind } from './backoff.js'

// Stderr patterns we retry on (network/server transients). Rate-limit and 404
// are handled separately below — rate-limit fails fast (the caller's breaker
// owns the backoff schedule); 404 retries on a shorter base since an upstream
// edge-flap clears on the next request, not after server recovery. 422 throws
// on first attempt, logged verbatim so a 422-as-race shows in dispatcher logs.
//
// 401 (`gh: Bad credentials (HTTP 401)`) is here because GitHub intermittently
// 401s a valid token — an internal auth service hiccup the API facade surfaces
// as 401, cleared by the next request. We retry it like any transient rather
// than crash the tick; a genuinely-revoked token still surfaces via the
// per-entry consecutive-failure warn note (it just persists past the threshold).
const TRANSIENT_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /HTTP 5\d\d/i, label: 'http-5xx' },
  { re: /HTTP 401/i, label: 'http-401' },
  { re: /\btimed out\b/i, label: 'timeout' },
  { re: /\bcontext deadline exceeded\b/i, label: 'timeout' },
  { re: /\bi\/o timeout\b/i, label: 'timeout' },
  { re: /\bconnection refused\b/i, label: 'connection-refused' },
  { re: /\bconnection reset\b/i, label: 'connection-reset' },
  { re: /\bno such host\b/i, label: 'dns' },
  { re: /\bnetwork is unreachable\b/i, label: 'network-unreachable' },
  { re: /\bEOF\b/, label: 'eof' },
]

const HTTP_422 = /HTTP 422/i
const HTTP_404 = /HTTP 404/i
const HTTP_403 = /HTTP 403/i
const HTTP_401 = /HTTP 401/i
const HTTP_429 = /HTTP 429/i
const RATE_LIMIT_MSG = /rate limit|secondary rate/i
// The burst/abuse limiter (fires with core budget still remaining). GH phrases
// it as "secondary rate limit"; older responses said "abuse detection".
const SECONDARY_RATE_MSG = /secondary rate|abuse/i

function classifyTransient(stderr: string): string | null {
  for (const { re, label } of TRANSIENT_PATTERNS) {
    if (re.test(stderr)) return label
  }
  return null
}

// Short operator-facing reason for a read that keeps failing, derived from gh
// stderr. Surfaces the distinguishing *action* so a reader doesn't have to dig
// the dispatcher log: rotate the token (401), unwatch a dead repo (404), fix
// token scopes (403), file a query bug (422), or ride out a GitHub flake.
// Called only after the rate-limit branch, so a 403 here is the permission kind,
// not a rate-limit 403. Fed into the cooldown-gated warn note.
export function describeReadFailure(stderr: string): string {
  if (HTTP_401.test(stderr)) return 'auth rejected (HTTP 401), rotate token if it persists'
  if (HTTP_404.test(stderr)) return 'deleted/renamed (HTTP 404)'
  if (HTTP_403.test(stderr)) return 'permission denied (HTTP 403), check token scopes'
  if (HTTP_422.test(stderr)) return 'validation failed (HTTP 422), likely a query bug'
  const label = classifyTransient(stderr)
  if (label) return `GH flaking (${label})`
  const firstLine = stderr.split('\n').map(s => s.trim()).find(Boolean)
  return firstLine ? `gh error: ${firstLine}` : 'gh read failed'
}

// Rate-limit = HTTP 429, or HTTP 403 carrying a rate-limit message (primary or
// secondary). A 403 without that message is a real permission error and is left
// to throw. Retrying a rate-limit in-loop just burns the budget we're limited
// on, so spawnGh fails fast and the caller's breaker applies the backoff.
function isRateLimitStderr(stderr: string): boolean {
  if (HTTP_429.test(stderr)) return true
  return HTTP_403.test(stderr) && RATE_LIMIT_MSG.test(stderr)
}

export function isRateLimitError(e: unknown): boolean {
  return e instanceof GhError && (e.rateLimited || isRateLimitStderr(e.stderr))
}

// Secondary (burst/abuse) vs primary (budget) rate limit. The two get different
// backoff schedules — secondary clears in ~a minute, primary waits for the
// budget reset. Anything rate-limit-shaped that isn't tagged secondary is
// treated as primary (the conservative, longer backoff). Only meaningful when
// isRateLimitError(e) is already true.
export function rateLimitKind(e: GhError): RateLimitKind {
  return SECONDARY_RATE_MSG.test(e.stderr) ? 'secondary' : 'primary'
}

// GraphQL statusCheckRollup.state → our ci_state vocabulary (null | PENDING |
// SUCCESS | FAILURE). The rollup is what GitHub's own UI shows: it reflects the
// latest run per check. A naive OR over the REST check-runs list also sees
// superseded/re-run entries, so a re-run PR can stick at a stale FAILURE there;
// the rollup reports SUCCESS. Mapping: ERROR (a commit-status error) folds into
// FAILURE; EXPECTED (a required check not yet reported) folds into PENDING; a
// commit with no checks has a null rollup → null. Unknown future enum values map
// to null (no terminal signal) rather than risk a false SUCCESS/FAILURE transition.
export function rollupToCiState(state: string | null | undefined): string | null {
  switch (state) {
    case 'SUCCESS': return 'SUCCESS'
    case 'FAILURE': return 'FAILURE'
    case 'ERROR': return 'FAILURE'
    case 'PENDING': return 'PENDING'
    case 'EXPECTED': return 'PENDING'
    default: return null
  }
}

export class GhError extends Error {
  readonly stderr: string
  readonly attempts: number
  // Set when the error is a known rate-limit that carries no 403/429 in stderr to
  // classify off — the GraphQL RATE_LIMITED case (HTTP 200 with an error node).
  // Lets isRateLimitError recognize it without a fabricated status string.
  readonly rateLimited: boolean
  constructor(msg: string, stderr = '', attempts = 1, rateLimited = false) {
    super(msg)
    this.name = 'GhError'
    this.stderr = stderr
    this.attempts = attempts
    this.rateLimited = rateLimited
  }
}

// Default SpawnDeps.exec — runs gh once, parses output, throws GhError on
// non-zero exit. Tests inject a fake to avoid spawning a real gh.
async function runGhOnce(args: string[]): Promise<unknown> {
  const proc = Bun.spawn(['gh', ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [out, errOut] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    throw new GhError(
      `gh failed (exit ${exitCode}): gh ${args.join(' ')}\n${errOut.trim()}`,
      errOut
    )
  }
  const trimmed = out.trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    return trimmed
  }
}

// Envelope returned by a `gh api graphql` batch: partial `data` plus per-alias
// `errors`. gh exits non-zero whenever any alias errors, so the default
// exec (runGhOnce) would throw and discard the resolved aliases. This exec keeps
// stdout on a non-zero exit when a parseable GraphQL body is present, so
// per-entry isolation survives one bad alias (verified: gh exits 1 but still
// writes the full {data, errors} body to stdout). A non-zero exit with no usable
// body (rate-limit / auth / network) throws, routing back through spawnGh's
// retry + rate-limit classification.
async function runGhGraphqlBatchOnce(args: string[]): Promise<unknown> {
  const proc = Bun.spawn(['gh', ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [out, errOut] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const exitCode = await proc.exited
  const trimmed = out.trim()
  let parsed: unknown = null
  if (trimmed) {
    try { parsed = JSON.parse(trimmed) } catch { parsed = null }
  }
  if (exitCode === 0) return parsed
  if (parsed && typeof parsed === 'object' && 'data' in (parsed as Record<string, unknown>)) {
    return parsed
  }
  throw new GhError(
    `gh failed (exit ${exitCode}): gh ${args.join(' ')}\n${errOut.trim()}`,
    errOut
  )
}

export interface SpawnDeps {
  // log is required — every gh call gets a real sink.
  log: PluginLogger
  // Injectable for tests (no real sleeps/gh, deterministic jitter).
  sleep?: (ms: number) => Promise<void>
  attempts?: number          // total tries; default 3
  baseMs?: number            // first backoff; default 1000
  notFoundBaseMs?: number    // first backoff for 404 retries; default 250
  jitterFraction?: number    // backoff *= 1 + random()*jitterFraction; default 0.5
  random?: () => number      // 0..1; default Math.random
  exec?: (args: string[]) => Promise<unknown>  // default runGhOnce
}

const defaultSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

export async function spawnGh(args: string[], deps: SpawnDeps): Promise<unknown> {
  const sleep = deps.sleep ?? defaultSleep
  const log = deps.log
  const totalAttempts = deps.attempts ?? 3
  const baseMs = deps.baseMs ?? 1000
  const notFoundBaseMs = deps.notFoundBaseMs ?? 250
  const jitterFraction = deps.jitterFraction ?? 0.5
  const random = deps.random ?? Math.random
  const exec = deps.exec ?? runGhOnce

  const cmd = `gh ${args.join(' ')}`
  for (let i = 0; i < totalAttempts; i++) {
    try {
      return await exec(args)
    } catch (e) {
      // Non-GhError = upstream contract bug (missing gh, spawn crash) — bypass retry.
      if (!(e instanceof GhError)) throw e
      // Rate-limit fails fast — retrying burns the budget we're limited on. The
      // caller's breaker owns the minutes-scale backoff.
      if (isRateLimitStderr(e.stderr)) {
        log(`gh-retry: ${cmd} rate-limited (not retried here) — stderr verbatim:\n${e.stderr}\n`)
        throw e
      }
      if (HTTP_422.test(e.stderr)) {
        log(`gh-retry: ${cmd} HTTP 422 (non-transient) — stderr verbatim:\n${e.stderr}\n`)
        throw e
      }
      const is404 = HTTP_404.test(e.stderr)
      const matched = is404 ? 'http-404' : classifyTransient(e.stderr)
      if (!matched) throw e
      const attemptNum = i + 1
      if (attemptNum >= totalAttempts) {
        log(`gh-retry: ${cmd} exhausted ${totalAttempts} attempts (matched=${matched}) — stderr verbatim:\n${e.stderr}\n`)
        throw new GhError(`${e.message}\n(after ${totalAttempts} retries)`, e.stderr, totalAttempts)
      }
      const backoff = Math.round((is404 ? notFoundBaseMs : baseMs) * Math.pow(2, i) * (1 + random() * jitterFraction))
      log(`gh-retry: ${cmd} attempt ${attemptNum}/${totalAttempts} matched=${matched}, backoff ${backoff}ms before next try\n`)
      await sleep(backoff)
    }
  }
  // Unreachable — the loop always returns or throws.
  throw new GhError(`spawnGh: loop exited without result for ${cmd}`)
}

// ---- Rate limit observability ----------------------------------------------

// `gh api /rate_limit` — exempt endpoint, no token cost. `attempts: 1` because
// retries would burn the budget we're trying to measure. Null on any failure.
export async function fetchRateLimit(
  log: PluginLogger,
  deps?: Partial<SpawnDeps>
): Promise<RateLimitInfo | null> {
  try {
    // `attempts: 1` is last so deps can't accidentally override it.
    const raw = await spawnGh(['api', '/rate_limit'], { log, ...deps, attempts: 1 })
    if (raw == null || typeof raw !== 'object') return null
    const resp = raw as Record<string, unknown>
    const rate = resp.rate as { remaining?: number; limit?: number; reset?: number } | undefined
    if (!rate || rate.remaining == null || rate.limit == null || rate.reset == null) return null
    return { remaining: rate.remaining, limit: rate.limit, resetAt: rate.reset }
  } catch {
    return null
  }
}

export interface GhLabel {
  name?: string
}

export interface GhComment {
  id?: number
  html_url?: string
  user?: { login?: string }
  body?: string
  path?: string
  line?: number
  original_line?: number
}

export interface GhReview {
  id?: number
  html_url?: string
  user?: { login?: string }
  body?: string
  state?: string
}

// `/repos/{owner}/{repo}/issues` returns both issues and PRs — `pull_request`
// is the marker for filtering PRs out (see fetchRepoOpenIssues).
export interface GhRepoIssue {
  number?: number
  title?: string
  html_url?: string
  state?: string
  labels?: GhLabel[]
  pull_request?: Record<string, unknown>
}

export interface GhRepoPr {
  number?: number
  title?: string
  html_url?: string
  labels?: GhLabel[]
  user?: { login?: string }
}

// `/repos/{owner}/{repo}/commits` returns newest-first. We only consume sha,
// html_url, and the message subject — the rest stays untyped vs schema drift.
export interface GhCommit {
  sha?: string
  html_url?: string
  commit?: {
    message?: string
  }
}

export function labelNames(labels: GhLabel[] | null | undefined): string[] {
  if (!labels) return []
  return labels
    .map(l => (typeof l === 'string' ? l : l.name ?? ''))
    .filter(Boolean)
    .sort()
}

// ---- Batched GraphQL reads (one call per plugin per tick) ------------------
//
// The per-watch REST path cost ~6 requests per PR every tick; on a busy night
// that burst tripped GH's secondary (rate) limit. These batch all watched
// entries into a single aliased GraphQL query (e0, e1, …) so the tick costs one
// request regardless of watch count. Snapshots stay REST-shaped (databaseId →
// the numeric ids the diff keys on) so PrSnap/IssueSnap and diff.ts are unchanged.

// Newest-N cap per comment/review connection. A PR busier than this under-reads
// the older tail (the ids are already recorded as seen, so no false "new"
// events — just a one-tick blind spot on activity in very old threads). Surfaced
// as a WARN, not silently dropped; a paged fallback is a follow-up if it bites.
const BATCH_CONNECTION_CAP = 100

const PR_NODE_FIELDS = `
    number
    title
    url
    isDraft
    merged
    state
    headRefName
    headRefOid
    labels(first:100){ nodes{ name } }
    statusRollup: commits(last:1){ nodes{ commit{ statusCheckRollup{ state } } } }
    closingIssuesReferences(first:25){ nodes{ number repository{ nameWithOwner } } }
    reviews(last:${BATCH_CONNECTION_CAP}){ totalCount nodes{ databaseId url author{ login } body state } }
    comments(last:${BATCH_CONNECTION_CAP}){ totalCount nodes{ databaseId url author{ login } body } }
    reviewThreads(last:${BATCH_CONNECTION_CAP}){ totalCount nodes{ comments(first:${BATCH_CONNECTION_CAP}){ nodes{ databaseId url author{ login } body path line originalLine } } } }
`

const ISSUE_NODE_FIELDS = `
    number
    title
    url
    state
    labels(first:100){ nodes{ name } }
    comments(last:${BATCH_CONNECTION_CAP}){ totalCount nodes{ databaseId url author{ login } body } }
`

interface GqlComment {
  databaseId?: number
  url?: string
  author?: { login?: string } | null
  body?: string
  path?: string | null
  line?: number | null
  originalLine?: number | null
}
interface GqlReview {
  databaseId?: number
  url?: string
  author?: { login?: string } | null
  body?: string
  state?: string
}
interface GqlConnection<T> { totalCount?: number; nodes?: T[] }

export interface GhPrNode {
  number?: number
  title?: string | null
  url?: string | null
  isDraft?: boolean
  merged?: boolean
  state?: string | null
  headRefName?: string | null
  headRefOid?: string | null
  labels?: { nodes?: GhLabel[] }
  statusRollup?: { nodes?: Array<{ commit?: { statusCheckRollup?: { state?: string } | null } }> }
  closingIssuesReferences?: { nodes?: Array<{ number?: number; repository?: { nameWithOwner?: string } }> }
  reviews?: GqlConnection<GqlReview>
  comments?: GqlConnection<GqlComment>
  reviewThreads?: GqlConnection<{ comments?: GqlConnection<GqlComment> }>
}

export interface GhIssueNode {
  number?: number
  title?: string | null
  url?: string | null
  state?: string | null
  labels?: { nodes?: GhLabel[] }
  comments?: GqlConnection<GqlComment>
}

// Per-entry result of a batch read: the resolved node, or a per-alias failure
// (one bad entry — 404/renamed/forbidden — never sinks its siblings). `reason`
// feeds the operator-facing read-failure note; `logDetail` goes to daemon.log.
export type BatchOutcome<T> =
  | { ok: true; node: T }
  | { ok: false; reason: string; logDetail: string }

interface GqlEnvelope {
  data?: Record<string, unknown> | null
  errors?: Array<{ type?: string; message?: string; path?: unknown }>
}

// GraphQL alias errors carry `path: [alias, ...]`; index the first (most
// specific already, since gh reports the failing field) error per alias.
function indexAliasErrors(errors: GqlEnvelope['errors']): Map<string, { type?: string; message?: string }> {
  const byAlias = new Map<string, { type?: string; message?: string }>()
  for (const err of errors ?? []) {
    const path = err.path
    const alias = Array.isArray(path) && typeof path[0] === 'string' ? path[0] : null
    if (alias && !byAlias.has(alias)) byAlias.set(alias, { type: err.type, message: err.message })
  }
  return byAlias
}

// Operator-facing reason for a per-alias batch miss, mirroring describeReadFailure's
// action-first phrasing. A null node with no error is a nonexistent number.
function describeGraphqlAliasError(type: string | undefined, message: string | undefined): string {
  switch (type) {
    case 'NOT_FOUND': return 'deleted/renamed (not found)'
    case 'FORBIDDEN': return 'permission denied (forbidden), check token scopes'
    default:
      if (!type && !message) return 'not found (null result)'
      return message ? `graphql error: ${message.split('\n')[0]}` : `graphql error (${type})`
  }
}

// Per-alias envelope → outcomes. The load-bearing isolation step: one dead alias
// (deleted PR, renamed repo, forbidden) is a per-entry miss, never a thrown error
// that sinks its siblings. `pick` pulls the typed node
// out of an alias's data block (`.pullRequest` / `.issue`); a null/absent node
// with no matching error is a plain not-found. Pure and exported so the isolation
// can be tested against a crafted envelope without spawning gh.
export function mapBatchOutcomes<T>(
  env: GqlEnvelope,
  entries: ReadonlyArray<{ repo: string; number: number }>,
  pick: (aliasData: Record<string, unknown> | null | undefined) => T | null | undefined,
): Map<string, BatchOutcome<T>> {
  const results = new Map<string, BatchOutcome<T>>()
  const errByAlias = indexAliasErrors(env.errors)
  const data = (env.data ?? {}) as Record<string, Record<string, unknown> | null>
  entries.forEach((e, i) => {
    const key = `${e.repo}#${e.number}`
    const node = pick(data[`e${i}`])
    if (node != null) {
      results.set(key, { ok: true, node })
    } else {
      const err = errByAlias.get(`e${i}`)
      results.set(key, {
        ok: false,
        reason: describeGraphqlAliasError(err?.type, err?.message),
        logDetail: err ? `${err.type ?? 'error'}: ${err.message ?? ''}` : 'null result (not found)',
      })
    }
  })
  return results
}

// Per-plugin handle owning the PluginLogger. Every fetch lands in spawnGh (via
// the private api() helper or runBatchQuery), so retry stays universal.
export class GhClient {
  constructor(private readonly log: PluginLogger) {}

  private async api(endpoint: string, paginate = false): Promise<unknown> {
    const args = ['api']
    if (paginate) args.push('--paginate')
    args.push(endpoint)
    return spawnGh(args, { log: this.log })
  }

  // PR-stripped open-issue set (the endpoint returns both).
  async fetchRepoOpenIssues(repo: string): Promise<GhRepoIssue[]> {
    const raw = (await this.api(`repos/${repo}/issues?state=open&per_page=100`, true) ?? []) as GhRepoIssue[]
    return raw.filter(i => !i.pull_request)
  }

  async fetchRepoOpenPrs(repo: string): Promise<GhRepoPr[]> {
    return (await this.api(`repos/${repo}/pulls?state=open&per_page=100`, true) ?? []) as GhRepoPr[]
  }

  // Single page capped at `perPage` — multi-page bursts are caller-logged
  // (see GitHubCommitsPlugin).
  async fetchRepoCommits(
    repo: string,
    branch: string,
    path: string | undefined,
    perPage: number,
  ): Promise<GhCommit[]> {
    const params: string[] = [`sha=${encodeURIComponent(branch)}`, `per_page=${perPage}`]
    if (path) params.push(`path=${encodeURIComponent(path)}`)
    return (await this.api(`repos/${repo}/commits?${params.join('&')}`) ?? []) as GhCommit[]
  }

  // Run one aliased GraphQL query (retry via spawnGh's custom batch exec).
  // Throws a rate-limit GhError on a GraphQL RATE_LIMITED (primary budget, which
  // comes back HTTP 200 with an error) so the caller trips the breaker and
  // discards partial work — matching the secondary/403 path (thrown upstream).
  private async runBatchQuery(
    fieldsBuilder: (varSuffix: number) => string,
    entries: Array<{ repo: string; number: number }>,
  ): Promise<GqlEnvelope> {
    const decls: string[] = []
    const bodies: string[] = []
    const args: string[] = ['api', 'graphql']
    entries.forEach((e, i) => {
      const [owner, name] = e.repo.split('/', 2)
      decls.push(`$o${i}:String!,$n${i}:String!,$num${i}:Int!`)
      bodies.push(`e${i}: repository(owner:$o${i},name:$n${i}){ ${fieldsBuilder(i)} }`)
      args.push('-f', `o${i}=${owner ?? ''}`, '-f', `n${i}=${name ?? ''}`, '-F', `num${i}=${e.number}`)
    })
    const query = `query(${decls.join(',')}){ ${bodies.join(' ')} }`
    args.splice(2, 0, '-f', `query=${query}`)
    const raw = await spawnGh(args, { log: this.log, exec: runGhGraphqlBatchOnce })
    const env = (raw ?? {}) as GqlEnvelope
    if ((env.errors ?? []).some(e => e.type === 'RATE_LIMITED')) {
      // RATE_LIMITED comes back HTTP 200 with an error node, so there's no
      // 403/429 in stderr to classify off. Flag it explicitly rather than
      // fabricate a status string — a fake "HTTP 403" reads like a mistake a
      // cleanup could drop, silently killing breaker-on-primary-GraphQL-limit.
      throw new GhError('gh graphql: API rate limit exceeded (RATE_LIMITED)', '', 1, true)
    }
    return env
  }

  private warnTruncation(key: string, caps: Array<{ n: number | undefined; what: string }>): void {
    const over = caps.filter(c => (c.n ?? 0) > BATCH_CONNECTION_CAP).map(c => `${c.n} ${c.what}`)
    if (over.length) {
      this.log(
        `WARN github batch: ${key} has ${over.join(', ')} > ${BATCH_CONNECTION_CAP}/tick cap — ` +
        `only the newest ${BATCH_CONNECTION_CAP} are diffed; a paged fallback is needed if this persists\n`
      )
    }
  }

  // Batched PR read: one GraphQL call over every entry, isolated per alias.
  async fetchPrsBatch(entries: Array<{ repo: string; number: number }>): Promise<Map<string, BatchOutcome<GhPrNode>>> {
    if (!entries.length) return new Map()
    const env = await this.runBatchQuery(i => `pullRequest(number:$num${i}){ ${PR_NODE_FIELDS} }`, entries)
    const results = mapBatchOutcomes<GhPrNode>(env, entries, d => (d as { pullRequest?: GhPrNode | null } | null | undefined)?.pullRequest)
    for (const [key, outcome] of results) {
      if (!outcome.ok) continue
      this.warnTruncation(key, [
        { n: outcome.node.reviewThreads?.totalCount, what: 'review threads' },
        { n: outcome.node.comments?.totalCount, what: 'conversation comments' },
        { n: outcome.node.reviews?.totalCount, what: 'reviews' },
      ])
    }
    return results
  }

  // Batched issue read: mirror of fetchPrsBatch for the issues plugin.
  async fetchIssuesBatch(entries: Array<{ repo: string; number: number }>): Promise<Map<string, BatchOutcome<GhIssueNode>>> {
    if (!entries.length) return new Map()
    const env = await this.runBatchQuery(i => `issue(number:$num${i}){ ${ISSUE_NODE_FIELDS} }`, entries)
    const results = mapBatchOutcomes<GhIssueNode>(env, entries, d => (d as { issue?: GhIssueNode | null } | null | undefined)?.issue)
    for (const [key, outcome] of results) {
      if (outcome.ok) this.warnTruncation(key, [{ n: outcome.node.comments?.totalCount, what: 'comments' }])
    }
    return results
  }
}
