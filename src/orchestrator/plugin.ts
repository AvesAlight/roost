// Plugin seam (#116). A plugin owns a slice of `state.plugins[name]`,
// declares which IRC channels it wants joined, and on each tick returns
// pre-routed events. The dispatcher itself is plugin-agnostic — it just
// walks `TaggedEvent[]` and writes to IRC.
import type { OrchestratorConfig } from './config.js'
import type { OrchestratorEvent } from './diff.js'

export interface TaggedEvent {
  event: OrchestratorEvent
  channels: string[]
}

export interface PluginTickResult {
  state: unknown
  taggedEvents: TaggedEvent[]
  // Comprehensive channel set the plugin wants joined now — includes dynamic
  // members only learnable after scraping (PR linked-issues channels), so
  // the orchestrator picks them up post-tick. Pre-tick boot uses the
  // synchronous desiredChannels(config) view instead.
  channels: string[]
}

export interface PluginTickOpts {
  seed: boolean
}

export interface Plugin {
  readonly name: string
  desiredChannels(config: OrchestratorConfig): string[]
  runTick(config: OrchestratorConfig, prevState: unknown, opts: PluginTickOpts): Promise<PluginTickResult>
}

export abstract class BasePlugin implements Plugin {
  abstract readonly name: string
  constructor(protected readonly defaultChannel: string) {}
  abstract desiredChannels(config: OrchestratorConfig): string[]
  abstract runTick(config: OrchestratorConfig, prevState: unknown, opts: PluginTickOpts): Promise<PluginTickResult>

  // Union auto-detected channels (PR linked-issues, issue's own channel) with
  // the entry's declared channels; fall back to the default channel if both
  // are empty (e.g. dispatcher-error events with no entity).
  protected resolveChannels(autoDetected: string[], entryChannels: string[] = []): string[] {
    const merged = Array.from(new Set([...autoDetected, ...entryChannels]))
    return merged.length ? merged : [this.defaultChannel]
  }
}
