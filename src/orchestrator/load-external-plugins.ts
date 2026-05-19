// External plugin loader. Each path in `config.plugin_paths` is dynamically
// imported before `buildPlugins` runs. The module is expected to call
// `registerPlugin(name, factory)` at top level (side-effect import); the
// orchestrator then sees the new name when it walks `config.plugins`.
//
// Relative paths resolve against the config directory (`.orchestrator/`),
// so a config like `"plugin_paths": ["../plugins/my-scraper.ts"]` is
// portable across operators. Absolute paths pass through unchanged.
//
// An import or registration failure is fatal: the dispatcher would
// otherwise silently drop events for the missing plugin. Crash loud at
// boot, fix the path / publish the module, retry.
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export async function loadExternalPlugins(stateDir: string, paths: string[] | undefined): Promise<void> {
  if (!paths || paths.length === 0) return
  for (const p of paths) {
    const abs = isAbsolute(p) ? p : resolve(stateDir, p)
    // pathToFileURL keeps ESM `import()` happy on absolute paths; without it
    // node treats `/foo/bar.ts` as a bare specifier on some platforms.
    await import(pathToFileURL(abs).href)
  }
}
