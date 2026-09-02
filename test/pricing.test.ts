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

describe('costFor claude-fable-5-1', () => {
  // Pins every rate explicitly so a drift in any field fails the test.
  it('prices at the Fable 5.1 rates', () => {
    const expected = (
      10 * SAMPLE_USAGE.input
      + 50 * SAMPLE_USAGE.output
      + 12.50 * SAMPLE_USAGE.cache_creation_5m
      + 20 * SAMPLE_USAGE.cache_creation_1h
      + 0.25 * SAMPLE_USAGE.cache_read
    ) / 1_000_000
    expect(costFor('claude-fable-5-1', SAMPLE_USAGE)).toBe(expected)
  })

  it('resolves the dated transcript form via the normalize fallback', () => {
    expect(costFor('claude-fable-5-1-20260901', SAMPLE_USAGE)).toBe(costFor('claude-fable-5-1', SAMPLE_USAGE))
    expect(costFor('claude-fable-5-1-20260901', SAMPLE_USAGE)).not.toBeNull()
  })
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

// Every ollama.com/pricing table id, keyed exactly as transcripts record it
// (bare `glm-5.3`, tagged `gpt-oss:120b` — no `:cloud` form is ever recorded).
describe('ollama-cloud models resolve', () => {
  const ollamaIds = [
    'deepseek-v4-flash', 'deepseek-v4-pro', 'gemma4', 'glm-5.3', 'glm-5.3-flash',
    'glm-5.2', 'glm-5.1', 'gpt-oss:120b', 'gpt-oss:20b', 'kimi-k3',
    'kimi-k2.7-code', 'kimi-k2.6', 'minimax-m3', 'minimax-m2.7', 'mistral-large-3',
    'nemotron-3-nano', 'nemotron-3-super', 'nemotron-3-ultra', 'qwen3.5:397b',
  ]

  it('prices every ollama table id to a non-null cost', () => {
    for (const id of ollamaIds) {
      expect(costFor(id, SAMPLE_USAGE)).not.toBeNull()
    }
  })

  it('prices glm-5.3 at its exact table rates (writes bill at input, reads discount to cached)', () => {
    expect(PRICING['glm-5.3']).toEqual({
      input: 1.40, output: 4.40, cache_creation_5m: 1.40, cache_creation_1h: 1.40, cache_read: 0.26,
    })
    expect(costFor('glm-5.3', SAMPLE_USAGE)).not.toBeNull()
  })

  // The two models the issue names for real spend — a transcription slip here
  // would ship green and misprice spend, so pin their rates too.
  it('prices deepseek-v4-flash at its exact table rates', () => {
    expect(PRICING['deepseek-v4-flash']).toEqual({
      input: 0.44, output: 1.32, cache_creation_5m: 0.44, cache_creation_1h: 0.44, cache_read: 0.014,
    })
    expect(costFor('deepseek-v4-flash', SAMPLE_USAGE)).not.toBeNull()
  })

  it('prices glm-5.2 at its exact table rates', () => {
    expect(PRICING['glm-5.2']).toEqual({
      input: 1.40, output: 4.40, cache_creation_5m: 1.40, cache_creation_1h: 1.40, cache_read: 0.26,
    })
    expect(costFor('glm-5.2', SAMPLE_USAGE)).not.toBeNull()
  })
})

describe('ornith local-compute tiers are $0 (no $? warning)', () => {
  it('keys both recorded spellings as zero cost', () => {
    expect(costFor('ornith-mlx8:latest', SAMPLE_USAGE)).toBe(0)
    expect(costFor('ornith-mlx8-o:latest', SAMPLE_USAGE)).toBe(0)
  })

  it('returns 0 (not null) so token-usage never marks them unknown', () => {
    expect(costFor('ornith-mlx8:latest', ZERO_USAGE)).toBe(0)
    expect(missCostFor('ornith-mlx8:latest', 100, 100)).toBe(0)
  })
})

describe('ollama cache-mapping: writes bill at input, reads discount to cached', () => {
  // cache_creation mirrors `input` and cache_read is the cached-input rate, so
  // a cache miss (write instead of read) carries the honest (input - cached)
  // premium.
  it('glm-5.3 miss premium is (input - cached) per miss token', () => {
    const p = PRICING['glm-5.3']!
    const expected = (
      (p.cache_creation_5m - p.cache_read) * 500
      + (p.cache_creation_1h - p.cache_read) * 250
    ) / 1_000_000
    expect(missCostFor('glm-5.3', 500, 250)).toBe(expected)
    expect(missCostFor('glm-5.3', 500, 250)).not.toBe(0)
  })
})

describe('claude-sonnet-5 intro rates hold (2026-09-01 flip canceled)', () => {
  it('keeps its introductory numbers, not the canceled standard tier', () => {
    expect(PRICING['claude-sonnet-5']).toEqual({
      input: 2, output: 10, cache_creation_5m: 2.50, cache_creation_1h: 4, cache_read: 0.20,
    })
  })
})
