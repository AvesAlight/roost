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
import { loadConfig, writeConfig, type OrchestratorConfig } from '../config.js'
import type { Plugin, PluginTickResult } from '../plugin.js'

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

describe('parseCommand', () => {
  it('parses bare watch as target=null', () => {
    expect(parseCommand('watch 5')).toEqual({ kind: 'watch', target: null, number: 5, channels: [] })
  })

  it('parses watch with channels', () => {
    expect(parseCommand('watch 5 #foo #bar')).toEqual({
      kind: 'watch', target: null, number: 5, channels: ['#foo', '#bar'],
    })
  })

  it('parses unwatch with target=null', () => {
    expect(parseCommand('unwatch 5')).toEqual({ kind: 'unwatch', target: null, number: 5 })
  })

  it('parses target keyword from any non-numeric first token', () => {
    expect(parseCommand('watch pr 10')).toEqual({ kind: 'watch', target: 'pr', number: 10, channels: [] })
    expect(parseCommand('watch linear 99')).toEqual({ kind: 'watch', target: 'linear', number: 99, channels: [] })
    expect(parseCommand('unwatch pr 10')).toEqual({ kind: 'unwatch', target: 'pr', number: 10 })
  })

  it('lowercases the target keyword', () => {
    expect(parseCommand('watch PR 10')).toEqual({ kind: 'watch', target: 'pr', number: 10, channels: [] })
  })

  it('parses watch list', () => {
    expect(parseCommand('watch list')).toEqual({ kind: 'list' })
  })

  it('parses help', () => {
    expect(parseCommand('help')).toEqual({ kind: 'help' })
  })

  it('is case-insensitive on verbs', () => {
    expect(parseCommand('WATCH 5')).toEqual({ kind: 'watch', target: null, number: 5, channels: [] })
    expect(parseCommand('Help')).toEqual({ kind: 'help' })
  })

  it('rejects bareword channel arguments', () => {
    const cmd = parseCommand('watch 5 foo') as Extract<Command, { kind: 'unknown' }>
    expect(cmd.kind).toBe('unknown')
    expect(cmd.error).toMatch(/channels must match/)
  })

  it('rejects malformed channel arguments', () => {
    for (const bad of ['#', '##foo']) {
      const cmd = parseCommand(`watch 5 ${bad}`) as Extract<Command, { kind: 'unknown' }>
      expect(cmd.kind).toBe('unknown')
      expect(cmd.error).toMatch(/channels must match/)
    }
  })

  it('rejects trailing tokens after `watch list`', () => {
    const cmd = parseCommand('watch list foo') as Extract<Command, { kind: 'unknown' }>
    expect(cmd.kind).toBe('unknown')
    expect(cmd.error).toMatch(/watch list takes no arguments/)
  })

  it('rejects trailing tokens after `help`', () => {
    const cmd = parseCommand('help me') as Extract<Command, { kind: 'unknown' }>
    expect(cmd.kind).toBe('unknown')
    expect(cmd.error).toMatch(/help takes no arguments/)
  })

  it('rejects a reserved verb in the target slot', () => {
    // `watch unwatch 5` is almost certainly a typo, not "target=unwatch";
    // surface the reserved-verb collision rather than silently routing.
    const cmd = parseCommand('watch unwatch 5') as Extract<Command, { kind: 'unknown' }>
    expect(cmd.kind).toBe('unknown')
    expect(cmd.error).toMatch(/reserved verb/)
  })

  it('rejects non-positive integers', () => {
    expect(parseCommand('watch foo bar').kind).toBe('unknown')
    expect(parseCommand('watch 5.5').kind).toBe('unknown')
    expect(parseCommand('watch -1').kind).toBe('unknown')
  })

  it('rejects unwatch with channel args', () => {
    const cmd = parseCommand('unwatch 5 #x') as Extract<Command, { kind: 'unknown' }>
    expect(cmd.kind).toBe('unknown')
    expect(cmd.error).toMatch(/no channel arguments/)
  })

  it('rejects unknown verb', () => {
    const cmd = parseCommand('foo bar') as Extract<Command, { kind: 'unknown' }>
    expect(cmd.kind).toBe('unknown')
    expect(cmd.error).toMatch(/unknown command/)
  })

  it('requires a number for watch/unwatch', () => {
    expect(parseCommand('watch').kind).toBe('unknown')
    expect(parseCommand('watch pr').kind).toBe('unknown')
  })
})

