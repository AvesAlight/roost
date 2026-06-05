import { describe, it, expect } from 'bun:test'
import { GhError, spawnGh, fetchRateLimit, isRateLimitError, isExpectedTransientError } from '../github-api.js'
import { computeRateLimitWarning, RATE_LIMIT_WINDOW_MS, type RateLimitInfo } from '../../_rate-limit.js'

function mkErr(stderr: string): GhError {
  return new GhError(`gh failed (exit 1): gh api foo\n${stderr.trim()}`, stderr)
}

interface Harness {
  attempts: string[][]
  sleeps: number[]
  logs: string[]
}

function harness(): Harness & {
  sleep: (ms: number) => Promise<void>
  log: (msg: string) => void
} {
  const h: Harness = { attempts: [], sleeps: [], logs: [] }
  return {
    ...h,
    sleep: async (ms: number) => { h.sleeps.push(ms) },
    log: (msg: string) => { h.logs.push(msg) },
  }
}

describe('spawnGh (retry-aware)', () => {
  it('returns on first attempt without retrying', async () => {
    const h = harness()
    let calls = 0
    const out = await spawnGh(['api', '/x'], {
      sleep: h.sleep,
      log: h.log,
      random: () => 0,
      exec: async () => { calls++; return { ok: true } },
    })
    expect(out).toEqual({ ok: true })
    expect(calls).toBe(1)
    expect(h.sleeps).toEqual([])
    expect(h.logs).toEqual([])
  })

  it('retries on transient 5xx then succeeds', async () => {
    const h = harness()
    let calls = 0
    const out = await spawnGh(['api', '/x'], {
      sleep: h.sleep,
      log: h.log,
      baseMs: 100,
      random: () => 0,
      exec: async () => {
        calls++
        if (calls === 1) throw mkErr('gh: HTTP 503: Service Unavailable')
        return { ok: true }
      },
    })
    expect(out).toEqual({ ok: true })
    expect(calls).toBe(2)
    expect(h.sleeps).toEqual([100])
    expect(h.logs.length).toBe(1)
    expect(h.logs[0]).toContain('attempt 1/3')
    expect(h.logs[0]).toContain('matched=http-5xx')
    expect(h.logs[0]).toContain('backoff 100ms')
  })

  it('exhausts and rethrows after N transient attempts', async () => {
    const h = harness()
    let calls = 0
    let caught: unknown = null
    try {
      await spawnGh(['api', '/x'], {
        sleep: h.sleep,
        log: h.log,
        baseMs: 100,
        random: () => 0,
        exec: async () => { calls++; throw mkErr('gh: HTTP 502: Bad Gateway') },
      })
    } catch (e) { caught = e }
    expect(calls).toBe(3)
    expect(h.sleeps).toEqual([100, 200])
    expect(caught).toBeInstanceOf(GhError)
    const ge = caught as GhError
    expect(ge.attempts).toBe(3)
    expect(ge.message).toContain('after 3 retries')
    // Two backoff logs + one exhaustion log.
    expect(h.logs.length).toBe(3)
    expect(h.logs[2]).toContain('exhausted 3 attempts')
    expect(h.logs[2]).toContain('HTTP 502: Bad Gateway')
  })

  it('retries a 404 (transient edge-flap) then succeeds, on the shorter base', async () => {
    const h = harness()
    let calls = 0
    const out = await spawnGh(['api', '/x'], {
      sleep: h.sleep,
      log: h.log,
      baseMs: 1000,
      notFoundBaseMs: 100,
      random: () => 0,
      exec: async () => {
        calls++
        if (calls === 1) throw mkErr('gh: HTTP 404: Not Found')
        return { ok: true }
      },
    })
    expect(out).toEqual({ ok: true })
    expect(calls).toBe(2)
    expect(h.sleeps).toEqual([100])  // notFoundBaseMs, not baseMs
    expect(h.logs[0]).toContain('matched=http-404')
  })

  it('exhausts a 404 after N attempts (real missing resource / sustained flap)', async () => {
    const h = harness()
    let calls = 0
    let caught: unknown = null
    try {
      await spawnGh(['api', '/x'], {
        sleep: h.sleep,
        log: h.log,
        notFoundBaseMs: 1,
        random: () => 0,
        exec: async () => { calls++; throw mkErr('gh: HTTP 404: Not Found') },
      })
    } catch (e) { caught = e }
    expect(calls).toBe(3)
    expect(caught).toBeInstanceOf(GhError)
    expect((caught as GhError).attempts).toBe(3)
    // A persistent 404 is the per-entry skip class, not rate-limit.
    expect(isExpectedTransientError(caught)).toBe(true)
    expect(isRateLimitError(caught)).toBe(false)
  })

  it('treats 422 as non-transient but logs stderr verbatim', async () => {
    const h = harness()
    let calls = 0
    const stderr = 'gh: HTTP 422: Validation Failed\nfield X may not be null'
    let caught: unknown = null
    try {
      await spawnGh(['api', '/x'], {
        sleep: h.sleep,
        log: h.log,
        exec: async () => { calls++; throw mkErr(stderr) },
      })
    } catch (e) { caught = e }
    expect(calls).toBe(1)
    expect(h.sleeps).toEqual([])
    expect(caught).toBeInstanceOf(GhError)
    expect(h.logs.length).toBe(1)
    expect(h.logs[0]).toContain('HTTP 422 (non-transient)')
    expect(h.logs[0]).toContain('field X may not be null')
  })

  it('classifies common transient shapes', async () => {
    const cases: Array<[string, string]> = [
      ['gh: HTTP 500', 'http-5xx'],
      ['gh: HTTP 504: Gateway Timeout', 'http-5xx'],
      ['dial tcp: i/o timeout', 'timeout'],
      ['context deadline exceeded', 'timeout'],
      ['request timed out', 'timeout'],
      ['dial tcp: connection refused', 'connection-refused'],
      ['read tcp: connection reset by peer', 'connection-reset'],
      ['lookup api.github.com: no such host', 'dns'],
      ['network is unreachable', 'network-unreachable'],
      ['unexpected EOF', 'eof'],
    ]
    for (const [stderr, label] of cases) {
      const h = harness()
      let calls = 0
      try {
        await spawnGh(['api', '/x'], {
          sleep: h.sleep,
          log: h.log,
          baseMs: 1,
          random: () => 0,
          exec: async () => { calls++; throw mkErr(stderr) },
        })
      } catch { /* exhausted */ }
      expect(calls).toBe(3)
      expect(h.logs[0]).toContain(`matched=${label}`)
    }
  })

  it('applies jitter via injected random', async () => {
    const h = harness()
    try {
      await spawnGh(['api', '/x'], {
        sleep: h.sleep,
        log: h.log,
        baseMs: 100,
        jitterFraction: 0.5,
        random: () => 1, // max jitter → 1 + 0.5 = 1.5x
        exec: async () => { throw mkErr('HTTP 500') },
      })
    } catch { /* exhausted */ }
    // i=0: 100 * 1 * 1.5 = 150; i=1: 100 * 2 * 1.5 = 300
    expect(h.sleeps).toEqual([150, 300])
  })

  it('does not retry HTTP 429 — fails fast for the breaker', async () => {
    const h = harness()
    let calls = 0
    let caught: unknown = null
    try {
      await spawnGh(['api', '/x'], {
        sleep: h.sleep,
        log: h.log,
        exec: async () => { calls++; throw mkErr('gh: HTTP 429: Too Many Requests') },
      })
    } catch (e) { caught = e }
    expect(calls).toBe(1)
    expect(h.sleeps).toEqual([])
    expect(isRateLimitError(caught)).toBe(true)
    expect(h.logs[0]).toContain('rate-limited (not retried here)')
  })

  it('treats HTTP 403 with a rate-limit message as rate-limit (no retry)', async () => {
    const h = harness()
    let calls = 0
    let caught: unknown = null
    try {
      await spawnGh(['api', '/x'], {
        sleep: h.sleep,
        log: h.log,
        exec: async () => { calls++; throw mkErr('gh: HTTP 403: API rate limit exceeded for user') },
      })
    } catch (e) { caught = e }
    expect(calls).toBe(1)
    expect(isRateLimitError(caught)).toBe(true)
  })

  it('treats an HTTP 403 secondary rate limit as rate-limit (no retry)', async () => {
    let caught: unknown = null
    try {
      await spawnGh(['api', '/x'], {
        sleep: async () => {},
        log: () => {},
        exec: async () => { throw mkErr('gh: HTTP 403: You have exceeded a secondary rate limit') },
      })
    } catch (e) { caught = e }
    expect(isRateLimitError(caught)).toBe(true)
  })

  it('does not treat a non-rate-limit HTTP 403 as rate-limit or transient (throws once)', async () => {
    const h = harness()
    let calls = 0
    let caught: unknown = null
    try {
      await spawnGh(['api', '/x'], {
        sleep: h.sleep,
        log: h.log,
        exec: async () => { calls++; throw mkErr('gh: HTTP 403: Resource not accessible by integration') },
      })
    } catch (e) { caught = e }
    expect(calls).toBe(1)
    expect(isRateLimitError(caught)).toBe(false)
    expect(isExpectedTransientError(caught)).toBe(false)
  })

  it('rethrows non-GhError immediately without classifying', async () => {
    const h = harness()
    let calls = 0
    let caught: unknown = null
    try {
      await spawnGh(['api', '/x'], {
        sleep: h.sleep,
        log: h.log,
        exec: async () => { calls++; throw new Error('bun.spawn died') },
      })
    } catch (e) { caught = e }
    expect(calls).toBe(1)
    expect(h.sleeps).toEqual([])
    expect((caught as Error).message).toBe('bun.spawn died')
  })
})

