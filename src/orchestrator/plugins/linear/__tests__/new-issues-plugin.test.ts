import { describe, it, expect, spyOn, beforeAll, afterAll } from 'bun:test'
import { LinearNewIssuesPlugin, type LinearNewIssuesPluginState, formatNewLinearIssue } from '../new-issues-plugin.js'
import { LinearClient, type LinearIssueNode } from '../linear-api.js'
import type { OrchestratorConfig } from '../../../config.js'

const noopLog = () => {}

function issue(identifier: string, overrides: Partial<LinearIssueNode> = {}): LinearIssueNode {
  const [team, num] = identifier.split('-')
  return {
    id: `uuid-${identifier}`,
    identifier,
    title: `Issue ${team}-${num}`,
    labels: null,
    url: `https://linear.app/test/issue/${identifier.toLowerCase()}/issue-${team}-${num}`,
    ...overrides,
  }
}

function baseConfig(overrides: Partial<OrchestratorConfig> = {}): OrchestratorConfig {
  return {
    project: 'proj',
    plugins: { 'linear-new-issues': { watched: [{ team: 'C' }] } },
    ...overrides,
  }
}

// Create a plugin with a fake client (avoids reading LINEAR_API_KEY from env).
function makePlugin(channel = '#proj-leads'): { plugin: LinearNewIssuesPlugin; client: LinearClient } {
  const client = new LinearClient('lin_api_fake_test', noopLog)
  const plugin = new LinearNewIssuesPlugin(channel, noopLog, client)
  return { plugin, client }
}

// Stub fetchTeamOpenIssues on the prototype so all instances in a test get the mock.
function stubFetch(response: LinearIssueNode[]) {
  return spyOn(LinearClient.prototype, 'fetchTeamOpenIssues').mockResolvedValue(response)
}

// Suppress the rate-limit observe path — `getLastRateLimit` returns null, no events.
function stubRateLimit() {
  let spy: { mockRestore(): void }
  beforeAll(() => {
    spy = spyOn(LinearClient.prototype, 'getLastRateLimit').mockReturnValue(null)
  })
  afterAll(() => { spy.mockRestore() })
}

function prevState(identifiers: string[], team = 'C'): LinearNewIssuesPluginState {
  return { teams: { [team]: [...identifiers].sort() } }
}

