import { describe, it, expect } from 'bun:test'
import { buildPlugins } from '../build-plugins.js'
import type { OrchestratorConfig } from '../config.js'
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
