import type { PluginLogger } from '../../plugin.js'
import type { RateLimitInfo } from '../_rate-limit.js'

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
  return e instanceof GhError && isRateLimitStderr(e.stderr)
}

// Expected/transient gh error class the per-entry readEntry path skips with a
// cooldown-gated note (vs failing the whole tick): a 404 that survived its
// retries, or any network/server transient that exhausted its retries.
export function isExpectedTransientError(e: unknown): boolean {
  return e instanceof GhError && (HTTP_404.test(e.stderr) || classifyTransient(e.stderr) != null)
}

export class GhError extends Error {
  readonly stderr: string
  readonly attempts: number
  constructor(msg: string, stderr = '', attempts = 1) {
    super(msg)
    this.name = 'GhError'
    this.stderr = stderr
    this.attempts = attempts
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

export interface GhCheckRun {
  status?: string
  conclusion?: string
}

export interface GhStatus {
  state?: string
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

export interface GhPr {
  title?: string
  html_url?: string
  draft?: boolean
  merged_at?: string | null
  state?: string
  labels?: GhLabel[]
  head?: { ref?: string; sha?: string }
}

export interface GhIssue {
  title?: string
  html_url?: string
  state?: string
  labels?: GhLabel[]
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

export interface FetchedPr {
  title: string | null
  url: string | null
  head_ref: string | null
  head_oid: string | null
  is_draft: boolean
  merged_at: string | null
  state: string | null
  labels: GhLabel[]
  ci_state: string | null
}

export function aggregateCi(runs: GhCheckRun[], statuses: GhStatus[]): string | null {
  const states = new Set<string>()
  for (const run of runs) {
    const status = (run.status ?? '').toUpperCase()
    if (['IN_PROGRESS', 'QUEUED', 'PENDING', 'WAITING'].includes(status)) {
      states.add('PENDING')
      continue
    }
    const conclusion = (run.conclusion ?? '').toUpperCase()
    if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(conclusion)) states.add('SUCCESS')
    else if (['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(conclusion)) states.add('FAILURE')
    else states.add('PENDING')
  }
  for (const st of statuses) {
    const s = (st.state ?? '').toUpperCase()
    if (s === 'SUCCESS') states.add('SUCCESS')
    else if (['FAILURE', 'ERROR'].includes(s)) states.add('FAILURE')
    else states.add('PENDING')
  }
  if (states.size === 0) return null
  if (states.has('FAILURE')) return 'FAILURE'
  if (states.has('PENDING')) return 'PENDING'
  return 'SUCCESS'
}

export function labelNames(labels: GhLabel[] | null | undefined): string[] {
  if (!labels) return []
  return labels
    .map(l => (typeof l === 'string' ? l : l.name ?? ''))
    .filter(Boolean)
    .sort()
}

// Per-plugin handle owning the PluginLogger. Every fetch lands in spawnGh via
// the private api()/graphql() helpers, so retry stays universal.
export class GhClient {
  constructor(private readonly log: PluginLogger) {}

  private async api(endpoint: string, paginate = false): Promise<unknown> {
    const args = ['api']
    if (paginate) args.push('--paginate')
    args.push(endpoint)
    return spawnGh(args, { log: this.log })
  }

  private async graphql(query: string, vars: Record<string, string | number>): Promise<unknown> {
    const args: string[] = ['api', 'graphql', '-f', `query=${query}`]
    for (const [k, v] of Object.entries(vars)) {
      args.push('-F', `${k}=${v}`)
    }
    return spawnGh(args, { log: this.log })
  }

  async fetchPr(repo: string, number: number): Promise<FetchedPr> {
    const pr = (await this.api(`repos/${repo}/pulls/${number}`) ?? {}) as GhPr
    const head = pr.head ?? {}
    const sha = head.sha

    let runs: GhCheckRun[] = []
    let statuses: GhStatus[] = []
    if (sha) {
      const checkResp = await this.api(`repos/${repo}/commits/${sha}/check-runs?per_page=100`, true)
      if (checkResp && typeof checkResp === 'object' && !Array.isArray(checkResp)) {
        runs = ((checkResp as Record<string, unknown>).check_runs ?? []) as GhCheckRun[]
      } else if (Array.isArray(checkResp)) {
        runs = checkResp as GhCheckRun[]
      }
      const combined = (await this.api(`repos/${repo}/commits/${sha}/status`) ?? {}) as Record<string, unknown>
      statuses = (combined.statuses ?? []) as GhStatus[]
    }

    return {
      title: pr.title ?? null,
      url: pr.html_url ?? null,
      head_ref: head.ref ?? null,
      head_oid: sha ?? null,
      is_draft: Boolean(pr.draft),
      merged_at: pr.merged_at ?? null,
      state: pr.state ? pr.state.toUpperCase() : null,
      labels: pr.labels ?? [],
      ci_state: aggregateCi(runs, statuses),
    }
  }

  async fetchPrReviewComments(repo: string, number: number): Promise<GhComment[]> {
    return (await this.api(`repos/${repo}/pulls/${number}/comments?per_page=100`, true) ?? []) as GhComment[]
  }

  async fetchPrConversationComments(repo: string, number: number): Promise<GhComment[]> {
    return (await this.api(`repos/${repo}/issues/${number}/comments?per_page=100`, true) ?? []) as GhComment[]
  }

  async fetchPrReviews(repo: string, number: number): Promise<GhReview[]> {
    return (await this.api(`repos/${repo}/pulls/${number}/reviews?per_page=100`, true) ?? []) as GhReview[]
  }

  // `closingIssuesReferences` can cross repos, so each entry carries its own
  // repo (load-bearing for routing). Sorted by `(repo, number)`.
  async fetchPrLinkedIssues(repo: string, number: number): Promise<Array<{ repo: string; number: number }>> {
    const [owner, name] = repo.split('/', 2)
    const query = (
      'query($owner:String!,$name:String!,$number:Int!){' +
      'repository(owner:$owner,name:$name){' +
      'pullRequest(number:$number){' +
      'closingIssuesReferences(first:25){nodes{number,repository{nameWithOwner}}}}}}'
    )
    const result = await this.graphql(query, { owner, name, number })
    if (!result) return []
    const r = result as Record<string, unknown>
    const nodes = (
      ((r.data as Record<string, unknown> | undefined)?.repository as Record<string, unknown> | undefined)
        ?.pullRequest as Record<string, unknown> | undefined
    )?.closingIssuesReferences as { nodes?: Array<{ number?: number; repository?: { nameWithOwner?: string } }> } | undefined
    return (nodes?.nodes ?? [])
      .filter(n => n.number != null && n.repository?.nameWithOwner)
      .map(n => ({ repo: n.repository!.nameWithOwner as string, number: n.number as number }))
      .sort((a, b) => a.repo === b.repo ? a.number - b.number : a.repo.localeCompare(b.repo))
  }

  async fetchIssue(repo: string, number: number): Promise<GhIssue> {
    return (await this.api(`repos/${repo}/issues/${number}`) ?? {}) as GhIssue
  }

  async fetchIssueComments(repo: string, number: number): Promise<GhComment[]> {
    return (await this.api(`repos/${repo}/issues/${number}/comments?per_page=100`, true) ?? []) as GhComment[]
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
}
