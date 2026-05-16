// Transient stderr classifier — patterns we'll retry on. Anything else
// (404/401/422/etc.) throws on the first attempt. 422 is logged verbatim
// in retryGh so a 422-as-race can be spotted in dispatcher logs.
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

async function spawnGh(args: string[]): Promise<unknown> {
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

export interface RetryDeps {
  // Each option is injectable so tests can pin behavior (no real sleeps, no
  // real gh, deterministic jitter).
  sleep?: (ms: number) => Promise<void>
  log?: (msg: string) => void
  attempts?: number          // total tries including the first; default 3
  baseMs?: number            // first backoff window; default 1000
  jitterFraction?: number    // backoff *= 1 + random()*jitterFraction; default 0.5
  random?: () => number      // 0..1; default Math.random
  exec?: (args: string[]) => Promise<unknown>  // default spawnGh
}

const defaultSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
// Retry diagnostics default to stderr. The daemon overrides this via
// setRetryLogger() to fan out to daemon.log too; one-shot modes (--dispatch-irc,
// plain CLI) keep the stderr-only default so output lands on the operator's tty.
let currentDefaultLog: (msg: string) => void = (msg) => { process.stderr.write(msg) }

export function setRetryLogger(fn: (msg: string) => void): void {
  currentDefaultLog = fn
}

export async function retryGh(args: string[], deps: RetryDeps = {}): Promise<unknown> {
  const sleep = deps.sleep ?? defaultSleep
  const log = deps.log ?? currentDefaultLog
  const totalAttempts = deps.attempts ?? 3
  const baseMs = deps.baseMs ?? 1000
  const jitterFraction = deps.jitterFraction ?? 0.5
  const random = deps.random ?? Math.random
  const exec = deps.exec ?? spawnGh

  const cmd = `gh ${args.join(' ')}`
  for (let i = 0; i < totalAttempts; i++) {
    try {
      return await exec(args)
    } catch (e) {
      if (!(e instanceof GhError)) throw e
      if (HTTP_422.test(e.stderr)) {
        log(`gh-retry: ${cmd} HTTP 422 (non-transient) — stderr verbatim:\n${e.stderr}\n`)
        throw new GhError(e.message, e.stderr, i + 1)
      }
      const matched = classifyTransient(e.stderr)
      if (!matched) throw new GhError(e.message, e.stderr, i + 1)
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
  // Unreachable.
  throw new GhError(`retryGh: loop exited without result for ${cmd}`)
}

async function ghApi(endpoint: string, paginate = false): Promise<unknown> {
  const args = ['api']
  if (paginate) args.push('--paginate')
  args.push(endpoint)
  return retryGh(args)
}

// Centralized so a future gh call can't slip past the retry wrapper.
async function ghGraphql(query: string, vars: Record<string, string | number>): Promise<unknown> {
  const args: string[] = ['api', 'graphql', '-f', `query=${query}`]
  for (const [k, v] of Object.entries(vars)) {
    args.push('-F', `${k}=${v}`)
  }
  return retryGh(args)
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

export async function fetchPr(repo: string, number: number): Promise<FetchedPr> {
  const pr = (await ghApi(`repos/${repo}/pulls/${number}`) ?? {}) as GhPr
  const head = pr.head ?? {}
  const sha = head.sha

  let runs: GhCheckRun[] = []
  let statuses: GhStatus[] = []
  if (sha) {
    const checkResp = await ghApi(`repos/${repo}/commits/${sha}/check-runs?per_page=100`, true)
    if (checkResp && typeof checkResp === 'object' && !Array.isArray(checkResp)) {
      runs = ((checkResp as Record<string, unknown>).check_runs ?? []) as GhCheckRun[]
    } else if (Array.isArray(checkResp)) {
      runs = checkResp as GhCheckRun[]
    }
    const combined = (await ghApi(`repos/${repo}/commits/${sha}/status`) ?? {}) as Record<string, unknown>
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

export async function fetchPrReviewComments(repo: string, number: number): Promise<GhComment[]> {
  return (await ghApi(`repos/${repo}/pulls/${number}/comments?per_page=100`, true) ?? []) as GhComment[]
}

export async function fetchPrConversationComments(repo: string, number: number): Promise<GhComment[]> {
  return (await ghApi(`repos/${repo}/issues/${number}/comments?per_page=100`, true) ?? []) as GhComment[]
}

export async function fetchPrReviews(repo: string, number: number): Promise<GhReview[]> {
  return (await ghApi(`repos/${repo}/pulls/${number}/reviews?per_page=100`, true) ?? []) as GhReview[]
}

export async function fetchPrLinkedIssues(repo: string, number: number): Promise<number[]> {
  const [owner, name] = repo.split('/', 2)
  const query = (
    'query($owner:String!,$name:String!,$number:Int!){' +
    'repository(owner:$owner,name:$name){' +
    'pullRequest(number:$number){' +
    'closingIssuesReferences(first:25){nodes{number}}}}}'
  )
  const result = await ghGraphql(query, { owner, name, number })
  if (!result) return []
  const r = result as Record<string, unknown>
  const nodes = (
    ((r.data as Record<string, unknown> | undefined)?.repository as Record<string, unknown> | undefined)
      ?.pullRequest as Record<string, unknown> | undefined
  )?.closingIssuesReferences as { nodes?: Array<{ number?: number }> } | undefined
  return (nodes?.nodes ?? [])
    .filter(n => n.number != null)
    .map(n => n.number as number)
    .sort((a, b) => a - b)
}

export async function fetchIssue(repo: string, number: number): Promise<GhIssue> {
  return (await ghApi(`repos/${repo}/issues/${number}`) ?? {}) as GhIssue
}

export async function fetchIssueComments(repo: string, number: number): Promise<GhComment[]> {
  return (await ghApi(`repos/${repo}/issues/${number}/comments?per_page=100`, true) ?? []) as GhComment[]
}
