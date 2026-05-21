import { describe, it, expect } from 'bun:test'
import { LinearIssuesPlugin, type LinearClientLike } from '../issues-plugin.js'
import type { OrchestratorConfig } from '../../../config.js'
import type { Command } from '../../../dispatcher-dm-handler.js'
import type { LinearIssuePluginState, LinearIssueSnap, LinearIssueTombstone } from '../types.js'
import { isTombstone } from '../types.js'
import type { RawLinearIssue } from '../diff.js'

// ---- Test scaffolding ----------------------------------------------------

function mockClient(handler: (id: string) => RawLinearIssue | null): LinearClientLike {
  return {
    graphql: async (_q, vars) => {
      const id = (vars as { id: string }).id
      return { issue: handler(id) }
    },
    getLastRateLimit: () => null,
  }
}

function plugin(client: LinearClientLike): LinearIssuesPlugin {
  return new LinearIssuesPlugin('#proj-leads', () => {}, client)
}

function watchCmd(identifier: string, channels: string[] = []): Command {
  return {
    kind: 'plugin',
    plugin: 'linear-issues',
    cmd: { verb: 'watch', identifier, channels },
    raw: '',
  }
}

function unwatchCmd(identifier: string): Command {
  return {
    kind: 'plugin',
    plugin: 'linear-issues',
    cmd: { verb: 'unwatch', identifier, channels: [] },
    raw: '',
  }
}

function rawIssue(overrides: Partial<RawLinearIssue> = {}): RawLinearIssue {
  return {
    id: 'uuid-1',
    identifier: 'C-758',
    title: 'A title',
    url: 'https://linear.app/teakio/issue/C-758/a-title',
    state: { type: 'started', name: 'In Progress' },
    labels: { nodes: [] },
    comments: { nodes: [] },
    attachments: { nodes: [] },
    ...overrides,
  }
}

// ---- handleCommand: watch / unwatch / list / help ------------------------

describe('LinearIssuesPlugin.handleCommand — watch', () => {
  const p = () => new LinearIssuesPlugin('#proj-leads')

  it('lands an entry in local overlay (AC: `watch linear C-758`)', () => {
    const merged: OrchestratorConfig = { project: 'proj' }
    const local: OrchestratorConfig = {}
    const out = p().handleCommand!(merged, local, watchCmd('C-758'))
    expect(out).toMatch(/watching linear issue C-758/)
    expect((local.plugins?.['linear-issues'] as { watched: unknown[] }).watched).toEqual([{ identifier: 'C-758' }])
  })

  it('idempotent on duplicate watch (tracked entry visible via merged)', () => {
    const merged: OrchestratorConfig = {
      project: 'proj',
      plugins: { 'linear-issues': { watched: [{ identifier: 'C-758' }] } },
    }
    const local: OrchestratorConfig = {}
    const out = p().handleCommand!(merged, local, watchCmd('C-758'))
    expect(out).toMatch(/already watching/)
    expect(local.plugins?.['linear-issues']).toBeUndefined()
  })

  it('appends channels to local entry', () => {
    const slice = { watched: [{ identifier: 'C-758', channels: ['#a'] }] }
    const merged: OrchestratorConfig = { project: 'proj', plugins: { 'linear-issues': slice } }
    const local: OrchestratorConfig = { plugins: { 'linear-issues': slice } }
    p().handleCommand!(merged, local, watchCmd('C-758', ['#a', '#b']))
    const entry = (local.plugins!['linear-issues'] as { watched: { channels: string[] }[] }).watched[0]
    expect(entry.channels).toEqual(['#a', '#b'])
  })

  it('refuses to add channels to a tracked-only entry', () => {
    const merged: OrchestratorConfig = {
      project: 'proj',
      plugins: { 'linear-issues': { watched: [{ identifier: 'C-758' }] } },
    }
    const out = p().handleCommand!(merged, {}, watchCmd('C-758', ['#x']))
    expect(out).toBe('linear issue C-758 in tracked config.json — hand-edit to add channels')
  })

  it('unwatch removes a local entry', () => {
    const local: OrchestratorConfig = {
      plugins: { 'linear-issues': { watched: [{ identifier: 'C-758' }, { identifier: 'D-1' }] } },
    }
    const merged: OrchestratorConfig = { project: 'proj', ...local }
    p().handleCommand!(merged, local, unwatchCmd('C-758'))
    expect((local.plugins!['linear-issues'] as { watched: { identifier: string }[] }).watched)
      .toEqual([{ identifier: 'D-1' }])
  })

  it('list shows watched issues', () => {
    const merged: OrchestratorConfig = {
      project: 'proj',
      plugins: { 'linear-issues': { watched: [{ identifier: 'C-758' }, { identifier: 'ENG-1', channels: ['#x'] }] } },
    }
    const out = p().handleCommand!(merged, {}, { kind: 'list', raw: '' } as Command)
    expect(out).toContain('linear-issues (2):')
    expect(out).toContain('  C-758')
    expect(out).toContain('  ENG-1 + #x')
  })

  it('help advertises the grammar', () => {
    const out = p().handleCommand!({}, {}, { kind: 'help', raw: '' } as Command)!
    expect(out).toContain('linear-issues commands')
    expect(out).toMatch(/watch linear <TEAM>-<N>/)
  })
})

