// Shared rate-limit budget predictor — same math for any API that exposes
// (remaining, limit, resetAt) telemetry. Pure functional util; no I/O.

import type { PluginLogger, TaggedEvent } from '../plugin.js'

export interface RateLimitInfo {
  remaining: number
  limit: number
  resetAt: number  // unix seconds
}

// 5 minute rolling window — stable cross-tick average without missing spikes.
export const RATE_LIMIT_WINDOW_MS = 5 * 60_000

// Cross-instance warning cooldown: one warning per 10 min per statics handle.
export const WARN_COOLDOWN_MS = 10 * 60_000

// Mutable handle passed by reference — one per plugin class so GH and Linear
// warning cooldowns stay independent. Initialized as `{ warnedAt: null }`.
export interface RateLimitStatics {
  warnedAt: number | null
}

// Returns a warning string when the rolling rate predicts exhaustion before
// reset; null otherwise. `history` is window-pruned by the caller, oldest first.
// `tag` prefixes the warning so multi-API operators can tell which budget is
// running out (e.g., "GH" vs "Linear").
export function computeRateLimitWarning(
  current: RateLimitInfo,
  history: ReadonlyArray<{ remaining: number; ts: number }>,
  now: number,
  tag: string,
): string | null {
  if (history.length === 0) return null
  const anchor = history[0]
  const consumed = anchor.remaining - current.remaining
  if (consumed <= 0) return null
  const intervalMs = now - anchor.ts
  if (intervalMs <= 0) return null
  // Need at least half the window before trusting the rate estimate.
  if (intervalMs < RATE_LIMIT_WINDOW_MS / 2) return null
  const ratePerMin = consumed / (intervalMs / 60_000)
  const minToReset = (current.resetAt * 1000 - now) / 60_000
  if (minToReset <= 0) return null
  const minToExhaustion = current.remaining / ratePerMin
  if (minToExhaustion >= minToReset) return null
  const exhaustionStr = minToExhaustion < 1
    ? `${Math.round(minToExhaustion * 60)}s`
    : `${Math.round(minToExhaustion)}m`
  return (
    `[dispatcher] ${tag} rate limit warning: ${current.remaining} calls remaining,` +
    ` reset in ${Math.round(minToReset)}m,` +
    ` current rate ~${Math.round(ratePerMin)}/min —` +
    ` projected exhaustion in ${exhaustionStr}`
  )
}

// End-of-tick rate-limit observation shared across plugin bases.
// Trims history to the rolling window, logs current budget, emits a cooldown-
// gated IRC warning event when the rolling rate predicts exhaustion before reset.
// Returns updated history (caller reassigns its instance field) and any events.
export function observeRateLimitFromInfo(
  info: RateLimitInfo,
  history: ReadonlyArray<{ remaining: number; ts: number }>,
  statics: RateLimitStatics,
  log: PluginLogger,
  projectChannel: string,
  tag: string,
  now = Date.now(),
): { events: TaggedEvent[]; history: Array<{ remaining: number; ts: number }> } {
  if (!info || typeof info.remaining !== 'number' || typeof info.limit !== 'number' || typeof info.resetAt !== 'number') {
    throw new Error('observeRateLimitFromInfo: info must be a valid RateLimitInfo')
  }
  if (!projectChannel) throw new Error('observeRateLimitFromInfo: projectChannel is required')
  if (!tag) throw new Error('observeRateLimitFromInfo: tag is required')

  const cutoff = now - RATE_LIMIT_WINDOW_MS
  const trimmed = history.filter(h => h.ts >= cutoff)

  const prev = trimmed.length > 0 ? trimmed[trimmed.length - 1] : null
  const delta = prev != null ? prev.remaining - info.remaining : null
  const deltaStr = delta != null ? ` (Δ=${delta} since prev sample)` : ''
  const resetMin = Math.round((info.resetAt * 1000 - now) / 60_000)
  log(`[ratelimit] ${tag.toLowerCase()} remaining=${info.remaining}/${info.limit}${deltaStr} reset_in=${resetMin}m\n`)

  const warning = computeRateLimitWarning(info, trimmed, now, tag)
  const updatedHistory = [...trimmed, { remaining: info.remaining, ts: now }]

  if (!warning) return { events: [], history: updatedHistory }

  const cooldownElapsed = statics.warnedAt == null || now - statics.warnedAt > WARN_COOLDOWN_MS
  if (!cooldownElapsed) return { events: [], history: updatedHistory }

  statics.warnedAt = now
  return {
    events: [{ channels: [projectChannel], payload: { kind: 'oneline', text: warning } }],
    history: updatedHistory,
  }
}
