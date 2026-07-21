import { describe, it, expect } from 'bun:test'
import { reconcileDesiredChannels } from '../../orchestrator.js'
import { GitHubNewIssuesPlugin } from '../plugins/github/new-issues-plugin.js'
import { GitHubPrsPlugin } from '../plugins/github/prs-plugin.js'
import type { OrchestratorConfig } from '../config.js'

// github-new-issues is the config-static plugin from #665: it always returns
// `channels: []` from runTick and relies entirely on desiredChannels for
// membership. github-prs is the tick-dynamic plugin whose runTick channels
// can legitimately drop a channel between ticks (e.g. a linked issue closes).
function config(overrides: Partial<OrchestratorConfig> = {}): OrchestratorConfig {
  return {
    project: 'proj',
    repo: 'org/repo',
    plugins: {
      'github-new-issues': { watched: [{ repo: 'org/repo', channels: ['#homelab'] }] },
    },
    ...overrides,
  }
}

describe('reconcileDesiredChannels', () => {
  it('retains a config-static plugin channel even when this tick reported no dynamic channels', () => {
    const plugins = [new GitHubNewIssuesPlugin('#proj-leads')]
    const cfg = config()

    // github-new-issues always returns channels: [] from runTick — simulate
    // exactly that (the #665 repro: no tick-dynamic plugin naming #homelab).
    const result = reconcileDesiredChannels(plugins, cfg, '#proj-leads', [])

    expect(result).toEqual(['#homelab', '#proj-leads'])
  })

  it('does not retain a dynamic channel this tick no longer names', () => {
    const plugins = [new GitHubNewIssuesPlugin('#proj-leads'), new GitHubPrsPlugin('#proj-leads')]
    const cfg = config()

    // Previous tick, github-prs named #issue-42 (e.g. a linked issue). This
    // tick it doesn't (the linked issue closed) — #issue-42 must be parted,
    // not retained forever just because it once appeared.
    const stale = reconcileDesiredChannels(plugins, cfg, '#proj-leads', ['#issue-42'])
    expect(stale).toContain('#issue-42')

    const current = reconcileDesiredChannels(plugins, cfg, '#proj-leads', [])
    expect(current).not.toContain('#issue-42')
    expect(current).toEqual(['#homelab', '#proj-leads'])
  })
})
