import { describe, it, expect } from 'bun:test'
import { GhError, spawnGh, setRetryLogger } from '../github-api.js'

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

  it('setRetryLogger swaps the default log sink for callers that omit deps.log', async () => {
    const captured: string[] = []
    const original = (msg: string) => { process.stderr.write(msg) }
    setRetryLogger((msg) => { captured.push(msg) })
    try {
      let calls = 0
      const out = await spawnGh(['api', '/x'], {
        // No `log` injected — falls through to currentDefaultLog.
        sleep: async () => { /* no real wait */ },
        baseMs: 1,
        random: () => 0,
        exec: async () => {
          calls++
          if (calls === 1) throw mkErr('HTTP 502')
          return { ok: true }
        },
      })
      expect(out).toEqual({ ok: true })
      expect(captured.length).toBe(1)
      expect(captured[0]).toContain('matched=http-5xx')
    } finally {
      setRetryLogger(original)
    }
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
