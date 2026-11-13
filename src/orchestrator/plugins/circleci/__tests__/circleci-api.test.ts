import { describe, it, expect } from 'bun:test'
import {
  CircleCiClient, CircleCiAuthError, CircleCiMissingTokenError, CircleCiNotFoundError, CircleCiRateLimitError, CircleCiError,
  parseRetryAfter, resolveToken, CIRCLECI_API,
} from '../circleci-api.js'

const PIPELINE_ID = '11111111-2222-3333-4444-555555555555'

interface Call { url: string; init: RequestInit }

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers })
}

// Scripted fetch: each call shifts the next response (or throws it if an Error).
function scripted(responses: Array<Response | Error>) {
  const calls: Call[] = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    const next = responses.shift()
    if (!next) throw new Error('scripted fetch: out of responses')
    if (next instanceof Error) throw next
    return next
  }) as typeof fetch
  return { fetchImpl, calls }
}

function client(fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof CircleCiClient>[0]> = {}) {
  const logs: string[] = []
  const sleeps: number[] = []
  const c = new CircleCiClient({
    log: m => { logs.push(m) },
    getToken: async () => 'tok-secret',
    fetch: fetchImpl,
    sleep: async ms => { sleeps.push(ms) },
    random: () => 0,
    ...extra,
  })
  return { c, logs, sleeps }
}

describe('CircleCiClient', () => {
  it('sends the token only as a Circle-Token header to circleci.com and refuses redirects', async () => {
    const { fetchImpl, calls } = scripted([json({ items: [], next_page_token: null })])
    const { c } = client(fetchImpl)
    await c.listPipelines('gh/GoCarrot/arboretum')
    expect(calls).toHaveLength(1)
    expect(new URL(calls[0].url).host).toBe('circleci.com')
    expect(calls[0].url).toBe(`${CIRCLECI_API}/project/gh/GoCarrot/arboretum/pipeline`)
    expect((calls[0].init.headers as Record<string, string>)['Circle-Token']).toBe('tok-secret')
    expect(calls[0].url).not.toContain('tok-secret')
    expect(calls[0].init.redirect).toBe('error')
  })

  it('passes the page token and returns the next one', async () => {
    const { fetchImpl, calls } = scripted([json({ items: [{ id: 'x' }], next_page_token: 'abc def' })])
    const { c } = client(fetchImpl)
    const page = await c.listPipelines('gh/o/r', 'prev token')
    expect(calls[0].url).toBe(`${CIRCLECI_API}/project/gh/o/r/pipeline?page-token=prev%20token`)
    expect(page.nextPageToken).toBe('abc def')
    expect(page.items).toHaveLength(1)
  })

  it('rejects a slug or id that is not a plain slug or uuid before any request', async () => {
    const { fetchImpl, calls } = scripted([])
    const { c } = client(fetchImpl)
    await expect(c.listPipelines('gh/o/r/../../x')).rejects.toThrow(CircleCiError)
    await expect(c.listPipelines('bb/o/r')).rejects.toThrow(CircleCiError)
    await expect(c.listWorkflows('../etc')).rejects.toThrow(CircleCiError)
    await expect(c.listJobs('not-a-uuid')).rejects.toThrow(CircleCiError)
    expect(calls).toHaveLength(0)
  })

  it('retries a 5xx with exponential backoff, then succeeds', async () => {
    const { fetchImpl, calls } = scripted([json({}, 502), json({}, 503), json({ items: [] })])
    const { c, sleeps } = client(fetchImpl)
    const page = await c.listWorkflows(PIPELINE_ID)
    expect(page.items).toEqual([])
    expect(calls).toHaveLength(3)
    expect(sleeps).toEqual([1000, 2000])
  })

  it('throws after exhausting retries on a persistent 5xx', async () => {
    const { fetchImpl, calls } = scripted([json({}, 500), json({}, 500), json({}, 500)])
    const { c, logs } = client(fetchImpl)
    await expect(c.listWorkflows(PIPELINE_ID)).rejects.toMatchObject({ status: 500, shape: 'http-5xx', attempts: 3 })
    expect(calls).toHaveLength(3)
    expect(logs.some(l => l.includes('exhausted 3 attempts'))).toBe(true)
  })

  it('retries a network failure', async () => {
    const { fetchImpl, calls } = scripted([new Error('ECONNRESET'), json({ items: [] })])
    const { c } = client(fetchImpl)
    await c.listWorkflows(PIPELINE_ID)
    expect(calls).toHaveLength(2)
  })

  it('does not retry a 429 and carries Retry-After', async () => {
    const { fetchImpl, calls } = scripted([json({}, 429, { 'Retry-After': '120' })])
    const { c } = client(fetchImpl)
    const err = await c.listWorkflows(PIPELINE_ID).catch(e => e)
    expect(err).toBeInstanceOf(CircleCiRateLimitError)
    expect(err.retryAfterMs).toBe(120_000)
    expect(calls).toHaveLength(1)
  })

  it('does not retry 401, 403 or 404', async () => {
    for (const [status, cls] of [[401, CircleCiAuthError], [403, CircleCiAuthError], [404, CircleCiNotFoundError]] as const) {
      const { fetchImpl, calls } = scripted([json({}, status)])
      const { c } = client(fetchImpl)
      await expect(c.listWorkflows(PIPELINE_ID)).rejects.toBeInstanceOf(cls)
      expect(calls).toHaveLength(1)
    }
  })

  it('re-resolves the token after a 401, so a rotated token is picked up', async () => {
    const { fetchImpl, calls } = scripted([json({}, 401), json({ items: [] })])
    let token = 'old-token'
    const { c } = client(fetchImpl, { getToken: async () => token })
    await expect(c.listWorkflows(PIPELINE_ID)).rejects.toBeInstanceOf(CircleCiAuthError)
    token = 'rotated-token'
    await c.listWorkflows(PIPELINE_ID)
    const sent = calls.map(call => (call.init.headers as Record<string, string>)['Circle-Token'])
    expect(sent).toEqual(['old-token', 'rotated-token'])
  })

  it('does not retry a blocked redirect', async () => {
    const { fetchImpl, calls } = scripted([new TypeError('fetch() redirect mode is set to error')])
    const { c } = client(fetchImpl)
    await expect(c.listWorkflows(PIPELINE_ID)).rejects.toMatchObject({ shape: 'redirect' })
    expect(calls).toHaveLength(1)
  })

  it('throws a missing-token error without making a request, and picks a later token up', async () => {
    const { fetchImpl, calls } = scripted([json({ items: [] })])
    let token: string | null = null
    const { c } = client(fetchImpl, { getToken: async () => token })
    await expect(c.listWorkflows(PIPELINE_ID)).rejects.toBeInstanceOf(CircleCiMissingTokenError)
    expect(calls).toHaveLength(0)
    token = 'now-set'
    await c.listWorkflows(PIPELINE_ID)
    expect((calls[0].init.headers as Record<string, string>)['Circle-Token']).toBe('now-set')
  })

  it('rejects a response with no items array', async () => {
    const { fetchImpl } = scripted([json({ message: 'weird' })])
    const { c } = client(fetchImpl)
    await expect(c.listWorkflows(PIPELINE_ID)).rejects.toMatchObject({ shape: 'bad-shape' })
  })
})

