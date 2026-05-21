// Shared rate-limit budget predictor — same math for any API that exposes
// (remaining, limit, resetAt) telemetry. Pure functional util; no I/O.

export interface RateLimitInfo {
  remaining: number
  limit: number
  resetAt: number  // unix seconds
}

// 5 minute rolling window — stable cross-tick average without missing spikes.
export const RATE_LIMIT_WINDOW_MS = 5 * 60_000

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
