import { describe, it, expect } from 'bun:test'
import {
  MAX_CHUNK_BODY,
  findNaturalBoundary,
  splitText,
  splitLineForMultiline,
  newBatchId,
  stripLegacyMarker,
  reassembleMultilineBatch,
} from '../src/irc-lib.js'
import { MULTILINE_LINE_BYTES } from '../src/constants.js'

describe('findNaturalBoundary', () => {
  it('prefers sentence-end boundary (period + space)', () => {
    // "hello world. next" — period at index 12, space at 13. Should split after the period.
    const text = 'a'.repeat(200) + '. ' + 'b'.repeat(200)
    const result = findNaturalBoundary(text, 0, MAX_CHUNK_BODY)
    expect(result).toBeLessThan(MAX_CHUNK_BODY)
    expect(text[result - 1]).toBe('.')
  })

  it('falls back to whitespace boundary', () => {
    // Space at position 250 — well within the scan range (minViable = 200, end = 300).
    const text = 'a'.repeat(250) + ' ' + 'b'.repeat(150)
    const result = findNaturalBoundary(text, 0, MAX_CHUNK_BODY)
    expect(result).toBeLessThan(MAX_CHUNK_BODY)
    expect(text[result]).toBe(' ')
  })

  it('hard-cuts when no boundary in range', () => {
    const text = 'a'.repeat(400)
    const result = findNaturalBoundary(text, 0, MAX_CHUNK_BODY)
    expect(result).toBe(MAX_CHUNK_BODY)
  })

  it('handles end-of-string after sentence punctuation', () => {
    const text = 'sentence.'
    const result = findNaturalBoundary(text, 0, text.length)
    expect(result).toBe(text.length)
  })
})

describe('splitText', () => {
  it('returns null for text within chunk limit', () => {
    expect(splitText('short')).toBeNull()
    expect(splitText('x'.repeat(MAX_CHUNK_BODY))).toBeNull()
  })

  it('splits text over limit into chunks', () => {
    const text = 'x'.repeat(MAX_CHUNK_BODY + 1)
    const chunks = splitText(text)
    expect(chunks).not.toBeNull()
    expect(chunks!.length).toBeGreaterThan(1)
    expect(chunks!.join('')).toBe(text)
  })

  it('each chunk is at most MAX_CHUNK_BODY bytes', () => {
    const text = 'a'.repeat(800)
    const chunks = splitText(text)!
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(MAX_CHUNK_BODY)
    }
  })

  it('reassembles to original', () => {
    const text = 'hello world. '.repeat(30)
    const chunks = splitText(text)!
    expect(chunks.join('')).toBe(text)
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

describe('stripLegacyMarker', () => {
  it('strips the legacy marker prefix', () => {
    const body = '[roost-split:abcd1234:1/3] hello'
    expect(stripLegacyMarker(body)).toBe('hello')
  })

  it('passes through body without marker', () => {
    expect(stripLegacyMarker('no marker here')).toBe('no marker here')
  })

  it('requires valid hex id', () => {
    const body = '[roost-split:ZZZZZZZZ:1/3] hello'
    expect(stripLegacyMarker(body)).toBe(body)
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
