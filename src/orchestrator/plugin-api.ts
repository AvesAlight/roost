// Public surface for external plugins — reach here via the `roost/plugin`
// exports map. Intentionally minimal: extend, register, type. Adding to this
// is a deliberate API change. See docs/PLUGINS.md.
export {
  BasePlugin,
  registerPlugin,
  type ParseResult,
  type Plugin,
  type PluginConfig,
  type PluginFactory,
  type PluginLogger,
  type PluginTickResult,
  type TaggedEvent,
  type TaggedEventPayload,
} from './plugin.js'

export type { Command } from './dispatcher-dm-handler.js'

export {
  tryClaimPerN,
  tryClaimPerRepo,
  type PerNCommand,
  type PerRepoCommand,
  type Verb,
} from './plugins/grammar.js'
