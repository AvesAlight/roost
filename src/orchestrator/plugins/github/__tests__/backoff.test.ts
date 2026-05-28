import { describe, it, expect } from 'bun:test'
import { RateLimitBreaker, BACKOFF_SCHEDULE_MS, formatBackoffNotice, formatReadFailureNote } from '../backoff.js'
import { WARN_COOLDOWN_MS } from '../../_rate-limit.js'

const T0 = 1_000_000_000_000
const M = 60_000

describe('RateLimitBreaker', () => {
  it('starts closed — shouldSkip false', () => {
    const b = new RateLimitBreaker()
    expect(b.shouldSkip(T0)).toBe(false)
    expect(b.currentLevel).toBe(0)
  })

  it('first trip opens for 5m and returns the window', () => {
    const b = new RateLimitBreaker()
    expect(b.trip(T0)).toBe(5 * M)
    expect(b.currentLevel).toBe(1)
    expect(b.shouldSkip(T0)).toBe(true)
    expect(b.shouldSkip(T0 + 5 * M - 1)).toBe(true)
    expect(b.shouldSkip(T0 + 5 * M)).toBe(false)  // window elapsed
  })

  it('escalates 5 → 10 → 30 → 60, capped at 60', () => {
    const b = new RateLimitBreaker()
    // Trip once per elapsed window.
    expect(b.trip(T0)).toBe(5 * M)
    expect(b.trip(T0 + 5 * M)).toBe(10 * M)
    expect(b.trip(T0 + 15 * M)).toBe(30 * M)
    expect(b.trip(T0 + 45 * M)).toBe(60 * M)
    expect(b.trip(T0 + 105 * M)).toBe(60 * M)  // capped
    expect(b.trip(T0 + 165 * M)).toBe(60 * M)  // stays capped
  })

  it('a trip inside an open window is a no-op (concurrent trips advance once)', () => {
    const b = new RateLimitBreaker()
    expect(b.trip(T0)).toBe(5 * M)
    // Same tick / still open → no advance, returns null.
    expect(b.trip(T0)).toBeNull()
    expect(b.trip(T0 + 1)).toBeNull()
    expect(b.currentLevel).toBe(1)
  })

  it('reset inside an open window is a no-op (a recovered sibling cannot cancel a trip)', () => {
    const b = new RateLimitBreaker()
    b.trip(T0)
    b.reset(T0 + 1)  // still inside the 5m window
    expect(b.shouldSkip(T0 + 1)).toBe(true)
    expect(b.currentLevel).toBe(1)
  })

  it('reset after the window closes the breaker (half-open recovery)', () => {
    const b = new RateLimitBreaker()
    b.trip(T0)
    b.reset(T0 + 5 * M)  // window elapsed
    expect(b.currentLevel).toBe(0)
    expect(b.shouldSkip(T0 + 5 * M)).toBe(false)
    // Next trip starts the schedule over at 5m.
    expect(b.trip(T0 + 6 * M)).toBe(5 * M)
  })

  it('forceClose resets unconditionally (test isolation)', () => {
    const b = new RateLimitBreaker()
    b.trip(T0)
    b.forceClose()
    expect(b.currentLevel).toBe(0)
    expect(b.shouldSkip(T0)).toBe(false)
  })

  it('schedule is 5/10/30/60 minutes', () => {
    expect(BACKOFF_SCHEDULE_MS).toEqual([5 * M, 10 * M, 30 * M, 60 * M])
  })
})

describe('format helpers', () => {
  it('formatBackoffNotice renders the window in minutes', () => {
    expect(formatBackoffNotice(5 * M)).toBe('[dispatcher] GH rate-limited, backing off 5m')
    expect(formatBackoffNotice(60 * M)).toBe('[dispatcher] GH rate-limited, backing off 60m')
  })

  it('formatReadFailureNote hedges deleted-vs-flaking and embeds the verbatim recovery command', () => {
    const note = formatReadFailureNote('github-new-issues', 'org/repo', 'unwatch new-issues org/repo')
    expect(note).toBe(
      `[dispatcher] github-new-issues: org/repo read failing (deleted/renamed or GH flaking) —` +
      ` suppressing ${Math.round(WARN_COOLDOWN_MS / 60_000)}m; if persistent: unwatch new-issues org/repo`
    )
  })
})
