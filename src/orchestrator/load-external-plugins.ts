// Dynamically imports each `config.plugin_paths` entry before `buildPlugins`.
// Each module calls `registerPlugin` at top level (side-effect import).
// Relative paths resolve against the config directory; failures are fatal so
// the dispatcher doesn't silently drop events for a missing plugin.
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export async function loadExternalPlugins(stateDir: string, paths: string[] | undefined): Promise<void> {
  if (!paths || paths.length === 0) return
  for (const p of paths) {
    const abs = isAbsolute(p) ? p : resolve(stateDir, p)
    // pathToFileURL — node treats absolute paths as bare specifiers without it.
    await import(pathToFileURL(abs).href)
  }
}
