// Reactive GH rate-limit circuit breaker. One instance is shared across every
// GH plugin (they poll one shared GH budget), held as a class-static on
// GhPluginBase. Once a tick surfaces a rate-limit error the breaker opens for an
// escalating window so the dispatcher goes quiet instead of re-firing the same
// error every tick. It recovers (level → 0) on the first clean tick after the
// window elapses (half-open trial).

import { WARN_COOLDOWN_MS } from '../_rate-limit.js'

// Escalating backoff windows, capped at the last. One step per open window.
// Two schedules keyed on rate-limit kind (see rateLimitKind):
//   primary   — core-budget exhaustion; the reset is minutes-to-an-hour away,
//               so back off long.
//   secondary — the burst/abuse limiter fired with budget still remaining; GH
//               clears these in ~a minute, so a 5m floor over-quiets the feed.
//               Start at 1m and escalate only if we keep tripping it.
export const BACKOFF_SCHEDULE_MS: ReadonlyArray<number> = [5, 10, 30, 60].map(m => m * 60_000)
export const SECONDARY_BACKOFF_SCHEDULE_MS: ReadonlyArray<number> = [1, 2, 5, 10].map(m => m * 60_000)

export type RateLimitKind = 'primary' | 'secondary'

// Consecutive failed ticks on one watched entry before readEntry treats it as
// likely-dead rather than flapping. Gates two behaviors off the same count:
// the IRC warn note (don't ping on a one-off flap) and read throttling (stop
// re-reading a dead entry every tick). 3 ticks ≈ ~9 failed gh attempts (each
// tick retries in-call), which a transient flap clears well inside — so only a
// sustained failure crosses it. See GhPluginBase.readEntry.
export const READ_FAILURE_THRESHOLD = 3

export class RateLimitBreaker {
  private level = 0   // 0 = closed; N = number of escalations applied
  private until = 0   // unix ms; polling is allowed again when now >= until

  // True while inside an open window — callers skip polling entirely.
  shouldSkip(now: number): boolean {
    return this.level > 0 && now < this.until
  }

  // Open (or escalate) the breaker. Advances at most once per window: all GH
  // plugins rate-limit together within a tick, so the first trip sets `until`
  // in the future and concurrent trips this tick see now < until and no-op.
  // `schedule` selects the window length by rate-limit kind (primary vs
  // secondary); the escalation level is shared across kinds — repeated trips of
  // any kind back off further. Returns the new window (ms) when it actually
  // advanced, else null.
  trip(now: number, schedule: ReadonlyArray<number> = BACKOFF_SCHEDULE_MS): number | null {
    if (this.level > 0 && now < this.until) return null
    const idx = Math.min(this.level, schedule.length - 1)
    const window = schedule[idx]
    this.level = Math.min(this.level + 1, schedule.length)
    this.until = now + window
    return window
  }

  // Close the breaker after a clean tick. No-ops inside an active window so a
  // sibling plugin that recovered can't cancel a trip from the same tick —
  // first writer wins either way, and the next tick stabilizes.
  reset(now: number): void {
    if (this.level > 0 && now < this.until) return
    this.level = 0
    this.until = 0
  }

  // Unconditional close — test-only, so a class-static breaker doesn't leak
  // trip state across cases.
  forceClose(): void {
    this.level = 0
    this.until = 0
  }

  // Test/observability accessors.
  get currentLevel(): number { return this.level }
  get openUntil(): number { return this.until }
}

// One-line notice posted when the breaker opens or escalates. Names the kind so
// an operator can tell a burst-limit blip (secondary) from budget exhaustion
// (primary) without digging the log.
export function formatBackoffNotice(windowMs: number, kind: RateLimitKind = 'primary'): string {
  const label = kind === 'secondary' ? 'secondary rate-limited' : 'rate-limited'
  return `[dispatcher] GH ${label}, backing off ${Math.round(windowMs / 60_000)}m`
}

// Cooldown-gated note for an entry whose read keeps failing past the
// consecutive-failure threshold. `reason` (from describeReadFailure) names the
// distinguishing action — rotate token (401), unwatch a dead repo (404), or
// ride out a GH flake — so the reader doesn't have to dig the dispatcher log.
// `recoveryCmd` is the exact dispatcher DM an operator types to stop watching,
// pulled verbatim from the owning plugin's help text.
export function formatReadFailureNote(pluginName: string, key: string, recoveryCmd: string, reason: string): string {
  const mins = Math.round(WARN_COOLDOWN_MS / 60_000)
  return `[dispatcher] ${pluginName}: ${key} read failing: ${reason}. suppressing ${mins}m; recover: ${recoveryCmd}`
}

// Cooldown-gated note for a whole-batch read failure — a transient that took the
// entire query down (persistent 5xx, top-level GraphQL error), not one bad alias.
// Unlike a per-entry failure there's no single entry to recover, so it names the
// reason and the suppression window and leaves it there; the operator's cue is
// that the whole feed has stalled. One throttled warn beats the silent-outage
// hole and the N-entry flood alike.
export function formatBatchFailureNote(pluginName: string, entryCount: number, reason: string): string {
  const mins = Math.round(WARN_COOLDOWN_MS / 60_000)
  return `[dispatcher] ${pluginName}: batch read failing (${entryCount} entries): ${reason}. suppressing ${mins}m`
}
