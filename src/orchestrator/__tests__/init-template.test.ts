// Regression guard: the config shape bin/roost's _init_config_json emits must
// not throw on first tick. If this test breaks, the init template needs
// updating alongside the plugin change.
import { describe, it, expect } from 'bun:test'
import { buildPlugins } from '../build-plugins.js'
import type { OrchestratorConfig } from '../config.js'
import '../registry.js'

// Mirrors _init_config_json in bin/roost verbatim (minus irc + agent_logins
// which the orchestrator doesn't touch during a tick).
const INIT_CONFIG: OrchestratorConfig = {
  project: 'my-project',
  repo: 'org/repo',
  plugins: {
    'github-prs': { watched: [] },
    'github-issues': { watched: [] },
    'github-new-issues': { watched: [] },
    'github-commits': { watched: [] },
  },
}

describe('bin/roost init template', () => {
  it('all plugins no-op on first tick without throwing', async () => {
    const plugins = buildPlugins(INIT_CONFIG, '#my-project-leads', () => {})
    const results = await Promise.all(plugins.map(p => p.runTick(INIT_CONFIG, null)))
    for (const result of results) {
      expect(result.taggedEvents).toHaveLength(0)
    }
  })
})