describe('fetchRateLimit', () => {
  const noopLog = () => {}

  it('returns parsed RateLimitInfo on success', async () => {
    const exec = async () => ({ rate: { limit: 5000, remaining: 4987, reset: 1716000000 } })
    const info = await fetchRateLimit(noopLog, { exec })
    expect(info).toEqual({ limit: 5000, remaining: 4987, resetAt: 1716000000 })
  })

  it('returns null when rate field is absent', async () => {
    const exec = async () => ({ resources: { core: { limit: 5000, remaining: 4987, reset: 1716000000 } } })
    expect(await fetchRateLimit(noopLog, { exec })).toBeNull()
  })

  it('returns null when rate fields are incomplete', async () => {
    const exec = async () => ({ rate: { limit: 5000 } })  // missing remaining + reset
    expect(await fetchRateLimit(noopLog, { exec })).toBeNull()
  })

  it('returns null on gh failure (never throws)', async () => {
    const exec = async () => { throw new GhError('no auth', 'HTTP 401: Unauthorized') }
    expect(await fetchRateLimit(noopLog, { exec })).toBeNull()
  })

  it('uses attempts:1 so a failure logs exhaustion at attempt 1 (no retries)', async () => {
    const logs: string[] = []
    const log = (m: string) => { logs.push(m) }
    let calls = 0
    const exec = async () => { calls++; throw mkErr('HTTP 500') }
    await fetchRateLimit(log, { exec, baseMs: 0 })
    expect(calls).toBe(1)  // no retries
  })
})

