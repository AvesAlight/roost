import { describe, it, expect } from 'bun:test'
import {
  findNaturalBoundary,
  splitLineForMultiline,
  packMultilineBatches,
  type MultilineWireLine,
  newBatchId,
  reassembleMultilineBatch,
} from '../src/irc-lib.js'
import { MULTILINE_LINE_BYTES } from '../src/constants.js'

describe('findNaturalBoundary', () => {
  it('prefers sentence-end boundary (period + space)', () => {
    const text = 'a'.repeat(200) + '. ' + 'b'.repeat(200)
    const result = findNaturalBoundary(text, 0, MULTILINE_LINE_BYTES)
    expect(result).toBeLessThan(MULTILINE_LINE_BYTES)
    expect(text[result - 1]).toBe('.')
  })

  it('falls back to whitespace boundary', () => {
    const text = 'a'.repeat(250) + ' ' + 'b'.repeat(150)
    const result = findNaturalBoundary(text, 0, MULTILINE_LINE_BYTES)
    expect(result).toBeLessThan(MULTILINE_LINE_BYTES)
    expect(text[result]).toBe(' ')
  })

  it('hard-cuts when no boundary in range', () => {
    const text = 'a'.repeat(400)
    const result = findNaturalBoundary(text, 0, MULTILINE_LINE_BYTES)
    expect(result).toBe(MULTILINE_LINE_BYTES)
  })

  it('handles end-of-string after sentence punctuation', () => {
    const text = 'sentence.'
    const result = findNaturalBoundary(text, 0, text.length)
    expect(result).toBe(text.length)
  })
})

describe('splitLineForMultiline', () => {
  it('returns single-element array for short line', () => {
    const chunks = splitLineForMultiline('short')
    expect(chunks).toEqual(['short'])
  })

  it('returns single-element array for line exactly at limit', () => {
    const line = 'x'.repeat(MULTILINE_LINE_BYTES)
    expect(splitLineForMultiline(line)).toEqual([line])
  })

  it('splits line one byte over limit into two chunks', () => {
    const line = 'x'.repeat(MULTILINE_LINE_BYTES + 1)
    const chunks = splitLineForMultiline(line)
    expect(chunks.length).toBe(2)
    expect(chunks.join('')).toBe(line)
  })

  it('reassembles to original', () => {
    const line = 'a'.repeat(MULTILINE_LINE_BYTES + 150)
    const chunks = splitLineForMultiline(line)
    expect(chunks.join('')).toBe(line)
  })
})

describe('newBatchId', () => {
  it('returns an 8-char hex string', () => {
    const id = newBatchId()
    expect(id).toMatch(/^[0-9a-f]{8}$/)
  })

  it('returns distinct values', () => {
    const ids = new Set(Array.from({ length: 20 }, newBatchId))
    expect(ids.size).toBeGreaterThan(1)
  })
})

describe('reassembleMultilineBatch', () => {
  const makeCmd = (body: string, concat = false, command = 'PRIVMSG') => ({
    command,
    params: ['#chan', body],
    tags: concat ? { 'draft/multiline-concat': '' } : {},
  })

  it('single PRIVMSG returns body', () => {
    expect(reassembleMultilineBatch([makeCmd('hello')])).toBe('hello')
  })

  it('two lines without concat join with newline', () => {
    expect(reassembleMultilineBatch([makeCmd('line1'), makeCmd('line2')])).toBe('line1\nline2')
  })

  it('continuation chunk with concat tag concatenates directly', () => {
    expect(reassembleMultilineBatch([makeCmd('hel'), makeCmd('lo', true)])).toBe('hello')
  })

  it('mixed: long line split with concat + second logical line', () => {
    const cmds = [makeCmd('hel'), makeCmd('lo', true), makeCmd('world')]
    expect(reassembleMultilineBatch(cmds)).toBe('hello\nworld')
  })

  it('ignores non-PRIVMSG commands', () => {
    const cmds = [
      { command: 'JOIN', params: ['#chan'], tags: {} },
      makeCmd('hello'),
    ]
    expect(reassembleMultilineBatch(cmds)).toBe('hello')
  })

  it('empty batch returns empty string', () => {
    expect(reassembleMultilineBatch([])).toBe('')
  })

  it('empty body in PRIVMSG preserved', () => {
    expect(reassembleMultilineBatch([makeCmd('a'), makeCmd(''), makeCmd('b')])).toBe('a\n\nb')
  })
})

// Rebuild the text a receiver sees from a batch: concat lines glue, others join with \n.
const render = (lines: MultilineWireLine[]): string =>
  lines.reduce((acc, l, i) => (i === 0 ? l.body : l.concat ? acc + l.body : acc + '\n' + l.body), '')

describe('packMultilineBatches', () => {
  const limits = { maxBytes: 16384, maxLines: 200 }

  it('text within limits is one batch that round-trips', () => {
    const text = 'one\ntwo\nthree'
    const out = packMultilineBatches(text, limits)
    expect(out).toHaveLength(1)
    expect(render(out[0]!)).toBe(text)
  })

  it('keeps the text\'s own trailing newline', () => {
    const out = packMultilineBatches('hello\nworld\n', limits)
    expect(out.map(render)).toEqual(['hello\nworld\n'])
  })

  it('prefers a blank-line break and drops the separator', () => {
    const events = Array.from({ length: 10 }, (_, i) => `head ${i}\nbody ${i}\nurl ${i}`)
    const out = packMultilineBatches(events.join('\n\n'), { maxBytes: 16384, maxLines: 10 })
    // 3-line events + blank separators: 2 events (3+1+3=7 lines) fit per batch, a third doesn't.
    expect(out.map(render)).toEqual([0, 2, 4, 6, 8].map(i => `${events[i]}\n\n${events[i + 1]}`))
  })

  it('never emits a batch that starts or ends on a blank line', () => {
    const text = Array.from({ length: 40 }, (_, i) => `p${i}`).join('\n\n')
    for (const b of packMultilineBatches(text, { maxBytes: 16384, maxLines: 7 })) {
      expect(b[0]!.body).not.toBe('')
      expect(b[b.length - 1]!.body).not.toBe('')
    }
  })

  it('splits a single logical line over the byte budget on its wire chunks', () => {
    const text = 'word '.repeat(400).trim() // ~2000 bytes, one logical line, 7 wire chunks
    const out = packMultilineBatches(text, { maxBytes: 700, maxLines: 200 })
    expect(out.length).toBeGreaterThan(1)
    for (const b of out) {
      expect(b[0]!.concat).toBe(false) // a batch never opens with a continuation
      expect(b.reduce((n, l) => n + Buffer.byteLength(l.body) + 1, 0)).toBeLessThanOrEqual(700)
    }
    expect(out.map(render).join('')).toBe(text)
  })

  it('counts UTF-8 bytes, not characters', () => {
    // 100 chars of 3-byte glyphs = 300 bytes per line; 3 lines = 903 > 800.
    const line = '€'.repeat(100)
    const out = packMultilineBatches([line, line, line].join('\n'), { maxBytes: 800, maxLines: 200 })
    expect(out.length).toBeGreaterThan(1)
  })
})
