import { describe, it, expect } from 'bun:test'
import { CircleCiPlugin, DISCOVERY_WINDOW_MS, GIVE_UP_MS, MAX_LIST_PAGES, RERUN_WINDOW_MS, type CircleCiPluginState } from '../circleci-plugin.js'
import {
  SLUG, SHA, START, STEP_MS, uuid, pipeline, workflow, buildJob, approvalJob, makeHarness, makeConfig, callsMatching, type Harness,
} from './circleci-fixtures.js'

const PIPE = 83
const TF = 101
const APPLY = 102
const RERUN = 103

// arboretum main merge: terraform workflow then apply, both in one pipeline.
function arboretum(h: Harness, terraform: string, apply: string | null) {
  h.fx.pipelines = [pipeline(PIPE)]
  // Newest first, as the API returns them.
  h.fx.workflows[uuid(PIPE)] = [
    ...(apply ? [workflow(APPLY, PIPE, 'apply', apply)] : []),
    workflow(TF, PIPE, 'terraform', terraform),
  ]
}

function setApply(h: Harness, status: string) {
  h.fx.workflows[uuid(PIPE)] = [workflow(APPLY, PIPE, 'apply', status), workflow(TF, PIPE, 'terraform', 'success')]
}

const state = (h: Harness) => h.state as CircleCiPluginState
const watchState = (h: Harness) => Object.values(state(h).watches)[0]
const link = `https://app.circleci.com/pipelines/${SLUG}/${PIPE}`
const wfLink = (id: number) => `https://app.circleci.com/pipelines/workflows/${uuid(id)}`

describe('first observation', () => {
  it('reports workflows that already finished, once', async () => {
    const h = makeHarness()
    arboretum(h, 'success', 'failed')
    h.fx.jobs[uuid(APPLY)] = [buildJob(201, 'apply-root', 'failed', 1202), buildJob(202, 'apply-other', 'success', 1203)]
    const first = await h.step()
    expect(first).toEqual([
      `pipeline #83 found for ${SLUG}@${SHA} (workflows: terraform, apply) — ${link}`,
      `workflow terraform success in ${SLUG}@${SHA} (pipeline #83) — ${wfLink(TF)}`,
      `workflow apply failed in ${SLUG}@${SHA} (pipeline #83) — failed jobs: apply-root (#1202) — ${wfLink(APPLY)}`,
    ])
    expect(callsMatching(h.fx, /\/job$/)).toBe(1)
    // Nothing repeats. The second settled poll does not end a failed watch: it
    // starts waiting for a re-run.
    const second = await h.step()
    expect(second).toHaveLength(1)
    expect(second[0]).toStartWith(`${SLUG}@${SHA} settled with a failed workflow; watching for a re-run until `)
    expect(watchState(h).done).toBeUndefined()
    expect(callsMatching(h.fx, /\/job$/)).toBe(1)
  })

  it('reports a workflow already on hold, once, and keeps the watch alive', async () => {
    const h = makeHarness()
    arboretum(h, 'success', 'on_hold')
    h.fx.jobs[uuid(APPLY)] = [approvalJob(301, 'hold-apply', 'on_hold'), buildJob(302, 'apply-root', 'blocked', 1301)]
    const first = await h.step()
    expect(first).toContain(`waiting on human: hold-apply — workflow apply in ${SLUG}@${SHA} (pipeline #83) — ${wfLink(APPLY)}`)
    expect(first.filter(t => t.startsWith('waiting on human'))).toHaveLength(1)
    for (let i = 0; i < 4; i++) expect(await h.step()).toEqual([])
    expect(callsMatching(h.fx, /\/job$/)).toBe(1)
    expect(watchState(h).done).toBeUndefined()
  })
})

