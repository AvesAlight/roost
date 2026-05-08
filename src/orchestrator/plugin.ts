// Plugin seam (#116). A plugin owns a slice of `state.plugins[name]`,
// declares which IRC channels it wants joined, and on each tick returns
// pre-routed, pre-formatted events. The dispatcher itself is fully
// plugin-agnostic — it iterates `TaggedEvent[]` and writes to IRC.
import type { OrchestratorConfig } from './config.js'

// Pre-formatted payload variants. Plugins decide one-line vs. multi-line;
// the dispatcher only knows how to write each variant to IRC.
export type TaggedEventPayload =
  | { kind: 'oneline'; text: string }
  | { kind: 'multiline'; header: string; body: string; url: string }

export interface TaggedEvent {
  channels: string[]
  payload: TaggedEventPayload
}

export interface PluginTickResult {
  state: unknown
  taggedEvents: TaggedEvent[]
  // Comprehensive channel set the plugin wants joined now — includes dynamic
  // members only learnable after scraping (PR linked-issues channels), so
  // the orchestrator picks them up post-tick. Pre-tick boot uses the
  // synchronous desiredChannels(config) view instead.
  // Excludes the project/default channel — orchestrator unions that in.
  channels: string[]
}

export interface Plugin {
  readonly name: string
  // Synchronous, config-only view of channels the plugin wants joined at boot,
  // before the first tick. Does NOT include the project/default channel —
  // the orchestrator unions that in itself.
  desiredChannels(config: OrchestratorConfig): string[]
  // Per-tick: state slice + tagged events + the live channel set (post-scrape,
  // including dynamic discoveries like PR linked-issues). Seeding is signaled
  // by `prevState === null`.
  runTick(config: OrchestratorConfig, prevState: unknown): Promise<PluginTickResult>
}

export abstract class BasePlugin implements Plugin {
  abstract readonly name: string
  constructor(protected readonly defaultChannel: string) {}
  abstract desiredChannels(config: OrchestratorConfig): string[]
  abstract runTick(config: OrchestratorConfig, prevState: unknown): Promise<PluginTickResult>

  // Union auto-detected channels with the entry's declared channels;
  // fall back to the default channel if both are empty (defensive for any
  // future entity-less event).
  protected resolveChannels(autoDetected: string[], entryChannels: string[]): string[] {
    const merged = Array.from(new Set([...autoDetected, ...entryChannels]))
    return merged.length ? merged : [this.defaultChannel]
  }
}
