#!/usr/bin/env bun
/**
 * Probe: ergo IRCv3 draft/multiline roundtrip.
 *
 * Two clients connect to ergo on 127.0.0.1:6667, both request the
 * draft/multiline cap. Sender emits a multi-paragraph message as a
 * BATCH+PRIVMSG(@batch=…)+BATCH wire sequence — same shape the MCP
 * uses in src/irc-server.ts:sendMultiline. Receiver subscribes to
 * `batch end draft/multiline` and reassembles per spec (\n join,
 * suppressed when draft/multiline-concat tag is present on a line).
 * We then assert the reassembled text byte-equals the original.
 *
 * Run ergo first:
 *   cd var/ergo && ./ergo run --conf ../../etc/ergo.yaml
 *
 * Then:
 *   bun tests/probe-multiline.ts
 */
// @ts-expect-error — irc-framework lacks first-class type defs
import IRC from 'irc-framework'

const SERVER = '127.0.0.1'
const PORT = 6667
const CHAN = '#multiline-probe'

// Multi-paragraph payload spanning > one IRC line, with explicit
// blank line and a >300-byte single line that will need to be chunked
// internally with draft/multiline-concat. Round-trip must preserve
// every byte including the blank line.
const ORIGINAL_MESSAGE = [
  'First paragraph — short and tidy.',
  '',
  'Second paragraph is here to test that an empty line between paragraphs survives the round-trip exactly as written.',
  'Third paragraph contains a deliberately long single sentence that will exceed the per-PRIVMSG byte limit our chunker uses, forcing it to be split across multiple wire frames carrying the +draft/multiline-concat tag so that the receiver reassembles them onto one logical line — without inserting any newline characters between the chunks. ' +
    'We also pad it out further with extra padding text so the resulting line is comfortably above three hundred bytes to guarantee the chunker fires and exercises the concat path end to end.',
  'Final line.',
].join('\n')

const MULTILINE_LINE_BYTES = 300

const findNaturalBoundary = (text: string, start: number, end: number): number => {
  const minViable = start + Math.floor((end - start) * 2 / 3)
  for (let j = end; j > minViable; j--) {
    const c = text[j - 1]
    const next = text[j]
    if ((c === '.' || c === '!' || c === '?') && (next === ' ' || next === undefined)) return j
  }
  for (let j = end; j > minViable; j--) {
    const c = text[j]
    if (c === ' ' || c === '\t') return j
  }
  return end
}

const splitLineForMultiline = (line: string): string[] => {
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

const log = (who: string, msg: string) => console.log(`[${who}] ${msg}`)

const sender = new IRC.Client()
const receiver = new IRC.Client()

sender.requestCap(['draft/multiline'])
receiver.requestCap(['draft/multiline'])

let senderJoined = false
let receiverJoined = false
let receiverHasMultilineCap = false

const sendBatch = () => {
  log('sender', `composing draft/multiline batch (${ORIGINAL_MESSAGE.length} bytes)`)
  const id = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0')
  const logical = ORIGINAL_MESSAGE.split('\n')
  const wireLines: Array<{ body: string; concat: boolean }> = []
  for (const line of logical) {
    const chunks = splitLineForMultiline(line)
    chunks.forEach((c, i) => wireLines.push({ body: c, concat: i > 0 }))
  }
  log('sender', `BATCH +${id} draft/multiline ${CHAN} (${wireLines.length} lines)`)
  sender.raw('BATCH', `+${id}`, 'draft/multiline', CHAN)
  for (const { body, concat } of wireLines) {
    // Ergo expects `draft/multiline-concat` (no `+` prefix).
    const tagStr = concat ? `batch=${id};draft/multiline-concat` : `batch=${id}`
    sender.connection.write(`@${tagStr} PRIVMSG ${CHAN} :${body}`)
  }
  sender.raw('BATCH', `-${id}`)
  log('sender', `BATCH -${id} (sent)`)
}

const trySend = () => {
  if (senderJoined && receiverJoined && receiverHasMultilineCap) sendBatch()
}

sender.on('registered', () => {
  log('sender', `caps enabled: ${(sender.network?.cap?.enabled ?? []).join(', ')}`)
  sender.join(CHAN)
})
sender.on('join', (e: { nick: string; channel: string }) => {
  if (e.nick === 'multi-sender') {
    log('sender', `joined ${e.channel}`)
    senderJoined = true
    trySend()
  }
})

receiver.on('registered', () => {
  const enabled: string[] = receiver.network?.cap?.enabled ?? []
  log('receiver', `caps enabled: ${enabled.join(', ')}`)
  receiverHasMultilineCap = enabled.includes('draft/multiline')
  if (!receiverHasMultilineCap) {
    log('receiver', 'FAIL: draft/multiline not enabled on receiver — ergo did not ACK?')
    process.exit(2)
  }
  receiver.join(CHAN)
})
receiver.on('join', (e: { nick: string; channel: string }) => {
  if (e.nick === 'multi-receiver') {
    log('receiver', `joined ${e.channel}`)
    receiverJoined = true
    trySend()
  }
})

let strayMessages = 0
receiver.on('message', (e: any) => {
  if (e.nick === 'multi-sender' && e.batch?.type === 'draft/multiline') {
    // Expected — quietly tracked by batch end. Don't count as stray.
    return
  }
  if (e.nick === 'multi-sender') {
    strayMessages += 1
    log('receiver', `STRAY individual PRIVMSG (no batch context): ${JSON.stringify(e.message)}`)
  }
})

receiver.on(
  'batch end draft/multiline',
  (event: {
    id: string
    params: string[]
    commands: Array<{ command: string; params: string[]; nick: string; tags: Record<string, unknown> }>
  }) => {
    const cmds = event.commands.filter(c => c.command === 'PRIVMSG')
    log(
      'receiver',
      `batch end id=${event.id} target=${event.params[0]} lines=${cmds.length} from=${cmds[0]?.nick}`,
    )
    let text = ''
    cmds.forEach((c, i) => {
      const body = c.params[c.params.length - 1] ?? ''
      const concat = 'draft/multiline-concat' in c.tags
      if (i === 0) text = body
      else if (concat) text += body
      else text += '\n' + body
    })

    if (text === ORIGINAL_MESSAGE) {
      log('result', `PASS: roundtrip byte-equal (${text.length} bytes, ${cmds.length} wire lines)`)
      if (strayMessages > 0) {
        log('result', `WARN: also saw ${strayMessages} stray non-batched PRIVMSGs from sender`)
      }
      sender.quit('done')
      receiver.quit('done')
      setTimeout(() => process.exit(0), 200)
    } else {
      log('result', 'FAIL: reassembled text does not match original')
      log('expected', JSON.stringify(ORIGINAL_MESSAGE))
      log('got     ', JSON.stringify(text))
      sender.quit('done')
      receiver.quit('done')
      setTimeout(() => process.exit(1), 200)
    }
  },
)

sender.connect({ host: SERVER, port: PORT, nick: 'multi-sender', username: 'multi-sender', gecos: 'multi-sender' })
receiver.connect({ host: SERVER, port: PORT, nick: 'multi-receiver', username: 'multi-receiver', gecos: 'multi-receiver' })

setTimeout(() => {
  log('probe', 'TIMEOUT — no batch end received within 8s')
  process.exit(2)
}, 8000)
