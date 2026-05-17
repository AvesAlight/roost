import { describe, it, expect } from 'bun:test'
import { GhError, spawnGh, fetchRateLimit, computeRateLimitWarning } from '../github-api.js'

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

  it('does not retry on non-transient errors (404)', async () => {
    const h = harness()
    let calls = 0
    let caught: unknown = null
    try {
      await spawnGh(['api', '/x'], {
        sleep: h.sleep,
        log: h.log,
        exec: async () => { calls++; throw mkErr('gh: HTTP 404: Not Found') },
      })
    } catch (e) { caught = e }
    expect(calls).toBe(1)
    expect(h.sleeps).toEqual([])
    expect(h.logs).toEqual([])
    expect(caught).toBeInstanceOf(GhError)
    expect((caught as GhError).attempts).toBe(1)
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
      ['gh: HTTP 429: rate limit', 'http-429-rate-limit'],
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
  function makeInfo(remaining: number, resetInMin = 60): import('../github-api.js').RateLimitInfo {
    return { remaining, limit: 5000, resetAt: Math.floor((T0 + resetInMin * MIN) / 1000) }
  }

  it('returns null when remaining is unchanged (no consumption)', () => {
    const prev = { remaining: 1000, ts: T0 - 15 * SEC }
    expect(computeRateLimitWarning(makeInfo(1000), prev, T0)).toBeNull()
  })

  it('returns null when remaining went up (reset happened between ticks)', () => {
    const prev = { remaining: 100, ts: T0 - 15 * SEC }
    expect(computeRateLimitWarning(makeInfo(5000), prev, T0)).toBeNull()
  })

  it('returns null when reset is already in the past', () => {
    const info = { remaining: 10, limit: 5000, resetAt: Math.floor((T0 - MIN) / 1000) }
    const prev = { remaining: 100, ts: T0 - 15 * SEC }
    expect(computeRateLimitWarning(info, prev, T0)).toBeNull()
  })

  it('returns null when trajectory is fine (exhaustion after reset)', () => {
    // 10 consumed in 15s → ~40/min. 2000 remaining → 50 min to exhaustion. reset in 30min.
    // exhaustion (50m) > reset (30m) → no warning
    const prev = { remaining: 2010, ts: T0 - 15 * SEC }
    expect(computeRateLimitWarning(makeInfo(2000, 30), prev, T0)).toBeNull()
  })

  it('returns warning string when exhaustion is predicted before reset', () => {
    // 400 consumed in 15s → 1600/min. 200 remaining → ~0.125 min exhaustion. reset in 30min.
    const prev = { remaining: 600, ts: T0 - 15 * SEC }
    const warning = computeRateLimitWarning(makeInfo(200, 30), prev, T0)
    expect(warning).toMatch(/rate limit warning/)
    expect(warning).toMatch(/200 calls remaining/)
    expect(warning).toMatch(/reset in 30m/)
    expect(warning).toMatch(/~1600\/min/)
  })

  it('warning includes projected exhaustion time', () => {
    // 60 consumed in 60s → 60/min. 60 remaining → 1 min to exhaustion. reset in 30min.
    const prev = { remaining: 120, ts: T0 - 60 * SEC }
    const warning = computeRateLimitWarning(makeInfo(60, 30), prev, T0)
    expect(warning).toMatch(/projected exhaustion in 1m/)
  })
})
