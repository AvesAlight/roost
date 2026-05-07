#!/usr/bin/env bun

import * as fs from 'node:fs'
import * as net from 'node:net'

const WORKER      = process.env['ROOST_IRC_NICK'] ?? 'unknown'
const SOCK_PATH   = process.env['ROOST_PERM_SOCK'] ?? ''
const PERM_TARGET = process.env['ROOST_PERM_TARGET'] ?? ''
const PERM_HOST   = process.env['ROOST_PERM_HOST'] ?? '127.0.0.1'
const PERM_PORT   = Number(process.env['ROOST_PERM_PORT'] ?? '6667')
const SOCKET_SAFETY_TIMEOUT = 570 // just under Claude Code's 600s hook default

const PASSTHROUGH_PREFIXES = ['mcp__roost-irc__', 'mcp__plugin_roost_roost-irc__']

// ---- Output -----------------------------------------------------------------

function emit(decision: 'ask', reason?: string): never
function emit(decision: 'allow' | 'deny', reason?: string): never
function emit(decision: string, reason = ''): never {
  if (decision === 'ask') {
    process.stderr.write(`perm-hook: deferring to terminal (${reason})\n`)
    process.exit(0)
  }
  const dec: { behavior: string; message?: string } = { behavior: decision }
  if (reason) dec.message = reason
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: dec },
  }) + '\n')
  process.exit(0)
}

// ---- Pure helpers -----------------------------------------------------------

function clip(s: string, n: number): string {
  s = (s || '').replace(/\r/g, ' ').replace(/\n/g, ' ').trim()
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

export function summarize(toolName: string, toolInput: Record<string, unknown>): string[] {
  const lines: string[] = []
  if (toolName === 'Read') {
    const p = toolInput['file_path'] ?? '?'
    const offset = toolInput['offset'] as number | undefined
    const limit = toolInput['limit'] as number | undefined
    let rng = ''
    if (offset || limit) {
      const start = offset ?? 1
      const end = limit ? (offset ?? 1) + limit - 1 : 'end'
      rng = ` (lines ${start}–${end})`
    }
    lines.push(`Read ${p}${rng}`)
  } else if (toolName === 'Write') {
    const p = toolInput['file_path'] ?? '?'
    const content = String(toolInput['content'] ?? '')
    lines.push(`Write ${p} (${content.length} bytes)`)
    if (content) lines.push(`  preview: ${clip(content, 200)}`)
  } else if (toolName === 'Edit') {
    const p = toolInput['file_path'] ?? '?'
    const old = String(toolInput['old_string'] ?? '')
    const nw = String(toolInput['new_string'] ?? '')
    lines.push(`Edit ${p}${toolInput['replace_all'] ? ' (replace_all)' : ''}`)
    lines.push(`  old: ${clip(old, 160)}`)
    lines.push(`  new: ${clip(nw, 160)}`)
  } else if (toolName === 'NotebookEdit') {
    const p = toolInput['notebook_path'] ?? '?'
    const cell = toolInput['cell_id'] ?? '?'
    lines.push(`NotebookEdit ${p} cell=${cell}`)
    const nw = String(toolInput['new_source'] ?? '')
    if (nw) lines.push(`  new: ${clip(nw, 160)}`)
  } else if (toolName === 'Bash') {
    const desc = String(toolInput['description'] ?? '').trim()
    const cmd = String(toolInput['command'] ?? '')
    lines.push(desc ? `Bash (${desc})` : 'Bash')
    lines.push(`  $ ${clip(cmd, 280)}`)
  } else if (toolName === 'Grep') {
    const pat = toolInput['pattern'] ?? '?'
    const p = toolInput['path'] as string | undefined
    const glob = toolInput['glob'] as string | undefined
    const bits = [`pattern=${JSON.stringify(pat)}`]
    if (p) bits.push(`path=${p}`)
    if (glob) bits.push(`glob=${glob}`)
    lines.push(`Grep ${bits.join(' ')}`)
  } else if (toolName === 'Glob') {
    const pat = toolInput['pattern'] ?? '?'
    const p = toolInput['path'] as string | undefined
    lines.push(`Glob ${pat}${p ? ` in ${p}` : ''}`)
  } else if (toolName === 'WebFetch') {
    const url = toolInput['url'] ?? '?'
    const prompt = toolInput['prompt'] as string | undefined
    lines.push(`WebFetch ${url}`)
    if (prompt) lines.push(`  prompt: ${clip(prompt, 200)}`)
  } else {
    const blob = JSON.stringify(toolInput)
    lines.push(`${toolName} ${clip(blob, 240)}`)
  }
  return lines
}

export function extractIntent(transcriptPath: string): string {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return ''
  let text: string
  try {
    const size = fs.statSync(transcriptPath).size
    const readSize = Math.min(size, 200_000)
    const buf = Buffer.alloc(readSize)
    const fd = fs.openSync(transcriptPath, 'r')
    fs.readSync(fd, buf, 0, readSize, Math.max(0, size - readSize))
    fs.closeSync(fd)
    text = buf.toString('utf8')
  } catch {
    return ''
  }
  const rawLines = text.split('\n')
  // first line after a mid-file seek is likely truncated; drop it
  const lines = text.length < 200_000 ? rawLines : rawLines.slice(1)
  let fallbackThinking = ''
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    let turn: unknown
    try { turn = JSON.parse(line) } catch { continue }
    if (typeof turn !== 'object' || turn === null) continue
    const t = turn as Record<string, unknown>
    if (t['type'] !== 'assistant') continue
    const content = (t['message'] as Record<string, unknown> | undefined)?.['content']
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue
      const b = block as Record<string, unknown>
      if (b['type'] === 'text') {
        const txt = String(b['text'] ?? '').trim()
        if (txt) return clip(txt, 400)
      } else if (b['type'] === 'thinking' && !fallbackThinking) {
        const think = String(b['thinking'] ?? '').trim()
        if (think) fallbackThinking = clip(think, 400)
      }
    }
  }
  return fallbackThinking
}

