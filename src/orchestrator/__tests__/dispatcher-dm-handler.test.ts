import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  handleDm,
  parseCommand,
  parseCommands,
  resolveAllowlist,
  splitCommands,
  type Command,
  type HandlerDeps,
} from '../dispatcher-dm-handler.js'
import { loadConfig, loadConfigBase, loadLocalOverlay, writeConfig, type OrchestratorConfig } from '../config.js'
import type { ParseResult, Plugin, PluginTickResult } from '../plugin.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'roost-dispatcher-dm-handler-test-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

// ---- Parser ----------------------------------------------------------------

describe('splitCommands', () => {
  it('splits on newlines, semicolons, commas; trims; drops empties', () => {
    expect(splitCommands('watch 5\n watch 6 ; watch 7, ,\nhelp')).toEqual([
      'watch 5', 'watch 6', 'watch 7', 'help',
    ])
  })
})

// A minimal Plugin that claims a target keyword via a per-N parser. Records
// every handleCommand call so tests can assert routing precisely.
class StubPlugin implements Plugin {
  readonly name: string
  readonly grammarPriority?: number
  readonly handled: Array<{ cmd: Command; mergedSnapshot: OrchestratorConfig; localSnapshot: OrchestratorConfig }> = []
  constructor(
    name: string,
    private readonly target: string | null,
    private readonly behavior?: (cmd: Command, merged: OrchestratorConfig, local: OrchestratorConfig) => string | null,
    grammarPriority?: number,
  ) {
    this.name = name
    this.grammarPriority = grammarPriority
  }
  desiredChannels(): string[] { return [] }
  async runTick(): Promise<PluginTickResult> {
    return { state: null, taggedEvents: [], channels: [] }
  }
  parseCommand(line: string): ParseResult | null {
    const tokens = line.split(/\s+/).filter(Boolean)
    const verb = tokens[0]?.toLowerCase()
    if (verb !== 'watch' && verb !== 'unwatch') return null
    let i = 1
    if (this.target !== null) {
      if (tokens[i]?.toLowerCase() !== this.target) return null
      i++
    } else if (tokens[i] !== undefined && !/^\d+$/.test(tokens[i])) {
      return null
    }
    const numTok = tokens[i]
    if (numTok === undefined || !/^\d+$/.test(numTok)) return null
    const number = parseInt(numTok, 10)
    const channels = tokens.slice(i + 1).filter(t => t.startsWith('#'))
    if (tokens.slice(i + 1).some(t => !t.startsWith('#'))) {
      return { kind: 'error', message: 'channels must match channel sigil' }
    }
    return { kind: 'ok', cmd: { verb, number, channels } }
  }
  handleCommand(merged: OrchestratorConfig, local: OrchestratorConfig, cmd: Command): string | null {
    this.handled.push({
      cmd,
      mergedSnapshot: JSON.parse(JSON.stringify(merged)) as OrchestratorConfig,
      localSnapshot: JSON.parse(JSON.stringify(local)) as OrchestratorConfig,
    })
    if (this.behavior) return this.behavior(cmd, merged, local)
    if (cmd.kind === 'list') return `${this.name}: list-section`
    if (cmd.kind === 'help') return `${this.name}: help-section`
    if (cmd.kind === 'plugin' && cmd.plugin === this.name) {
      const c = cmd.cmd as { verb: 'watch' | 'unwatch'; number: number }
      if (c.verb === 'watch') {
        local.plugins ??= {}
        local.plugins[this.name] = { watched: c.number }
        return `${this.name}: watched ${c.number}`
      }
      return `${this.name}: unwatched ${c.number}`
    }
    return null
  }
}

