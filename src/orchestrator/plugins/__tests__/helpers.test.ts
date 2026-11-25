import { afterAll, describe, expect, it } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// Through the public surface, so dropping an export from plugin-api fails here.
import { capPosts, mergeSeen, noteFailure, noteRecovery, runWithTimeout } from '../../plugin-api.js'

const say = (text: string) => ({ channels: ['#c'], text })

describe('noteFailure', () => {
  const failText = (why: string) => `broke: ${why}`

  it('reports a first failure and remembers it', () => {
    expect(noteFailure(null, 'HTTP 500', say, failText)).toEqual({
      error: 'HTTP 500',
      messages: [{ channels: ['#c'], text: 'broke: HTTP 500' }],
    })
  })

  it('stays quiet while the same failure repeats', () => {
    expect(noteFailure('HTTP 500', 'HTTP 500', say, failText)).toEqual({ error: 'HTTP 500', messages: [] })
  })

  it('reports again when the failure changes', () => {
    const r = noteFailure('HTTP 500', 'timed out', say, failText)
    expect(r.error).toBe('timed out')
    expect(r.messages.map(m => m.text)).toEqual(['broke: timed out'])
  })
})

describe('noteRecovery', () => {
  it('says so once, after a failure', () => {
    expect(noteRecovery('HTTP 500', say, 'back')).toEqual([{ channels: ['#c'], text: 'back' }])
  })

  it('says nothing when nothing was failing', () => {
    expect(noteRecovery(null, say, 'back')).toEqual([])
  })
})

describe('mergeSeen', () => {
  it('puts this read first, keeps older ids after it once, and caps', () => {
    expect(mergeSeen(['c', 'b'], ['b', 'a', 'z'], 10)).toEqual(['c', 'b', 'a', 'z'])
    expect(mergeSeen(['c', 'b'], ['b', 'a', 'z'], 3)).toEqual(['c', 'b', 'a'])
  })
})

describe('capPosts', () => {
  const items = ['a', 'b', 'c', 'd', 'e']
  const render = (s: string) => `item ${s}`
  const more = (n: number) => `${n} more`

  it('posts everything under the cap', () => {
    expect(capPosts(items, 5, render, more, say).map(m => m.text)).toEqual(items.map(render))
  })

  it('posts the first `max` in order, then one line counting the rest', () => {
    expect(capPosts(items, 2, render, more, say).map(m => m.text)).toEqual(['item a', 'item b', '3 more'])
  })
})

describe('runWithTimeout', () => {
  // A stand-in binary, called by absolute path so a real one never runs.
  const dir = mkdtempSync(join(tmpdir(), 'fake-bin-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  let n = 0
  function fakeBin(body: string): string {
    const bin = join(dir, `tool-${n++}`)
    writeFileSync(bin, `#!/usr/bin/env bash\n${body}\n`)
    chmodSync(bin, 0o755)
    return bin
  }

  it('flags a call that outlives its timeout and kills it', async () => {
    const started = Date.now()
    const res = await runWithTimeout(200, fakeBin('sleep 5'))(['x'])
    expect(res.timedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('returns output and exit code from a call that finishes', async () => {
    const res = await runWithTimeout(5000, fakeBin('echo "$1"; echo oops >&2; exit 3'))(['hello'])
    expect(res).toEqual({ code: 3, stdout: 'hello\n', stderr: 'oops\n', timedOut: false })
  })
})
