// Fetch fixtures shaped like CircleCI v2 responses for gh/GoCarrot/arboretum.
// A mutable scenario plus a router that answers the three list endpoints, so
// the plugin runs against the real client with only `fetch` replaced.
import { CircleCiClient, CIRCLECI_API } from '../circleci-api.js'
import { CircleCiPlugin, type CircleCiPluginState } from '../circleci-plugin.js'
import type { OrchestratorConfig } from '../../../config.js'

export const SLUG = 'gh/GoCarrot/arboretum'
export const SHA = 'abc1234'
export const FULL_SHA = 'abc1234def5678abc1234def5678abc1234def5'
export const START = 1_700_000_000_000
export const STEP_MS = 90_000

export function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
}

export function pipeline(n: number, over: Record<string, unknown> = {}) {
  return {
    id: uuid(n),
    project_slug: SLUG,
    number: n,
    state: 'created',
    created_at: '2026-11-10T10:00:00Z',
    vcs: { provider_name: 'GitHub', revision: FULL_SHA, branch: 'main' },
    ...over,
  }
}

export function workflow(id: number, pipelineN: number, name: string, status: string) {
  return { pipeline_id: uuid(pipelineN), id: uuid(id), name, project_slug: SLUG, status, pipeline_number: pipelineN, created_at: `2026-11-10T10:${String(id % 60).padStart(2, '0')}:00Z` }
}

export function buildJob(id: number, name: string, status: string, jobNumber: number) {
  return { id: uuid(id), name, project_slug: SLUG, status, type: 'build', job_number: jobNumber, dependencies: [] }
}

export function approvalJob(id: number, name: string, status: string) {
  return { id: uuid(id), name, project_slug: SLUG, status, type: 'approval', approval_request_id: uuid(id), dependencies: [] }
}

interface Failure { match: RegExp; status: number; headers?: Record<string, string> }

export interface Fx {
  pipelines: unknown[]
  // When set, the pipeline list is served in these pages (tokens p1, p2, ...).
  pipelinePages: unknown[][] | null
  workflows: Record<string, unknown[]>
  jobs: Record<string, unknown[]>
  calls: string[]
  failures: Failure[]
}

export function makeFx(): Fx {
  return { pipelines: [], pipelinePages: null, workflows: {}, jobs: {}, calls: [], failures: [] }
}

export function callsMatching(fx: Fx, re: RegExp): number {
  return fx.calls.filter(c => re.test(c)).length
}

function respond(fx: Fx, url: string): Response {
  const path = url.slice(CIRCLECI_API.length)
  fx.calls.push(path)
  const failure = fx.failures.find(f => f.match.test(path))
  if (failure) return new Response('{}', { status: failure.status, headers: failure.headers })
  const [bare, query = ''] = path.split('?')
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
  if (/\/pipeline$/.test(bare)) {
    if (fx.pipelinePages) {
      const token = new URLSearchParams(query).get('page-token')
      const idx = token ? Number(token.slice(1)) : 0
      const next = idx + 1 < fx.pipelinePages.length ? `p${idx + 1}` : null
      return json({ items: fx.pipelinePages[idx] ?? [], next_page_token: next })
    }
    return json({ items: fx.pipelines, next_page_token: null })
  }
  const wf = bare.match(/^\/pipeline\/([^/]+)\/workflow$/)
  if (wf) return json({ items: fx.workflows[wf[1]] ?? [], next_page_token: null })
  const jobs = bare.match(/^\/workflow\/([^/]+)\/job$/)
  if (jobs) return json({ items: fx.jobs[jobs[1]] ?? [], next_page_token: null })
  return new Response('{}', { status: 404 })
}

export interface Harness {
  fx: Fx
  plugin: CircleCiPlugin
  logs: string[]
  clock: { t: number }
  state: CircleCiPluginState | null
  config: OrchestratorConfig
  // Advance the clock, run one tick, carry state forward. Returns message texts.
  step(ms?: number): Promise<string[]>
  lastMessages: Array<{ channels: string[]; text: string }>
}

export function makeConfig(watched: unknown[], extra: Record<string, unknown> = {}): OrchestratorConfig {
  return { project: 'proj', repo: 'org/repo', plugins: { circleci: { watched, ...extra } } }
}

export function makeHarness(opts: { watched?: unknown[]; config?: OrchestratorConfig; token?: string | null } = {}): Harness {
  const fx = makeFx()
  const logs: string[] = []
  const clock = { t: START }
  const token = opts.token === undefined ? 'tok' : opts.token
  const client = new CircleCiClient({
    log: m => { logs.push(m) },
    getToken: async () => token,
    fetch: (async (url: string | URL | Request) => respond(fx, String(url))) as typeof fetch,
    sleep: async () => {},
    random: () => 0,
  })
  const plugin = new CircleCiPlugin('#proj-leads', m => { logs.push(m) }, client, () => clock.t)
  const h: Harness = {
    fx, plugin, logs, clock, state: null, lastMessages: [],
    config: opts.config ?? makeConfig(opts.watched ?? [{ slug: SLUG, sha: SHA, started_at: START }]),
    async step(ms = STEP_MS) {
      clock.t += ms
      const r = await plugin.runTick(h.config, h.state)
      h.state = r.state as CircleCiPluginState
      h.lastMessages = r.messages
      return r.messages.map(m => m.text)
    },
  }
  return h
}
