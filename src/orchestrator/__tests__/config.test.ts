import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, writeConfig, mutateConfig, validateRepoConsistency } from '../config.js'

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

describe('mutateConfig', () => {
  beforeEach(async () => {
    await writeConfig(dir, { project: 'initial' })
  })

  it('applies fn and persists the result', async () => {
    await mutateConfig(dir, (c) => { c.repo = 'org/repo' })
    const config = await loadConfig(dir)
    expect(config.project).toBe('initial')
    expect(config.repo).toBe('org/repo')
  })

  it('serializes concurrent callers — no lost updates', async () => {
    await writeConfig(dir, { project: '0' })
    const bump = () => mutateConfig(dir, async (c) => {
      const n = parseInt(c.project ?? '0', 10)
      await new Promise(r => setTimeout(r, 5))
      c.project = String(n + 1)
    })
    await Promise.all([bump(), bump()])
    const config = await loadConfig(dir)
    expect(config.project).toBe('2')
  })

  it('serializes an async fn that awaits in the middle', async () => {
    await writeConfig(dir, { project: '0' })
    const order: string[] = []
    const tagged = (tag: string) => mutateConfig(dir, async (c) => {
      order.push(`${tag}-start`)
      await new Promise(r => setTimeout(r, 5))
      order.push(`${tag}-end`)
      c.project = tag
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

  it('rejects mixed-repo configs at load time (single mode + watched pinning a different repo)', async () => {
    await writeConfig(dir, {
      project: 'p',
      repo: 'org/main',
      plugins: { 'github-prs': { watched: [{ number: 1, repo: 'org/other' }] } },
    })
    await expect(loadConfig(dir)).rejects.toThrow(/single-repo mode.*pins repo=org\/other/)
  })

  it('rejects multi-mode entries missing repo at load time', async () => {
    await writeConfig(dir, {
      project: 'p',
      plugins: { 'github-prs': { watched: [{ number: 1 }] } },
    })
    await expect(loadConfig(dir)).rejects.toThrow(/multi-repo mode.*requires repo/)
  })

  it('does not write on fn error and the queue advances for next caller', async () => {
    await expect(
      mutateConfig(dir, () => { throw new Error('boom') })
    ).rejects.toThrow('boom')
    const config = await loadConfig(dir)
    expect(config.project).toBe('initial')
    // Queue not poisoned: next mutate succeeds
    await mutateConfig(dir, (c) => { c.project = 'after-error' })
    expect((await loadConfig(dir)).project).toBe('after-error')
  })
})

describe('validateRepoConsistency', () => {
  it('accepts a single-repo config with entries omitting repo', () => {
    expect(() => validateRepoConsistency({
      project: 'p',
      repo: 'org/main',
      plugins: { 'github-prs': { watched: [{ number: 1 }, { number: 2 }] } },
    })).not.toThrow()
  })

  it('accepts a single-repo config with entries that pin the matching repo', () => {
    expect(() => validateRepoConsistency({
      project: 'p',
      repo: 'org/main',
      plugins: { 'github-issues': { watched: [{ number: 7, repo: 'org/main' }] } },
    })).not.toThrow()
  })

  it('accepts a multi-repo config when every entry carries a repo', () => {
    expect(() => validateRepoConsistency({
      project: 'p',
      plugins: {
        'github-prs': { watched: [{ number: 1, repo: 'org/a' }] },
        'github-issues': { watched: [{ number: 9, repo: 'org/b' }] },
      },
    })).not.toThrow()
  })

  it('rejects a single-repo config where github-new-issues pins a different slice.repo', () => {
    expect(() => validateRepoConsistency({
      project: 'p',
      repo: 'org/main',
      plugins: { 'github-new-issues': { repo: 'org/other' } },
    })).toThrow(/single-repo mode.*pins repo=org\/other/)
  })

  it('skips non-object plugin slices', () => {
    expect(() => validateRepoConsistency({
      project: 'p',
      repo: 'org/main',
      plugins: { 'weird': null as unknown as Record<string, unknown> },
    })).not.toThrow()
  })
})
