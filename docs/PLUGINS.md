# Writing a roost plugin

A plugin is the unit of extension for the dispatcher (`src/orchestrator.ts`). Each plugin owns symmetric slices of `config.plugins[name]` and `state.plugins[name]`, declares which IRC channels it wants joined, and on each tick returns pre-routed, pre-formatted events for the dispatcher to write.

The built-ins (`github-prs`, `github-issues`, `github-new-issues`, `github-commits`) all use the same seam. External plugins are loaded the same way — they just live outside this repo.

## The seam

External plugins import from `roost/plugin` — never deep `src/orchestrator/...` paths. The set re-exported there is the stable surface; everything else is internal.

```ts
import {
  BasePlugin,
  registerPlugin,
  type Plugin,
  type PluginConfig,
  type PluginTickResult,
  type TaggedEvent,
  type TaggedEventPayload,
  type PluginFactory,
  type PluginLogger,
  type Command,
} from 'roost/plugin'
```

`PluginConfig` is intentionally narrow — `{ plugins?: Record<string, unknown> }`. The dispatcher passes the full orchestrator config at runtime (project/repo/irc/etc. are all present on the value), but declaring your method parameters as `PluginConfig` keeps your code honest about reading only your own slice via `BasePlugin.pluginConfig<T>(config)`. It's a convention, not a fence — but it's the convention the seam is shaped around. Anything you need at config time goes in your slice.

## Contract

Four methods (one optional):

| Method | Purpose |
|---|---|
| `name` | Slot key for both `config.plugins[name]` and `state.plugins[name]`. Must match the string passed to `registerPlugin`. |
| `desiredChannels(config)` | Synchronous, config-only view of channels to join at boot, before the first tick. Excludes the project/default channel (orchestrator adds it). |
| `runTick(config, prevState)` | Returns `{ state, taggedEvents, channels }`. `prevState === null` signals a seed tick. `channels` is the comprehensive post-scrape set. |
| `handleCommand?(config, cmd)` | Optional DM handler. Return a reply line when this plugin owns the command, `null` otherwise. MUST NOT throw — return `"error: ..."` for deterministic failures. |

The dispatcher writes each `TaggedEvent` to every channel in `event.channels`. Event kinds are plugin-internal — pick whatever vocabulary fits your source.

## The register-on-load handshake

The loader treats each `plugin_paths` entry as a side-effect import. The module **must** call `registerPlugin(name, factory)` at top level; the orchestrator then sees the new name when it walks `config.plugins`. If the registration is buried inside a function or a default export, the dispatcher will fail with `unknown plugin in config: <name>`.

Names collide loudly: `registerPlugin` throws on a duplicate. Built-ins are non-negotiable; external plugins pick a unique name (a short scoped slug works — e.g. `acme-deploys`, `linear-issues`).

## Minimal example

```ts
// my-plugin.ts
import { BasePlugin, registerPlugin, type PluginConfig, type PluginTickResult } from 'roost/plugin'

interface MySlice {
  rooms?: string[]
}

class MyPlugin extends BasePlugin {
  readonly name = 'acme-pulse'

  desiredChannels(config: PluginConfig): string[] {
    return this.pluginConfig<MySlice>(config)?.rooms ?? []
  }

  async runTick(config: PluginConfig): Promise<PluginTickResult> {
    const rooms = this.pluginConfig<MySlice>(config)?.rooms ?? []
    return {
      state: null,
      taggedEvents: rooms.map(channel => ({
        channels: [channel],
        payload: { kind: 'oneline', text: '[acme_pulse] still alive' },
      })),
      channels: rooms,
    }
  }
}

registerPlugin('acme-pulse', (defaultChannel) => new MyPlugin(defaultChannel))
```

Operator config:

```json
{
  "project": "acme",
  "irc": { "nick": "acme-dispatcher" },
  "plugin_paths": ["../plugins/my-plugin.ts"],
  "plugins": {
    "acme-pulse": { "rooms": ["#acme-pulse"] }
  }
}
```

Relative `plugin_paths` resolve against `.orchestrator/` (the directory containing `config.json`), so configs stay portable across operator checkouts. Absolute paths work too — the loader runs `path.resolve` either way.

