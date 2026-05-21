import { describe, it, expect } from 'bun:test'
import { buildPlugins, warnPriorityTies } from '../build-plugins.js'
import type { OrchestratorConfig } from '../config.js'
import type { Plugin, PluginTickResult } from '../plugin.js'
import '../registry.js'

const NOOP_LOG = () => {}

describe('buildPlugins', () => {
  it('instantiates plugins listed under config.plugins', () => {
    const cfg: OrchestratorConfig = {
      project: 'proj',
      repo: 'org/repo',
      plugins: { 'github-issues': { watched: [] }, 'github-prs': { watched: [] } },
    }
    const names = buildPlugins(cfg, '#proj-leads', NOOP_LOG).map(p => p.name)
    expect(names).toEqual(['github-issues', 'github-prs'])
  })

  it('does not instantiate plugins absent from config.plugins (no default-on)', () => {
    const cfg: OrchestratorConfig = {
      project: 'proj',
      repo: 'org/repo',
      plugins: { 'github-issues': { watched: [] } },
    }
    const names = buildPlugins(cfg, '#proj-leads', NOOP_LOG).map(p => p.name)
    expect(names).toEqual(['github-issues'])
  })

  it('returns an empty list when config.plugins is missing', () => {
    const cfg: OrchestratorConfig = { project: 'proj', repo: 'org/repo' }
    expect(buildPlugins(cfg, '#proj-leads', NOOP_LOG)).toEqual([])
  })

  it('preserves Object.keys insertion order so emission order is predictable', () => {
    const cfg: OrchestratorConfig = {
      project: 'proj',
      repo: 'org/repo',
      plugins: {
        'github-new-issues': { watched: [] },
        'github-prs': { watched: [] },
        'github-issues': { watched: [] },
      },
    }
    const names = buildPlugins(cfg, '#proj-leads', NOOP_LOG).map(p => p.name)
    expect(names).toEqual(['github-new-issues', 'github-prs', 'github-issues'])
  })

  it('throws on unknown plugin key', () => {
    const cfg: OrchestratorConfig = {
      project: 'proj',
      repo: 'org/repo',
      plugins: { 'nonexistent': {} },
    }
    expect(() => buildPlugins(cfg, '#proj-leads', NOOP_LOG)).toThrow(/unknown plugin/)
  })

  it('error message lists the available registered plugins', () => {
    const cfg: OrchestratorConfig = {
      project: 'proj',
      repo: 'org/repo',
      plugins: { 'typo-plugin': {} },
    }
    expect(() => buildPlugins(cfg, '#proj-leads', NOOP_LOG)).toThrow(/available:.*github-issues/)
  })

  it('instantiates github-commits when listed in config.plugins', () => {
    const cfg: OrchestratorConfig = {
      project: 'proj',
      repo: 'org/repo',
      plugins: { 'github-commits': { watched: [] } },
    }
    const names = buildPlugins(cfg, '#proj-leads', NOOP_LOG).map(p => p.name)
    expect(names).toEqual(['github-commits'])
  })

  it('does not instantiate github-commits when absent from config.plugins (default-off)', () => {
    const cfg: OrchestratorConfig = {
      project: 'proj',
      repo: 'org/repo',
      plugins: { 'github-prs': { watched: [] } },
    }
    const names = buildPlugins(cfg, '#proj-leads', NOOP_LOG).map(p => p.name)
    expect(names).toEqual(['github-prs'])
  })
})

// ---- warnPriorityTies -------------------------------------------------------

// Minimal stub — no registry, no factory. Tests exercise warnPriorityTies directly.
function makePlugin(name: string, claims: string[], grammarPriority?: number): Plugin {
  return {
    name,
    grammarPriority,
    parseCommand: (line: string) => claims.includes(line) ? { kind: 'ok', cmd: {} } : null,
    desiredChannels: () => [],
    runTick: async (): Promise<PluginTickResult> => ({ state: null, taggedEvents: [], channels: [] }),
  }
}

function makePlainPlugin(name: string): Plugin {
  return {
    name,
    desiredChannels: () => [],
    runTick: async (): Promise<PluginTickResult> => ({ state: null, taggedEvents: [], channels: [] }),
  }
}

describe('warnPriorityTies', () => {
  it('no warning when no plugins have parseCommand', () => {
    const logs: string[] = []
    warnPriorityTies([makePlainPlugin('a'), makePlainPlugin('b')], {}, msg => logs.push(msg))
    expect(logs).toHaveLength(0)
  })

  it('no warning when same-priority plugins claim different lines', () => {
    const logs: string[] = []
    const a = makePlugin('a', ['watch 1'])
    const b = makePlugin('b', ['watch org/repo'])
    warnPriorityTies([a, b], {}, msg => logs.push(msg))
    expect(logs).toHaveLength(0)
  })

  it('warns when two plugins both claim the same probe line at the same priority', () => {
    const logs: string[] = []
    const a = makePlugin('a', ['watch 1'])
    const b = makePlugin('b', ['watch 1'])
    warnPriorityTies([a, b], {}, msg => logs.push(msg))
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('"a"')
    expect(logs[0]).toContain('"watch 1"')
    expect(logs[0]).toContain('"b" shadowed')
    expect(logs[0]).toContain('plugin_priorities.a')
    expect(logs[0]).toContain('plugin_priorities.b')
  })

  it('no warning when priorities differ', () => {
    const logs: string[] = []
    const a = makePlugin('a', ['watch 1'], 10)
    const b = makePlugin('b', ['watch 1'], 0)
    warnPriorityTies([a, b], {}, msg => logs.push(msg))
    expect(logs).toHaveLength(0)
  })

  it('plugin_priorities override resolves a tie', () => {
    const logs: string[] = []
    const a = makePlugin('a', ['watch 1'])
    const b = makePlugin('b', ['watch 1'])
    const config: OrchestratorConfig = { plugin_priorities: { a: 5 } }
    warnPriorityTies([a, b], config, msg => logs.push(msg))
    expect(logs).toHaveLength(0)
  })

  it('warns once per conflicting pair even when multiple probe lines tie', () => {
    const logs: string[] = []
    const a = makePlugin('a', ['watch 1', 'watch org/repo'])
    const b = makePlugin('b', ['watch 1', 'watch org/repo'])
    warnPriorityTies([a, b], {}, msg => logs.push(msg))
    expect(logs).toHaveLength(1)
  })

  it('warns for each conflicting pair independently', () => {
    const logs: string[] = []
    const a = makePlugin('a', ['watch 1'])
    const b = makePlugin('b', ['watch 1'])
    const c = makePlugin('c', ['watch 1'])
    warnPriorityTies([a, b, c], {}, msg => logs.push(msg))
    expect(logs).toHaveLength(3)
  })

  it('only pairs where both have parseCommand are checked', () => {
    const logs: string[] = []
    const a = makePlugin('a', ['watch 1'])
    const plain = makePlainPlugin('plain')
    const b = makePlugin('b', ['watch 1'])
    warnPriorityTies([a, plain, b], {}, msg => logs.push(msg))
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('"a"')
    expect(logs[0]).toContain('"b"')
  })
})
