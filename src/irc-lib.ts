import { MULTILINE_LINE_BYTES } from './constants.js'

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
