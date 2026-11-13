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

// `specifier` defaults to the in-tree plugin.ts; pass 'roost/plugin' to import
// the way a real project plugin does.
async function writePluginModule(
  absPath: string,
  pluginName: string,
  specifier: string = join(import.meta.dir, '..', 'plugin.ts'),
): Promise<void> {
  await mkdir(join(absPath, '..'), { recursive: true })
  const src = `
import { registerPlugin, BasePlugin } from '${specifier}'
class P extends BasePlugin {
  name = '${pluginName}'
  desiredChannels() { return [] }
  async runTick() { return { state: null, messages: [], channels: [] } }
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

  it('resolves `roost/plugin` to the dispatcher\'s own registry with no node_modules', async () => {
    const name = uniquePluginName()
    const file = join(workDir, 'bare-plugin.ts')
    await writePluginModule(file, name, 'roost/plugin')
    try {
      await loadExternalPlugins(workDir, [file])
      expect(getPluginFactory(name)).toBeTypeOf('function')
    } finally {
      unregisterPlugin(name)
    }
  })

  it('prefers the dispatcher over a project-local copy of roost', async () => {
    const name = uniquePluginName()
    // A separate roost copy whose registerPlugin would land in the wrong registry.
    const copyDir = join(workDir, 'node_modules', 'roost')
    await mkdir(join(copyDir, 'src'), { recursive: true })
    await writeFile(join(copyDir, 'package.json'), JSON.stringify({
      name: 'roost',
      exports: { './plugin': './src/plugin-api.ts' },
    }), 'utf8')
    await writeFile(
      join(copyDir, 'src', 'plugin-api.ts'),
      'export const registerPlugin = () => { throw new Error("project copy used") }\nexport class BasePlugin {}\n',
      'utf8',
    )
    const file = join(workDir, 'copy-plugin.ts')
    await writePluginModule(file, name, 'roost/plugin')
    try {
      await loadExternalPlugins(workDir, [file])
      expect(getPluginFactory(name)).toBeTypeOf('function')
    } finally {
      unregisterPlugin(name)
    }
  })

  it('fails loudly when a module registers nothing', async () => {
    const file = join(workDir, 'empty-plugin.ts')
    await writeFile(file, 'export {}\n', 'utf8')
    const err = await loadExternalPlugins(workDir, [file]).then(() => null, (e: unknown) => e as Error)
    expect(err).not.toBeNull()
    expect(err!.message).toContain(file)
    expect(err!.message).toMatch(/registered no plugin/)
    expect(err!.message).toContain('roost/plugin')
    expect(err!.message).toContain('roost root')
  })
})