// ---- runTick: routing + state ------------------------------------------

describe('LinearIssuesPlugin.runTick — routing', () => {
  it('emits added_to_watch + backlog when entry is new to a populated state', async () => {
    // prev is a real state object (post-seed); the entry is new — prevEntry=null
    // path triggers seed events. prev=null in runTick means orchestrator-wide
    // seed, which suppresses all events; that's a separate path.
    const client = mockClient(() => rawIssue({
      comments: { nodes: [{ id: 'c-old', body: 'old', user: { name: 'a' }, parent: null }] },
    }))
    const cfg: OrchestratorConfig = {
      project: 'proj',
      plugins: { 'linear-issues': { watched: [{ identifier: 'C-758' }] } },
    }
    const result = await plugin(client).runTick(cfg, { issues: {} })
    const addedToWatch = result.taggedEvents.find(e =>
      e.payload.kind === 'oneline' && e.payload.text.startsWith('now watching linear issue'))
    expect(addedToWatch).toBeDefined()
    expect(addedToWatch?.channels).toEqual(['#proj-leads'])

    const backlog = result.taggedEvents.find(e =>
      e.payload.kind === 'oneline' && e.payload.text.includes('BACKLOG'))
    expect(backlog).toBeDefined()
    expect(backlog?.channels).toEqual(['#proj-issue-c-758'])

    const state = result.state as LinearIssuePluginState
    expect(isTombstone(state.issues['C-758'])).toBe(false)
  })

  it('orchestrator-wide seed (prev=null) tombstones missing issues silently', async () => {
    const client = mockClient(() => null)
    const cfg: OrchestratorConfig = {
      project: 'proj',
      plugins: { 'linear-issues': { watched: [{ identifier: 'C-9999' }] } },
    }
    const result = await plugin(client).runTick(cfg, null)
    // Seed path emits nothing — mirror github's `prevSnap === undefined` rule.
    expect(result.taggedEvents).toEqual([])
    expect(isTombstone((result.state as LinearIssuePluginState).issues['C-9999'])).toBe(true)
  })

  it('routes per-issue events to #<project>-issue-<team>-<n>', async () => {
    const prev: LinearIssuePluginState = {
      issues: {
        'C-758': {
          id: 'uuid-1', identifier: 'C-758', title: 't', url: 'https://x',
          status: 'In Progress', statusType: 'started', labels: [],
          seen_comment_ids: [], seen_github_attachment_ids: [],
        } as LinearIssueSnap,
      },
    }
    const client = mockClient(() => rawIssue({
      state: { type: 'completed', name: 'Done' },
    }))
    const cfg: OrchestratorConfig = {
      project: 'proj',
      plugins: { 'linear-issues': { watched: [{ identifier: 'C-758' }] } },
    }
    const result = await plugin(client).runTick(cfg, prev)
    const stateEv = result.taggedEvents.find(e =>
      e.payload.kind === 'oneline' && e.payload.text.includes('state:'))
    expect(stateEv).toBeDefined()
    expect(stateEv?.channels).toEqual(['#proj-issue-c-758'])
  })
})

// ---- runTick: disappeared (AC) -----------------------------------------

