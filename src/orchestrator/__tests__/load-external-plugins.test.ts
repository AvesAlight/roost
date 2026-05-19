import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadExternalPlugins } from '../load-external-plugins.js'
import { getPluginFactory, unregisterPlugin } from '../plugin.js'

// Each test gets a fresh temp dir + fresh plugin name so module-import caching
// (ESM caches by resolved URL) doesn't carry registrations between tests.
let workDir: string
let pluginCounter = 0

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'roost-loader-'))
})

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true })
})

function uniquePluginName(): string {
  pluginCounter += 1
  return `ext-plugin-${process.pid}-${pluginCounter}`
}

async function writePluginModule(absPath: string, pluginName: string): Promise<void> {
  await mkdir(join(absPath, '..'), { recursive: true })
  const src = `
import { registerPlugin, BasePlugin } from '${join(import.meta.dir, '..', 'plugin.ts')}'
class P extends BasePlugin {
  name = '${pluginName}'
  desiredChannels() { return [] }
  async runTick() { return { state: null, taggedEvents: [], channels: [] } }
}
registerPlugin('${pluginName}', (dc) => new P(dc))
`
  await writeFile(absPath, src, 'utf8')
}

describe('loadExternalPlugins', () => {
  it('is a no-op when plugin_paths is undefined', async () => {
    await loadExternalPlugins(workDir, undefined)
  })

  it('is a no-op when plugin_paths is empty', async () => {
    await loadExternalPlugins(workDir, [])
  })

  it('loads an absolute path and registers its plugin', async () => {
    const name = uniquePluginName()
    const file = join(workDir, 'abs-plugin.ts')
    await writePluginModule(file, name)
    try {
      await loadExternalPlugins(workDir, [file])
      expect(getPluginFactory(name)).toBeTypeOf('function')
    } finally {
      unregisterPlugin(name)
    }
  })

  it('resolves a relative path against the config dir', async () => {
    const name = uniquePluginName()
    const subdir = join(workDir, 'sub')
    await mkdir(subdir, { recursive: true })
    const file = join(subdir, 'rel-plugin.ts')
    await writePluginModule(file, name)
    try {
      // Relative to workDir (the simulated `.orchestrator/`).
      await loadExternalPlugins(workDir, ['./sub/rel-plugin.ts'])
      expect(getPluginFactory(name)).toBeTypeOf('function')
    } finally {
      unregisterPlugin(name)
    }
  })

  it('crashes on a missing path so a bad config fails loud at boot', async () => {
    await expect(
      loadExternalPlugins(workDir, ['./does-not-exist.ts'])
    ).rejects.toThrow()
  })

  it('crashes when the module throws on a duplicate name', async () => {
    const name = uniquePluginName()
    const fileA = join(workDir, 'a.ts')
    const fileB = join(workDir, 'b.ts')
    await writePluginModule(fileA, name)
    await writePluginModule(fileB, name)
    try {
      await expect(
        loadExternalPlugins(workDir, [fileA, fileB])
      ).rejects.toThrow(/already registered/)
    } finally {
      unregisterPlugin(name)
    }
  })
})
