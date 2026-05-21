import { describe, it, expect } from 'bun:test'
import {
  spawnLinear,
  LinearClient,
  LinearError,
  LinearAuthError,
  LinearRateLimitedError,
  LINEAR_ENDPOINT,
  MISSING_KEY_MESSAGE,
  REJECTED_KEY_MESSAGE,
} from '../linear-api.js'

interface Harness {
  sleeps: number[]
  logs: string[]
  fetchCalls: Array<{ url: string; init: RequestInit }>
}

function harness(): Harness & {
  sleep: (ms: number) => Promise<void>
  log: (msg: string) => void
} {
  const h: Harness = { sleeps: [], logs: [], fetchCalls: [] }
  return {
    ...h,
    sleep: async (ms: number) => { h.sleeps.push(ms) },
    log: (msg: string) => { h.logs.push(msg) },
  }
}

// Test factory: queue a sequence of responses (or thrown errors). Each `fetch`
// call dequeues from the head. `Response`-shaped queue entries become real
// Response objects; functions are called for thrown-error queue entries.
function mockFetch(
  queue: Array<{ status: number; body: string; headers?: Record<string, string> } | Error>,
  capture: Harness,
): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
    capture.fetchCalls.push({ url: u, init: init ?? {} })
    const next = queue.shift()
    if (next === undefined) throw new Error('mockFetch: queue exhausted')
    if (next instanceof Error) throw next
    return new Response(next.body, { status: next.status, headers: next.headers ?? {} })
  }) as typeof fetch
}

const OK_HEADERS = {
  'x-ratelimit-requests-remaining': '2400',
  'x-ratelimit-requests-limit': '2500',
  'x-ratelimit-requests-reset': String(Math.floor(Date.now() / 1000) + 3600),
}

const okBody = (data: unknown) => JSON.stringify({ data })