describe('hold, approval, then failure', () => {
  it('announces the hold once, stays quiet through approval, then names the failed jobs', async () => {
    const h = makeHarness({ config: makeConfig([{ slug: SLUG, sha: SHA, started_at: START }], { failure_hint: 'ci-o-mat log {slug} {job} --failed' }) })
    arboretum(h, 'running', null)
    expect((await h.step()).filter(t => t.startsWith('waiting'))).toEqual([])

    arboretum(h, 'success', 'on_hold')
    h.fx.jobs[uuid(APPLY)] = [approvalJob(301, 'hold-apply', 'on_hold')]
    const held = await h.step()
    expect(held.filter(t => t.startsWith('waiting on human: hold-apply'))).toHaveLength(1)
    expect(await h.step()).toEqual([])

    setApply(h, 'running')
    expect(await h.step()).toEqual([])

    setApply(h, 'failed')
    h.fx.jobs[uuid(APPLY)] = [approvalJob(301, 'hold-apply', 'success'), buildJob(303, 'apply-root', 'failed', 1310)]
    const failed = await h.step()
    expect(failed).toEqual([
      `workflow apply failed in ${SLUG}@${SHA} (pipeline #83) — failed jobs: apply-root (#1310) — ${wfLink(APPLY)} — ci-o-mat log ${SLUG} 1310 --failed`,
    ])
  })

  it('announces a second approval in the same workflow after the first was approved', async () => {
    const h = makeHarness()
    arboretum(h, 'success', 'on_hold')
    h.fx.jobs[uuid(APPLY)] = [approvalJob(301, 'hold-plan', 'on_hold')]
    await h.step()
    setApply(h, 'running')
    await h.step()
    setApply(h, 'on_hold')
    h.fx.jobs[uuid(APPLY)] = [approvalJob(301, 'hold-plan', 'success'), approvalJob(304, 'hold-apply', 'on_hold')]
    const again = await h.step()
    expect(again).toHaveLength(1)
    expect(again[0]).toStartWith('waiting on human: hold-apply')
  })

  it('does not re-announce an approval job that is still pending after the workflow flips back to on_hold', async () => {
    const h = makeHarness()
    arboretum(h, 'success', 'on_hold')
    h.fx.jobs[uuid(APPLY)] = [approvalJob(301, 'hold-a', 'on_hold')]
    expect((await h.step()).filter(t => t.startsWith('waiting on human: hold-a'))).toHaveLength(1)
    setApply(h, 'running')
    await h.step()
    // Parallel branches: hold-a is still pending when hold-b appears.
    setApply(h, 'on_hold')
    h.fx.jobs[uuid(APPLY)] = [approvalJob(301, 'hold-a', 'on_hold'), approvalJob(304, 'hold-b', 'on_hold')]
    const again = (await h.step()).filter(t => t.startsWith('waiting on human'))
    expect(again).toHaveLength(1)
    expect(again[0]).toStartWith('waiting on human: hold-b')
  })

  it('omits the failure hint unless configured, and when no failed job has a number', async () => {
    const plain = makeHarness()
    arboretum(plain, 'success', 'failed')
    plain.fx.jobs[uuid(APPLY)] = [buildJob(201, 'apply-root', 'failed', 1202)]
    expect((await plain.step()).join('\n')).not.toContain('ci-o-mat')

    const hinted = makeHarness({ config: makeConfig([{ slug: SLUG, sha: SHA, started_at: START }], { failure_hint: 'log {slug} {job}' }) })
    arboretum(hinted, 'success', 'error')
    hinted.fx.jobs[uuid(APPLY)] = [{ id: uuid(210), name: 'infra', status: 'failed', type: 'build' }]
    const out = (await hinted.step()).join('\n')
    expect(out).toContain('workflow apply error')
    expect(out).toContain('failed jobs: infra —')
    expect(out).not.toContain('log gh/')
  })

  it('caps the failed-job list', async () => {
    const h = makeHarness()
    arboretum(h, 'success', 'failed')
    h.fx.jobs[uuid(APPLY)] = [1, 2, 3, 4, 5, 6, 7].map(n => buildJob(400 + n, `job-${n}`, 'failed', 1400 + n))
    const out = (await h.step()).find(t => t.startsWith('workflow apply'))!
    expect(out).toContain('job-5 (#1405) +2 more')
    expect(out).not.toContain('job-6')
  })

  it('retries a failed jobs call and still reports the failure once', async () => {
    const h = makeHarness()
    arboretum(h, 'success', 'failed')
    h.fx.jobs[uuid(APPLY)] = [buildJob(201, 'apply-root', 'failed', 1202)]
    h.fx.failures.push({ match: /\/job$/, status: 400 })
    const first = await h.step()
    expect(first.some(t => t.startsWith('workflow apply'))).toBe(false)
    expect(first.some(t => t.startsWith('workflow terraform success'))).toBe(true)
    h.fx.failures.length = 0
    const second = await h.step()
    expect(second.filter(t => t.startsWith('workflow apply failed'))).toHaveLength(1)
    expect((await h.step()).filter(t => t.startsWith('workflow apply'))).toEqual([])
  })
})