## Failure modes (all fatal at boot)

- A `plugin_paths` entry that doesn't import (missing file, syntax error, throw at top level).
- A duplicate `registerPlugin` name — internal or external collisions both throw.
- A `config.plugins[name]` key with no matching registration (`unknown plugin in config: <name>. available: ...`).

These crash the dispatcher loudly rather than silently dropping events. Fix the path / publish the module / correct the config, then retry.

## Development workflow

A day-1 loop for a fresh external plugin repo:

1. **Bootstrap the repo.** `bun init` (or pnpm/npm equivalent). Add roost via one of the [install patterns](#installing-roostplugin-in-an-external-project) below — `bun link` from a roost checkout for tight dev loops, git-dep for stable consumption.

2. **Write the module.** A single file, top-level `registerPlugin(name, factory)`, no default export. See [Minimal example](#minimal-example).

3. **Wire into a target project's `.orchestrator/config.json`.** `plugin_paths` points at the module file (relative to the config dir, or absolute):

   ```json
   {
     "project": "demo",
     "plugin_paths": ["/abs/path/to/my-plugin-repo/src/my-plugin.ts"],
     "plugins": { "my-plugin": { /* your slice */ } }
   }
   ```

4. **Dry-run the dispatcher.** Prints the `TaggedEvent` JSON to stdout — no IRC connection, no state written:

   ```sh
   "$(roost root)/bin/dispatcher" --dry-run --config-dir .orchestrator
   ```

   (From a roost checkout: `bin/dispatcher --dry-run --config-dir .orchestrator`.)

5. **Iterate.** Edit the plugin file, re-run step 4. The loader re-imports each boot; for a continuously running daemon, restart it (`bin/stop-dispatcher` + `bin/start-dispatcher`).

## Testing

**Unit tests.** Construct the plugin directly and drive its methods. Use `bun:test`'s `spyOn(...).mockImplementation(...)` to stub network calls. Canonical reference: `src/orchestrator/plugins/github/__tests__/commits-plugin.test.ts`.

The shape:

```ts
import { describe, it, expect } from 'bun:test'
import { MyPlugin } from '../my-plugin.js'
import type { PluginConfig } from 'roost/plugin'

const config: PluginConfig = { plugins: { 'my-plugin': { rooms: ['#x'] } } }

describe('MyPlugin.runTick', () => {
  it('seeds without emitting on first run', async () => {
    const result = await new MyPlugin('#proj-leads').runTick(config, null)
    expect(result.taggedEvents).toHaveLength(0)
  })

  it('emits on the second tick when state changes', async () => {
    const prev = { /* ... */ }
    const result = await new MyPlugin('#proj-leads').runTick(config, prev)
    expect(result.taggedEvents[0]?.channels).toEqual(['#x'])
  })
})
```

Two ticks (seed + normal) cover the common case. Mock external IO at the boundary the plugin owns; assert on `state` and `taggedEvents`.

**Integration tests** are optional — a running dispatcher against a test IRC server with only your plugin loaded. Worth it only if your plugin's correctness depends on the dispatch layer (channel sync, DM handling). Most plugins don't.

## Installing `roost/plugin` in an external project

Roost ships via Homebrew tap, not npm, so the import path `'roost/plugin'` doesn't resolve out of the box. Two patterns work today:

- **`bun link` from a roost checkout** — clone roost, `bun link` in the roost root, `bun link roost` in your project. Picks up the `exports` map.
- **Git dependency** — pin roost in your `package.json`:

  ```json
  { "dependencies": { "roost": "github:AvesAlight/roost#<tag>" } }
  ```

Either way, the resolved package exposes only `roost/plugin`. Deep imports into `src/orchestrator/...` are not part of the supported surface and may change.

## Versioning

There is no compile-time API version check yet. The seam is stable in spirit — `Plugin`, `BasePlugin`, `TaggedEvent`, `PluginTickResult` haven't changed shape since they landed — but changes will be signalled via the roost release notes and the tag your git dep is pinned to. A `requires` field on the factory may land once a second project actually ships an external plugin and we have something concrete to coordinate against.
