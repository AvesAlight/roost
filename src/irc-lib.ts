import { MULTILINE_LINE_BYTES } from './constants.js'

export interface IrcMessage {
  channel: string
  sender: string
  text: string
  ts: string
  isDirect: boolean
  /** Memoized result of the nick mention regex (text-only). Set by recordMessage; OR'd with isDirect at wire-emit time. */
  mention?: boolean
  /** Set when reassembled from N wire PRIVMSGs (a chathistory-replayed multiline batch).
   *  States what was grouped, not what the sender typed. */
  reassembledFrom?: number
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

export interface MultilineWireLine {
  body: string
  /** Continues the previous wire line (draft/multiline-concat) rather than starting a new one. */
  concat: boolean
}

export interface MultilineLimits {
  maxBytes: number
  maxLines: number
}

const wireLineCost = (l: MultilineWireLine): number => Buffer.byteLength(l.body, 'utf8') + 1

// Split text into draft/multiline batches that each fit the server's advertised
// limits; a server rejects an over-limit batch whole, so nothing in it arrives.
// Packs on logical-line boundaries and prefers to break at a blank line (the
// dispatcher separates events with one), dropping that separator. A single
// logical line over budget is split on its wire chunks. Byte cost is UTF-8,
// plus one per line for the joining newline, so it errs toward smaller batches.
export const packMultilineBatches = (text: string, limits: MultilineLimits): MultilineWireLine[][] => {
  const groups: MultilineWireLine[][] = text.split('\n').map(line =>
    splitLineForMultiline(line).map((body, idx) => ({ body, concat: idx > 0 })),
  )
  const isBlank = (g: MultilineWireLine[]) => g.length === 1 && g[0]!.body === ''
  const cost = (gs: MultilineWireLine[][]) => {
    let bytes = 0
    let lines = 0
    for (const g of gs) for (const l of g) { bytes += wireLineCost(l); lines++ }
    return { bytes, lines }
  }
  const fits = (gs: MultilineWireLine[][]) => {
    const c = cost(gs)
    return c.bytes <= limits.maxBytes && c.lines <= limits.maxLines
  }

  const batches: MultilineWireLine[][] = []
  // A blank at a split point is a separator and is dropped; the text's own trailing
  // blank line (final batch) is content and is kept.
  const emit = (gs: MultilineWireLine[][], final = false) => {
    while (!final && gs.length && isBlank(gs[gs.length - 1]!)) gs = gs.slice(0, -1)
    if (gs.length) batches.push(gs.flat())
  }

  let cur: MultilineWireLine[][] = []
  for (const g of groups) {
    if (!cur.length && batches.length && isBlank(g)) continue
    while (cur.length && !fits([...cur, g])) {
      let k = -1
      for (let i = cur.length - 2; i >= 1; i--) if (isBlank(cur[i]!)) { k = i; break }
      if (k > 0) {
        emit(cur.slice(0, k))
        cur = cur.slice(k + 1)
      } else {
        emit(cur)
        cur = []
      }
    }
    if (!fits([g])) {
      // One logical line over budget on its own: cut it on wire-line boundaries.
      let piece: MultilineWireLine[] = []
      for (const l of g) {
        if (piece.length && !fits([[...piece, l]])) {
          batches.push(piece)
          piece = []
        }
        piece.push(piece.length ? l : { body: l.body, concat: false })
      }
      cur = piece.length ? [piece] : []
      continue
    }
    cur.push(g)
  }
  emit(cur, true)
  return batches
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