describe('stop rules', () => {
  it('ends after two consecutive settled polls with a summary, then makes no calls', async () => {
    const h = makeHarness()
    arboretum(h, 'success', 'success')
    await h.step()
    expect(watchState(h).done).toBeUndefined()
    const ended = await h.step()
    expect(ended).toEqual([`watch ended ${SLUG}@${SHA}: #83 terraform success, apply success (${link})`])
    expect(watchState(h).done?.reason).toBe('settled')
    const before = h.fx.calls.length
    expect(await h.step()).toEqual([])
    expect(await h.step()).toEqual([])
    expect(h.fx.calls.length).toBe(before)
  })

  it('does not end when a workflow appears between the two settled polls', async () => {
    const h = makeHarness()
    arboretum(h, 'success', null)
    await h.step()
    expect(watchState(h).settled_ticks).toBe(1)
    setApply(h, 'running')
    await h.step()
    expect(watchState(h).settled_ticks).toBe(0)
    expect(watchState(h).done).toBeUndefined()
    setApply(h, 'success')
    await h.step()
    expect(watchState(h).done).toBeUndefined()
    expect((await h.step())[0]).toStartWith('watch ended')
  })

  it('an on_hold workflow is not settled', async () => {
    const h = makeHarness()
    arboretum(h, 'success', 'on_hold')
    h.fx.jobs[uuid(APPLY)] = [approvalJob(301, 'hold-apply', 'on_hold')]
    for (let i = 0; i < 5; i++) await h.step()
    expect(watchState(h).done).toBeUndefined()
    expect(watchState(h).settled_ticks).toBe(0)
  })

  it('ends with `no pipeline` once the discovery window closes with nothing found', async () => {
    const h = makeHarness()
    expect(await h.step(STEP_MS)).toEqual([])
    expect(await h.step(5 * 60_000)).toEqual([])
    expect(callsMatching(h.fx, /\/pipeline$/)).toBe(2)
    const out = await h.step(DISCOVERY_WINDOW_MS)
    expect(out).toEqual([`no pipeline for ${SLUG}@${SHA} after 15m`])
    expect(watchState(h).done?.reason).toBe('no-pipeline')
    const before = h.fx.calls.length
    expect(await h.step()).toEqual([])
    expect(h.fx.calls.length).toBe(before)
  })

  it('does not end as `no pipeline` while listing is failing', async () => {
    const h = makeHarness()
    h.fx.failures.push({ match: /\/pipeline$/, status: 500 })
    expect(await h.step(DISCOVERY_WINDOW_MS + 1)).toEqual([])
    expect(watchState(h).done).toBeUndefined()
    h.fx.failures.length = 0
    expect(await h.step()).toEqual([`no pipeline for ${SLUG}@${SHA} after 15m`])
  })

  it('gives up after 24h without calling the API', async () => {
    const h = makeHarness()
    arboretum(h, 'success', 'on_hold')
    h.fx.jobs[uuid(APPLY)] = [approvalJob(301, 'hold-apply', 'on_hold')]
    await h.step()
    const before = h.fx.calls.length
    const out = await h.step(GIVE_UP_MS)
    expect(out).toHaveLength(1)
    expect(out[0]).toStartWith(`gave up watching ${SLUG}@${SHA} after 24h: #83 terraform success, apply on_hold`)
    expect(watchState(h).done?.reason).toBe('gave-up')
    expect(h.fx.calls.length).toBe(before)
  })

  it('a pipeline with no workflows holds the watch open until the window closes, then settles', async () => {
    const h = makeHarness()
    h.fx.pipelines = [pipeline(PIPE, { state: 'setup' })]
    h.fx.workflows[uuid(PIPE)] = []
    const first = await h.step()
    expect(first).toEqual([`pipeline #83 found for ${SLUG}@${SHA} (workflows: none yet) — ${link}`])
    await h.step()
    await h.step()
    expect(watchState(h).done).toBeUndefined()
    await h.step(DISCOVERY_WINDOW_MS)
    expect(watchState(h).done).toBeUndefined()
    const out = await h.step()
    expect(out[0]).toStartWith('watch ended')
    expect(out[0]).toContain('no workflows')
  })

  it('an errored pipeline with no workflows settles inside the window', async () => {
    const h = makeHarness()
    h.fx.pipelines = [pipeline(PIPE, { state: 'errored' })]
    h.fx.workflows[uuid(PIPE)] = []
    await h.step()
    expect((await h.step())[0]).toStartWith('watch ended')
  })
})

