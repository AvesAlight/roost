// Dynamically imports each `config.plugin_paths` entry before `buildPlugins`.
// Each module calls `registerPlugin` at top level (side-effect import).
// Relative paths resolve against the config directory; failures are fatal so
// the dispatcher doesn't silently drop events for a missing plugin.
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { plugin } from 'bun'
import * as pluginApi from './plugin-api.js'
import { registeredPluginNames } from './plugin.js'

// Plugin files import `registerPlugin` from `roost/plugin`. That specifier must
// resolve to the running dispatcher's own plugin-api, or the plugin registers
// into a different registry than the one buildPlugins reads. `build.module`
// intercepts the bare specifier at runtime, even when the project has its own
// copy of roost in node_modules. `onResolve` does not.
let specifierInstalled = false
function installRoostPluginSpecifier(): void {
  if (specifierInstalled) return
  plugin({
    name: 'roost-plugin-api',
    setup(build) {
      build.module('roost/plugin', () => ({ exports: { ...pluginApi }, loader: 'object' }))
    },
  })
  specifierInstalled = true
}

export async function loadExternalPlugins(stateDir: string, paths: string[] | undefined): Promise<void> {
  if (!paths || paths.length === 0) return
  installRoostPluginSpecifier()
  for (const p of paths) {
    const abs = isAbsolute(p) ? p : resolve(stateDir, p)
    const before = registeredPluginNames().length
    // pathToFileURL — node treats absolute paths as bare specifiers without it.
    await import(pathToFileURL(abs).href)
    if (registeredPluginNames().length === before) {
      throw new Error(
        `plugin_paths module registered no plugin: ${abs}. ` +
        `Does its \`roost/plugin\` import resolve to $(roost root)?`
      )
    }
  }
}