describe('parseRetryAfter', () => {
  it('parses seconds, HTTP dates, and falls back on junk or absence', () => {
    expect(parseRetryAfter('30', 0)).toBe(30_000)
    expect(parseRetryAfter(new Date(90_000).toUTCString(), 0)).toBe(90_000)
    expect(parseRetryAfter('soon', 0)).toBe(60_000)
    expect(parseRetryAfter(null, 0)).toBe(60_000)
  })
  it('clamps a past date to 0 and a huge value to an hour', () => {
    expect(parseRetryAfter(new Date(0).toUTCString(), 10_000)).toBe(0)
    expect(parseRetryAfter('999999999', 0)).toBe(3_600_000)
  })
})

describe('resolveToken', () => {
  const noFile = async () => { throw new Error('ENOENT') }

  it('prefers CIRCLECI_TOKEN', async () => {
    const t = await resolveToken({ env: { CIRCLECI_TOKEN: ' env-tok ' }, readFile: async () => 'token: file-tok' })
    expect(t).toBe('env-tok')
  })

  it('falls back to the top-level token in cli.yml, stripping quotes and comments', async () => {
    const read = (text: string) => resolveToken({ env: {}, homeDir: '/h', readFile: async () => text })
    expect(await read('host: https://circleci.com\ntoken: file-tok\n')).toBe('file-tok')
    expect(await read('token: "quoted"\n')).toBe('quoted')
    expect(await read("token: 'single' # note\n")).toBe('single')
  })

  it('reads ~/.circleci/cli.yml', async () => {
    let seen = ''
    await resolveToken({ env: {}, homeDir: '/home/x', readFile: async p => { seen = p; return '' } })
    expect(seen).toBe('/home/x/.circleci/cli.yml')
  })

  it('returns null for a missing file, no token line, an empty value, or an indented token', async () => {
    expect(await resolveToken({ env: {}, readFile: noFile })).toBeNull()
    expect(await resolveToken({ env: {}, readFile: async () => 'host: x\n' })).toBeNull()
    expect(await resolveToken({ env: {}, readFile: async () => 'token:\n' })).toBeNull()
    expect(await resolveToken({ env: {}, readFile: async () => 'nested:\n  token: nope\n' })).toBeNull()
  })
})
