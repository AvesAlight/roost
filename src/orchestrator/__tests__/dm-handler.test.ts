import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyCommand,
  formatList,
  handleDm,
  parseCommand,
  parseCommands,
  resolveAllowlist,
  splitCommands,
  type Command,
} from '../dm-handler.js'
import { loadConfig, writeConfig, type OrchestratorConfig } from '../config.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'roost-dm-handler-test-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('splitCommands', () => {
  it('splits on newlines, semicolons, commas; trims; drops empties', () => {
    expect(splitCommands('watch 5\n watch 6 ; watch 7, ,\nhelp')).toEqual([
      'watch 5', 'watch 6', 'watch 7', 'help',
    ])
  })
})

describe('parseCommand', () => {
  it('parses bare watch', () => {
    expect(parseCommand('watch 5')).toEqual({ kind: 'watch', plugin: 'github-issues', number: 5, channels: [] })
  })

  it('parses watch with channels', () => {
    expect(parseCommand('watch 5 #foo #bar')).toEqual({
      kind: 'watch', plugin: 'github-issues', number: 5, channels: ['#foo', '#bar'],
    })
  })

  it('parses unwatch', () => {
    expect(parseCommand('unwatch 5')).toEqual({ kind: 'unwatch', plugin: 'github-issues', number: 5 })
  })

  it('parses watch pr', () => {
    expect(parseCommand('watch pr 10')).toEqual({ kind: 'watch', plugin: 'github-prs', number: 10, channels: [] })
  })

  it('parses watch pr with channels', () => {
    expect(parseCommand('watch pr 10 #x #y')).toEqual({
      kind: 'watch', plugin: 'github-prs', number: 10, channels: ['#x', '#y'],
    })
  })

  it('parses unwatch pr', () => {
    expect(parseCommand('unwatch pr 10')).toEqual({ kind: 'unwatch', plugin: 'github-prs', number: 10 })
  })

  it('parses watch list', () => {
    expect(parseCommand('watch list')).toEqual({ kind: 'list' })
  })

  it('parses help', () => {
    expect(parseCommand('help')).toEqual({ kind: 'help' })
  })

  it('is case-insensitive on verbs', () => {
    expect(parseCommand('WATCH PR 10')).toEqual({ kind: 'watch', plugin: 'github-prs', number: 10, channels: [] })
    expect(parseCommand('Help')).toEqual({ kind: 'help' })
  })

  it('rejects bareword channel arguments', () => {
    const cmd = parseCommand('watch 5 foo') as Extract<Command, { kind: 'unknown' }>
    expect(cmd.kind).toBe('unknown')
    expect(cmd.error).toMatch(/channels must start with #/)
  })

  it('rejects non-integer numbers', () => {
    expect(parseCommand('watch foo').kind).toBe('unknown')
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
      { kind: 'watch', plugin: 'github-issues', number: 5, channels: [] },
      { kind: 'unwatch', plugin: 'github-prs', number: 10 },
    ])
  })
})

