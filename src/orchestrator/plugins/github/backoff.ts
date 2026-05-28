// Reactive GH rate-limit circuit breaker. One instance is shared across every
// GH plugin (they poll one shared GH budget), held as a class-static on
// GhPluginBase. Once a tick surfaces a rate-limit error the breaker opens for an
// escalating window so the dispatcher goes quiet instead of re-firing the same
// error every tick. It recovers (level → 0) on the first clean tick after the
// window elapses (half-open trial).

import { WARN_COOLDOWN_MS } from '../_rate-limit.js'

// Escalating backoff windows, capped at the last. One step per open window.
export const BACKOFF_SCHEDULE_MS: ReadonlyArray<number> = [5, 10, 30, 60].map(m => m * 60_000)

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
  // Returns the new window (ms) when it actually advanced, else null.
  trip(now: number): number | null {
    if (this.level > 0 && now < this.until) return null
    const idx = Math.min(this.level, BACKOFF_SCHEDULE_MS.length - 1)
    const window = BACKOFF_SCHEDULE_MS[idx]
    this.level = Math.min(this.level + 1, BACKOFF_SCHEDULE_MS.length)
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

// One-line notice posted when the breaker opens or escalates.
export function formatBackoffNotice(windowMs: number): string {
  return `[dispatcher] GH rate-limited, backing off ${Math.round(windowMs / 60_000)}m`
}

// Cooldown-gated note for an entry whose read keeps failing after retries. HTTP
// 404 can't tell a deleted/renamed repo from an upstream edge-flap, so the
// wording hedges; recurrence is the persistence signal (a real deletion keeps
// warning every window, a one-off flap warns once). `recoveryCmd` is the exact
// dispatcher DM an operator types to stop watching — pulled verbatim from the
// owning plugin's help text.
export function formatReadFailureNote(pluginName: string, key: string, recoveryCmd: string): string {
  const mins = Math.round(WARN_COOLDOWN_MS / 60_000)
  return (
    `[dispatcher] ${pluginName}: ${key} read failing (deleted/renamed or GH flaking) —` +
    ` suppressing ${mins}m; if persistent: ${recoveryCmd}`
  )
}
