import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, writeConfig, mutateConfig } from '../config.js'

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
    // Whoever ran first must fully complete before the other starts
    const aStart = order.indexOf('a-start')
    const aEnd = order.indexOf('a-end')
    const bStart = order.indexOf('b-start')
    const bEnd = order.indexOf('b-end')
    const firstEnd = Math.min(aEnd, bEnd)
    const secondStart = aStart < bStart ? bStart : aStart
    expect(firstEnd).toBeLessThan(secondStart)
  })

  it('rolls back on fn error: config unchanged, lock released', async () => {
    await expect(
      mutateConfig(dir, () => { throw new Error('boom') })
    ).rejects.toThrow('boom')
    const config = await loadConfig(dir)
    expect(config.project).toBe('initial')
    // Lock released: subsequent mutate succeeds
    await mutateConfig(dir, (c) => { c.project = 'after-error' })
    expect((await loadConfig(dir)).project).toBe('after-error')
  })

  it('clears a stale lock from a dead PID', async () => {
    // Use a PID well above the kernel max (4194304 on Linux, 99999 on macOS)
    await writeFile(join(dir, 'config.lock'), '99999999\n')
    await mutateConfig(dir, (c) => { c.project = 'after-stale' })
    expect((await loadConfig(dir)).project).toBe('after-stale')
    expect(readdirSync(dir).includes('config.lock')).toBe(false)
  })
})
