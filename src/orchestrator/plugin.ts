// Plugin seam (#116, extended in #215). A plugin owns a slice of
// `state.plugins[name]` and the symmetric slice of `config.plugins[name]`,
// declares which IRC channels it wants joined, and on each tick returns
// pre-routed, pre-formatted events. Event kinds are plugin-internal —
// the dispatcher iterates `TaggedEvent[]` and writes to IRC, agnostic to
// the source plugin's event vocabulary.
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

  // Read this plugin's config slice from `config.plugins[name]`. The shape is
  // plugin-private; callers cast to their own typed interface.
  protected pluginConfig<T>(config: OrchestratorConfig): T | undefined {
    return config.plugins?.[this.name] as T | undefined
  }
}

// ---- Registry (#215) -------------------------------------------------------
// Config-driven instantiation: each plugin module registers a factory keyed
// on the same name it uses for its state slice. orchestrator.ts iterates
// `config.plugins` and instantiates via `getPluginFactory`. Side-effect
// imports in src/orchestrator/registry.ts populate the built-in set.

export type PluginFactory = (defaultChannel: string) => Plugin

const REGISTRY = new Map<string, PluginFactory>()

export function registerPlugin(name: string, factory: PluginFactory): void {
  REGISTRY.set(name, factory)
}

export function getPluginFactory(name: string): PluginFactory | undefined {
  return REGISTRY.get(name)
}

export function registeredPluginNames(): string[] {
  return [...REGISTRY.keys()]
}