describe('applyCommand', () => {
  it('adds a new issue entry', () => {
    const config: OrchestratorConfig = {}
    const out = applyCommand(config, { kind: 'watch', plugin: 'github-issues', number: 5, channels: [] })
    expect(out).toMatch(/watching issue #5/)
    expect((config.plugins?.['github-issues'] as { watched: unknown[] }).watched).toEqual([{ number: 5 }])
  })

  it('is idempotent for re-adding without channels', () => {
    const config: OrchestratorConfig = { plugins: { 'github-issues': { watched: [{ number: 5 }] } } }
    const out = applyCommand(config, { kind: 'watch', plugin: 'github-issues', number: 5, channels: [] })
    expect(out).toMatch(/already watching/)
  })

  it('appends + dedupes channels onto existing entry', () => {
    const config: OrchestratorConfig = {
      plugins: { 'github-issues': { watched: [{ number: 5, channels: ['#a'] }] } },
    }
    applyCommand(config, { kind: 'watch', plugin: 'github-issues', number: 5, channels: ['#a', '#b'] })
    const entry = (config.plugins!['github-issues'] as { watched: { channels: string[] }[] }).watched[0]
    expect(entry.channels).toEqual(['#a', '#b'])
  })

  it('removes an entry on unwatch', () => {
    const config: OrchestratorConfig = {
      plugins: { 'github-issues': { watched: [{ number: 5 }, { number: 6 }] } },
    }
    applyCommand(config, { kind: 'unwatch', plugin: 'github-issues', number: 5 })
    expect((config.plugins!['github-issues'] as { watched: { number: number }[] }).watched).toEqual([{ number: 6 }])
  })

  it('reports not-watching on unwatch of unknown entry', () => {
    const config: OrchestratorConfig = {}
    const out = applyCommand(config, { kind: 'unwatch', plugin: 'github-issues', number: 5 })
    expect(out).toMatch(/not watching/)
  })

  it('watch pr targets the github-prs slice', () => {
    const config: OrchestratorConfig = {}
    applyCommand(config, { kind: 'watch', plugin: 'github-prs', number: 10, channels: ['#x'] })
    expect(config.plugins?.['github-prs']).toEqual({ watched: [{ number: 10, channels: ['#x'] }] })
    expect(config.plugins?.['github-issues']).toBeUndefined()
  })

  it('emits help text and list text for those commands', () => {
    const config: OrchestratorConfig = {}
    expect(applyCommand(config, { kind: 'help' })).toMatch(/commands \(DM only\)/)
    expect(applyCommand(config, { kind: 'list' })).toMatch(/issues \(0\)/)
  })
})

describe('formatList', () => {
  it('formats both slices with channel attachments', () => {
    const config: OrchestratorConfig = {
      plugins: {
        'github-issues': { watched: [{ number: 5 }, { number: 6, channels: ['#a', '#b'] }] },
        'github-prs': { watched: [{ number: 10, channels: ['#x'] }] },
      },
    }
    const out = formatList(config)
    expect(out).toContain('issues (2):')
    expect(out).toContain('  #5')
    expect(out).toContain('  #6 + #a #b')
    expect(out).toContain('prs (1):')
    expect(out).toContain('  #10 + #x')
  })

  it('reports (none) for empty slices', () => {
    expect(formatList({})).toContain('(none)')
  })
})

describe('resolveAllowlist', () => {
  it('defaults to [<project>-lead-pm] when unset', () => {
    expect(resolveAllowlist({ project: 'roost' })).toEqual(['roost-lead-pm'])
  })

  it('returns the explicit list when set (including empty)', () => {
    expect(resolveAllowlist({ irc: { command_senders: ['alex', 'bot'] } })).toEqual(['alex', 'bot'])
    expect(resolveAllowlist({ irc: { command_senders: [] } })).toEqual([])
  })

  it('returns [] when no project/repo to derive a default from', () => {
    expect(resolveAllowlist({})).toEqual([])
  })
})

// ---- handleDm — end-to-end via real config files --------------------------

interface FakeIrc {
  dms: Array<{ nick: string; text: string }>
  errors: string[]
  logs: string[]
}

function makeDeps(stateDir: string): { deps: Parameters<typeof handleDm>[0]; irc: FakeIrc } {
  const irc: FakeIrc = { dms: [], errors: [], logs: [] }
  const deps = {
    stateDir,
    dm: (nick: string, text: string) => { irc.dms.push({ nick, text }) },
    postProjectError: (text: string) => { irc.errors.push(text) },
    log: (line: string) => { irc.logs.push(line) },
  }
  return { deps, irc }
}

describe('handleDm', () => {
  it('rejects senders outside the allowlist with a tight one-liner', async () => {
    await writeConfig(dir, { project: 'roost', irc: { command_senders: ['alex'] }, plugins: {} })
    const { deps, irc } = makeDeps(dir)
    await handleDm(deps, { sender: 'mallory', text: 'watch 5' })
    expect(irc.dms).toEqual([{ nick: 'mallory', text: 'not authorized; configure irc.command_senders' }])
    // No mutation
    expect((await loadConfig(dir)).plugins?.['github-issues']).toBeUndefined()
  })

  it('allows the default lead-pm nick when command_senders is unset', async () => {
    await writeConfig(dir, { project: 'roost', plugins: {} })
    const { deps, irc } = makeDeps(dir)
    await handleDm(deps, { sender: 'roost-lead-pm', text: 'watch 5' })
    expect(irc.dms).toHaveLength(1)
    expect(irc.dms[0].text).toMatch(/watching issue #5/)
    const config = await loadConfig(dir)
    expect((config.plugins?.['github-issues'] as { watched: unknown[] }).watched).toEqual([{ number: 5 }])
  })

  it('case-insensitive sender match', async () => {
    await writeConfig(dir, { project: 'roost', irc: { command_senders: ['Alex'] }, plugins: {} })
    const { deps, irc } = makeDeps(dir)
    await handleDm(deps, { sender: 'ALEX', text: 'watch 7' })
    expect(irc.dms[0].text).toMatch(/watching issue #7/)
  })

  it('mutates config and replies with a single confirmation for multi-command DMs', async () => {
    await writeConfig(dir, { project: 'roost', plugins: {} })
    const { deps, irc } = makeDeps(dir)
    await handleDm(deps, {
      sender: 'roost-lead-pm',
      text: 'watch 5 #foo\nwatch pr 10 #bar',
    })
    expect(irc.dms).toHaveLength(1)
    const reply = irc.dms[0].text
    expect(reply).toMatch(/watching issue #5/)
    expect(reply).toMatch(/watching pr #10/)
    const config = await loadConfig(dir)
    expect(config.plugins?.['github-issues']).toEqual({ watched: [{ number: 5, channels: ['#foo'] }] })
    expect(config.plugins?.['github-prs']).toEqual({ watched: [{ number: 10, channels: ['#bar'] }] })
  })

  it('parse failures reply with a one-liner and do not throw', async () => {
    await writeConfig(dir, { project: 'roost', plugins: {} })
    const { deps, irc } = makeDeps(dir)
    await handleDm(deps, { sender: 'roost-lead-pm', text: 'watch 5 foo' })
    expect(irc.dms).toHaveLength(1)
    expect(irc.dms[0].text).toMatch(/error: channels must start with #/)
    // Config untouched
    expect((await loadConfig(dir)).plugins?.['github-issues']).toBeUndefined()
  })

  it('watch list replies with the formatted lists', async () => {
    await writeConfig(dir, {
      project: 'roost',
      plugins: {
        'github-issues': { watched: [{ number: 5 }] },
        'github-prs': { watched: [{ number: 10, channels: ['#x'] }] },
      },
    })
    const { deps, irc } = makeDeps(dir)
    await handleDm(deps, { sender: 'roost-lead-pm', text: 'watch list' })
    expect(irc.dms).toHaveLength(1)
    const reply = irc.dms[0].text
    expect(reply).toContain('issues (1):')
    expect(reply).toContain('  #5')
    expect(reply).toContain('prs (1):')
    expect(reply).toContain('  #10 + #x')
  })

  it('empty-body DMs are ignored silently', async () => {
    await writeConfig(dir, { project: 'roost', plugins: {} })
    const { deps, irc } = makeDeps(dir)
    await handleDm(deps, { sender: 'roost-lead-pm', text: '   ' })
    expect(irc.dms).toEqual([])
    expect(irc.errors).toEqual([])
  })

  it('config write error surfaces to project channel + DM, no throw', async () => {
    // Point at a non-existent dir to force loadConfig to fail
    const bogusDir = join(dir, 'does', 'not', 'exist')
    const { deps, irc } = makeDeps(bogusDir)
    await handleDm(deps, { sender: 'roost-lead-pm', text: 'watch 5' })
    expect(irc.errors.some(e => e.startsWith('[dispatcher_error] config load'))).toBe(true)
  })

  it('explicit empty allowlist blocks everyone (including lead-pm)', async () => {
    await writeConfig(dir, { project: 'roost', irc: { command_senders: [] }, plugins: {} })
    const { deps, irc } = makeDeps(dir)
    await handleDm(deps, { sender: 'roost-lead-pm', text: 'watch 5' })
    expect(irc.dms).toEqual([{ nick: 'roost-lead-pm', text: 'not authorized; configure irc.command_senders' }])
  })
})
