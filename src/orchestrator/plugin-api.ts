// Public surface for external plugins — reach here via the `roost/plugin`
// exports map: extend, register, type, plus the shared grammar and watch-list
// helpers the built-ins use, so external plugins don't copy them. Adding to
// this is a deliberate API change. See docs/PLUGINS.md.
export {
  BasePlugin,
  defaultPluginLogger,
  registerPlugin,
  type ParseResult,
  type Plugin,
  type PluginConfig,
  type PluginFactory,
  type PluginLogger,
  type PluginTickResult,
  type PluginMessage,
} from './plugin.js'

export type { Command } from './dispatcher-dm-handler.js'

export {
  tryClaimWatch,
  tryClaimPerN,
  tryClaimPerRepo,
  type ClaimWatchOptions,
  type PerNCommand,
  type PerRepoCommand,
  type SpecMatch,
  type Verb,
  type WatchCommand,
} from './plugins/grammar.js'

export { addChannelsToEntry, applyUnwatchEntry, trackedRefusal } from './plugins/_shared.js'

export { CooldownGate } from './plugins/_rate-limit.js'

export { resolveProjectChannel } from './naming.js'
