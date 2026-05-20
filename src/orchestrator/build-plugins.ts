// Plugin instantiation. A plugin not listed in `config.plugins` is not built —
// no default-on. New projects pick up shipped plugins via `bin/roost init`.
import type { OrchestratorConfig } from './config.js'
import { getPluginFactory, registeredPluginNames, type Plugin, type PluginLogger } from './plugin.js'

// Order follows `Object.keys` insertion order so emission order is predictable.
export function buildPlugins(config: OrchestratorConfig, defaultChannel: string, log: PluginLogger): Plugin[] {
  const names = Object.keys(config.plugins ?? {})
  return names.map(name => {
    const factory = getPluginFactory(name)
    if (!factory) {
      const available = registeredPluginNames().sort().join(', ') || '(none)'
      throw new Error(`unknown plugin in config: ${name}. available: ${available}`)
    }
    return factory(defaultChannel, log)
  })
}
