// Plugin seam. A plugin owns symmetric slices of `state.plugins[name]` and
// `config.plugins[name]`, declares the IRC channels it wants joined, and per
// tick returns pre-routed, pre-formatted events.
import type { Command } from './dispatcher-dm-handler.js'
import type { OrchestratorConfig } from './config.js'

// Narrow view of OrchestratorConfig surfaced to external plugins — only the
// `plugins.<name>` slice path, not the wider shape.
export interface PluginConfig {
  plugins?: Record<string, unknown>
}

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
  // Channels the plugin wants joined post-tick, including dynamic ones only
  // learnable after scraping (PR linked-issues). Excludes the project channel
  // — orchestrator unions that in. Boot path uses desiredChannels(config).
  channels: string[]
}

export interface Plugin {
  readonly name: string
  // Config-only channel view at boot, before first tick. Excludes the project
  // channel — orchestrator unions that in.
  desiredChannels(config: OrchestratorConfig): string[]
  // Per tick: next state slice, tagged events, and the live channel set
  // (post-scrape, including dynamic discoveries). `prevState === null` signals seed.
  runTick(config: OrchestratorConfig, prevState: unknown): Promise<PluginTickResult>
  // Optional DM handler. `merged` is the live view; `local` is the gitignored
  // overlay the plugin mutates (config.json is read-only from the dispatcher).
  // Returns the reply when handled, null when not ours. MUST NOT throw —
  // deterministic failures come back as `"error: ..."`. `list`/`help` broadcast
  // to every plugin; replies join with `\n\n`.
  handleCommand?(merged: OrchestratorConfig, local: OrchestratorConfig, cmd: Command): string | null | Promise<string | null>
  // Optional repo-mode check for plugins that own a `watched`/`repo` shape.
  // Throws on violation. Called after every config load.
  //
  // Tracked-only: local-overlay entries (DM-driven) bypass this check because
  // the DM parser validates OWNER/REPO shape at write time, leaving the
  // overlay parser-clean by construction. Single source of truth for the
  // tracked-vs-overlay distinction lives here — call sites cite this JSDoc.
  assertRepoMode?(base: OrchestratorConfig): void
}

export abstract class BasePlugin implements Plugin {
  abstract readonly name: string
  constructor(protected readonly defaultChannel: string) {}
  abstract desiredChannels(config: OrchestratorConfig): string[]
  abstract runTick(config: OrchestratorConfig, prevState: unknown): Promise<PluginTickResult>
  handleCommand?(merged: OrchestratorConfig, local: OrchestratorConfig, cmd: Command): string | null | Promise<string | null>

  // Union auto-detected channels with declared channels; fall back to the
  // default channel if both are empty (defensive for any entity-less event).
  protected resolveChannels(autoDetected: string[], entryChannels: string[]): string[] {
    const merged = Array.from(new Set([...autoDetected, ...entryChannels]))
    return merged.length ? merged : [this.defaultChannel]
  }

  // This plugin's config slice from `config.plugins[name]` — shape is plugin-private.
  protected pluginConfig<T>(config: OrchestratorConfig): T | undefined {
    return config.plugins?.[this.name] as T | undefined
  }

  // Read-or-create the typed slice under `local.plugins[name]`. The one
  // mutation seam shared by every watch-list plugin.
  protected localSlice<T extends object>(local: OrchestratorConfig): T {
    local.plugins ??= {}
    const existing = local.plugins[this.name]
    if (existing && typeof existing === 'object') return existing as T
    const fresh = {} as T
    local.plugins[this.name] = fresh
    return fresh
  }
}

// ---- Registry --------------------------------------------------------------
// Plugin modules register a factory keyed on the slice name. orchestrator.ts
// iterates `config.plugins` and instantiates via `getPluginFactory`. Built-ins
// register via side-effect import of `registry.ts`.

export type PluginLogger = (msg: string) => void

// Stderr fallback for direct-construction test paths. Real dispatcher modes
// supply their own sink via the plugin factory.
export const defaultPluginLogger: PluginLogger = (msg) => { process.stderr.write(msg) }

export type PluginFactory = (defaultChannel: string, log: PluginLogger) => Plugin

const REGISTRY = new Map<string, PluginFactory>()

// Throws on duplicate — silent overwrite would shadow another plugin's state
// slice (registry key === state.plugins[name] key).
export function registerPlugin(name: string, factory: PluginFactory): void {
  if (REGISTRY.has(name)) {
    throw new Error(`plugin already registered: ${name}`)
  }
  REGISTRY.set(name, factory)
}

// Test-only escape hatch — not exported from `plugin-api.ts`.
export function unregisterPlugin(name: string): boolean {
  return REGISTRY.delete(name)
}

export function getPluginFactory(name: string): PluginFactory | undefined {
  return REGISTRY.get(name)
}

export function registeredPluginNames(): string[] {
  return [...REGISTRY.keys()]
}

// Dispatch each plugin's `assertRepoMode` if implemented. Called by every
// config-load site so an operator hand-edit is caught on the next tick / DM.
export function assertRepoModeAll(plugins: Plugin[], base: OrchestratorConfig): void {
  for (const p of plugins) p.assertRepoMode?.(base)
}
