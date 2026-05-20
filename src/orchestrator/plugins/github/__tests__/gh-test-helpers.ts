import { beforeAll, afterAll, spyOn } from 'bun:test'
import { GhPluginBase } from '../base.js'

// Call inside a describe block to suppress the real `gh api /rate_limit`
// subprocess that observeRateLimit fires at the end of every runTick.
export function stubRateLimit(): void {
  let spy: { mockRestore(): void }
  beforeAll(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    spy = spyOn(GhPluginBase.prototype as any, 'observeRateLimit').mockResolvedValue([])
  })
  afterAll(() => { spy.mockRestore() })
}
