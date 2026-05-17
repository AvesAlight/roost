// Pricing for Anthropic models keyed by the exact `message.model` value
// that appears in Claude Code session JSONLs. Used by bin/roost-token-usage
// to estimate cost from token counts.
//
// Source: https://platform.claude.com/docs/en/about-claude/pricing
// Retrieved: 2026-05-16
//
// All rates are USD per 1M tokens. When Anthropic publishes new rates or a
// model ID we don't yet recognize appears in transcripts, bump this table
// (and the retrieval date). Unknown model IDs cause roost-token-usage to
// print `$?` for that nick and stderr-warn the unknown ID rather than
// silently defaulting to a rate that could mislead in either direction.
//
// Cache-write tier: Anthropic bills 5-minute cache writes at 1.25x the base
// input rate and 1-hour cache writes at 2x. The JSONL `usage.cache_creation`
// nested object breaks these out (`ephemeral_5m_input_tokens` and
// `ephemeral_1h_input_tokens`). When only the aggregate
// `cache_creation_input_tokens` is present, token-usage defaults to the 5m
// rate (the common case under default `cache_control`).

export interface ModelPricing {
  input: number
  output: number
  cache_creation_5m: number
  cache_creation_1h: number
  cache_read: number
}

export const PRICING: Readonly<Record<string, ModelPricing>> = {
  // Opus 4.x current generation — $5 base input. (Opus 4.1 and earlier
  // remain on the older $15 tier.)
  'claude-opus-4-7':           { input: 5,  output: 25, cache_creation_5m: 6.25,  cache_creation_1h: 10,  cache_read: 0.50 },
  'claude-opus-4-6':           { input: 5,  output: 25, cache_creation_5m: 6.25,  cache_creation_1h: 10,  cache_read: 0.50 },
  'claude-opus-4-5':           { input: 5,  output: 25, cache_creation_5m: 6.25,  cache_creation_1h: 10,  cache_read: 0.50 },
  'claude-opus-4-1':           { input: 15, output: 75, cache_creation_5m: 18.75, cache_creation_1h: 30,  cache_read: 1.50 },
  // Sonnet 4.x current generation.
  'claude-sonnet-4-6':         { input: 3,  output: 15, cache_creation_5m: 3.75,  cache_creation_1h: 6,   cache_read: 0.30 },
  'claude-sonnet-4-5':         { input: 3,  output: 15, cache_creation_5m: 3.75,  cache_creation_1h: 6,   cache_read: 0.30 },
  // Haiku 4.5 (with date-stamped variant Claude Code records).
  'claude-haiku-4-5':          { input: 1,  output: 5,  cache_creation_5m: 1.25,  cache_creation_1h: 2,   cache_read: 0.10 },
  'claude-haiku-4-5-20251001': { input: 1,  output: 5,  cache_creation_5m: 1.25,  cache_creation_1h: 2,   cache_read: 0.10 },
}

// IDs that appear in transcripts but don't represent real API spend —
// internal placeholders we count as zero cost without warning.
export const SKIPPED_MODELS: ReadonlySet<string> = new Set(['<synthetic>'])

export interface UsageCounts {
  input: number
  output: number
  cache_creation_5m: number
  cache_creation_1h: number
  cache_read: number
}

// Returns the USD cost for the given counts at the given model's rates, or
// `null` if the model is unknown (caller surfaces `$?` and warns).
export function costFor(model: string, u: UsageCounts): number | null {
  if (SKIPPED_MODELS.has(model)) return 0
  const p = PRICING[model]
  if (!p) return null
  return (
    p.input * u.input
    + p.output * u.output
    + p.cache_creation_5m * u.cache_creation_5m
    + p.cache_creation_1h * u.cache_creation_1h
    + p.cache_read * u.cache_read
  ) / 1_000_000
}

// Returns the USD cost premium for cache miss tokens — the extra spend vs what
// a cache read would have cost. Defaults to the 5m creation tier (the common
// case; cache_miss_reason doesn't expose TTL). Returns `null` for unknown models.
export function missCostFor(model: string, tokens: number): number | null {
  if (SKIPPED_MODELS.has(model)) return 0
  const p = PRICING[model]
  if (!p) return null
  return (p.cache_creation_5m - p.cache_read) * tokens / 1_000_000
}
