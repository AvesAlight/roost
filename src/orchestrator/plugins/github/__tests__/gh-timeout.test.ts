import { describe, it, expect, afterAll, beforeEach } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runWithTimeout } from '../../../plugin-api.js'
import { GhClient, GhError, spawnGh } from '../github-api.js'
import { GhPluginBase } from '../base.js'
import { GitHubNewPrsPlugin } from '../new-prs-plugin.js'
import type { OrchestratorConfig } from '../../../config.js'
import { stubRateLimit } from './gh-test-helpers.js'

// A stand-in gh that never answers, called by absolute path so a real gh never runs.
const dir = mkdtempSync(join(tmpdir(), 'fake-gh-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const hungGh = join(dir, 'gh')
writeFileSync(hungGh, '#!/usr/bin/env bash\nexec sleep 30\n')
chmodSync(hungGh, 0o755)

const hung = () => runWithTimeout(100, hungGh)
const noSleep = async () => {}

describe('gh call timeout', () => {
  it('spawnGh fails a hung gh as a retried timeout and gives up after the attempts', async () => {
    const lines: string[] = []
    const started = Date.now()
    const err = await spawnGh(['api', 'x'], {
      log: m => lines.push(m), run: hung(), sleep: noSleep, attempts: 2,
    }).catch(e => e)
    expect(err).toBeInstanceOf(GhError)
    expect((err as GhError).stderr).toMatch(/timed out/)
    expect((err as GhError).attempts).toBe(2)
    expect(lines.join('')).toContain('matched=timeout')
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('a hung REST read rejects as a timeout', async () => {
    const client = new GhClient(() => {}, { run: hung(), sleep: noSleep })
    const err = await client.fetchRepoOpenPrs('org/repo').catch(e => e)
    expect(err).toBeInstanceOf(GhError)
    expect((err as GhError).stderr).toMatch(/timed out/)
  })

  it('a hung graphql batch rejects as a timeout', async () => {
    const client = new GhClient(() => {}, { run: hung(), sleep: noSleep })
    const err = await client.fetchPrsBatch([{ repo: 'org/repo', number: 1 }]).catch(e => e)
    expect(err).toBeInstanceOf(GhError)
    expect((err as GhError).stderr).toMatch(/timed out/)
  })

  describe('tick', () => {
    stubRateLimit()
    beforeEach(() => { GhPluginBase.resetBreakerForTest() })

    it('a plugin tick with a hung gh finishes instead of stalling', async () => {
      const config: OrchestratorConfig = {
        project: 'proj', repo: 'org/repo',
        plugins: { 'github-new-prs': { watched: [{ repo: 'org/repo' }] } },
      }
      const lines: string[] = []
      const log = (m: string) => { lines.push(m) }
      const client = new GhClient(log, { run: hung(), sleep: noSleep })
      const plugin = new GitHubNewPrsPlugin('#proj-leads', log, client)
      const res = await plugin.runTick(config, undefined)
      expect(res.messages).toEqual([])
      expect(lines.join('')).toContain('matched=timeout')
    })
  })
})
