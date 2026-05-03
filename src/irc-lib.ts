import { MULTILINE_LINE_BYTES } from './constants.js'

export const MAX_CHUNK_BODY = 300
export const INITIAL_BUFFER_MS = 250
export const EXTENDED_BUFFER_MS = 2000
export const LEGACY_MARKER_RE = /^\[roost-split:[0-9a-f]{8}:\d+\/\d+\] /

export interface IrcMessage {
  channel: string
  sender: string
  text: string
  ts: string
  isDirect: boolean
}

// Split at natural boundaries when possible — prefer sentence end, then any
// whitespace. Searches backward within the last 1/3 of the chunk. Falls back
// to a hard cut only if no boundary is in range.
//
// ngircd strips trailing whitespace, so boundary whitespace goes at the START
// of chunk N+1 (chunk N ends with non-whitespace; chunk N+1 starts with the
// boundary character), preserving the original byte content on concatenation.
export const findNaturalBoundary = (text: string, start: number, end: number): number => {
  const minViable = start + Math.floor((end - start) * 2 / 3)
  for (let j = end; j > minViable; j--) {
    const c = text[j - 1]
    const next = text[j]
    if ((c === '.' || c === '!' || c === '?') && (next === ' ' || next === undefined)) {
      return j
    }
  }
  for (let j = end; j > minViable; j--) {
    const c = text[j]
    if (c === ' ' || c === '\t') return j
  }
  return end
}

export const splitText = (text: string): string[] | null => {
  if (text.length <= MAX_CHUNK_BODY) return null
  const out: string[] = []
  let i = 0
  while (i < text.length) {
    const remaining = text.length - i
    if (remaining <= MAX_CHUNK_BODY) {
      out.push(text.slice(i))
      break
    }
    const split = findNaturalBoundary(text, i, i + MAX_CHUNK_BODY)
    out.push(text.slice(i, split))
    i = split
  }
  return out
}

export const splitLineForMultiline = (line: string): string[] => {
  if (line.length <= MULTILINE_LINE_BYTES) return [line]
  const out: string[] = []
  let i = 0
  while (i < line.length) {
    const remaining = line.length - i
    if (remaining <= MULTILINE_LINE_BYTES) {
      out.push(line.slice(i))
      break
    }
    const split = findNaturalBoundary(line, i, i + MULTILINE_LINE_BYTES)
    out.push(line.slice(i, split))
    i = split
  }
  return out
}

export const newBatchId = (): string =>
  Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0')

export const stripLegacyMarker = (body: string): string => {
  const m = LEGACY_MARKER_RE.exec(body)
  return m ? body.slice(m[0].length) : body
}

// Reassemble a draft/multiline batch into a single string. Filters to PRIVMSG
// commands; adjacent lines join with \n unless the line carries
// draft/multiline-concat (then they concat directly onto the prior chunk).
export const reassembleMultilineBatch = (
  cmds: Array<{
    command: string
    params: string[]
    tags: Record<string, unknown>
  }>,
): string => {
  const privmsgs = cmds.filter(c => c.command === 'PRIVMSG')
  let text = ''
  privmsgs.forEach((c, i) => {
    const body = c.params[c.params.length - 1] ?? ''
    const concat = 'draft/multiline-concat' in c.tags
    if (i === 0) {
      text = body
    } else if (concat) {
      text += body
    } else {
      text += '\n' + body
    }
  })
  return text
}