describe('computeRateLimitWarning', () => {
  const T0 = 1_000_000_000_000  // arbitrary epoch ms
  const SEC = 1000
  const MIN = 60 * SEC

  // reset 60 minutes from now
  function makeInfo(remaining: number, resetInMin = 60): RateLimitInfo {
    return { remaining, limit: 5000, resetAt: Math.floor((T0 + resetInMin * MIN) / 1000) }
  }

  it('returns null when history is empty', () => {
    expect(computeRateLimitWarning(makeInfo(1000), [], T0, 'GH')).toBeNull()
  })

  it('returns null when remaining is unchanged (no consumption)', () => {
    const prev = { remaining: 1000, ts: T0 - 15 * SEC }
    expect(computeRateLimitWarning(makeInfo(1000), [prev], T0, 'GH')).toBeNull()
  })

  it('returns null when remaining went up (reset happened between ticks)', () => {
    const prev = { remaining: 100, ts: T0 - 15 * SEC }
    expect(computeRateLimitWarning(makeInfo(5000), [prev], T0, 'GH')).toBeNull()
  })

  it('returns null when reset is already in the past', () => {
    const info = { remaining: 10, limit: 5000, resetAt: Math.floor((T0 - MIN) / 1000) }
    const prev = { remaining: 100, ts: T0 - 15 * SEC }
    expect(computeRateLimitWarning(info, [prev], T0, 'GH')).toBeNull()
  })

  it('returns null when trajectory is fine (exhaustion after reset)', () => {
    // 10 consumed in 15s → ~40/min. 2000 remaining → 50 min to exhaustion. reset in 30min.
    // exhaustion (50m) > reset (30m) → no warning
    const prev = { remaining: 2010, ts: T0 - 15 * SEC }
    expect(computeRateLimitWarning(makeInfo(2000, 30), [prev], T0, 'GH')).toBeNull()
  })

  it('returns null when history spans less than half the rolling window', () => {
    // 100s < RATE_LIMIT_WINDOW_MS/2 (150s) — not enough history to trust rate.
    const prev = { remaining: 5000, ts: T0 - 100 * SEC }
    expect(computeRateLimitWarning(makeInfo(100, 30), [prev], T0, 'GH')).toBeNull()
  })

  it('returns warning string when exhaustion is predicted before reset', () => {
    // 400 consumed in 160s → 150/min. 200 remaining → ~1.3 min exhaustion. reset in 30min.
    const prev = { remaining: 600, ts: T0 - 160 * SEC }
    const warning = computeRateLimitWarning(makeInfo(200, 30), [prev], T0, 'GH')
    expect(warning).toMatch(/GH rate limit warning/)
    expect(warning).toMatch(/200 calls remaining/)
    expect(warning).toMatch(/reset in 30m/)
    expect(warning).toMatch(/~150\/min/)
  })

  it('warning includes projected exhaustion time', () => {
    // 160 consumed in 160s → 60/min. 60 remaining → 1 min to exhaustion. reset in 30min.
    const prev = { remaining: 220, ts: T0 - 160 * SEC }
    const warning = computeRateLimitWarning(makeInfo(60, 30), [prev], T0, 'GH')
    expect(warning).toMatch(/projected exhaustion in 1m/)
  })

  it('shows seconds for sub-minute projected exhaustion', () => {
    // 1600 consumed in 160s → 600/min. 100 remaining → ~10s to exhaustion. reset in 30min.
    const prev = { remaining: 1700, ts: T0 - 160 * SEC }
    const warning = computeRateLimitWarning(makeInfo(100, 30), [prev], T0, 'GH')
    expect(warning).toMatch(/projected exhaustion in 10s/)
  })

  it('cold-start single entry: no warn when nothing consumed', () => {
    // One history entry, remaining unchanged — graceful no-op.
    const prev = { remaining: 5000, ts: T0 - 30 * SEC }
    expect(computeRateLimitWarning(makeInfo(5000), [prev], T0, 'GH')).toBeNull()
  })

  it('uses oldest history entry as anchor, smoothing across the window', () => {
    // Burst in the middle tick inflates tick-to-tick rate, but the 5-min window
    // dilutes it. anchor=T0-300s: 200 consumed over 300s → 40/min.
    // minToExhaustion = 4800/40 = 120 min, reset in 60 min → no warning.
    const history = [
      { remaining: 5000, ts: T0 - 300 * SEC },  // oldest anchor
      { remaining: 4900, ts: T0 - 150 * SEC },  // burst: -100 in 150s
      { remaining: 4800, ts: T0 - 10 * SEC },   // then quiet
    ]
    // tick-to-tick from last entry: 0 consumed in 10s → no warn (consumed<=0)
    // but anchor-based: 200 consumed in 300s → 40/min → 4800/40=120m > 60m reset → no warn
    expect(computeRateLimitWarning(makeInfo(4800), history, T0, 'GH')).toBeNull()
  })

  it('rolling window: a genuine sustained spike still warns', () => {
    // 300 consumed over 300s → 60/min. 60 remaining → 1 min to exhaustion, reset in 30 min.
    const history = [
      { remaining: 360, ts: T0 - 300 * SEC },
      { remaining: 260, ts: T0 - 200 * SEC },
      { remaining: 160, ts: T0 - 100 * SEC },
    ]
    const warning = computeRateLimitWarning(makeInfo(60, 30), history, T0, 'GH')
    expect(warning).toMatch(/GH rate limit warning/)
    expect(warning).toMatch(/~60\/min/)
  })

  it('RATE_LIMIT_WINDOW_MS is exported and equals 5 minutes', () => {
    expect(RATE_LIMIT_WINDOW_MS).toBe(5 * 60 * 1000)
  })
})
