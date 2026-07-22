import { describe, it, expect } from 'bun:test'
import { RateLimitBreaker, BACKOFF_SCHEDULE_MS, SECONDARY_BACKOFF_SCHEDULE_MS, formatBackoffNotice, formatReadFailureNote } from '../backoff.js'
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

describe('RateLimitBreaker — secondary (burst) schedule', () => {
  it('secondary schedule is 1/2/5/10 minutes — a shorter floor than primary', () => {
    expect(SECONDARY_BACKOFF_SCHEDULE_MS).toEqual([1 * M, 2 * M, 5 * M, 10 * M])
  })

  it('a secondary trip opens for 1m and escalates 1 → 2 → 5 → 10, capped at 10', () => {
    const b = new RateLimitBreaker()
    const s = SECONDARY_BACKOFF_SCHEDULE_MS
    expect(b.trip(T0, s)).toBe(1 * M)
    expect(b.trip(T0 + 1 * M, s)).toBe(2 * M)
    expect(b.trip(T0 + 3 * M, s)).toBe(5 * M)
    expect(b.trip(T0 + 8 * M, s)).toBe(10 * M)
    expect(b.trip(T0 + 18 * M, s)).toBe(10 * M)  // capped
  })

  it('the escalation level is shared across kinds — the window comes from the passed schedule', () => {
    const b = new RateLimitBreaker()
    // First trip is secondary (level 0 → window secondary[0]=1m, level → 1).
    expect(b.trip(T0, SECONDARY_BACKOFF_SCHEDULE_MS)).toBe(1 * M)
    // Next trip is primary at the shared level 1 → window primary[1]=10m (not 5m).
    expect(b.trip(T0 + 1 * M, BACKOFF_SCHEDULE_MS)).toBe(10 * M)
    expect(b.currentLevel).toBe(2)
  })
})

describe('RateLimitBreaker — exact Retry-After override', () => {
  it('honors an exact override under the schedule floor (the whole point: GH often clears faster than our fixed floor)', () => {
    const b = new RateLimitBreaker()
    expect(b.trip(T0, SECONDARY_BACKOFF_SCHEDULE_MS, 20_000)).toBe(20_000)
  })

  it('clamps an implausibly large exact value to the schedule ceiling', () => {
    const b = new RateLimitBreaker()
    const ceiling = SECONDARY_BACKOFF_SCHEDULE_MS[SECONDARY_BACKOFF_SCHEDULE_MS.length - 1]
    expect(b.trip(T0, SECONDARY_BACKOFF_SCHEDULE_MS, 999 * M)).toBe(ceiling)
  })

  it('clamps a sub-second exact value up to 1s (sanity floor, not the schedule floor)', () => {
    const b = new RateLimitBreaker()
    expect(b.trip(T0, SECONDARY_BACKOFF_SCHEDULE_MS, 10)).toBe(1000)
  })

  it('falls back to the schedule when no exact value is given', () => {
    const b = new RateLimitBreaker()
    expect(b.trip(T0, SECONDARY_BACKOFF_SCHEDULE_MS, undefined)).toBe(1 * M)
  })
})

describe('format helpers', () => {
  it('formatBackoffNotice renders the window in minutes', () => {
    expect(formatBackoffNotice(5 * M)).toBe('[dispatcher] GH rate-limited, backing off 5m')
    expect(formatBackoffNotice(60 * M)).toBe('[dispatcher] GH rate-limited, backing off 60m')
  })

  it('formatBackoffNotice names the kind so a burst blip reads differently from budget exhaustion', () => {
    // Primary is the default and keeps the original wording.
    expect(formatBackoffNotice(5 * M, 'primary')).toBe('[dispatcher] GH rate-limited, backing off 5m')
    expect(formatBackoffNotice(1 * M, 'secondary')).toBe('[dispatcher] GH secondary rate-limited, backing off 1m')
  })

  it('formatBackoffNotice renders sub-minute windows in seconds, not a rounded-down "0m"', () => {
    expect(formatBackoffNotice(20_000, 'secondary')).toBe('[dispatcher] GH secondary rate-limited, backing off 20s')
    expect(formatBackoffNotice(59_000, 'secondary')).toBe('[dispatcher] GH secondary rate-limited, backing off 59s')
  })

  it('formatReadFailureNote surfaces the failure reason and embeds the verbatim recovery command', () => {
    const note = formatReadFailureNote('github-new-issues', 'org/repo', 'unwatch new-issues org/repo', 'deleted/renamed (HTTP 404)')
    expect(note).toBe(
      `[dispatcher] github-new-issues: org/repo read failing: deleted/renamed (HTTP 404).` +
      ` suppressing ${Math.round(WARN_COOLDOWN_MS / 60_000)}m; recover: unwatch new-issues org/repo`
    )
  })
})
