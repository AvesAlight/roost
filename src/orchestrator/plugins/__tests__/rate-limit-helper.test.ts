import { describe, it, expect } from 'bun:test'
import { observeRateLimitFromInfo, WARN_COOLDOWN_MS, RATE_LIMIT_WINDOW_MS, type RateLimitStatics } from '../_rate-limit.js'
import type { RateLimitInfo } from '../_rate-limit.js'

const noop = () => {}

function statics(): RateLimitStatics {
  return { warnedAt: null }
}

function info(remaining: number, resetInMs = 60 * 60_000): RateLimitInfo {
  return {
    remaining,
    limit: 5000,
    resetAt: Math.floor((Date.now() + resetInMs) / 1000),
  }
}

// ---- arg validation -------------------------------------------------------

describe('observeRateLimitFromInfo — arg validation', () => {
  it('throws on null info', () => {
    expect(() =>
      observeRateLimitFromInfo(null as unknown as RateLimitInfo, [], statics(), noop, '#proj', 'GH')
    ).toThrow('observeRateLimitFromInfo: info must be a valid RateLimitInfo')
  })

  it('throws on info with non-numeric remaining', () => {
    expect(() =>
      observeRateLimitFromInfo({ remaining: 'x', limit: 5000, resetAt: 0 } as unknown as RateLimitInfo, [], statics(), noop, '#proj', 'GH')
    ).toThrow('observeRateLimitFromInfo: info must be a valid RateLimitInfo')
  })

  it('throws on empty projectChannel', () => {
    expect(() =>
      observeRateLimitFromInfo(info(5000), [], statics(), noop, '', 'GH')
    ).toThrow('observeRateLimitFromInfo: projectChannel is required')
  })

  it('throws on empty tag', () => {
    expect(() =>
      observeRateLimitFromInfo(info(5000), [], statics(), noop, '#proj', '')
    ).toThrow('observeRateLimitFromInfo: tag is required')
  })
})

// ---- history management ---------------------------------------------------

describe('observeRateLimitFromInfo — history', () => {
  it('appends current sample to returned history', () => {
    const now = Date.now()
    const { history } = observeRateLimitFromInfo(info(5000), [], statics(), noop, '#proj', 'GH', now)
    expect(history).toHaveLength(1)
    expect(history[0]).toEqual({ remaining: 5000, ts: now })
  })

  it('prunes stale entries from history', () => {
    const now = Date.now()
    const stale = { remaining: 5000, ts: now - RATE_LIMIT_WINDOW_MS - 1 }
    const fresh = { remaining: 4800, ts: now - 60_000 }
    const { history } = observeRateLimitFromInfo(info(4700), [stale, fresh], statics(), noop, '#proj', 'GH', now)
    expect(history.some(h => h.ts === stale.ts)).toBe(false)
    expect(history.some(h => h.ts === fresh.ts)).toBe(true)
  })
})

// ---- warning emission -----------------------------------------------------

describe('observeRateLimitFromInfo — warning emission', () => {
  it('no events on cold start (empty history)', () => {
    const { events } = observeRateLimitFromInfo(info(5000), [], statics(), noop, '#proj', 'GH')
    expect(events).toEqual([])
  })

  it('no events when consumption rate is safe', () => {
    const now = Date.now()
    // 5000 → 4800 in 300s = 40/min. 4800 remaining at 40/min = 120 min to exhaust; reset in 60 min. safe.
    const seed = [{ remaining: 5000, ts: now - 300_000 }]
    const { events } = observeRateLimitFromInfo(info(4800, 60 * 60_000), seed, statics(), noop, '#proj', 'GH', now)
    expect(events).toEqual([])
  })

  it('emits warning event when rolling rate predicts exhaustion before reset', () => {
    const now = Date.now()
    // 5000 → 100 in 160s → very high burn rate → warns
    const seed = [{ remaining: 5000, ts: now - 160_000 }]
    const { events } = observeRateLimitFromInfo(info(100, 60 * 60_000), seed, statics(), noop, '#proj', 'GH', now)
    expect(events).toHaveLength(1)
    expect(events[0]?.channels).toEqual(['#proj'])
    expect((events[0]?.payload as { text: string }).text).toMatch(/rate limit warning/)
    expect((events[0]?.payload as { text: string }).text).toContain('GH')
  })

  it('uses tag in log line', () => {
    const now = Date.now()
    const seed = [{ remaining: 5000, ts: now - 160_000 }]
    const lines: string[] = []
    observeRateLimitFromInfo(info(100, 60 * 60_000), seed, statics(), msg => lines.push(msg), '#proj', 'MyAPI', now)
    expect(lines.some(l => l.includes('myapi remaining='))).toBe(true)
  })
})

// ---- cooldown gate --------------------------------------------------------

describe('observeRateLimitFromInfo — cooldown gate', () => {
  it('does not re-emit within cooldown window', () => {
    const now = Date.now()
    const seed = [{ remaining: 5000, ts: now - 160_000 }]
    const s = statics()
    const first = observeRateLimitFromInfo(info(100, 60 * 60_000), seed, s, noop, '#proj', 'GH', now)
    expect(first.events).toHaveLength(1)

    // Second call immediately after: same statics, warnedAt is set → no event
    const seed2 = [...first.history, { remaining: 5000, ts: now - 160_000 }].filter(h => h.ts >= now - RATE_LIMIT_WINDOW_MS)
    const second = observeRateLimitFromInfo(info(80, 60 * 60_000), first.history, s, noop, '#proj', 'GH', now + 1_000)
    expect(second.events).toHaveLength(0)
  })

  it('re-emits after cooldown elapses', () => {
    const now = Date.now()
    const seed = [{ remaining: 5000, ts: now - 160_000 }]
    const s = statics()
    const first = observeRateLimitFromInfo(info(100, 60 * 60_000), seed, s, noop, '#proj', 'GH', now)
    expect(first.events).toHaveLength(1)

    const later = now + WARN_COOLDOWN_MS + 1_000
    const seed2 = [{ remaining: 5000, ts: later - 160_000 }]
    const second = observeRateLimitFromInfo(info(100, 60 * 60_000), seed2, s, noop, '#proj', 'GH', later)
    expect(second.events).toHaveLength(1)
  })

  it('updates statics.warnedAt when emitting', () => {
    const now = Date.now()
    const seed = [{ remaining: 5000, ts: now - 160_000 }]
    const s = statics()
    expect(s.warnedAt).toBeNull()
    observeRateLimitFromInfo(info(100, 60 * 60_000), seed, s, noop, '#proj', 'GH', now)
    expect(s.warnedAt).toBe(now)
  })

  it('independent statics handles gate independently', () => {
    const now = Date.now()
    const seed = [{ remaining: 5000, ts: now - 160_000 }]
    const s1 = statics()
    const s2 = statics()
    observeRateLimitFromInfo(info(100, 60 * 60_000), seed, s1, noop, '#proj', 'GH', now)
    // s2 not yet warned — should still emit
    const { events } = observeRateLimitFromInfo(info(100, 60 * 60_000), seed, s2, noop, '#proj', 'Linear', now)
    expect(events).toHaveLength(1)
  })
})