describe('discovery', () => {
  it('matches a sha prefix against vcs.revision and ignores other commits', async () => {
    const h = makeHarness()
    h.fx.pipelines = [pipeline(90, { vcs: { revision: 'ffff000' + '0'.repeat(33), branch: 'main' } }), pipeline(PIPE)]
    h.fx.workflows[uuid(PIPE)] = [workflow(TF, PIPE, 'terraform', 'running')]
    const out = await h.step()
    expect(out).toHaveLength(1)
    expect(out[0]).toContain('pipeline #83 found')
    expect(callsMatching(h.fx, new RegExp(uuid(90)))).toBe(0)
  })

  it('finds a tag pipeline that has no branch', async () => {
    const h = makeHarness()
    h.fx.pipelines = [pipeline(PIPE, { vcs: { revision: 'abc1234def5678abc1234def5678abc1234def5', tag: 'v1.2.3' } })]
    h.fx.workflows[uuid(PIPE)] = [workflow(TF, PIPE, 'terraform', 'running')]
    expect((await h.step())[0]).toContain('pipeline #83 found')
    expect(h.fx.calls.some(c => c.includes('branch='))).toBe(false)
  })

  it('picks up a later pipeline on the same sha inside the window', async () => {
    const h = makeHarness()
    arboretum(h, 'running', null)
    await h.step()
    h.fx.pipelines = [pipeline(84), pipeline(PIPE)]
    h.fx.workflows[uuid(84)] = [workflow(110, 84, 'terraform', 'success')]
    const out = await h.step()
    expect(out.some(t => t.startsWith('pipeline #84 found'))).toBe(true)
    expect(out.some(t => t.startsWith('workflow terraform success') && t.includes('#84'))).toBe(true)
  })

  it('stops listing once the window closes and a pipeline is tracked', async () => {
    const h = makeHarness()
    arboretum(h, 'running', null)
    await h.step()
    const lists = callsMatching(h.fx, /\/pipeline$/)
    await h.step(DISCOVERY_WINDOW_MS)
    expect(callsMatching(h.fx, /\/pipeline$/)).toBe(lists)
    expect(callsMatching(h.fx, /\/workflow$/)).toBeGreaterThan(1)
  })

  it('reads at most MAX_LIST_PAGES pages while nothing matches, and one page once tracking', async () => {
    const h = makeHarness()
    const other = (n: number) => pipeline(n, { vcs: { revision: 'e'.repeat(40), branch: 'main' } })
    h.fx.pipelinePages = [[other(1)], [other(2)], [other(3)], [other(4)], [pipeline(PIPE)]]
    await h.step()
    expect(callsMatching(h.fx, /\/pipeline(\?|$)/)).toBe(MAX_LIST_PAGES)
    expect(watchState(h).pipelines).toEqual({})

    const h2 = makeHarness()
    h2.fx.pipelinePages = [[other(1)], [pipeline(PIPE)], [other(3)]]
    h2.fx.workflows[uuid(PIPE)] = [workflow(TF, PIPE, 'terraform', 'running')]
    await h2.step()
    expect(callsMatching(h2.fx, /\/pipeline(\?|$)/)).toBe(2)
    h2.fx.calls.length = 0
    await h2.step()
    expect(callsMatching(h2.fx, /\/pipeline(\?|$)/)).toBe(1)
  })
})