describe('parseCommand (central — global verbs)', () => {
  it('parses help', () => {
    expect(parseCommand('help', [], {})).toEqual({ kind: 'help' })
  })

  it('parses watch list', () => {
    expect(parseCommand('watch list', [], {})).toEqual({ kind: 'list' })
  })

  it('is case-insensitive on verbs', () => {
    expect(parseCommand('Help', [], {})).toEqual({ kind: 'help' })
  })

  it('rejects trailing tokens after `watch list`', () => {
    const cmd = parseCommand('watch list foo', [], {}) as Extract<Command, { kind: 'unknown' }>
    expect(cmd.kind).toBe('unknown')
    expect(cmd.error).toMatch(/watch list takes no arguments/)
  })

  it('rejects trailing tokens after `help`', () => {
    const cmd = parseCommand('help me', [], {}) as Extract<Command, { kind: 'unknown' }>
    expect(cmd.kind).toBe('unknown')
    expect(cmd.error).toMatch(/help takes no arguments/)
  })

  it('rejects a reserved verb in the target slot before consulting plugins', () => {
    const cmd = parseCommand('watch unwatch 5', [new StubPlugin('issues', null)], {}) as Extract<Command, { kind: 'unknown' }>
    expect(cmd.kind).toBe('unknown')
    expect(cmd.error).toMatch(/reserved verb/)
  })

  it('rejects an unknown top-level verb', () => {
    const cmd = parseCommand('foo bar', [], {}) as Extract<Command, { kind: 'unknown' }>
    expect(cmd.kind).toBe('unknown')
    expect(cmd.error).toMatch(/unknown command/)
  })

  it('surfaces "no plugin handles" when no plugin claims', () => {
    const cmd = parseCommand('watch linear 99', [new StubPlugin('issues', null)], {}) as Extract<Command, { kind: 'unknown' }>
    expect(cmd.kind).toBe('unknown')
    expect(cmd.error).toMatch(/no plugin handles `watch linear 99`/)
    expect(cmd.error).toMatch(/enabled plugins: issues/)
  })
})

describe('parseCommand (plugin claims)', () => {
  it('routes claims to the matching plugin', () => {
    const issues = new StubPlugin('issues', null)
    const prs = new StubPlugin('prs', 'pr')
    const cmd = parseCommand('watch pr 10', [issues, prs], {}) as Extract<Command, { kind: 'plugin' }>
    expect(cmd.kind).toBe('plugin')
    expect(cmd.plugin).toBe('prs')
  })

  it('honors grammarPriority (higher wins on overlap)', () => {
    const lo = new StubPlugin('lo', 'pr', undefined, 0)
    const hi = new StubPlugin('hi', 'pr', undefined, 10)
    const cmd = parseCommand('watch pr 5', [lo, hi], {}) as Extract<Command, { kind: 'plugin' }>
    expect(cmd.plugin).toBe('hi')
  })

  it('config.plugin_priorities overrides static grammarPriority outright', () => {
    const a = new StubPlugin('a', 'pr', undefined, 10)
    const b = new StubPlugin('b', 'pr', undefined, 0)
    // Static order would pick a (10>0). Override flips it.
    const cmd = parseCommand('watch pr 5', [a, b], { plugin_priorities: { a: 0, b: 100 } }) as Extract<Command, { kind: 'plugin' }>
    expect(cmd.plugin).toBe('b')
  })

  it('plugin error claims terminate iteration (no second crack at the same line)', () => {
    // First plugin in priority order claims-with-error; second plugin would
    // succeed if it got the chance — it must not.
    class ErrPlugin implements Plugin {
      readonly name = 'first'
      readonly grammarPriority = 100
      desiredChannels(): string[] { return [] }
      async runTick(): Promise<PluginTickResult> { return { state: null, taggedEvents: [], channels: [] } }
      parseCommand(): ParseResult { return { kind: 'error', message: 'first-plugin malformed' } }
      handleCommand(): string | null { return null }
    }
    const second = new StubPlugin('second', null)
    const cmd = parseCommand('watch 5', [new ErrPlugin(), second], {}) as Extract<Command, { kind: 'unknown' }>
    expect(cmd.kind).toBe('unknown')
    expect(cmd.error).toBe('first-plugin malformed')
  })
})

describe('parseCommands', () => {
  it('parses multi-line input', () => {
    const issues = new StubPlugin('issues', null)
    const prs = new StubPlugin('prs', 'pr')
    const cmds = parseCommands('watch 5; unwatch pr 10', [issues, prs], {})
    expect(cmds).toHaveLength(2)
    expect(cmds[0]).toMatchObject({ kind: 'plugin', plugin: 'issues' })
    expect(cmds[1]).toMatchObject({ kind: 'plugin', plugin: 'prs' })
  })
})

// ---- Allowlist -------------------------------------------------------------

describe('resolveAllowlist', () => {
  it('defaults to [leadPmNick(project), apmNick(project)] when unset', () => {
    expect(resolveAllowlist({ project: 'roost' })).toEqual(['roost-lead-pm', 'roost-apm'])
  })

  it('returns the explicit list when set (including empty)', () => {
    expect(resolveAllowlist({ irc: { command_senders: ['alex', 'bot'] } })).toEqual(['alex', 'bot'])
    expect(resolveAllowlist({ irc: { command_senders: [] } })).toEqual([])
  })

  it('returns [] when no project/repo to derive a default from', () => {
    expect(resolveAllowlist({})).toEqual([])
  })

  it('logs the cause when project is unresolvable', () => {
    const logs: string[] = []
    const out = resolveAllowlist({}, line => logs.push(line))
    expect(out).toEqual([])
    expect(logs.some(l => l.includes('cannot resolve default allowlist'))).toBe(true)
  })
})

