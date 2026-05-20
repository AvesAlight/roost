import type { PluginLogger } from '../../plugin.js'

// Stderr patterns we retry on. 404/401/422/etc. throw on first attempt; 422
// is logged verbatim in spawnGh so a 422-as-race shows in dispatcher logs.
const TRANSIENT_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /HTTP 5\d\d/i, label: 'http-5xx' },
  { re: /HTTP 429/i, label: 'http-429-rate-limit' },
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

function classifyTransient(stderr: string): string | null {
  for (const { re, label } of TRANSIENT_PATTERNS) {
    if (re.test(stderr)) return label
  }
  return null
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
      if (HTTP_422.test(e.stderr)) {
        log(`gh-retry: ${cmd} HTTP 422 (non-transient) — stderr verbatim:\n${e.stderr}\n`)
        throw e
      }
      const matched = classifyTransient(e.stderr)
      if (!matched) throw e
      const attemptNum = i + 1
      if (attemptNum >= totalAttempts) {
        log(`gh-retry: ${cmd} exhausted ${totalAttempts} attempts (matched=${matched}) — stderr verbatim:\n${e.stderr}\n`)
        throw new GhError(`${e.message}\n(after ${totalAttempts} retries)`, e.stderr, totalAttempts)
      }
      const backoff = Math.round(baseMs * Math.pow(2, i) * (1 + random() * jitterFraction))
      log(`gh-retry: ${cmd} attempt ${attemptNum}/${totalAttempts} matched=${matched}, backoff ${backoff}ms before next try\n`)
      await sleep(backoff)
    }
  }
  // Unreachable — the loop always returns or throws.
  throw new GhError(`spawnGh: loop exited without result for ${cmd}`)
}

// ---- Rate limit observability ----------------------------------------------

export interface RateLimitInfo {
  remaining: number
  limit: number
  resetAt: number  // unix seconds
}

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

// 5 minute rolling window — stable cross-tick average without missing spikes.
export const RATE_LIMIT_WINDOW_MS = 5 * 60_000

// Returns a warning string when the rolling rate predicts exhaustion before
// reset; null otherwise. `history` is window-pruned by the caller, oldest first.
export function computeRateLimitWarning(
  current: RateLimitInfo,
  history: ReadonlyArray<{ remaining: number; ts: number }>,
  now: number
): string | null {
  if (history.length === 0) return null
  const anchor = history[0]
  const consumed = anchor.remaining - current.remaining
  if (consumed <= 0) return null
  const intervalMs = now - anchor.ts
  if (intervalMs <= 0) return null
  // Need at least half the window before trusting the rate estimate.
  if (intervalMs < RATE_LIMIT_WINDOW_MS / 2) return null
  const ratePerMin = consumed / (intervalMs / 60_000)
  const minToReset = (current.resetAt * 1000 - now) / 60_000
  if (minToReset <= 0) return null
  const minToExhaustion = current.remaining / ratePerMin
  if (minToExhaustion >= minToReset) return null
  const exhaustionStr = minToExhaustion < 1
    ? `${Math.round(minToExhaustion * 60)}s`
    : `${Math.round(minToExhaustion)}m`
  return (
    `[dispatcher] GH rate limit warning: ${current.remaining} calls remaining,` +
    ` reset in ${Math.round(minToReset)}m,` +
    ` current rate ~${Math.round(ratePerMin)}/min —` +
    ` projected exhaustion in ${exhaustionStr}`
  )
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
