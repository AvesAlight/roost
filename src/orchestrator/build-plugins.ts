// Plugin instantiation. A plugin not listed in `config.plugins` is not built —
// no default-on. New projects pick up shipped plugins via `bin/roost init`.
import type { OrchestratorConfig } from './config.js'
import { getPluginFactory, priorityOf, registeredPluginNames, type Plugin, type PluginLogger } from './plugin.js'

function isParseable(p: Plugin): p is Plugin & { parseCommand: NonNullable<Plugin['parseCommand']> } {
  return typeof p.parseCommand === 'function'
}

// Warn for every pair of configured plugins where both implement parseCommand
// and share the same effective priority. The dispatcher resolves ties by
// config order, silently shadowing the later plugin. Points operators at
// plugin_priorities in config.json.
export function warnPriorityTies(plugins: Plugin[], config: OrchestratorConfig, log: PluginLogger): void {
  const parseable = plugins.filter(isParseable)
  for (let i = 0; i < parseable.length; i++) {
    for (let j = i + 1; j < parseable.length; j++) {
      const a = parseable[i]
      const b = parseable[j]
      const pri = priorityOf(a, config)
      if (pri !== priorityOf(b, config)) continue
      log(
        `[priority-tie] "${a.name}" and "${b.name}" both define parseCommand at priority ${pri};` +
        ` "${b.name}" shadowed by config order if their grammars overlap.` +
        ` set plugin_priorities.${a.name} or plugin_priorities.${b.name} in config.json to resolve.\n`
      )
    }
  }
}

// Order follows `Object.keys` insertion order so emission order is predictable.
export function buildPlugins(config: OrchestratorConfig, defaultChannel: string, log: PluginLogger): Plugin[] {
  const names = Object.keys(config.plugins ?? {})
  const plugins = names.map(name => {
    const factory = getPluginFactory(name)
    if (!factory) {
      const available = registeredPluginNames().sort().join(', ') || '(none)'
      throw new Error(`unknown plugin in config: ${name}. available: ${available}`)
    }
    return factory(defaultChannel, log)
  })
  warnPriorityTies(plugins, config, log)
  return plugins
}