describe('errors and limits', () => {
  it('skips ticks until Retry-After on a 429, without calls, then resumes', async () => {
    const h = makeHarness()
    arboretum(h, 'running', null)
    h.fx.failures.push({ match: /\/pipeline$/, status: 429, headers: { 'Retry-After': '200' } })
    expect(await h.step()).toEqual([])
    const calls = h.fx.calls.length
    expect(await h.step(STEP_MS)).toEqual([])
    expect(await h.step(STEP_MS)).toEqual([])
    expect(h.fx.calls.length).toBe(calls)
    h.fx.failures.length = 0
    const out = await h.step(STEP_MS)
    expect(out[0]).toContain('pipeline #83 found')
  })

  it('keeps existing state across a 429 tick', async () => {
    const h = makeHarness()
    arboretum(h, 'running', null)
    await h.step()
    const before = JSON.stringify(h.state)
    h.fx.failures.push({ match: /\/workflow$/, status: 429, headers: { 'Retry-After': '120' } })
    expect(await h.step()).toEqual([])
    expect(JSON.stringify(h.state)).toBe(before)
  })

  it('posts one missing-token error to the project channel, without throwing, and none after', async () => {
    const h = makeHarness({ token: null })
    const first = await h.step()
    expect(first).toHaveLength(1)
    expect(first[0]).toContain('no CircleCI token')
    expect(h.lastMessages[0].channels).toEqual(['#proj-leads'])
    expect(await h.step()).toEqual([])
    expect(h.fx.calls).toEqual([])
  })

  it('makes no call and no error when nothing is watched', async () => {
    const h = makeHarness({ watched: [], token: null })
    expect(await h.step()).toEqual([])
    expect(h.fx.calls).toEqual([])
  })

  it('reports a 404 on the watch channels right away, once per cooldown', async () => {
    const h = makeHarness({ watched: [{ slug: SLUG, sha: SHA, started_at: START, channels: ['#issue-1'] }] })
    h.fx.failures.push({ match: /\/pipeline$/, status: 404 })
    const out = await h.step()
    expect(out).toHaveLength(1)
    expect(out[0]).toContain('404')
    expect(out[0]).toContain(`unwatch pipeline ${SLUG}@${SHA}`)
    expect(h.lastMessages[0].channels).toEqual(['#issue-1'])
    expect(await h.step()).toEqual([])
  })

  it('reports a persistent 5xx only after three failed polls in a row', async () => {
    const h = makeHarness()
    h.fx.failures.push({ match: /\/pipeline$/, status: 503 })
    expect(await h.step()).toEqual([])
    expect(await h.step()).toEqual([])
    const third = await h.step()
    expect(third).toHaveLength(1)
    expect(third[0]).toContain('cannot poll')
  })

  it('does not let a failing watch drop another watch', async () => {
    const h = makeHarness({ watched: [{ slug: 'gh/o/bad', sha: SHA, started_at: START }, { slug: SLUG, sha: SHA, started_at: START }] })
    h.fx.failures.push({ match: /\/project\/gh\/o\/bad\//, status: 404 })
    arboretum(h, 'running', null)
    const out = await h.step()
    expect(out.some(t => t.includes('404'))).toBe(true)
    expect(out.some(t => t.startsWith('pipeline #83 found'))).toBe(true)
  })
})

describe('state and config handling', () => {
  it('keeps a watch\'s channels desired on the tick it ends, and drops them the tick after', async () => {
    const h = makeHarness({ watched: [{ slug: SLUG, sha: SHA, started_at: START, channels: ['#issue-1'] }] })
    arboretum(h, 'success', 'success')
    const first = await h.plugin.runTick(h.config, null)
    expect(first.channels).toEqual(['#issue-1'])
    h.state = first.state as CircleCiPluginState
    h.clock.t += STEP_MS
    const ending = await h.plugin.runTick(h.config, h.state)
    expect(ending.messages[0].text).toStartWith('watch ended')
    expect(ending.messages[0].channels).toEqual(['#issue-1'])
    expect(ending.channels).toEqual(['#issue-1'])
    expect(h.plugin.desiredChannels(h.config)).toEqual(['#issue-1'])
    h.state = ending.state as CircleCiPluginState
    h.clock.t += STEP_MS
    const after = await h.plugin.runTick(h.config, h.state)
    expect(after.channels).toEqual([])
    expect(h.plugin.desiredChannels(h.config)).toEqual([])
  })

  it('also keeps channels desired on the tick a `no pipeline` ending posts', async () => {
    const h = makeHarness({ watched: [{ slug: SLUG, sha: SHA, started_at: START, channels: ['#issue-1'] }] })
    const none = await h.plugin.runTick(h.config, null)
    h.state = none.state as CircleCiPluginState
    h.clock.t += DISCOVERY_WINDOW_MS
    const ending = await h.plugin.runTick(h.config, h.state)
    expect(ending.messages[0].text).toStartWith('no pipeline')
    expect(ending.channels).toEqual(['#issue-1'])
  })

  it('routes to entry channels, else the project channel', async () => {
    const h = makeHarness({ watched: [{ slug: SLUG, sha: SHA, started_at: START, channels: ['#a', '#b'] }] })
    arboretum(h, 'running', null)
    await h.step()
    expect(h.lastMessages[0].channels).toEqual(['#a', '#b'])
    expect((await h.plugin.runTick(h.config, h.state)).channels).toEqual(['#a', '#b'])

    const d = makeHarness()
    arboretum(d, 'running', null)
    await d.step()
    expect(d.lastMessages[0].channels).toEqual(['#proj-leads'])
  })

  it('merges duplicate entries for one sha and unions their channels', async () => {
    const h = makeHarness({ watched: [
      { slug: SLUG, sha: SHA, channels: ['#a'] },
      { slug: SLUG, sha: SHA.toUpperCase(), started_at: START, channels: ['#b'] },
    ] })
    arboretum(h, 'running', null)
    await h.step()
    expect(h.lastMessages).toHaveLength(1)
    expect(h.lastMessages[0].channels.sort()).toEqual(['#a', '#b'])
    expect(callsMatching(h.fx, /\/pipeline$/)).toBe(1)
  })

  it('falls back to the first-tick time for an entry with no started_at', async () => {
    const h = makeHarness({ watched: [{ slug: SLUG, sha: SHA }] })
    await h.step()
    expect(watchState(h).started_at).toBe(START + STEP_MS)
    expect(watchState(h).entry_started_at).toBeNull()
  })

  it('drops state for an entry that has left config', async () => {
    const h = makeHarness()
    arboretum(h, 'running', null)
    await h.step()
    expect(Object.keys(state(h).watches)).toHaveLength(1)
    h.config = makeConfig([])
    await h.step()
    expect(state(h).watches).toEqual({})
  })

  it('a re-watch (new started_at) of a finished sha starts fresh', async () => {
    const h = makeHarness()
    arboretum(h, 'success', 'success')
    await h.step()
    await h.step()
    expect(watchState(h).done).toBeDefined()
    h.config = makeConfig([{ slug: SLUG, sha: SHA, started_at: h.clock.t }])
    const out = await h.step()
    expect(out.some(t => t.startsWith('pipeline #83 found'))).toBe(true)
    expect(watchState(h).done).toBeUndefined()
  })

  it('a crash in one watch keeps its prior state and spares the others', async () => {
    const h = makeHarness({ watched: [{ slug: SLUG, sha: SHA, started_at: START }, { slug: 'gh/o/r2', sha: SHA, started_at: START }] })
    arboretum(h, 'running', null)
    await h.step()
    const bad = h.plugin as unknown as { followWorkflow: (...a: unknown[]) => Promise<void> }
    const orig = bad.followWorkflow.bind(h.plugin)
    let n = 0
    bad.followWorkflow = async (...a: unknown[]) => { if (n++ === 0) throw new TypeError('boom'); return orig(...a) }
    h.fx.pipelines = [pipeline(PIPE), pipeline(120)]
    h.fx.workflows[uuid(120)] = [workflow(130, 120, 'terraform', 'running')]
    await h.step()
    expect(h.logs.some(l => l.includes('poll crashed'))).toBe(true)
    expect(Object.keys(state(h).watches)).toHaveLength(2)
  })
})

describe('DM handling', () => {
  const cmd = (verb: 'watch' | 'unwatch', sha = SHA, channels: string[] = []) =>
    ({ kind: 'plugin' as const, plugin: 'circleci', raw: '', cmd: { verb, slug: SLUG, sha, channels } })
  const newPlugin = (t = 5000) => new CircleCiPlugin('#proj-leads', () => {}, undefined, () => t)
  const empty = () => ({ project: 'proj', repo: 'org/repo' }) as ReturnType<typeof makeConfig>
  const merge = (base: ReturnType<typeof makeConfig>, local: ReturnType<typeof makeConfig>) =>
    makeConfig([...((base.plugins?.circleci as { watched: unknown[] } | undefined)?.watched ?? []), ...((local.plugins?.circleci as { watched: unknown[] } | undefined)?.watched ?? [])])

  it('watch stamps started_at on a local entry, is idempotent, and merges channels', () => {
    const p = newPlugin(5000)
    const local = empty()
    expect(p.handleCommand(merge(empty(), local), local, cmd('watch', SHA, ['#a']))).toBe(`watching pipeline ${SLUG}@${SHA} + #a`)
    expect((local.plugins!.circleci as { watched: unknown[] }).watched).toEqual([{ slug: SLUG, sha: SHA, started_at: 5000, channels: ['#a'] }])
    expect(p.handleCommand(merge(empty(), local), local, cmd('watch'))).toBe(`already watching pipeline ${SLUG}@${SHA}`)
    expect(p.handleCommand(merge(empty(), local), local, cmd('watch', SHA, ['#b']))).toBe(`pipeline ${SLUG}@${SHA} + #b`)
  })

  it('unwatch removes a local entry and refuses a tracked one', () => {
    const p = newPlugin()
    const local = empty()
    p.handleCommand(merge(empty(), local), local, cmd('watch'))
    expect(p.handleCommand(merge(empty(), local), local, cmd('unwatch'))).toBe(`unwatched pipeline ${SLUG}@${SHA}`)
    expect(p.handleCommand(merge(empty(), local), local, cmd('unwatch'))).toBe(`not watching pipeline ${SLUG}@${SHA}`)
    const base = makeConfig([{ slug: SLUG, sha: SHA }])
    expect(p.handleCommand(merge(base, empty()), empty(), cmd('unwatch'))).toContain('hand-edit to remove')
    expect(p.handleCommand(merge(base, empty()), empty(), cmd('watch', SHA, ['#x']))).toContain('hand-edit to add channels')
  })

  it('list and help include the plugin', () => {
    const p = newPlugin()
    const merged = makeConfig([{ slug: SLUG, sha: SHA, channels: ['#a'] }])
    expect(p.handleCommand(merged, empty(), { kind: 'list' })).toBe(`circleci (1):\n  ${SLUG}@${SHA} + #a`)
    expect(p.handleCommand(makeConfig([]), empty(), { kind: 'list' })).toBe('circleci (0):\n  (none)')
    expect(p.handleCommand(merged, empty(), { kind: 'help' })).toContain('watch pipeline gh/<org>/<repo>@<sha>')
  })

  it('claims its own grammar and nothing else', () => {
    const p = newPlugin()
    expect(p.parseCommand(`watch pipeline ${SLUG}@${SHA}`)?.kind).toBe('ok')
    expect(p.parseCommand('watch 5')).toBeNull()
    expect(p.parseCommand(`watch repo org/repo`)).toBeNull()
  })

  it('prunes finished local entries on the next handleCommand and hides them from list', async () => {
    const h = makeHarness()
    const local = makeConfig([{ slug: SLUG, sha: SHA, started_at: START }, { slug: SLUG, sha: 'def5678', started_at: START }])
    h.config = local
    h.fx.pipelines = [pipeline(PIPE)]
    h.fx.workflows[uuid(PIPE)] = [workflow(TF, PIPE, 'terraform', 'success')]
    await h.step()
    await h.step()
    expect(Object.values(state(h).watches).filter(w => w.done)).toHaveLength(1)

    const listed = h.plugin.handleCommand(local, local, { kind: 'list' })!
    expect(listed).toContain('circleci (1):')
    expect(listed).toContain('def5678')
    expect(listed).not.toContain(`@${SHA}\n`)

    h.plugin.handleCommand(local, local, { kind: 'help' })
    const watched = (local.plugins!.circleci as { watched: Array<{ sha: string }> }).watched
    expect(watched.map(e => e.sha)).toEqual(['def5678'])
  })

  it('re-watching a finished sha adds a fresh entry that survives the next prune', async () => {
    const h = makeHarness()
    arboretum(h, 'success', 'success')
    await h.step()
    await h.step()
    const local = h.config
    h.clock.t += STEP_MS
    expect(h.plugin.handleCommand(local, local, cmd('watch'))).toBe(`watching pipeline ${SLUG}@${SHA}`)
    const watched = (local.plugins!.circleci as { watched: Array<{ sha: string; started_at: number }> }).watched
    expect(watched).toHaveLength(1)
    expect(watched[0].started_at).toBe(h.clock.t)
    h.plugin.handleCommand(local, local, { kind: 'help' })
    expect((local.plugins!.circleci as { watched: unknown[] }).watched).toHaveLength(1)
  })
})

// A re-run of a failed workflow adds a new workflow with the same name to the
// same pipeline. The failed one stays failed.
function rerunOf(h: Harness, status: string) {
  h.fx.workflows[uuid(PIPE)] = [
    workflow(RERUN, PIPE, 'apply', status),
    workflow(APPLY, PIPE, 'apply', 'failed'),
    workflow(TF, PIPE, 'terraform', 'success'),
  ]
}

function failedApply(): Harness {
  const h = makeHarness()
  arboretum(h, 'success', 'failed')
  h.fx.jobs[uuid(APPLY)] = [buildJob(201, 'apply-root', 'failed', 1202)]
  return h
}

describe('a failed watch waits for a re-run', () => {
  it('announces the wait once, then stays quiet at one workflow listing per poll', async () => {
    const h = failedApply()
    await h.step()
    const waiting = await h.step()
    expect(waiting).toEqual([`${SLUG}@${SHA} settled with a failed workflow; watching for a re-run until 00:16 UTC. To stop: unwatch pipeline ${SLUG}@${SHA}`])
    expect(watchState(h).rerun_until).toBe(h.clock.t + RERUN_WINDOW_MS)
    const before = h.fx.calls.length
    for (let i = 0; i < 3; i++) expect(await h.step()).toEqual([])
    expect(h.fx.calls.slice(before).filter(c => /\/workflow$/.test(c))).toHaveLength(3)
    expect(callsMatching(h.fx, /\/job$/)).toBe(1)
    expect(watchState(h).done).toBeUndefined()
  })

  it('ends when the re-run succeeds, judging only the latest workflow per name', async () => {
    const h = failedApply()
    await h.step()
    await h.step()
    rerunOf(h, 'running')
    expect(await h.step()).toEqual([])
    expect(watchState(h).settled_ticks).toBe(0)
    expect(watchState(h).rerun_until).toBeUndefined()
    rerunOf(h, 'success')
    expect(await h.step()).toEqual([`workflow apply success in ${SLUG}@${SHA} (pipeline #83) — ${wfLink(RERUN)}`])
    // The old failed workflow is still failed, but it no longer counts.
    const ended = await h.step()
    expect(ended).toEqual([`watch ended ${SLUG}@${SHA}: #83 terraform success, apply success (${link})`])
    expect(watchState(h).done?.reason).toBe('settled')
  })

  it('opens a fresh window when the re-run fails too', async () => {
    const h = failedApply()
    await h.step()
    await h.step()
    const firstUntil = watchState(h).rerun_until!
    rerunOf(h, 'running')
    await h.step()
    h.fx.jobs[uuid(RERUN)] = [buildJob(203, 'apply-root', 'failed', 1204)]
    rerunOf(h, 'failed')
    const failed = await h.step()
    expect(failed).toEqual([`workflow apply failed in ${SLUG}@${SHA} (pipeline #83) — failed jobs: apply-root (#1204) — ${wfLink(RERUN)}`])
    const waiting = await h.step()
    expect(waiting).toHaveLength(1)
    expect(waiting[0]).toContain('watching for a re-run until')
    expect(watchState(h).rerun_until!).toBeGreaterThan(firstUntil)
    expect(watchState(h).done).toBeUndefined()
  })

  it('ends when the window runs out with no re-run, then makes no calls', async () => {
    const h = failedApply()
    await h.step()
    await h.step()
    expect(await h.step(RERUN_WINDOW_MS - STEP_MS)).toEqual([])
    const ended = await h.step(STEP_MS)
    expect(ended).toEqual([`watch ended ${SLUG}@${SHA}: no re-run in 2h: #83 terraform success, apply failed (${link})`])
    expect(watchState(h).done?.reason).toBe('no-rerun')
    const before = h.fx.calls.length
    expect(await h.step()).toEqual([])
    expect(h.fx.calls.length).toBe(before)
  })

  it('keeps the watch channels desired through the tick the `no re-run` ending posts', async () => {
    const h = makeHarness({ watched: [{ slug: SLUG, sha: SHA, started_at: START, channels: ['#issue-1'] }] })
    arboretum(h, 'success', 'failed')
    h.fx.jobs[uuid(APPLY)] = [buildJob(201, 'apply-root', 'failed', 1202)]
    await h.step()
    await h.step()
    expect(h.plugin.desiredChannels(h.config)).toEqual(['#issue-1'])
    h.clock.t += RERUN_WINDOW_MS
    const ending = await h.plugin.runTick(h.config, h.state)
    expect(ending.messages[0].text).toStartWith('watch ended')
    expect(ending.messages[0].channels).toEqual(['#issue-1'])
    expect(ending.channels).toEqual(['#issue-1'])
  })

  it('does not wait on a canceled workflow: a cancel is not a failure to retry', async () => {
    const h = makeHarness()
    arboretum(h, 'success', 'canceled')
    await h.step()
    const ended = await h.step()
    expect(ended).toEqual([`watch ended ${SLUG}@${SHA}: #83 terraform success, apply canceled (${link})`])
    expect(watchState(h).done?.reason).toBe('settled')
  })
})