describe('LinearIssuesPlugin.runTick — disappeared lifecycle', () => {
  it('AC: `watch linear C-9999` accepted then disappeared fires once next tick', async () => {
    const client = mockClient(() => null) // 404 every time
    const cfg: OrchestratorConfig = {
      project: 'proj',
      plugins: { 'linear-issues': { watched: [{ identifier: 'C-9999' }] } },
    }

    // First tick after the DM lands — prev is the post-seed state object,
    // entry is new (prev.issues[key] undefined → prevEntry=null in scraper).
    const tick1 = await plugin(client).runTick(cfg, { issues: {} })
    const disappeared = tick1.taggedEvents.find(e =>
      e.payload.kind === 'oneline' && e.payload.text.includes('no longer accessible'))
    expect(disappeared).toBeDefined()
    expect(disappeared?.channels).toEqual(['#proj-leads']) // project channel
    expect(isTombstone((tick1.state as LinearIssuePluginState).issues['C-9999'])).toBe(true)

    // Second tick: prev now carries the tombstone — no re-emit, no fetch.
    let fetchCalls = 0
    const guardedClient: LinearClientLike = {
      graphql: async () => { fetchCalls++; return { issue: null } },
      getLastRateLimit: () => null,
    }
    const tick2 = await new LinearIssuesPlugin('#proj-leads', () => {}, guardedClient)
      .runTick(cfg, tick1.state as LinearIssuePluginState)
    expect(fetchCalls).toBe(0)
    const reEmit = tick2.taggedEvents.find(e =>
      e.payload.kind === 'oneline' && e.payload.text.includes('no longer accessible'))
    expect(reEmit).toBeUndefined()
    expect(isTombstone((tick2.state as LinearIssuePluginState).issues['C-9999'])).toBe(true)
  })
})

// ---- runTick: backlog seed fires once (AC) -----------------------------

describe('LinearIssuesPlugin.runTick — backlog seed once-only', () => {
  it('first tick (entry new to populated state) emits backlog; second tick does not re-emit', async () => {
    const client = mockClient(() => rawIssue({
      comments: { nodes: [{ id: 'c1', body: 'old', user: null, parent: null }] },
    }))
    const cfg: OrchestratorConfig = {
      project: 'proj',
      plugins: { 'linear-issues': { watched: [{ identifier: 'C-758' }] } },
    }

    const tick1 = await plugin(client).runTick(cfg, { issues: {} })
    expect(tick1.taggedEvents.some(e =>
      e.payload.kind === 'oneline' && e.payload.text.includes('BACKLOG'))).toBe(true)

    const tick2 = await plugin(client).runTick(cfg, tick1.state as LinearIssuePluginState)
    expect(tick2.taggedEvents.some(e =>
      e.payload.kind === 'oneline' && e.payload.text.includes('BACKLOG'))).toBe(false)
  })
})

// ---- runTick: no watches -----------------------------------------------

describe('LinearIssuesPlugin.runTick — no watches', () => {
  it('returns empty result without touching the client', async () => {
    let calls = 0
    const client: LinearClientLike = {
      graphql: async () => { calls++; return { issue: null } },
      getLastRateLimit: () => null,
    }
    const result = await plugin(client).runTick({ project: 'proj' }, null)
    expect(calls).toBe(0)
    expect(result.taggedEvents).toEqual([])
    expect(result.channels).toEqual([])
  })
})

// ---- desiredChannels ---------------------------------------------------

describe('LinearIssuesPlugin.desiredChannels', () => {
  it('emits per-issue channel for each watched entry, plus declared extras', () => {
    const cfg: OrchestratorConfig = {
      project: 'proj',
      plugins: { 'linear-issues': { watched: [
        { identifier: 'C-758' },
        { identifier: 'ENG-1', channels: ['#extra'] },
      ] } },
    }
    const chans = new LinearIssuesPlugin('#proj-leads').desiredChannels(cfg).sort()
    expect(chans).toEqual(['#extra', '#proj-issue-c-758', '#proj-issue-eng-1'])
  })

  it('empty when no watches (no project lookup required)', () => {
    expect(new LinearIssuesPlugin('#proj-leads').desiredChannels({})).toEqual([])
  })
})

// ---- isTombstone re-export (used as discriminant) ---------------------

describe('isTombstone helper', () => {
  it('discriminates between snap and tombstone', () => {
    const snap: LinearIssueSnap = {
      id: 'u', identifier: 'C-1', title: null, url: null,
      status: null, statusType: null, labels: [],
      seen_comment_ids: [], seen_github_attachment_ids: [],
    }
    const tomb: LinearIssueTombstone = { identifier: 'C-1', disappeared: true }
    expect(isTombstone(snap)).toBe(false)
    expect(isTombstone(tomb)).toBe(true)
    expect(isTombstone(null)).toBe(false)
    expect(isTombstone(undefined)).toBe(false)
  })
})
