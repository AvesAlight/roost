import { describe, it, expect } from 'bun:test'
import { tryClaimPerN, tryClaimPerRepo, splitCommands } from '../grammar.js'

// ---- splitCommands --------------------------------------------------------

describe('splitCommands', () => {
  it('splits on newlines, semicolons, commas; trims; drops empties', () => {
    expect(splitCommands('watch 5\n watch 6 ; watch 7, ,\nhelp')).toEqual([
      'watch 5', 'watch 6', 'watch 7', 'help',
    ])
  })
})

// tokenizeVerbLine is a grammar.ts internal — exercised end-to-end via the
// tryClaim* helpers below. No standalone test.

// ---- tryClaimPerN (target=null — bare watch <N>) --------------------------

describe('tryClaimPerN — bare (target=null)', () => {
  it('claims `watch 5`', () => {
    expect(tryClaimPerN(null, 'watch 5')).toEqual({
      kind: 'ok', cmd: { verb: 'watch', number: 5, repo: null, channels: [] },
    })
  })

  it('claims with channels', () => {
    expect(tryClaimPerN(null, 'watch 5 #foo #bar')).toEqual({
      kind: 'ok', cmd: { verb: 'watch', number: 5, repo: null, channels: ['#foo', '#bar'] },
    })
  })

  it('claims `unwatch 5`', () => {
    expect(tryClaimPerN(null, 'unwatch 5')).toEqual({
      kind: 'ok', cmd: { verb: 'unwatch', number: 5, repo: null, channels: [] },
    })
  })

  it('defers on a leading target keyword (some other plugin claims `pr`)', () => {
    expect(tryClaimPerN(null, 'watch pr 10')).toBeNull()
    expect(tryClaimPerN(null, 'unwatch pr 10')).toBeNull()
  })

  it('defers on a leading reserved verb (typo handler upstream)', () => {
    expect(tryClaimPerN(null, 'watch unwatch 5')).toBeNull()
  })

  it('defers when the spec token is repo-shape (per-repo plugin claims)', () => {
    expect(tryClaimPerN(null, 'watch org/r')).toBeNull()
  })

  it('errors on missing number after the verb', () => {
    const r = tryClaimPerN(null, 'watch')
    expect(r).toEqual({ kind: 'error', message: 'watch requires an issue/PR number or <owner>/<repo> spec' })
  })

  it('defers on a first token that\'s neither a digit-string, repo-shape, nor channel', () => {
    // `watch foo` / `watch -1` / `watch 5.5` could all be "some other plugin's
    // target=… with missing args" from the bare claimer's perspective. Defer
    // and let the dispatcher surface "no plugin handles" if nothing claims it.
    expect(tryClaimPerN(null, 'watch foo')).toBeNull()
    expect(tryClaimPerN(null, 'watch -1')).toBeNull()
    expect(tryClaimPerN(null, 'watch 5.5')).toBeNull()
  })

  it('errors on a digit-shaped but non-positive integer', () => {
    expect(tryClaimPerN(null, 'watch 0')?.kind).toBe('error')
  })

  it('claims repo positional after the number', () => {
    expect(tryClaimPerN(null, 'watch 5 org/repo')).toEqual({
      kind: 'ok', cmd: { verb: 'watch', number: 5, repo: 'org/repo', channels: [] },
    })
  })

  it('claims repo + channels', () => {
    expect(tryClaimPerN(null, 'watch 5 org/repo #chan')).toEqual({
      kind: 'ok', cmd: { verb: 'watch', number: 5, repo: 'org/repo', channels: ['#chan'] },
    })
  })

  it('does NOT mis-grab a #channel as the repo positional', () => {
    expect(tryClaimPerN(null, 'watch 5 #chan')).toEqual({
      kind: 'ok', cmd: { verb: 'watch', number: 5, repo: null, channels: ['#chan'] },
    })
  })

  it('rejects unwatch with channel args', () => {
    expect(tryClaimPerN(null, 'unwatch 5 #x')).toEqual({
      kind: 'error', message: 'unwatch takes no channel arguments',
    })
  })

  it('rejects malformed channels', () => {
    for (const bad of ['#', '##foo']) {
      const r = tryClaimPerN(null, `watch 5 ${bad}`)
      expect(r?.kind).toBe('error')
      expect((r as { kind: 'error'; message: string }).message).toMatch(/channels must match/)
    }
  })

  it('rejects bareword channel arguments', () => {
    const r = tryClaimPerN(null, 'watch 5 foo')
    expect(r?.kind).toBe('error')
    expect((r as { kind: 'error'; message: string }).message).toMatch(/channels must match/)
  })

  it('only one repo positional; a second is treated as malformed channel', () => {
    const r = tryClaimPerN(null, 'watch 5 org/a org/b')
    expect(r?.kind).toBe('error')
    expect((r as { kind: 'error'; message: string }).message).toMatch(/channels must match/)
  })

  it('rejects unwatch with a trailing channel after the repo positional', () => {
    const r = tryClaimPerN(null, 'unwatch 5 org/r #x')
    expect(r?.kind).toBe('error')
    expect((r as { kind: 'error'; message: string }).message).toMatch(/no channel arguments/)
  })
})

// ---- tryClaimPerN (target='pr') -------------------------------------------

