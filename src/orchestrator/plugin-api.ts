// Stable public surface for external plugins. Reach here via the
// `roost/plugin` exports map — never the deep `src/orchestrator/...`
// paths. Intentionally minimal: extend a plugin, register it, type its
// methods. Registry-read (`getPluginFactory`), the stderr logger fallback
// (`defaultPluginLogger`), and the github-shaped watch-list helpers
// (`WatchedEntry` / `resolveRepoEntry`) stay internal — externals don't
// need them and adding them back is a deliberate API change. See
// docs/PLUGINS.md.
export {
  BasePlugin,
  registerPlugin,
  type Plugin,
  type PluginConfig,
  type PluginFactory,
  type PluginLogger,
  type PluginTickResult,
  type TaggedEvent,
  type TaggedEventPayload,
} from './plugin.js'

export type { Command } from './dispatcher-dm-handler.js'
