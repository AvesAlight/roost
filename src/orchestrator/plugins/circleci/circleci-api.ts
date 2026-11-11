import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { PluginLogger } from '../../plugin.js'

// The only host the token is ever sent to. Every request URL is built from
// this constant plus validated path segments, never from a response field.
export const CIRCLECI_API = 'https://circleci.com/api/v2'
export const CIRCLECI_APP = 'https://app.circleci.com'

// Verbatim operator-facing messages, shared by thrown errors and the IRC notes.
export const MISSING_TOKEN_MESSAGE =
  'no CircleCI token: set CIRCLECI_TOKEN in the dispatcher env or `token:` in ~/.circleci/cli.yml.'
export const REJECTED_TOKEN_MESSAGE =
  'CircleCI rejected the token (HTTP 401/403). Verify the token is valid and can read the project.'

const DEFAULT_TIMEOUT_MS = 15_000
// Retry-After fallback when a 429 carries none, and the ceiling for a hostile or
// confused value, so a bad header can't park the plugin for hours.
const DEFAULT_RETRY_AFTER_MS = 60_000
const MAX_RETRY_AFTER_MS = 60 * 60_000

const SLUG_RE = /^gh\/[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/
const ID_RE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/

export class CircleCiError extends Error {
  readonly status: number | null
  // Short label for the error shape (`http-5xx`, `network`, ...) for daemon.log greps.
  readonly shape: string
  readonly attempts: number
  constructor(msg: string, opts: { status?: number | null; shape?: string; attempts?: number } = {}) {
    super(msg)
    this.name = 'CircleCiError'
    this.status = opts.status ?? null
    this.shape = opts.shape ?? 'unknown'
    this.attempts = opts.attempts ?? 1
  }
}

// No token configured. Distinct from a rejected token so the plugin can say
// which fix to make.
export class CircleCiMissingTokenError extends CircleCiError {
  constructor() {
    super(MISSING_TOKEN_MESSAGE, { shape: 'no-token' })
    this.name = 'CircleCiMissingTokenError'
  }
}

// HTTP 401/403: the token is wrong or lacks access. Non-transient.
export class CircleCiAuthError extends CircleCiError {
  constructor(status: number) {
    super(REJECTED_TOKEN_MESSAGE, { status, shape: `http-${status}` })
    this.name = 'CircleCiAuthError'
  }
}

// HTTP 404: a project slug typo, or a project the token can't see.
export class CircleCiNotFoundError extends CircleCiError {
  constructor(readonly path: string) {
    super(`CircleCI returned 404 for ${path}`, { status: 404, shape: 'http-404' })
    this.name = 'CircleCiNotFoundError'
  }
}

// HTTP 429. Never retried in-call: the caller skips the tick and waits out
// `retryAfterMs`.
export class CircleCiRateLimitError extends CircleCiError {
  constructor(readonly retryAfterMs: number) {
    super(`CircleCI rate-limited (HTTP 429), retry after ${Math.round(retryAfterMs / 1000)}s`, { status: 429, shape: 'http-429' })
    this.name = 'CircleCiRateLimitError'
  }
}

export interface CciPipeline {
  id: string
  number: number
  state?: string
  created_at?: string
  vcs?: { revision?: string; branch?: string; tag?: string }
}

export interface CciWorkflow {
  id: string
  name: string
  status: string
  created_at?: string
}

export interface CciJob {
  id?: string
  name: string
  status: string
  type?: string
  job_number?: number
  approval_request_id?: string
}

export interface CciPage<T> {
  items: T[]
  nextPageToken: string | null
}

export interface TokenDeps {
  env?: Record<string, string | undefined>
  homeDir?: string
  readFile?: (path: string) => Promise<string>
}

// `CIRCLECI_TOKEN`, else the top-level `token:` of ~/.circleci/cli.yml. Read at
// call time, not at import or construction, so a dispatcher can boot without a
// token and pick one up later. Null when neither source has a value.
export async function resolveToken(deps: TokenDeps = {}): Promise<string | null> {
  const envToken = (deps.env ?? process.env).CIRCLECI_TOKEN?.trim()
  if (envToken) return envToken
  const read = deps.readFile ?? ((p: string) => readFile(p, 'utf8'))
  let text: string
  try {
    text = await read(join(deps.homeDir ?? homedir(), '.circleci', 'cli.yml'))
  } catch {
    return null
  }
  const m = text.match(/^token:[ \t]*(.*)$/m)
  if (!m) return null
  const value = m[1].replace(/\s+#.*$/, '').trim().replace(/^(["'])(.*)\1$/, '$2')
  return value || null
}

export interface CircleCiClientDeps {
  log: PluginLogger
  // Injectable for tests. Default resolves the token on every call until one is
  // found, then caches it.
  getToken?: () => Promise<string | null>
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  attempts?: number        // total tries; default 3
  baseMs?: number          // first backoff; default 1000
  jitterFraction?: number  // backoff *= 1 + random()*jitterFraction; default 0.5
  random?: () => number
  timeoutMs?: number
  now?: () => number
}

const defaultSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

// Seconds or an HTTP date. Anything else falls back to the default.
export function parseRetryAfter(value: string | null, now: number): number {
  if (value == null) return DEFAULT_RETRY_AFTER_MS
  const trimmed = value.trim()
  let ms: number
  if (/^\d+$/.test(trimmed)) {
    ms = Number(trimmed) * 1000
  } else {
    const at = Date.parse(trimmed)
    if (!Number.isFinite(at)) return DEFAULT_RETRY_AFTER_MS
    ms = at - now
  }
  return Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS)
}

export function assertSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) throw new CircleCiError(`invalid CircleCI project slug: ${slug}`, { shape: 'bad-slug' })
}