describe('tryClaimPerN — target=pr', () => {
  it('claims `watch pr 10`', () => {
    expect(tryClaimPerN('pr', 'watch pr 10')).toEqual({
      kind: 'ok', cmd: { verb: 'watch', number: 10, repo: null, channels: [] },
    })
  })

  it('defers on bare `watch 10` (bare claimer\'s shape)', () => {
    expect(tryClaimPerN('pr', 'watch 10')).toBeNull()
  })

  it('defers on a different target', () => {
    expect(tryClaimPerN('pr', 'watch repo org/r')).toBeNull()
    expect(tryClaimPerN('pr', 'watch new-issues org/r')).toBeNull()
  })

  it('lowercases the target token', () => {
    expect(tryClaimPerN('pr', 'watch PR 10')).toEqual({
      kind: 'ok', cmd: { verb: 'watch', number: 10, repo: null, channels: [] },
    })
  })

  it('errors when target matches but number is missing', () => {
    const r = tryClaimPerN('pr', 'watch pr')
    expect(r).toEqual({ kind: 'error', message: 'watch requires an issue/PR number or <owner>/<repo> spec' })
  })

  it('claims `watch pr 10 org/r #chan`', () => {
    expect(tryClaimPerN('pr', 'watch pr 10 org/r #chan')).toEqual({
      kind: 'ok', cmd: { verb: 'watch', number: 10, repo: 'org/r', channels: ['#chan'] },
    })
  })
})

// ---- tryClaimPerRepo (target='repo') --------------------------------------

describe('tryClaimPerRepo — target=repo', () => {
  it('claims bare `watch repo org/r`', () => {
    expect(tryClaimPerRepo('repo', 'watch repo org/r')).toEqual({
      kind: 'ok', cmd: { verb: 'watch', repo: 'org/r', branch: null, path: null, channels: [] },
    })
  })

  it('claims @branch', () => {
    expect(tryClaimPerRepo('repo', 'watch repo org/r@develop')).toEqual({
      kind: 'ok', cmd: { verb: 'watch', repo: 'org/r', branch: 'develop', path: null, channels: [] },
    })
  })

  it('claims :path without branch', () => {
    expect(tryClaimPerRepo('repo', 'watch repo org/r:Formula/x.rb')).toEqual({
      kind: 'ok', cmd: { verb: 'watch', repo: 'org/r', branch: null, path: 'Formula/x.rb', channels: [] },
    })
  })

  it('claims @branch:path + channels', () => {
    expect(tryClaimPerRepo('repo', 'watch repo org/r@develop:Formula/x.rb #chan')).toEqual({
      kind: 'ok', cmd: { verb: 'watch', repo: 'org/r', branch: 'develop', path: 'Formula/x.rb', channels: ['#chan'] },
    })
  })

  it('claims `unwatch repo org/r@develop:Formula/x.rb`', () => {
    expect(tryClaimPerRepo('repo', 'unwatch repo org/r@develop:Formula/x.rb')).toEqual({
      kind: 'ok', cmd: { verb: 'unwatch', repo: 'org/r', branch: 'develop', path: 'Formula/x.rb', channels: [] },
    })
  })

  it('defers on a different target', () => {
    expect(tryClaimPerRepo('repo', 'watch new-issues org/r')).toBeNull()
  })

  it('defers when spec is a number (per-N plugin claims)', () => {
    expect(tryClaimPerRepo('repo', 'watch repo 5')).toBeNull()
  })

  it('errors when target matches but spec is missing', () => {
    expect(tryClaimPerRepo('repo', 'watch repo')).toEqual({
      kind: 'error', message: 'watch requires an <owner>/<repo> spec',
    })
  })

  it('errors on a malformed repo spec', () => {
    const r = tryClaimPerRepo('repo', 'watch repo notavalidspec!')
    expect(r?.kind).toBe('error')
  })

  it('rejects unwatch with channel args', () => {
    expect(tryClaimPerRepo('repo', 'unwatch repo org/r #x')).toEqual({
      kind: 'error', message: 'unwatch takes no channel arguments',
    })
  })
})

// ---- tryClaimPerRepo (target='new-issues') --------------------------------

describe('tryClaimPerRepo — target=new-issues', () => {
  it('claims `watch new-issues org/r #chan`', () => {
    expect(tryClaimPerRepo('new-issues', 'watch new-issues org/r #chan')).toEqual({
      kind: 'ok', cmd: { verb: 'watch', repo: 'org/r', branch: null, path: null, channels: ['#chan'] },
    })
  })
})

// ---- tryClaimPerRepo (target=null) ---------------------------------------

describe('tryClaimPerRepo — bare (target=null)', () => {
  it('claims bare `watch org/r` (a generic per-repo plugin can opt in)', () => {
    expect(tryClaimPerRepo(null, 'watch org/r')).toEqual({
      kind: 'ok', cmd: { verb: 'watch', repo: 'org/r', branch: null, path: null, channels: [] },
    })
  })

  it('defers on `watch pr org/r` (target keyword), `watch 5` (number)', () => {
    expect(tryClaimPerRepo(null, 'watch pr org/r')).toBeNull()
    expect(tryClaimPerRepo(null, 'watch 5')).toBeNull()
  })
})