describe('LinearNewIssuesPlugin.runTick', () => {
  stubRateLimit()

  it('seeds without emitting on first run (prev === null)', async () => {
    const spy = stubFetch([issue('C-1'), issue('C-2'), issue('C-3')])
    try {
      const { plugin } = makePlugin()
      const result = await plugin.runTick(baseConfig(), null)
      expect(result.taggedEvents).toHaveLength(0)
      expect((result.state as LinearNewIssuesPluginState).teams['C']).toEqual(['C-1', 'C-2', 'C-3'])
    } finally { spy.mockRestore() }
  })

  it('emits a oneline announcement for issues new since last tick', async () => {
    const spy = stubFetch([issue('C-1'), issue('C-2'), issue('C-3')])
    try {
      const { plugin } = makePlugin()
      const result = await plugin.runTick(baseConfig(), prevState(['C-1']))
      expect(result.taggedEvents).toHaveLength(2)
      expect(result.taggedEvents[0]?.payload).toEqual({
        kind: 'oneline',
        text: `new linear issue C-2: Issue C-2 — https://linear.app/test/issue/c-2/issue-C-2`,
      })
      expect(result.taggedEvents[1]?.payload).toEqual({
        kind: 'oneline',
        text: `new linear issue C-3: Issue C-3 — https://linear.app/test/issue/c-3/issue-C-3`,
      })
    } finally { spy.mockRestore() }
  })

  it('routes announcements to the project channel by default', async () => {
    const spy = stubFetch([issue('C-5')])
    try {
      const { plugin } = makePlugin()
      const result = await plugin.runTick(baseConfig(), prevState([]))
      expect(result.taggedEvents[0]?.channels).toEqual(['#proj-leads'])
    } finally { spy.mockRestore() }
  })

  it('honors entry.channels override when set', async () => {
    const spy = stubFetch([issue('C-5')])
    try {
      const { plugin } = makePlugin()
      const config = baseConfig({ plugins: { 'linear-new-issues': { watched: [{ team: 'C', channels: ['#triage', '#leads'] }] } } })
      const result = await plugin.runTick(config, prevState([]))
      expect(result.taggedEvents[0]?.channels).toEqual(['#triage', '#leads'])
    } finally { spy.mockRestore() }
  })

  it('emits a defensive per-event channel copy — sibling mutation does not leak', async () => {
    const spy = stubFetch([issue('C-1'), issue('C-2')])
    try {
      const { plugin } = makePlugin()
      const result = await plugin.runTick(baseConfig(), prevState([]))
      result.taggedEvents[0]?.channels.push('#tampered')
      expect(result.taggedEvents[1]?.channels).toEqual(['#proj-leads'])
    } finally { spy.mockRestore() }
  })

  it('includes labels in the announcement when present', async () => {
    const spy = stubFetch([issue('C-7', { labels: { nodes: [{ name: 'bug' }, { name: 'Tooling' }] } })])
    try {
      const { plugin } = makePlugin()
      const result = await plugin.runTick(baseConfig(), prevState([]))
      const text = (result.taggedEvents[0]?.payload as { kind: 'oneline'; text: string }).text
      expect(text).toContain('[bug, Tooling]')
    } finally { spy.mockRestore() }
  })

  it('accumulates seen identifiers across ticks', async () => {
    const spy = stubFetch([issue('C-1'), issue('C-2')])
    try {
      const { plugin } = makePlugin()
      const result = await plugin.runTick(baseConfig(), prevState(['C-5']))
      expect((result.state as LinearNewIssuesPluginState).teams['C']).toEqual(['C-1', 'C-2', 'C-5'])
    } finally { spy.mockRestore() }
  })

  it('does not re-announce issues already in seen', async () => {
    const spy = stubFetch([issue('C-1'), issue('C-2')])
    try {
      const { plugin } = makePlugin()
      const result = await plugin.runTick(baseConfig(), prevState(['C-1', 'C-2']))
      expect(result.taggedEvents).toHaveLength(0)
    } finally { spy.mockRestore() }
  })

  it('no-ops when watched list is empty', async () => {
    const config: OrchestratorConfig = {
      project: 'proj',
      plugins: { 'linear-new-issues': { watched: [] } },
    }
    const { plugin } = makePlugin()
    const result = await plugin.runTick(config, null)
    expect(result.taggedEvents).toHaveLength(0)
  })

  it('no-ops when watched is absent', async () => {
    const config: OrchestratorConfig = {
      project: 'proj',
      plugins: { 'linear-new-issues': {} },
    }
    const { plugin } = makePlugin()
    const result = await plugin.runTick(config, null)
    expect(result.taggedEvents).toHaveLength(0)
  })

  it('orders announcements by identifier', async () => {
    const spy = stubFetch([issue('C-20'), issue('C-5'), issue('C-11')])
    try {
      const { plugin } = makePlugin()
      const result = await plugin.runTick(baseConfig(), prevState([]))
      const identifiers = result.taggedEvents.map(e =>
        ((e.payload as { kind: 'oneline'; text: string }).text.match(/new linear issue (\S+):/)?.[1])
      )
      expect(identifiers).toEqual(['C-11', 'C-20', 'C-5'])
    } finally { spy.mockRestore() }
  })

  it('desiredChannels returns empty when no entry has channels', () => {
    const { plugin } = makePlugin()
    expect(plugin.desiredChannels(baseConfig())).toEqual([])
  })

  it('desiredChannels unions channels across all watched entries', () => {
    const { plugin } = makePlugin()
    const config = baseConfig({
      plugins: {
        'linear-new-issues': {
          watched: [
            { team: 'C', channels: ['#triage'] },
            { team: 'MAR', channels: ['#triage', '#leads'] },
          ],
        },
      },
    })
    expect(plugin.desiredChannels(config)).toEqual(['#triage', '#leads'])
  })

  it('polls each watched team independently', async () => {
    const calls: string[] = []
    const spy = spyOn(LinearClient.prototype, 'fetchTeamOpenIssues').mockImplementation(async (team: string) => {
      calls.push(team)
      return team === 'C' ? [issue('C-1')] : [issue('MAR-2')]
    })
    try {
      const config: OrchestratorConfig = {
        project: 'proj',
        plugins: {
          'linear-new-issues': {
            watched: [{ team: 'C' }, { team: 'MAR' }],
          },
        },
      }
      const { plugin } = makePlugin()
      const result = await plugin.runTick(config, { teams: { C: [], MAR: [] } })
      expect(calls).toEqual(['C', 'MAR'])
      expect(result.taggedEvents).toHaveLength(2)
      expect((result.taggedEvents[0]?.payload as { text: string }).text).toContain('C-1')
      expect((result.taggedEvents[1]?.payload as { text: string }).text).toContain('MAR-2')
    } finally { spy.mockRestore() }
  })

  it('seeds a new team entry without emitting when added to an existing config', async () => {
    const spy = spyOn(LinearClient.prototype, 'fetchTeamOpenIssues').mockImplementation(async (team: string) => {
      return team === 'C' ? [issue('C-1')] : [issue('MAR-10'), issue('MAR-11')]
    })
    try {
      const config: OrchestratorConfig = {
        project: 'proj',
        plugins: {
          'linear-new-issues': {
            watched: [{ team: 'C' }, { team: 'MAR' }],
          },
        },
      }
      const { plugin } = makePlugin()
      // prev state only has C — MAR is brand new
      const result = await plugin.runTick(config, { teams: { C: [] } })
      const texts = result.taggedEvents.map(e => (e.payload as { text: string }).text)
      expect(texts.every(t => t.includes('C-1'))).toBe(true)
      expect(texts.some(t => t.includes('MAR'))).toBe(false)
      expect((result.state as LinearNewIssuesPluginState).teams['MAR']).toEqual(['MAR-10', 'MAR-11'])
    } finally { spy.mockRestore() }
  })

  it('carries forward removed-entry state — remove-then-readd does not replay history', async () => {
    const spy = stubFetch([issue('C-5')])
    try {
      const { plugin } = makePlugin()
      const result = await plugin.runTick(
        baseConfig(),
        { teams: { C: [], GONE: ['GONE-10', 'GONE-11'] } },
      )
      const state = result.state as LinearNewIssuesPluginState
      expect(state.teams['GONE']).toEqual(['GONE-10', 'GONE-11'])
    } finally { spy.mockRestore() }
  })

  it('treats old non-teams state shape as null and re-seeds', async () => {
    const spy = stubFetch([issue('C-1'), issue('C-2')])
    try {
      const { plugin } = makePlugin()
      const oldState = { seen_identifiers: ['C-1', 'C-2', 'C-3'] }
      const result = await plugin.runTick(baseConfig(), oldState)
      // Re-seeded: no events emitted
      expect(result.taggedEvents).toHaveLength(0)
      expect((result.state as LinearNewIssuesPluginState).teams['C']).toEqual(['C-1', 'C-2'])
    } finally { spy.mockRestore() }
  })

  it('logs and continues when fetchTeamOpenIssues throws', async () => {
    const logs: string[] = []
    const errClient = new LinearClient('lin_api_fake_test', (msg) => { logs.push(msg) })
    const spy = spyOn(LinearClient.prototype, 'fetchTeamOpenIssues').mockRejectedValue(new Error('network error'))
    try {
      const plugin = new LinearNewIssuesPlugin('#proj-leads', (msg) => { logs.push(msg) }, errClient)
      const result = await plugin.runTick(baseConfig(), prevState([]))
      expect(result.taggedEvents).toHaveLength(0)
      expect(logs.some(l => l.includes('network error'))).toBe(true)
    } finally { spy.mockRestore() }
  })
})

describe('formatNewLinearIssue', () => {
  it('formats without labels', () => {
    const text = formatNewLinearIssue(issue('C-758'))
    expect(text).toBe('new linear issue C-758: Issue C-758 — https://linear.app/test/issue/c-758/issue-C-758')
  })

  it('formats with labels', () => {
    const text = formatNewLinearIssue(issue('C-758', { labels: { nodes: [{ name: 'carrot' }, { name: 'Tooling' }] } }))
    expect(text).toContain('[carrot, Tooling]')
  })

  it('handles null labels gracefully', () => {
    const text = formatNewLinearIssue(issue('C-1', { labels: null }))
    expect(text).not.toContain('[')
  })
})