describe('spawnLinear (retry-aware)', () => {
  it('returns on first attempt without retrying', async () => {
    const h = harness()
    const result = await spawnLinear('test-key', '{ viewer { id } }', undefined, {
      log: h.log,
      sleep: h.sleep,
      random: () => 0,
      fetch: mockFetch([{ status: 200, body: okBody({ viewer: { id: 'V1' } }), headers: OK_HEADERS }], h),
    })
    expect(result.body.data).toEqual({ viewer: { id: 'V1' } })
    expect(result.rateLimit).toEqual({ remaining: 2400, limit: 2500, resetAt: expect.any(Number) })
    expect(h.sleeps).toEqual([])
    expect(h.logs).toEqual([])
    expect(h.fetchCalls.length).toBe(1)
  })

  it('sends Authorization header verbatim (no Bearer prefix)', async () => {
    const h = harness()
    await spawnLinear('lin_pat_abc123', '{ viewer { id } }', undefined, {
      log: h.log,
      sleep: h.sleep,
      fetch: mockFetch([{ status: 200, body: okBody({ viewer: { id: 'V1' } }), headers: OK_HEADERS }], h),
    })
    const sentHeaders = (h.fetchCalls[0].init.headers ?? {}) as Record<string, string>
    expect(sentHeaders['Authorization']).toBe('lin_pat_abc123')
    expect(sentHeaders['Authorization']).not.toMatch(/^Bearer /)
    expect(h.fetchCalls[0].url).toBe(LINEAR_ENDPOINT)
  })

  it('retries on transient 5xx then succeeds', async () => {
    const h = harness()
    const result = await spawnLinear('k', '{ x }', undefined, {
      log: h.log,
      sleep: h.sleep,
      baseMs: 100,
      random: () => 0,
      fetch: mockFetch([
        { status: 503, body: 'Service Unavailable' },
        { status: 200, body: okBody({ x: 1 }), headers: OK_HEADERS },
      ], h),
    })
    expect(result.body.data).toEqual({ x: 1 })
    expect(h.sleeps).toEqual([100])
    expect(h.logs.length).toBe(1)
    expect(h.logs[0]).toContain('attempt 1/3')
    expect(h.logs[0]).toContain('matched=http-5xx')
    expect(h.logs[0]).toContain('status=503')
  })

  it('retries on HTTP 429 then succeeds', async () => {
    const h = harness()
    await spawnLinear('k', '{ x }', undefined, {
      log: h.log,
      sleep: h.sleep,
      baseMs: 50,
      random: () => 0,
      fetch: mockFetch([
        { status: 429, body: 'Too Many Requests' },
        { status: 200, body: okBody({ x: 1 }), headers: OK_HEADERS },
      ], h),
    })
    expect(h.logs[0]).toContain('matched=http-429-rate-limit')
  })

  it('exhausts and rethrows after N transient attempts', async () => {
    const h = harness()
    let caught: unknown = null
    try {
      await spawnLinear('k', '{ x }', undefined, {
        log: h.log,
        sleep: h.sleep,
        baseMs: 100,
        random: () => 0,
        fetch: mockFetch([
          { status: 502, body: 'Bad Gateway' },
          { status: 502, body: 'Bad Gateway' },
          { status: 502, body: 'Bad Gateway' },
        ], h),
      })
    } catch (e) { caught = e }
    expect(h.sleeps).toEqual([100, 200])
    expect(caught).toBeInstanceOf(LinearError)
    expect((caught as LinearError).status).toBe(502)
    expect((caught as LinearError).attempts).toBe(3)
    expect(h.logs.length).toBe(3)
    expect(h.logs[2]).toContain('exhausted 3 attempts')
  })

  it('throws LinearAuthError on HTTP 401 without retrying', async () => {
    const h = harness()
    let caught: unknown = null
    try {
      await spawnLinear('bad-key', '{ x }', undefined, {
        log: h.log,
        sleep: h.sleep,
        fetch: mockFetch([{ status: 401, body: 'Unauthorized' }], h),
      })
    } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(LinearAuthError)
    expect(caught).toBeInstanceOf(LinearError) // subclass relationship
    expect((caught as LinearAuthError).message).toBe(REJECTED_KEY_MESSAGE)
    expect((caught as LinearAuthError).status).toBe(401)
    expect(h.sleeps).toEqual([])
    expect(h.fetchCalls.length).toBe(1)
  })

  it('throws LinearRateLimitedError on HTTP 400 + RATELIMITED without retrying', async () => {
    const h = harness()
    const body = JSON.stringify({ errors: [{ message: 'rate limited', extensions: { code: 'RATELIMITED' } }] })
    let caught: unknown = null
    try {
      await spawnLinear('k', '{ x }', undefined, {
        log: h.log,
        sleep: h.sleep,
        fetch: mockFetch([{ status: 400, body }], h),
      })
    } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(LinearRateLimitedError)
    expect(caught).toBeInstanceOf(LinearError)
    expect((caught as LinearRateLimitedError).code).toBe('RATELIMITED')
    expect((caught as LinearRateLimitedError).status).toBe(400)
    expect(h.sleeps).toEqual([])
    expect(h.fetchCalls.length).toBe(1)
    // Raw body must be logged for shape capture (un-empirically-verified per design doc).
    expect(h.logs.some(l => l.includes('linear-ratelimited') && l.includes('RATELIMITED'))).toBe(true)
  })

  it('throws plain LinearError on HTTP 400 with non-RATELIMITED code', async () => {
    // Guards against future Linear API changes silently classifying as rate-limited.
    const h = harness()
    const body = JSON.stringify({ errors: [{ message: 'bad query', extensions: { code: 'INVALID_INPUT' } }] })
    let caught: unknown = null
    try {
      await spawnLinear('k', '{ x }', undefined, {
        log: h.log,
        sleep: h.sleep,
        fetch: mockFetch([{ status: 400, body }], h),
      })
    } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(LinearError)
    expect(caught).not.toBeInstanceOf(LinearRateLimitedError)
    expect(caught).not.toBeInstanceOf(LinearAuthError)
    expect((caught as LinearError).code).toBe('INVALID_INPUT')
    expect((caught as LinearError).status).toBe(400)
  })

  it('throws LinearError on HTTP 200 with errors[] populated (graphql-layer failure)', async () => {
    const h = harness()
    const body = JSON.stringify({ data: null, errors: [{ message: 'oops', extensions: { code: 'INTERNAL_SERVER_ERROR' } }] })
    let caught: unknown = null
    try {
      await spawnLinear('k', '{ x }', undefined, {
        log: h.log,
        sleep: h.sleep,
        fetch: mockFetch([{ status: 200, body, headers: OK_HEADERS }], h),
      })
    } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(LinearError)
    expect((caught as LinearError).status).toBe(200)
    expect((caught as LinearError).code).toBe('INTERNAL_SERVER_ERROR')
    expect(h.sleeps).toEqual([])
    // Raw body logged so the classifier can grow if INTERNAL_SERVER_ERROR turns out to be transient.
    expect(h.logs.some(l => l.includes('linear-graphql-error') && l.includes('INTERNAL_SERVER_ERROR'))).toBe(true)
  })

  it('retries on fetch network error then succeeds', async () => {
    const h = harness()
    const result = await spawnLinear('k', '{ x }', undefined, {
      log: h.log,
      sleep: h.sleep,
      baseMs: 50,
      random: () => 0,
      fetch: mockFetch([
        new Error('ECONNREFUSED'),
        { status: 200, body: okBody({ x: 1 }), headers: OK_HEADERS },
      ], h),
    })
    expect(result.body.data).toEqual({ x: 1 })
    expect(h.logs[0]).toContain('matched=connection-refused')
  })

  it('retries on DNS failure (ENOTFOUND)', async () => {
    const h = harness()
    await spawnLinear('k', '{ x }', undefined, {
      log: h.log,
      sleep: h.sleep,
      baseMs: 50,
      random: () => 0,
      fetch: mockFetch([
        new Error('getaddrinfo ENOTFOUND api.linear.app'),
        { status: 200, body: okBody({ x: 1 }), headers: OK_HEADERS },
      ], h),
    })
    expect(h.logs[0]).toContain('matched=dns')
  })

  it('retries on abort/timeout', async () => {
    const h = harness()
    await spawnLinear('k', '{ x }', undefined, {
      log: h.log,
      sleep: h.sleep,
      baseMs: 50,
      random: () => 0,
      fetch: mockFetch([
        new Error('The operation was aborted'),
        { status: 200, body: okBody({ x: 1 }), headers: OK_HEADERS },
      ], h),
    })
    expect(h.logs[0]).toContain('matched=timeout')
  })

  it('does not retry on unrecognized fetch errors', async () => {
    const h = harness()
    let caught: unknown = null
    try {
      await spawnLinear('k', '{ x }', undefined, {
        log: h.log,
        sleep: h.sleep,
        fetch: mockFetch([new Error('some weird thing nobody anticipated')], h),
      })
    } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(LinearError)
    expect(h.sleeps).toEqual([])
    expect(h.fetchCalls.length).toBe(1)
  })

  it('throws LinearError on non-JSON response body', async () => {
    const h = harness()
    let caught: unknown = null
    try {
      await spawnLinear('k', '{ x }', undefined, {
        log: h.log,
        sleep: h.sleep,
        fetch: mockFetch([{ status: 200, body: '<html>proxy intercept</html>', headers: OK_HEADERS }], h),
      })
    } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(LinearError)
    expect((caught as LinearError).message).toMatch(/non-JSON/)
    expect((caught as LinearError).body).toMatch(/proxy intercept/)
  })

  it('applies jitter via injected random', async () => {
    const h = harness()
    try {
      await spawnLinear('k', '{ x }', undefined, {
        log: h.log,
        sleep: h.sleep,
        baseMs: 100,
        jitterFraction: 0.5,
        random: () => 1, // max jitter → 1 + 0.5 = 1.5x
        fetch: mockFetch([
          { status: 500, body: '' },
          { status: 500, body: '' },
          { status: 500, body: '' },
        ], h),
      })
    } catch { /* exhausted */ }
    // i=0: 100 * 1 * 1.5 = 150; i=1: 100 * 2 * 1.5 = 300
    expect(h.sleeps).toEqual([150, 300])
  })

  it('parses rate-limit headers case-insensitively', async () => {
    const h = harness()
    const upperHeaders = {
      'X-RateLimit-Requests-Remaining': '100',
      'X-RateLimit-Requests-Limit': '2500',
      'X-RateLimit-Requests-Reset': '1716000000',
    }
    const result = await spawnLinear('k', '{ x }', undefined, {
      log: h.log,
      sleep: h.sleep,
      fetch: mockFetch([{ status: 200, body: okBody({ x: 1 }), headers: upperHeaders }], h),
    })
    expect(result.rateLimit).toEqual({ remaining: 100, limit: 2500, resetAt: 1716000000 })
  })

  it('normalizes ms-since-epoch reset to seconds (Linear ships ms)', async () => {
    // Empirically confirmed live: Linear's `x-ratelimit-requests-reset` is
    // milliseconds (13-digit value). RateLimitInfo's contract is seconds so
    // computeRateLimitWarning's `resetAt * 1000` math works.
    const h = harness()
    const result = await spawnLinear('k', '{ x }', undefined, {
      log: h.log,
      sleep: h.sleep,
      fetch: mockFetch([{ status: 200, body: okBody({ x: 1 }), headers: {
        'x-ratelimit-requests-remaining': '2499',
        'x-ratelimit-requests-limit': '2500',
        'x-ratelimit-requests-reset': '1779379756696',  // ms — observed live
      } }], h),
    })
    expect(result.rateLimit).toEqual({ remaining: 2499, limit: 2500, resetAt: 1779379756 })
  })

  it('leaves a seconds-shaped reset untouched (heuristic guards future Linear change)', async () => {
    const h = harness()
    const result = await spawnLinear('k', '{ x }', undefined, {
      log: h.log,
      sleep: h.sleep,
      fetch: mockFetch([{ status: 200, body: okBody({ x: 1 }), headers: {
        'x-ratelimit-requests-remaining': '2499',
        'x-ratelimit-requests-limit': '2500',
        'x-ratelimit-requests-reset': '1779379756',  // hypothetical seconds form
      } }], h),
    })
    expect(result.rateLimit).toEqual({ remaining: 2499, limit: 2500, resetAt: 1779379756 })
  })

  it('returns null rateLimit when no recognized headers present', async () => {
    const h = harness()
    const result = await spawnLinear('k', '{ x }', undefined, {
      log: h.log,
      sleep: h.sleep,
      fetch: mockFetch([{ status: 200, body: okBody({ x: 1 }), headers: { 'content-type': 'application/json' } }], h),
    })
    expect(result.rateLimit).toBeNull()
    expect(result.headers['content-type']).toBe('application/json')
  })

  it('serializes variables in the request body', async () => {
    const h = harness()
    await spawnLinear('k', 'query($id:ID!){ x }', { id: 'C-758' }, {
      log: h.log,
      sleep: h.sleep,
      fetch: mockFetch([{ status: 200, body: okBody({ x: 1 }), headers: OK_HEADERS }], h),
    })
    const sent = JSON.parse(String(h.fetchCalls[0].init.body))
    expect(sent.query).toBe('query($id:ID!){ x }')
    expect(sent.variables).toEqual({ id: 'C-758' })
  })
})