// ---- handleDm routing — stub plugins ---------------------------------------

interface FakeIrc {
  dms: Array<{ nick: string; text: string }>
  errors: string[]
  logs: string[]
}

function makeDeps(stateDir: string, plugins: Plugin[] = []): { deps: HandlerDeps; irc: FakeIrc } {
  const irc: FakeIrc = { dms: [], errors: [], logs: [] }
  const deps: HandlerDeps = {
    stateDir,
    plugins,
    dm: (nick, text) => { irc.dms.push({ nick, text }) },
    postProjectError: (text) => { irc.errors.push(text) },
    log: (line) => { irc.logs.push(line) },
  }
  return { deps, irc }
}

describe('handleDm — routing', () => {
  it('rejects senders outside the allowlist with a tight one-liner', async () => {
    await writeConfig(dir, { project: 'roost', irc: { command_senders: ['alex'] }, plugins: {} })
    const { deps, irc } = makeDeps(dir, [new StubPlugin('issues', null)])
    await handleDm(deps, { sender: 'mallory', text: 'watch 5' })
    expect(irc.dms).toEqual([{ nick: 'mallory', text: 'not authorized; configure irc.command_senders' }])
    expect((await loadConfig(dir)).plugins?.['issues']).toBeUndefined()
  })

  it('allows the default lead-pm nick when command_senders is unset', async () => {
    await writeConfig(dir, { project: 'roost', plugins: {} })
    const issues = new StubPlugin('issues', null)
    const { deps, irc } = makeDeps(dir, [issues])
    await handleDm(deps, { sender: 'roost-lead-pm', text: 'watch 5' })
    expect(irc.dms).toHaveLength(1)
    expect(irc.dms[0].text).toBe('issues: watched 5')
    expect(issues.handled).toHaveLength(1)
  })

  it('allows the default apm nick when command_senders is unset', async () => {
    await writeConfig(dir, { project: 'roost', plugins: {} })
    const issues = new StubPlugin('issues', null)
    const { deps, irc } = makeDeps(dir, [issues])
    await handleDm(deps, { sender: 'roost-apm', text: 'unwatch 5' })
    expect(irc.dms).toHaveLength(1)
    expect(irc.dms[0].text).toBe('issues: unwatched 5')
    expect(issues.handled).toHaveLength(1)
  })

  it('routes a bare watch only to the matching plugin', async () => {
    await writeConfig(dir, { project: 'roost', plugins: {} })
    const issues = new StubPlugin('issues', null)
    const prs = new StubPlugin('prs', 'pr')
    const { deps, irc } = makeDeps(dir, [issues, prs])
    await handleDm(deps, { sender: 'roost-lead-pm', text: 'watch 5' })
    expect(issues.handled).toHaveLength(1)
    expect(prs.handled).toHaveLength(0)
    expect(irc.dms[0].text).toBe('issues: watched 5')
  })

  it('routes target=pr commands only to the matching plugin', async () => {
    await writeConfig(dir, { project: 'roost', plugins: {} })
    const issues = new StubPlugin('issues', null)
    const prs = new StubPlugin('prs', 'pr')
    const { deps, irc } = makeDeps(dir, [issues, prs])
    await handleDm(deps, { sender: 'roost-lead-pm', text: 'watch pr 10' })
    expect(irc.dms[0].text).toBe('prs: watched 10')
    expect(issues.handled).toHaveLength(0)
  })

  it('broadcasts `watch list` to every plugin and joins replies with \\n\\n', async () => {
    await writeConfig(dir, { project: 'roost', plugins: {} })
    const issues = new StubPlugin('issues', null)
    const prs = new StubPlugin('prs', 'pr')
    const { deps, irc } = makeDeps(dir, [issues, prs])
    await handleDm(deps, { sender: 'roost-lead-pm', text: 'watch list' })
    expect(irc.dms).toHaveLength(1)
    expect(irc.dms[0].text).toBe('issues: list-section\n\nprs: list-section')
  })

  it('broadcasts `help` and prepends the dispatcher synopsis', async () => {
    await writeConfig(dir, { project: 'roost', plugins: {} })
    const issues = new StubPlugin('issues', null)
    const prs = new StubPlugin('prs', 'pr')
    const { deps, irc } = makeDeps(dir, [issues, prs])
    await handleDm(deps, { sender: 'roost-lead-pm', text: 'help' })
    expect(irc.dms[0].text).toContain('dispatcher DM grammar')
    expect(irc.dms[0].text).toContain('issues: help-section\n\nprs: help-section')
  })

  it('surfaces "no plugin handles" with the raw line + enabled plugins', async () => {
    await writeConfig(dir, { project: 'roost', plugins: {} })
    const issues = new StubPlugin('issues', null)
    const { deps, irc } = makeDeps(dir, [issues])
    await handleDm(deps, { sender: 'roost-lead-pm', text: 'watch linear 99' })
    expect(irc.dms).toHaveLength(1)
    expect(irc.dms[0].text).toMatch(/no plugin handles `watch linear 99`/)
    expect(irc.dms[0].text).toMatch(/enabled plugins: issues/)
  })

  it('any parse error aborts the batch — no plugin called', async () => {
    await writeConfig(dir, { project: 'roost', plugins: {} })
    const issues = new StubPlugin('issues', null)
    const { deps, irc } = makeDeps(dir, [issues])
    await handleDm(deps, { sender: 'roost-lead-pm', text: 'watch 5 foo; watch 6' })
    expect(irc.dms).toHaveLength(1)
    expect(irc.dms[0].text).toMatch(/error: channels must match/)
    expect(issues.handled).toHaveLength(0)
  })

  it('reports multiple parse errors in one reply', async () => {
    await writeConfig(dir, { project: 'roost', plugins: {} })
    const { deps, irc } = makeDeps(dir, [new StubPlugin('issues', null)])
    await handleDm(deps, { sender: 'roost-lead-pm', text: 'watch list foo; watch 5 bar' })
    expect(irc.dms).toHaveLength(1)
    const reply = irc.dms[0].text
    expect(reply).toMatch(/watch list takes no arguments/)
    expect(reply).toMatch(/channels must match/)
  })

  it('multi-cmd write batch lands in one mutateConfig call (single atomic write)', async () => {
    await writeConfig(dir, { project: 'roost', plugins: {} })
    const issues = new StubPlugin('issues', null)
    const prs = new StubPlugin('prs', 'pr')
    const { deps, irc } = makeDeps(dir, [issues, prs])
    await handleDm(deps, { sender: 'roost-lead-pm', text: 'watch 5\nwatch pr 10' })
    expect(irc.dms).toHaveLength(1)
    expect(irc.dms[0].text).toBe('issues: watched 5\n\nprs: watched 10')
    const config = await loadConfig(dir)
    expect(config.plugins?.['issues']).toEqual({ watched: 5 })
    expect(config.plugins?.['prs']).toEqual({ watched: 10 })
  })

  it('writes go to config.local.json, never config.json', async () => {
    await writeConfig(dir, { project: 'roost', plugins: {} })
    const baseBefore = await loadConfigBase(dir)
    const { deps } = makeDeps(dir, [new StubPlugin('issues', null), new StubPlugin('prs', 'pr')])
    await handleDm(deps, { sender: 'roost-lead-pm', text: 'watch 5\nwatch pr 10' })
    const baseAfter = await loadConfigBase(dir)
    expect(baseAfter).toEqual(baseBefore)
    const overlay = await loadLocalOverlay(dir)
    expect(overlay.plugins?.['issues']).toEqual({ watched: 5 })
    expect(overlay.plugins?.['prs']).toEqual({ watched: 10 })
  })

  it('re-merges base+local before each cmd so in-batch dedup sees prior writes', async () => {
    await writeConfig(dir, { project: 'roost', plugins: {} })
    class ListishPlugin implements Plugin {
      readonly name = 'listish'
      desiredChannels(): string[] { return [] }
      async runTick(): Promise<PluginTickResult> {
        return { state: null, taggedEvents: [], channels: [] }
      }
      parseCommand(line: string): ParseResult | null {
        const tokens = line.split(/\s+/).filter(Boolean)
        if (tokens[0]?.toLowerCase() !== 'watch') return null
        const numTok = tokens[1]
        if (!numTok || !/^\d+$/.test(numTok)) return null
        return { kind: 'ok', cmd: { number: parseInt(numTok, 10) } }
      }
      handleCommand(merged: OrchestratorConfig, local: OrchestratorConfig, cmd: Command): string | null {
        if (cmd.kind !== 'plugin' || cmd.plugin !== 'listish') return null
        const c = cmd.cmd as { number: number }
        const mergedWatched = (merged.plugins?.['listish'] as { watched?: number[] } | undefined)?.watched ?? []
        if (mergedWatched.includes(c.number)) return `already watching ${c.number}`
        local.plugins ??= {}
        const slice = (local.plugins['listish'] as { watched?: number[] } | undefined) ?? {}
        slice.watched = [...(slice.watched ?? []), c.number]
        local.plugins['listish'] = slice
        return `watching ${c.number}`
      }
    }
    const { deps, irc } = makeDeps(dir, [new ListishPlugin()])
    await handleDm(deps, { sender: 'roost-lead-pm', text: 'watch 5; watch 5' })
    expect(irc.dms[0].text).toBe('watching 5\n\nalready watching 5')
    const overlay = await loadLocalOverlay(dir)
    expect((overlay.plugins?.['listish'] as { watched: number[] }).watched).toEqual([5])
  })

  it('empty-body DMs are ignored silently', async () => {
    await writeConfig(dir, { project: 'roost', plugins: {} })
    const { deps, irc } = makeDeps(dir, [new StubPlugin('issues', null)])
    await handleDm(deps, { sender: 'roost-lead-pm', text: '   ' })
    expect(irc.dms).toEqual([])
    expect(irc.errors).toEqual([])
  })

  it('case-insensitive sender match', async () => {
    await writeConfig(dir, { project: 'roost', irc: { command_senders: ['Alex'] }, plugins: {} })
    const { deps, irc } = makeDeps(dir, [new StubPlugin('issues', null)])
    await handleDm(deps, { sender: 'ALEX', text: 'watch 7' })
    expect(irc.dms[0].text).toBe('issues: watched 7')
  })

  it('explicit empty allowlist blocks everyone (including lead-pm and apm)', async () => {
    await writeConfig(dir, { project: 'roost', irc: { command_senders: [] }, plugins: {} })
    const { deps, irc } = makeDeps(dir, [new StubPlugin('issues', null)])
    await handleDm(deps, { sender: 'roost-lead-pm', text: 'watch 5' })
    await handleDm(deps, { sender: 'roost-apm', text: 'watch 5' })
    expect(irc.dms).toEqual([
      { nick: 'roost-lead-pm', text: 'not authorized; configure irc.command_senders' },
      { nick: 'roost-apm', text: 'not authorized; configure irc.command_senders' },
    ])
  })

  it('config load error surfaces to project channel, no throw', async () => {
    const bogusDir = join(dir, 'does', 'not', 'exist')
    const { deps, irc } = makeDeps(bogusDir, [new StubPlugin('issues', null)])
    await handleDm(deps, { sender: 'roost-lead-pm', text: 'watch 5' })
    expect(irc.errors.some(e => e.startsWith('[dispatcher_error] config load'))).toBe(true)
  })

  it('config write error surfaces to project channel + DM, no throw', async () => {
    await writeConfig(dir, { project: 'roost', plugins: {} })
    await chmod(dir, 0o555)
    try {
      const { deps, irc } = makeDeps(dir, [new StubPlugin('issues', null)])
      await handleDm(deps, { sender: 'roost-lead-pm', text: 'watch 5' })
      expect(irc.errors.some(e => e.startsWith('[dispatcher_error] config write'))).toBe(true)
      expect(irc.dms.some(d => d.text.startsWith('error: failed to update config'))).toBe(true)
    } finally {
      await chmod(dir, 0o700)
    }
  })

  it('plugin.handleCommand that throws is caught + surfaced as [dispatcher_error]', async () => {
    await writeConfig(dir, { project: 'roost', plugins: {} })
    const buggy = new StubPlugin('buggy', null, () => { throw new Error('plugin bug') })
    const { deps, irc } = makeDeps(dir, [buggy])
    await handleDm(deps, { sender: 'roost-lead-pm', text: 'watch 5' })
    expect(irc.errors.some(e => e.includes('handleCommand'))).toBe(true)
    expect(irc.dms.some(d => /handler crashed/.test(d.text))).toBe(true)
  })

  it('pure-read batches do not call mutateConfig (snapshot path)', async () => {
    await writeConfig(dir, { project: 'roost', repo: 'org/r', plugins: { issues: { watched: [{ number: 99 }] } } })
    const { mtimeMs: before } = await Bun.file(join(dir, 'config.json')).stat()
    await new Promise(r => setTimeout(r, 20))
    const { deps, irc } = makeDeps(dir, [new StubPlugin('issues', null)])
    await handleDm(deps, { sender: 'roost-lead-pm', text: 'watch list' })
    expect(irc.dms).toHaveLength(1)
    const { mtimeMs: after } = await Bun.file(join(dir, 'config.json')).stat()
    expect(after).toBe(before)
  })
})
