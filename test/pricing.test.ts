import { describe, it, expect } from 'bun:test'
import { PRICING, costFor, missCostFor, normalizeModelId, type ModelPricing } from '../src/pricing.js'

const ZERO_USAGE = { input: 0, output: 0, cache_creation_5m: 0, cache_creation_1h: 0, cache_read: 0 }
const SAMPLE_USAGE = { input: 1000, output: 500, cache_creation_5m: 200, cache_creation_1h: 100, cache_read: 50 }

describe('normalizeModelId', () => {
  it('strips a trailing 8-digit date stamp', () => {
    expect(normalizeModelId('claude-opus-4-8-20260115')).toBe('claude-opus-4-8')
  })

  it('leaves ids with no trailing date stamp unchanged', () => {
    expect(normalizeModelId('claude-opus-4-8')).toBe('claude-opus-4-8')
  })

  it('does not strip a 7-digit trailing numeric group', () => {
    expect(normalizeModelId('claude-foo-1234567')).toBe('claude-foo-1234567')
  })

  it('does not strip a 9-digit trailing numeric group', () => {
    expect(normalizeModelId('claude-foo-123456789')).toBe('claude-foo-123456789')
  })

  it('only strips the trailing group, not an 8-digit group in the middle', () => {
    expect(normalizeModelId('claude-20260115-foo')).toBe('claude-20260115-foo')
  })
})

// One case per model id we removed the redundant dated duplicate for —
// proves each drop is safe (fallback reproduces the same price) rather than
// assumed.
describe('costFor resolves dated snapshot ids via fallback', () => {
  const cases: [string, string][] = [
    ['claude-opus-4-8', 'claude-opus-4-8-20260115'],
    ['claude-opus-4-5', 'claude-opus-4-5-20251101'],
    ['claude-sonnet-5', 'claude-sonnet-5-20260601'],
    ['claude-sonnet-4-5', 'claude-sonnet-4-5-20250929'],
    ['claude-haiku-4-5', 'claude-haiku-4-5-20251001'],
  ]

  for (const [bare, dated] of cases) {
    it(`${dated} matches ${bare}'s price`, () => {
      expect(costFor(dated, SAMPLE_USAGE)).toBe(costFor(bare, SAMPLE_USAGE))
      expect(costFor(dated, SAMPLE_USAGE)).not.toBeNull()
    })
  }
})

describe('costFor / missCostFor unknown models', () => {
  it('returns null for a wholly unknown model with no date stamp', () => {
    expect(costFor('claude-mystery-9-0', ZERO_USAGE)).toBeNull()
  })

  it('returns null for an unknown model even with a trailing date stamp', () => {
    expect(costFor('claude-mystery-9-0-20260115', ZERO_USAGE)).toBeNull()
    expect(missCostFor('claude-mystery-9-0-20260115', 100, 100)).toBeNull()
  })
})

describe('exact match takes priority over the normalized fallback', () => {
  // No shipped PRICING entry has both a dated and bare form anymore (that's
  // exactly the duplication this PR removed), so a real divergent case has
  // to be planted to actually exercise the `??` priority order rather than
  // just asserting it structurally.
  it('a literal dated entry is used over its bare alias, even when priced differently', () => {
    const bare = 'claude-test-fixture-4-0'
    const dated = 'claude-test-fixture-4-0-20260101'
    const bareRate: ModelPricing = { input: 1, output: 1, cache_creation_5m: 1, cache_creation_1h: 1, cache_read: 1 }
    const datedRate: ModelPricing = { input: 999, output: 999, cache_creation_5m: 999, cache_creation_1h: 999, cache_read: 999 }
    const mutablePricing = PRICING as Record<string, ModelPricing>
    mutablePricing[bare] = bareRate
    mutablePricing[dated] = datedRate
    try {
      const expectedDatedCost = (
        datedRate.input * SAMPLE_USAGE.input
        + datedRate.output * SAMPLE_USAGE.output
        + datedRate.cache_creation_5m * SAMPLE_USAGE.cache_creation_5m
        + datedRate.cache_creation_1h * SAMPLE_USAGE.cache_creation_1h
        + datedRate.cache_read * SAMPLE_USAGE.cache_read
      ) / 1_000_000
      expect(costFor(dated, SAMPLE_USAGE)).toBe(expectedDatedCost)
      expect(costFor(dated, SAMPLE_USAGE)).not.toBe(costFor(bare, SAMPLE_USAGE))
    } finally {
      delete mutablePricing[bare]
      delete mutablePricing[dated]
    }
  })
})

describe('missCostFor resolves dated snapshot ids via fallback', () => {
  it('claude-sonnet-4-6-20260301 matches claude-sonnet-4-6', () => {
    expect(missCostFor('claude-sonnet-4-6-20260301', 500, 250)).toBe(missCostFor('claude-sonnet-4-6', 500, 250))
    expect(missCostFor('claude-sonnet-4-6-20260301', 500, 250)).not.toBeNull()
  })
})