describe('parseCommands', () => {
  it('parses multi-line input', () => {
    expect(parseCommands('watch 5; unwatch pr 10')).toEqual([
      { kind: 'watch', target: null, number: 5, channels: [] },
      { kind: 'unwatch', target: 'pr', number: 10 },
    ])
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

// A minimal Plugin that claims a target keyword. Records every call so
// tests can assert routing precisely without depending on slice schemas.
class StubPlugin implements Plugin {
  readonly name: string
  readonly handled: Array<{ cmd: Command; configSnapshot: OrchestratorConfig }> = []
  constructor(name: string, private readonly target: string | null, private readonly behavior?: (cmd: Command, config: OrchestratorConfig) => string | null) {
    this.name = name
  }
  desiredChannels(): string[] { return [] }
  async runTick(): Promise<PluginTickResult> {
    return { state: null, taggedEvents: [], channels: [] }
  }
  handleCommand(config: OrchestratorConfig, cmd: Command): string | null {
    this.handled.push({ cmd, configSnapshot: JSON.parse(JSON.stringify(config)) as OrchestratorConfig })
    if (this.behavior) return this.behavior(cmd, config)
    if (cmd.kind === 'list') return `${this.name}: list-section`
    if (cmd.kind === 'help') return `${this.name}: help-section`
    if (cmd.kind === 'watch' && cmd.target === this.target) {
      config.plugins ??= {}
      config.plugins[this.name] = { watched: cmd.number }
      return `${this.name}: watched ${cmd.number}`
    }
    if (cmd.kind === 'unwatch' && cmd.target === this.target) {
      return `${this.name}: unwatched ${cmd.number}`
    }
    return null
  }
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

  it('routes target=null commands only to the matching plugin', async () => {
    await writeConfig(dir, { project: 'roost', plugins: {} })
    const issues = new StubPlugin('issues', null)
    const prs = new StubPlugin('prs', 'pr')
    const { deps, irc } = makeDeps(dir, [issues, prs])
    await handleDm(deps, { sender: 'roost-lead-pm', text: 'watch 5' })
    // Both plugins are invoked, only issues claims it.
    expect(issues.handled).toHaveLength(1)
    expect(prs.handled).toHaveLength(1)
    expect(irc.dms[0].text).toBe('issues: watched 5')
  })

  it('routes target=pr commands only to the matching plugin', async () => {
    await writeConfig(dir, { project: 'roost', plugins: {} })
    const issues = new StubPlugin('issues', null)
    const prs = new StubPlugin('prs', 'pr')
    const { deps, irc } = makeDeps(dir, [issues, prs])
    await handleDm(deps, { sender: 'roost-lead-pm', text: 'watch pr 10' })
    expect(irc.dms[0].text).toBe('prs: watched 10')
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

  it('broadcasts `help` to every plugin and joins with \\n\\n', async () => {
    await writeConfig(dir, { project: 'roost', plugins: {} })
    const issues = new StubPlugin('issues', null)
    const prs = new StubPlugin('prs', 'pr')
    const { deps, irc } = makeDeps(dir, [issues, prs])
    await handleDm(deps, { sender: 'roost-lead-pm', text: 'help' })
    expect(irc.dms[0].text).toBe('issues: help-section\n\nprs: help-section')
  })

  it('surfaces "no plugin handles" when no plugin claims a target', async () => {
    await writeConfig(dir, { project: 'roost', plugins: {} })
    const issues = new StubPlugin('issues', null)
    const { deps, irc } = makeDeps(dir, [issues])
    await handleDm(deps, { sender: 'roost-lead-pm', text: 'watch linear 99' })
    expect(irc.dms).toHaveLength(1)
    expect(irc.dms[0].text).toMatch(/no plugin handles `watch linear <N>/)
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
    // Seed a watched entry. After `watch list`, config on disk is unchanged
    // — proves we didn't re-serialize via mutateConfig.
    await writeConfig(dir, { project: 'roost', repo: 'org/r', plugins: { issues: { watched: [{ number: 99 }] } } })
    const { mtimeMs: before } = await Bun.file(join(dir, 'config.json')).stat()
    // Small delay so a write would show a different mtime.
    await new Promise(r => setTimeout(r, 20))
    const { deps, irc } = makeDeps(dir, [new StubPlugin('issues', null)])
    await handleDm(deps, { sender: 'roost-lead-pm', text: 'watch list' })
    expect(irc.dms).toHaveLength(1)
    const { mtimeMs: after } = await Bun.file(join(dir, 'config.json')).stat()
    expect(after).toBe(before)
  })
})
