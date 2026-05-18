/** Extract the text content from a callTool result. */
export function toolText(result: unknown): string {
  return (((result as { content: unknown[] }).content)[0] as { text: string }).text
}

export const sleep = (ms: number): Promise<void> => new Promise(res => setTimeout(res, ms))

// Bun 1.2.20 deadlocks the runner when an unhandled promise rejection arrives
// from a test the runner has already abandoned. Our timeout-based test helpers
// race the user's `await` against
// bun's test timeout; if bun aborts first, the helper's setTimeout still fires
// and the reject() becomes unhandled. Pre-attaching a no-op .catch keeps the
// rejection "handled" without affecting an active `await` — that consumer
// still receives the error.
export function suppressLateRejection<T>(p: Promise<T>): Promise<T> {
  // Attach a no-op handler so the rejection is never reported as unhandled.
  // This handler always fires on rejection — it's a no-op when an awaiter
  // already propagated the error, and the safety net when none exists.
  p.catch(() => {})
  return p
}
