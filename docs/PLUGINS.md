# Writing a roost plugin

A plugin polls a source on each dispatcher tick and returns IRC events. It owns a config slice at `config.plugins[name]` and a state slice at `state.plugins[name]`. The same name keys both.

The built-ins (`github-prs`, `github-issues`, `github-new-issues`, `github-new-prs`, `github-commits`) all use this contract. External plugins load via `plugin_paths` in your dispatcher config and use the same contract.

## The seam

Import from `roost/plugin`. Deep imports into `src/orchestrator/...` are not supported and may change.

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

`PluginConfig` is `{ plugins?: Record<string, unknown> }`. The dispatcher passes the full config at runtime. Type your method parameters as `PluginConfig` and read your slice via `BasePlugin.pluginConfig<T>(config)`. Put everything else you need in your slice.

## Contract

| Method | Purpose |
|---|---|
| `name` | Slot key for both slices. Must match the string passed to `registerPlugin`. |
| `desiredChannels(config)` | Channels to join at boot. The orchestrator adds the project channel. |
| `runTick(config, prevState)` | Returns `{ state, taggedEvents, channels }`. `prevState === null` on a seed tick. `channels` is the post-scrape set. |
| `parseCommand?(line)` | Optional. Claim a single watch/unwatch DM line. See "DM grammar" below. |
| `grammarPriority?` | Optional. Higher = parsed first when two plugins overlap. Default 0. Operator override: `config.plugin_priorities[name]` replaces this outright. |
| `handleCommand?(merged, local, cmd)` | Optional. Receives `list`/`help` broadcasts + any command this plugin's own `parseCommand` claimed. Returns a reply or `null`. Return `"error: ..."` on failure. Don't throw. |

The dispatcher writes each `TaggedEvent` to every channel in `event.channels`. Event kind strings are yours.

## DM grammar

The dispatcher knows only two global verbs (`help`, `watch list`) and an allowlist. Everything else — `watch <N>`, `watch pr 5`, `watch repo org/r@main`, your own `watch deploy …` — is parsed by the plugin that claims the shape. The canonical semantics live on `Plugin.parseCommand` in `src/orchestrator/plugin.ts` (defer with `null`, claim with `{kind:'ok',cmd}`, fail with `{kind:'error',message}`).

Shared parser helpers cover the two shipped shapes:

```ts
import { tryClaimPerN, tryClaimPerRepo } from 'roost/plugin'

class MyPlugin extends BasePlugin {
  readonly name = 'acme-deploy'
  parseCommand(line: string) {
    // Claims `watch deploy <N>` / `unwatch deploy <N>`.
    return tryClaimPerN('deploy', line)
  }
  handleCommand(merged, local, cmd) {
    if (cmd.kind === 'list') return `${this.name}: …`
    if (cmd.kind === 'help') return `${this.name}: …`
    if (cmd.kind === 'plugin' && cmd.plugin === this.name) {
      const c = cmd.cmd as { verb: 'watch'|'unwatch'; number: number; repo: string|null; channels: string[] }
      // …
    }
    return null
  }
}
```

When two plugins want overlapping shapes (e.g. a linear plugin claiming bare `watch <N>` alongside `github-issues`), pick a `grammarPriority` (higher wins) or let the operator set `config.plugin_priorities`. Once a plugin returns `{kind:'error'}`, no other plugin gets a second crack at that line — the producing plugin's parser is the authority on its shape.

### Migration from pre-0.7.0

Plugins that used to receive every `Command` via `handleCommand` (the central parser model) need to add a `parseCommand` to claim what they want. `handleCommand` now only fires for `list`, `help`, and the plugin's own claimed commands. There are no built-in `watch`/`unwatch`/`watch-repo`/`unwatch-repo` Command kinds anymore; the dispatcher wraps claimed payloads as `{kind:'plugin', plugin:<name>, cmd:<your shape>, raw:<original DM line>}`. `raw` is dispatcher-injected for logging — plugin authors don't set it, but test code constructing synthetic `plugin` Commands must include it.

## Register on load

Each `plugin_paths` entry is imported for its side effects. The module must call `registerPlugin(name, factory)` at the top level. If you bury the call in a function or a default export, the dispatcher fails with `unknown plugin in config: <name>`.

`registerPlugin` throws on duplicate names. Built-in names are reserved. Pick a unique slug like `acme-deploys` or `linear-issues`.

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

Relative `plugin_paths` resolve against `.orchestrator/`. Absolute paths work too.

## Failure modes (all fatal at boot)

- `plugin_paths` entry won't import: missing file, syntax error, top-level throw.
- Duplicate `registerPlugin` name.
- `config.plugins[name]` with no matching registration: `unknown plugin in config: <name>. available: ...`.

## Development workflow

From a fresh repo:

1. **Bootstrap.** `bun init` (or pnpm/npm). Add roost via one of the [install patterns](#installing-roostplugin) below: `bun link` for dev, git-dep for stable consumption.

2. **Write the module.** A single file, top-level `registerPlugin(name, factory)`, no default export. See [Minimal example](#minimal-example).

3. **Wire into a target project's `.orchestrator/config.json`.** `plugin_paths` points at the module file (relative to the config dir, or absolute):

   ```json
   {
     "project": "demo",
     "plugin_paths": ["/abs/path/to/my-plugin-repo/src/my-plugin.ts"],
     "plugins": { "my-plugin": { /* your slice */ } }
   }
   ```

4. **Dry-run the dispatcher.** Prints `TaggedEvent` JSON to stdout. No IRC, no state written.

   ```sh
   "$(roost root)/bin/dispatcher" --dry-run --config-dir .orchestrator
   ```

   From a roost checkout: `bin/dispatcher --dry-run --config-dir .orchestrator`.

5. **Iterate.** Edit and re-run step 4. For a running daemon, restart it: `bin/stop-dispatcher` then `bin/start-dispatcher`.

## Testing

**Unit tests.** Construct the plugin and call its methods. Stub network calls with `bun:test`'s `spyOn(...).mockImplementation(...)`. Reference: `src/orchestrator/plugins/github/__tests__/commits-plugin.test.ts`.

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

Mock IO at the boundary your plugin owns. Assert on `state` and `taggedEvents`.

**Integration tests** are optional. Spin up a test IRC server and run the dispatcher with only your plugin loaded. Worth doing only if your plugin depends on the dispatch layer (channel sync, DM handling).

## Installing `roost/plugin`

Roost ships via Homebrew tap, not npm. The import path `'roost/plugin'` doesn't resolve out of the box. Two ways to fix it:

- **`bun link`.** Clone roost, `bun link` in its root, `bun link roost` in your project.
- **Git dependency.** Pin roost in your `package.json`:

  ```json
  { "dependencies": { "roost": "github:AvesAlight/roost#<tag>" } }
  ```

Both expose only `roost/plugin`. Deep imports may change.

## Versioning

No compile-time API check yet. The seam types (`Plugin`, `BasePlugin`, `TaggedEvent`, `PluginTickResult`) haven't changed shape since they landed. Pin a tag if you need stability. A `requires` field may land once a second external plugin exists.
