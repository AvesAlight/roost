import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, loadConfigBase, loadLocalOverlay, mergeConfigs, mutateConfig, writeConfig, writeLocalConfig, assertEntryRepoMode } from '../config.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'roost-config-test-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('writeConfig', () => {
  it('writes config.json and leaves no .tmp files', async () => {
    await writeConfig(dir, { project: 'test' })
    const config = await loadConfig(dir)
    expect(config.project).toBe('test')
    expect(readdirSync(dir).every(f => !f.endsWith('.tmp'))).toBe(true)
  })

  it('sorts fields via sortedJson', async () => {
    await writeConfig(dir, { repo: 'x/y', project: 'myproject' })
    const text = await readFile(join(dir, 'config.json'), 'utf8')
    expect(text.indexOf('"project"')).toBeLessThan(text.indexOf('"repo"'))
  })
})

describe('mergeConfigs', () => {
  it('returns the base unchanged when overlay is empty', () => {
    const base = { project: 'p', repo: 'o/r', plugins: { x: { watched: [{ number: 1 }] } } }
    expect(mergeConfigs(base, {})).toEqual(base)
  })

  it('local wins on top-level scalars', () => {
    const merged = mergeConfigs({ project: 'base', repo: 'o/r' }, { project: 'local' })
    expect(merged).toEqual({ project: 'local', repo: 'o/r' })
  })

  it('merges irc per-field (local-wins, base fills gaps)', () => {
    const merged = mergeConfigs(
      { irc: { server: 'a', port: 6667 } },
      { irc: { server: 'b' } }
    )
    expect(merged.irc).toEqual({ server: 'b', port: 6667 })
  })

  it('concatenates plugins.<name>.watched arrays', () => {
    const merged = mergeConfigs(
      { plugins: { 'github-prs': { watched: [{ number: 1 }, { number: 2 }] } } },
      { plugins: { 'github-prs': { watched: [{ number: 3 }] } } }
    )
    expect((merged.plugins!['github-prs'] as { watched: unknown[] }).watched).toEqual([
      { number: 1 }, { number: 2 }, { number: 3 },
    ])
  })

  it('preserves sibling slice keys with overlay-wins for non-watched fields', () => {
    const merged = mergeConfigs(
      { plugins: { x: { watched: [{ number: 1 }], other: 'base' } } },
      { plugins: { x: { other: 'local' } } }
    )
    expect(merged.plugins!.x).toEqual({ watched: [{ number: 1 }], other: 'local' })
  })

  it('keeps a plugin slice that exists only on one side', () => {
    const merged = mergeConfigs(
      { plugins: { 'github-commits': { watched: [{ number: 9 }] } } },
      { plugins: { 'github-prs': { watched: [{ number: 1 }] } } }
    )
    expect(Object.keys(merged.plugins!).sort()).toEqual(['github-commits', 'github-prs'])
  })
})

describe('loadConfig (with overlay)', () => {
  it('treats missing config.local.json as an empty overlay', async () => {
    await writeConfig(dir, { project: 'p', plugins: { x: { watched: [{ number: 1 }] } } })
    expect(await loadLocalOverlay(dir)).toEqual({})
    const merged = await loadConfig(dir)
    expect(merged.project).toBe('p')
    expect((merged.plugins!.x as { watched: unknown[] }).watched).toEqual([{ number: 1 }])
  })

  it('concatenates watched arrays across files', async () => {
    await writeConfig(dir, { plugins: { 'github-prs': { watched: [{ number: 1 }] } } })
    await writeLocalConfig(dir, { plugins: { 'github-prs': { watched: [{ number: 2 }] } } })
    const merged = await loadConfig(dir)
    expect((merged.plugins!['github-prs'] as { watched: unknown[] }).watched).toEqual([
      { number: 1 }, { number: 2 },
    ])
  })

  it('local overlay wins on top-level scalars', async () => {
    await writeConfig(dir, { project: 'base', repo: 'o/r' })
    await writeLocalConfig(dir, { project: 'local' })
    const merged = await loadConfig(dir)
    expect(merged).toEqual({ project: 'local', repo: 'o/r' })
  })
})

