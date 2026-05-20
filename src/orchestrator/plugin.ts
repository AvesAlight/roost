// Plugin seam. A plugin owns symmetric slices of `state.plugins[name]` and
// `config.plugins[name]`, declares which IRC channels it wants joined, and on
// each tick returns pre-routed, pre-formatted events. Event kinds are
// plugin-internal — the dispatcher iterates `TaggedEvent[]` and writes to IRC,
// agnostic to the source plugin's event vocabulary.
//
// Plugins may also opt in to inbound DM commands via `handleCommand`: see
// dispatcher-dm-handler.ts for the routing layer. Plugins mutate their own slice
// (config.plugins[name]) in place inside the dispatcher's mutateConfig
// callback; dispatcher-dm-handler never touches slice shapes.
import type { Command } from './dispatcher-dm-handler.js'
import type { OrchestratorConfig } from './config.js'

// Narrow view of the orchestrator config that the plugin seam exposes
// publicly. External plugins type their method parameters with this so they
// only see their own slice path — never the wider OrchestratorConfig shape
// (project/repo/irc/etc.). OrchestratorConfig is structurally assignable to
// PluginConfig, so internal callers passing OrchestratorConfig still satisfy
// external implementations that declare PluginConfig.
export interface PluginConfig {
  plugins?: Record<string, unknown>
}

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
  // Optional: handle a parsed DM command (see dispatcher-dm-handler.ts). Plugins mutate
  // their own slice (config.plugins[name]) in place — the call site is wrapped
  // in mutateConfig so writes are atomic across plugins. Return a reply line
  // when this plugin handles the command, null when it doesn't apply.
  // Implementations MUST NOT throw: deterministic failures (e.g. malformed
  // slice) must come back as an `"error: ..."` string. The router will treat
  // a thrown exception as a bug and surface a [dispatcher_error]. Both watch
  // list and help are broadcast to every enabled plugin; replies are joined
  // with `\n\n`.
  handleCommand?(config: OrchestratorConfig, cmd: Command): string | null | Promise<string | null>
  // Optional: assert this plugin's own slice respects the active repo mode
  // (single vs multi). Plugins that own a `watched`/`repo` shape implement
  // this to enforce their own constraints; plugins that are cross-repo by
  // design (e.g. github-commits) omit it. Throw on violation — the caller
  // surfaces the message. Called after config load and per-tick reload.
  assertRepoMode?(config: OrchestratorConfig): void
}

export abstract class BasePlugin implements Plugin {
  abstract readonly name: string
  constructor(protected readonly defaultChannel: string) {}
  abstract desiredChannels(config: OrchestratorConfig): string[]
  abstract runTick(config: OrchestratorConfig, prevState: unknown): Promise<PluginTickResult>
  handleCommand?(config: OrchestratorConfig, cmd: Command): string | null | Promise<string | null>

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

// ---- Registry --------------------------------------------------------------
// Config-driven instantiation: each plugin module registers a factory keyed
// on the same name it uses for its state slice. orchestrator.ts iterates
// `config.plugins` and instantiates via `getPluginFactory`. Side-effect
// imports in src/orchestrator/registry.ts populate the built-in set.

// Diagnostic log sink passed to every plugin factory. Plugins use it for
// boot-time wiring (e.g., the github plugin pipes its retry trace through
// this), letting core stay plugin-agnostic.
export type PluginLogger = (msg: string) => void

// Stderr-only fallback for direct-construction test paths. The real
// dispatcher modes always supply their own sink via the plugin factory.
export const defaultPluginLogger: PluginLogger = (msg) => { process.stderr.write(msg) }

export type PluginFactory = (defaultChannel: string, log: PluginLogger) => Plugin

const REGISTRY = new Map<string, PluginFactory>()

// Throws on duplicate name — silent overwrite would let one plugin
// shadow another's state slice (registry key === state.plugins[name] key)
// and cause hours of "where did my events go" debugging. Built-ins register
// once at process boot via side-effect import of `registry.ts`; external
// plugins register at top level of their module when loaded by the loader.
// Test cleanup uses `unregisterPlugin`.
export function registerPlugin(name: string, factory: PluginFactory): void {
  if (REGISTRY.has(name)) {
    throw new Error(`plugin already registered: ${name}`)
  }
  REGISTRY.set(name, factory)
}

// Test-only escape hatch. Not exported from `plugin-api.ts` — external
// plugins have no reason to deregister themselves. Returns true if the name
// was registered, false if absent.
export function unregisterPlugin(name: string): boolean {
  return REGISTRY.delete(name)
}

export function getPluginFactory(name: string): PluginFactory | undefined {
  return REGISTRY.get(name)
}

export function registeredPluginNames(): string[] {
  return [...REGISTRY.keys()]
}

// Iterate plugins and dispatch each one's `assertRepoMode` (if implemented).
// Core is plugin-agnostic — it doesn't know about `watched[*].repo` or
// `slice.repo`; the plugins that own those shapes enforce their own rules.
// Called by every config-load site so an operator hand-edit is caught on
// the next tick / DM rather than only at boot.
export function assertRepoModeAll(plugins: Plugin[], config: OrchestratorConfig): void {
  for (const p of plugins) p.assertRepoMode?.(config)
}