// ---- Socket round-trip to permbot daemon ------------------------------------

export async function askDaemon(summary: string): Promise<string | null> {
  if (!SOCK_PATH || !fs.existsSync(SOCK_PATH)) {
    process.stderr.write('perm-hook: ROOST_PERM_SOCK not set or socket missing\n')
    return null
  }
  return new Promise((resolve) => {
    const sock = net.createConnection(SOCK_PATH)
    sock.setTimeout(SOCKET_SAFETY_TIMEOUT * 1000)
    let buf = ''
    sock.on('connect', () => {
      sock.write(JSON.stringify({ summary, timeout: SOCKET_SAFETY_TIMEOUT }) + '\n')
    })
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      if (!buf.includes('\n')) return
      const line = buf.split('\n')[0]
      sock.destroy()
      try {
        const resp = JSON.parse(line) as Record<string, unknown>
        if (resp['timeout']) { resolve(null); return }
        if (resp['error']) {
          process.stderr.write(`perm-hook: daemon error: ${resp['error']}\n`)
          resolve(null); return
        }
        resolve(String(resp['reply'] ?? ''))
      } catch (e) {
        process.stderr.write(`perm-hook: bad daemon response: ${e}\n`)
        resolve(null)
      }
    })
    sock.on('timeout', () => {
      process.stderr.write('perm-hook: daemon response truncated\n')
      sock.destroy(); resolve(null)
    })
    sock.on('error', (e) => {
      process.stderr.write(`perm-hook: connect ${SOCK_PATH} failed: ${e}\n`)
      resolve(null)
    })
  })
}

// ---- Fallback DM via RoostIrcClient (transient connection) ------------------

export async function sendFallbackDm(summary: string, reason: string): Promise<void> {
  if (!PERM_TARGET) return
  const nick = `pnotify-${WORKER}`
  const { RoostIrcClientImpl } = await import('./irc-client-impl.js')
  const client = new RoostIrcClientImpl({
    nick, autoJoin: [], historySize: 0, joinHistoryLines: 0, joinHistoryMinutes: 0,
  })
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 10_000)
    let sent = false
    client.on('system', (kind) => {
      // 'registered' fires when multiline cap is available (real ergo);
      // 'cap-missing' fires otherwise — both mean the connection is ready.
      if ((kind === 'registered' || kind === 'cap-missing') && !sent) {
        sent = true
        client.say(PERM_TARGET, `[${WORKER}] terminal fallback: ${reason}`)
        for (const ln of summary.split('\n')) {
          if (ln.trim()) client.say(PERM_TARGET, `  ${ln.trimEnd()}`)
        }
        client.say(PERM_TARGET, '(worker blocked on terminal — no one watching)')
        // quit() flushes buffered writes before the connection drops;
        // wait for 'disconnected' so PRIVMSGs are actually delivered.
        client.quit()
      } else if (kind === 'disconnected' || kind === 'registration-failed') {
        clearTimeout(timer)
        resolve()
      }
    })
    client.connect({ host: PERM_HOST, port: PERM_PORT, nick, username: nick, gecos: 'perm-notify' })
  })
}

// ---- Entrypoint -------------------------------------------------------------

if (import.meta.main) {
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(await Bun.stdin.text()) as Record<string, unknown>
  } catch (e) {
    process.stderr.write(`perm-hook: bad stdin JSON: ${e}\n`)
    emit('ask', 'hook input parse error')
  }

  const toolName      = String(payload!['tool_name'] ?? '')
  const toolInput     = (payload!['tool_input'] as Record<string, unknown> | null) ?? {}
  const transcriptPath = String(payload!['transcript_path'] ?? '')

  if (PASSTHROUGH_PREFIXES.some(p => toolName.startsWith(p))) emit('allow', 'roost-irc passthrough')

  const intent = extractIntent(transcriptPath)
  const summaryLines = summarize(toolName, toolInput)
  if (intent) summaryLines.push(`intent: ${intent}`)
  const summary = summaryLines.join('\n')

  const reply = await askDaemon(summary)
  if (reply === null) {
    await sendFallbackDm(summary, 'permbot unavailable / timed out')
    emit('ask', 'permbot unavailable / timed out; falling back to terminal')
  }

  const parts = reply!.trim().split(/\s+/, 2)
  const norm = (parts[0] ?? '').toLowerCase()
  const msg  = parts[1] ?? ''
  if (['y', 'yes', 'allow', 'ok', 'approve'].includes(norm)) emit('allow', msg)
  if (['n', 'no', 'deny', 'block'].includes(norm)) emit('deny', msg)
  await sendFallbackDm(summary, `unrecognized reply ${JSON.stringify(reply)}`)
  emit('ask', `unrecognized reply ${JSON.stringify(reply)}; falling back to terminal`)
}
