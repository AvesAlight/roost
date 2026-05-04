import { describe, it, expect } from 'bun:test'
import {
  findNaturalBoundary,
  splitLineForMultiline,
  newBatchId,
  reassembleMultilineBatch,
} from '../src/irc-lib.js'
import { MULTILINE_LINE_BYTES } from '../src/constants.js'

const BOUNDARY_SIZE = 300

describe('findNaturalBoundary', () => {
  it('prefers sentence-end boundary (period + space)', () => {
    const text = 'a'.repeat(200) + '. ' + 'b'.repeat(200)
    const result = findNaturalBoundary(text, 0, BOUNDARY_SIZE)
    expect(result).toBeLessThan(BOUNDARY_SIZE)
    expect(text[result - 1]).toBe('.')
  })

  it('falls back to whitespace boundary', () => {
    const text = 'a'.repeat(250) + ' ' + 'b'.repeat(150)
    const result = findNaturalBoundary(text, 0, BOUNDARY_SIZE)
    expect(result).toBeLessThan(BOUNDARY_SIZE)
    expect(text[result]).toBe(' ')
  })

  it('hard-cuts when no boundary in range', () => {
    const text = 'a'.repeat(400)
    const result = findNaturalBoundary(text, 0, BOUNDARY_SIZE)
    expect(result).toBe(BOUNDARY_SIZE)
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
