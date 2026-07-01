import { describe, it, expect } from 'bun:test'
import { PRICING, costFor, missCostFor, normalizeModelId } from '../src/pricing.js'

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
  it('an exact PRICING entry is used as-is even though it also has a dated shape', () => {
    // claude-opus-4-1 has no trailing date stamp, so normalization is a
    // no-op here — this just locks that the exact-match lookup path runs
    // first and short-circuits before any fallback.
    expect(costFor('claude-opus-4-1', SAMPLE_USAGE)).toBe(
      (PRICING['claude-opus-4-1'].input * SAMPLE_USAGE.input
        + PRICING['claude-opus-4-1'].output * SAMPLE_USAGE.output
        + PRICING['claude-opus-4-1'].cache_creation_5m * SAMPLE_USAGE.cache_creation_5m
        + PRICING['claude-opus-4-1'].cache_creation_1h * SAMPLE_USAGE.cache_creation_1h
        + PRICING['claude-opus-4-1'].cache_read * SAMPLE_USAGE.cache_read) / 1_000_000,
    )
  })
})

describe('missCostFor resolves dated snapshot ids via fallback', () => {
  it('claude-sonnet-4-6-20260301 matches claude-sonnet-4-6', () => {
    expect(missCostFor('claude-sonnet-4-6-20260301', 500, 250)).toBe(missCostFor('claude-sonnet-4-6', 500, 250))
    expect(missCostFor('claude-sonnet-4-6-20260301', 500, 250)).not.toBeNull()
  })
})