function assertId(id: string): void {
  if (!ID_RE.test(id)) throw new CircleCiError(`invalid CircleCI id: ${id}`, { shape: 'bad-id' })
}

export class CircleCiClient {
  private cachedToken: string | null = null

  constructor(private readonly deps: CircleCiClientDeps) {}

  private async token(): Promise<string> {
    if (this.cachedToken) return this.cachedToken
    const t = await (this.deps.getToken ?? (() => resolveToken()))()
    if (!t) throw new CircleCiMissingTokenError()
    this.cachedToken = t
    return t
  }

  // `GET /project/<slug>/pipeline`, newest first. `pageToken` continues a prior page.
  async listPipelines(slug: string, pageToken?: string): Promise<CciPage<CciPipeline>> {
    assertSlug(slug)
    const [vcs, org, repo] = slug.split('/')
    const path = `/project/${vcs}/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/pipeline`
    return this.getPage<CciPipeline>(path, pageToken)
  }

  async listWorkflows(pipelineId: string): Promise<CciPage<CciWorkflow>> {
    assertId(pipelineId)
    return this.getPage<CciWorkflow>(`/pipeline/${pipelineId}/workflow`)
  }

  async listJobs(workflowId: string): Promise<CciPage<CciJob>> {
    assertId(workflowId)
    return this.getPage<CciJob>(`/workflow/${workflowId}/job`)
  }

  private async getPage<T>(path: string, pageToken?: string): Promise<CciPage<T>> {
    const url = pageToken ? `${path}?page-token=${encodeURIComponent(pageToken)}` : path
    const body = await this.get(url) as { items?: unknown; next_page_token?: unknown }
    if (!body || !Array.isArray(body.items)) {
      throw new CircleCiError(`CircleCI response for ${path} had no items array`, { shape: 'bad-shape' })
    }
    const next = typeof body.next_page_token === 'string' && body.next_page_token ? body.next_page_token : null
    return { items: body.items as T[], nextPageToken: next }
  }

  // Sole call site for `fetch`. Retries 5xx and network failures with jittered
  // exponential backoff. 429 and 4xx are not retried.
  private async get(path: string): Promise<unknown> {
    const { log } = this.deps
    const sleep = this.deps.sleep ?? defaultSleep
    const totalAttempts = this.deps.attempts ?? 3
    const baseMs = this.deps.baseMs ?? 1000
    const jitterFraction = this.deps.jitterFraction ?? 0.5
    const random = this.deps.random ?? Math.random
    const timeoutMs = this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const fetchImpl = this.deps.fetch ?? fetch
    const now = this.deps.now ?? Date.now
    const token = await this.token()
    const bare = path.split('?')[0]

    for (let i = 0; i < totalAttempts; i++) {
      const attemptNum = i + 1
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      let label: string
      try {
        const resp = await fetchImpl(`${CIRCLECI_API}${path}`, {
          method: 'GET',
          headers: { 'Circle-Token': token, 'Accept': 'application/json' },
          // The token must not follow a redirect to another host.
          redirect: 'error',
          signal: controller.signal,
        })
        if (resp.status === 401 || resp.status === 403) throw new CircleCiAuthError(resp.status)
        if (resp.status === 404) throw new CircleCiNotFoundError(bare)
        if (resp.status === 429) throw new CircleCiRateLimitError(parseRetryAfter(resp.headers.get('retry-after'), now()))
        if (resp.status >= 500) {
          label = `http-${resp.status}`
          if (attemptNum >= totalAttempts) {
            log(`circleci-retry: GET ${bare} exhausted ${totalAttempts} attempts (status=${resp.status})\n`)
            throw new CircleCiError(`CircleCI GET ${bare} failed: HTTP ${resp.status} (after ${totalAttempts} attempts)`, { status: resp.status, shape: 'http-5xx', attempts: totalAttempts })
          }
        } else if (resp.status < 200 || resp.status >= 300) {
          throw new CircleCiError(`CircleCI GET ${bare} failed: HTTP ${resp.status}`, { status: resp.status, shape: 'http-other' })
        } else {
          try {
            return JSON.parse(await resp.text()) as unknown
          } catch {
            throw new CircleCiError(`CircleCI GET ${bare} returned non-JSON`, { status: resp.status, shape: 'non-json' })
          }
        }
      } catch (e) {
        if (e instanceof CircleCiError) throw e
        // fetch itself threw: network, timeout, DNS, or the blocked redirect.
        const msg = e instanceof Error ? e.message : String(e)
        if (/redirect/i.test(msg)) throw new CircleCiError(`CircleCI GET ${bare} was redirected; refusing to follow`, { shape: 'redirect' })
        label = 'network'
        if (attemptNum >= totalAttempts) {
          log(`circleci-retry: GET ${bare} exhausted ${totalAttempts} attempts (matched=network) — message verbatim:\n${msg}\n`)
          throw new CircleCiError(`CircleCI GET ${bare} failed: ${msg} (after ${totalAttempts} attempts)`, { shape: 'network', attempts: totalAttempts })
        }
      } finally {
        clearTimeout(timer)
      }
      const backoff = Math.round(baseMs * Math.pow(2, i) * (1 + random() * jitterFraction))
      log(`circleci-retry: GET ${bare} attempt ${attemptNum}/${totalAttempts} matched=${label}, backoff ${backoff}ms before next try\n`)
      await sleep(backoff)
    }
    // Unreachable: the loop returns or throws.
    throw new CircleCiError(`CircleCI GET ${bare}: loop exited without result`)
  }
}