describe('LinearClient.fromEnv', () => {
  const noopLog = () => {}

  it('throws verbatim MISSING_KEY_MESSAGE when LINEAR_API_KEY is unset', () => {
    const saved = process.env.LINEAR_API_KEY
    delete process.env.LINEAR_API_KEY
    try {
      expect(() => LinearClient.fromEnv(noopLog)).toThrow(MISSING_KEY_MESSAGE)
    } finally {
      if (saved != null) process.env.LINEAR_API_KEY = saved
    }
  })

  it('returns a LinearClient when LINEAR_API_KEY is set', () => {
    const saved = process.env.LINEAR_API_KEY
    process.env.LINEAR_API_KEY = 'lin_pat_abc'
    try {
      const client = LinearClient.fromEnv(noopLog)
      expect(client).toBeInstanceOf(LinearClient)
    } finally {
      if (saved != null) process.env.LINEAR_API_KEY = saved
      else delete process.env.LINEAR_API_KEY
    }
  })
})

describe('LinearClient constructor', () => {
  it('throws when apiKey is empty string', () => {
    expect(() => new LinearClient('', () => {})).toThrow(LinearError)
  })
})

describe('LinearClient.graphql + getLastRateLimit', () => {
  it('records rate-limit info from response headers after each call', async () => {
    const h = harness()
    const client = new LinearClient('k', h.log, {
      sleep: h.sleep,
      fetch: mockFetch([
        { status: 200, body: okBody({ x: 1 }), headers: { 'x-ratelimit-requests-remaining': '2000', 'x-ratelimit-requests-limit': '2500', 'x-ratelimit-requests-reset': '1716000000' } },
        { status: 200, body: okBody({ y: 2 }), headers: { 'x-ratelimit-requests-remaining': '1900', 'x-ratelimit-requests-limit': '2500', 'x-ratelimit-requests-reset': '1716000000' } },
      ], h),
    })
    expect(client.getLastRateLimit()).toBeNull()
    await client.graphql('{ x }')
    expect(client.getLastRateLimit()).toEqual({ remaining: 2000, limit: 2500, resetAt: 1716000000 })
    await client.graphql('{ y }')
    expect(client.getLastRateLimit()).toEqual({ remaining: 1900, limit: 2500, resetAt: 1716000000 })
  })

  it('WARNs once when response has no recognized rate-limit headers', async () => {
    const h = harness()
    const client = new LinearClient('k', h.log, {
      sleep: h.sleep,
      fetch: mockFetch([
        { status: 200, body: okBody({ x: 1 }), headers: { 'content-type': 'application/json', 'x-some-future-ratelimit-shape': '99' } },
        { status: 200, body: okBody({ y: 2 }), headers: { 'content-type': 'application/json' } },
      ], h),
    })
    await client.graphql('{ x }')
    await client.graphql('{ y }')
    const warns = h.logs.filter(l => l.includes('[ratelimit] WARN') && l.includes('no recognized rate-limit headers'))
    expect(warns.length).toBe(1)  // one-shot until a recognized shape arrives
    // Header dump is restricted to rate-limit-shaped keys to avoid leaking
    // arbitrary response headers (e.g. set-cookie) into daemon.log.
    expect(warns[0]).toContain('x-some-future-ratelimit-shape')
    expect(warns[0]).not.toContain('content-type')
  })

  it('WARN re-fires after recognized headers arrive and then drop again', async () => {
    // Clearing the flag on a recognized response means a later regression in
    // header detection still produces a WARN. Sticky-once would hide a real
    // production regression behind a successful first request.
    const h = harness()
    const client = new LinearClient('k', h.log, {
      sleep: h.sleep,
      fetch: mockFetch([
        { status: 200, body: okBody({ x: 1 }), headers: { 'content-type': 'application/json' } },     // miss → WARN
        { status: 200, body: okBody({ y: 2 }), headers: OK_HEADERS },                                  // hit → clears
        { status: 200, body: okBody({ z: 3 }), headers: { 'content-type': 'application/json' } },     // miss again → WARN
      ], h),
    })
    await client.graphql('{ x }')
    await client.graphql('{ y }')
    await client.graphql('{ z }')
    const warns = h.logs.filter(l => l.includes('[ratelimit] WARN') && l.includes('no recognized rate-limit headers'))
    expect(warns.length).toBe(2)
  })

  it('filters non-rate-limit-shaped headers from the WARN dump', async () => {
    const h = harness()
    const client = new LinearClient('k', h.log, {
      sleep: h.sleep,
      fetch: mockFetch([
        { status: 200, body: okBody({ x: 1 }), headers: {
          'content-type': 'application/json',
          'set-cookie': 'session=secret-token; Path=/',
          'authorization': 'should-never-appear-but-guard-anyway',
          'x-some-future-ratelimit-shape': '99',
          'retry-after': '60',
        } },
      ], h),
    })
    await client.graphql('{ x }')
    const warn = h.logs.find(l => l.includes('[ratelimit] WARN'))
    expect(warn).toBeDefined()
    expect(warn).toContain('x-some-future-ratelimit-shape')
    expect(warn).toContain('retry-after')
    expect(warn).not.toContain('set-cookie')
    expect(warn).not.toContain('secret-token')
    expect(warn).not.toContain('authorization')
  })
})