describe('mutateConfig', () => {
  beforeEach(async () => {
    await writeConfig(dir, { project: 'initial' })
  })

  it('applies fn and persists only to config.local.json', async () => {
    await mutateConfig(dir, (_base, local) => { local.repo = 'org/repo' })
    expect((await loadConfigBase(dir)).repo).toBeUndefined()
    expect((await loadLocalOverlay(dir)).repo).toBe('org/repo')
    const merged = await loadConfig(dir)
    expect(merged.project).toBe('initial')
    expect(merged.repo).toBe('org/repo')
  })

  it('does not touch config.json bytes', async () => {
    const before = await readFile(join(dir, 'config.json'), 'utf8')
    await mutateConfig(dir, (_base, local) => {
      local.plugins ??= {}
      local.plugins['github-prs'] = { watched: [{ number: 7 }] }
    })
    const after = await readFile(join(dir, 'config.json'), 'utf8')
    expect(after).toBe(before)
    expect(existsSync(join(dir, 'config.local.json'))).toBe(true)
  })

  it('serializes concurrent callers — no lost updates', async () => {
    await writeConfig(dir, { project: '0' })
    const bump = () => mutateConfig(dir, async (_base, local) => {
      const n = parseInt(local.project ?? '0', 10)
      await new Promise(r => setTimeout(r, 5))
      local.project = String(n + 1)
    })
    await Promise.all([bump(), bump()])
    const merged = await loadConfig(dir)
    expect(merged.project).toBe('2')
  })

  it('serializes an async fn that awaits in the middle', async () => {
    await writeConfig(dir, { project: '0' })
    const order: string[] = []
    const tagged = (tag: string) => mutateConfig(dir, async (_base, local) => {
      order.push(`${tag}-start`)
      await new Promise(r => setTimeout(r, 5))
      order.push(`${tag}-end`)
      local.project = tag
    })
    await Promise.all([tagged('a'), tagged('b')])
    const aStart = order.indexOf('a-start')
    const aEnd = order.indexOf('a-end')
    const bStart = order.indexOf('b-start')
    const bEnd = order.indexOf('b-end')
    const firstEnd = Math.min(aEnd, bEnd)
    const secondStart = aStart < bStart ? bStart : aStart
    expect(firstEnd).toBeLessThan(secondStart)
  })

  it('does not write on fn error and the queue advances for next caller', async () => {
    await expect(
      mutateConfig(dir, () => { throw new Error('boom') })
    ).rejects.toThrow('boom')
    const merged = await loadConfig(dir)
    expect(merged.project).toBe('initial')
    expect(existsSync(join(dir, 'config.local.json'))).toBe(false)
    // Queue not poisoned: next mutate succeeds
    await mutateConfig(dir, (_base, local) => { local.project = 'after-error' })
    expect((await loadConfig(dir)).project).toBe('after-error')
  })

  it('preserves an already-on-disk local overlay even when fn does nothing', async () => {
    await writeFile(join(dir, 'config.local.json'), JSON.stringify({ repo: 'preserved/repo' }))
    await mutateConfig(dir, () => { /* no-op */ })
    expect((await loadLocalOverlay(dir)).repo).toBe('preserved/repo')
  })
})

describe('assertEntryRepoMode', () => {
  it('accepts a single-repo entry whose repo is omitted', () => {
    expect(() => assertEntryRepoMode('plug', '#1', undefined, 'org/main')).not.toThrow()
  })

  it('accepts a single-repo entry whose repo matches', () => {
    expect(() => assertEntryRepoMode('plug', '#1', 'org/main', 'org/main')).not.toThrow()
  })

  it('rejects a single-repo entry whose repo diverges', () => {
    expect(() => assertEntryRepoMode('plug', '#1', 'org/other', 'org/main'))
      .toThrow(/single-repo mode.*plug #1 pins repo=org\/other/)
  })

  it('accepts a multi-repo entry that carries its own repo', () => {
    expect(() => assertEntryRepoMode('plug', '#1', 'org/a', undefined)).not.toThrow()
  })

  it('rejects a multi-repo entry that is missing its repo', () => {
    expect(() => assertEntryRepoMode('plug', '#1', undefined, undefined))
      .toThrow(/multi-repo mode.*plug #1 is missing one/)
  })
})
