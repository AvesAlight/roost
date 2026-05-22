// Regression guard: the merged shape that `bin/roost init` emits across
// config.json + config.local.json must not throw on first tick. If this
// test breaks, the init templates need updating alongside the plugin
// change.
import { describe, it, expect } from 'bun:test'
import { buildPlugins } from '../build-plugins.js'
import { mergeConfigs, type OrchestratorConfig } from '../config.js'
import '../registry.js'

// Mirrors `_init_config_json` in bin/roost — tracked, static slices only.
const INIT_CONFIG: OrchestratorConfig = {
  project: 'my-project',
  repo: 'org/repo',
  plugins: {
    'github-new-issues': { watched: [] },
    'github-new-prs': { watched: [] },
    'github-commits': { watched: [] },
  },
}

// Mirrors `_init_config_local_json` in bin/roost — gitignored overlay
// with the DM-driven plugin slices.
const INIT_LOCAL: OrchestratorConfig = {
  plugins: {
    'github-prs': { watched: [] },
    'github-issues': { watched: [] },
  },
}

describe('bin/roost init template', () => {
  it('merged shape enables all five built-in plugins', () => {
    const merged = mergeConfigs(INIT_CONFIG, INIT_LOCAL)
    expect(Object.keys(merged.plugins ?? {}).sort()).toEqual([
      'github-commits', 'github-issues', 'github-new-issues', 'github-new-prs', 'github-prs',
    ])
  })

  it('all plugins no-op on first tick without throwing', async () => {
    const merged = mergeConfigs(INIT_CONFIG, INIT_LOCAL)
    const plugins = buildPlugins(merged, '#my-project-leads', () => {})
    const results = await Promise.all(plugins.map(p => p.runTick(merged, null)))
    for (const result of results) {
      expect(result.taggedEvents).toHaveLength(0)
    }
  })
})