describe('LinearClient.probe', () => {
  const probeData = {
    viewer: { id: 'V1', name: 'Bot User', email: 'bot@example.com' },
    organization: { name: 'teakio', urlKey: 'teakio' },
    teams: { nodes: [{ id: 'T1', key: 'C' }, { id: 'T2', key: 'MAR' }] },
  }

  it('logs the success line with name (email) in org, teams', async () => {
    const h = harness()
    const client = new LinearClient('k', h.log, {
      sleep: h.sleep,
      fetch: mockFetch([{ status: 200, body: okBody(probeData), headers: OK_HEADERS }], h),
    })
    const result = await client.probe()
    expect(result.viewer.name).toBe('Bot User')
    expect(result.viewer.email).toBe('bot@example.com')
    expect(result.organization.name).toBe('teakio')
    expect(result.teams.map(t => t.key).sort()).toEqual(['C', 'MAR'])
    const successLog = h.logs.find(l => l.includes('linear: authenticated as'))
    expect(successLog).toBeDefined()
    expect(successLog).toContain('Bot User (bot@example.com)')
    expect(successLog).toContain('in teakio')
    expect(successLog).toContain('teams: [C, MAR]')
  })

  it('handles null viewer.name with a fallback in the log line', async () => {
    const h = harness()
    const nullNameData = { ...probeData, viewer: { id: 'V1', name: null, email: 'bot@example.com' } }
    const client = new LinearClient('k', h.log, {
      sleep: h.sleep,
      fetch: mockFetch([{ status: 200, body: okBody(nullNameData), headers: OK_HEADERS }], h),
    })
    const result = await client.probe()
    expect(result.viewer.name).toBeNull()
    const successLog = h.logs.find(l => l.includes('linear: authenticated as'))
    expect(successLog).toContain('(no name)')
    expect(successLog).toContain('(bot@example.com)')
  })

  it('throws LinearAuthError on HTTP 401 (fatal-able by dispatcher boot)', async () => {
    const h = harness()
    const client = new LinearClient('bad-key', h.log, {
      sleep: h.sleep,
      fetch: mockFetch([{ status: 401, body: 'Unauthorized' }], h),
    })
    let caught: unknown = null
    try { await client.probe() } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(LinearAuthError)
    expect((caught as LinearAuthError).message).toBe(REJECTED_KEY_MESSAGE)
  })

  it('throws LinearError when viewer.id is missing from response', async () => {
    const h = harness()
    const client = new LinearClient('k', h.log, {
      sleep: h.sleep,
      fetch: mockFetch([{ status: 200, body: okBody({ viewer: null, organization: { name: 'org' }, teams: { nodes: [] } }), headers: OK_HEADERS }], h),
    })
    let caught: unknown = null
    try { await client.probe() } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(LinearError)
    expect((caught as LinearError).message).toMatch(/unexpected shape/)
  })
})
