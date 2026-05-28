#!/usr/bin/env bun

import * as fs from 'node:fs'
import * as path from 'node:path'
import { checkOwnership } from './owner-gate.js'
import { socketRoundtrip, describeNickReject, type DaemonResponse } from './permbot-socket.js'

const WORKER      = process.env['ROOST_IRC_NICK'] ?? 'unknown'
const SOCK_PATH   = process.env['ROOST_PERM_SOCK'] ?? ''
const PERM_TARGET = process.env['ROOST_PERM_TARGET'] ?? ''
const PERM_HOST   = process.env['ROOST_PERM_HOST'] ?? '127.0.0.1'
const PERM_PORT   = Number(process.env['ROOST_PERM_PORT'] ?? '6667')
const DATA_DIR    = process.env['ROOST_DATA_DIR'] ?? ''
const SESSION_ID  = process.env['CLAUDE_CODE_SESSION_ID'] ?? ''
// 570s default — just under Claude Code's 600s hook timeout. Override via
// ROOST_PERM_TIMEOUT_SECS for tests that need to exercise the timeout path
// without waiting nine minutes.
// keep in sync with src/pretooluse-prompt.ts (SOCKET_SAFETY_TIMEOUT)
const SOCKET_SAFETY_TIMEOUT = Math.min(570, Math.max(1, Number(process.env['ROOST_PERM_TIMEOUT_SECS'] ?? '570')))

// Fallback-DM deadlines. Split in two so a slow ergo registration doesn't eat
// the budget reserved for flushing PRIVMSGs through quit(). The previous single
// 10s timer meant a 9.5s register left 0.5s for say+quit+disconnect — under
// load the parent process exited before quit() drained, the operator saw no
// DM, and there was no log line to explain why. Tests override via env.
const FALLBACK_REG_TIMEOUT_MS   = Math.max(1, Number(process.env['ROOST_FALLBACK_REG_TIMEOUT_MS']   ?? '5000'))
const FALLBACK_FLUSH_TIMEOUT_MS = Math.max(1, Number(process.env['ROOST_FALLBACK_FLUSH_TIMEOUT_MS'] ?? '5000'))

const PASSTHROUGH_PREFIXES = ['mcp__roost-irc__', 'mcp__plugin_roost_roost-irc__']

// ---- Output -----------------------------------------------------------------

function emit(decision: 'ask', reason?: string): never
function emit(decision: 'allow' | 'deny', reason?: string): never
function emit(decision: string, reason = ''): never {
  if (decision === 'ask') {
    process.stderr.write(`perm-hook[${WORKER}]: deferring to terminal (${reason})\n`)
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

export function resolveTranscriptPath(transcriptPath: string, agentId: string): string {
  if (!agentId) return transcriptPath
  if (transcriptPath.includes('/subagents/')) return transcriptPath
  const sessionDir = transcriptPath.replace(/\.jsonl$/, '')
  const subPath = path.join(sessionDir, 'subagents', `agent-${agentId}.jsonl`)
  return fs.existsSync(subPath) ? subPath : transcriptPath
}

// ---- Socket round-trip to permbot daemon ------------------------------------

export async function askDaemon(summary: string): Promise<DaemonResponse> {
  const req: Record<string, unknown> = { summary, timeout: SOCKET_SAFETY_TIMEOUT, kind: 'permission' }
  if (PERM_TARGET) req['replyTarget'] = PERM_TARGET
  return socketRoundtrip(SOCK_PATH, req, (msg) => { process.stderr.write(`perm-hook[${WORKER}]: ${msg}\n`) })
}

// ---- Fallback DM via RoostIrcClient (transient connection) ------------------

function flog(msg: string): void {
  process.stderr.write(`perm-hook[${WORKER}]: fallback-dm: ${msg}\n`)
}

export async function sendFallbackDm(summary: string, reason: string): Promise<void> {
  if (!PERM_TARGET) return
  const nick = `pnotify-${WORKER}`
  flog(`starting transient connection -> ${PERM_TARGET}`)
  const { RoostIrcClientImpl } = await import('./irc-client-impl.js')
  const client = new RoostIrcClientImpl({
    nick, autoJoin: [], historySize: 0, joinHistoryLines: 0, joinHistoryMinutes: 0,
  })
  await new Promise<void>((resolve) => {
    let done = false
    const finish = (): void => { if (!done) { done = true; resolve() } }

    // Registration deadline: armed at connect, cleared once 'registered' or
    // 'cap-missing' fires. If it expires first, the IRC handshake never
    // completed (ergo unreachable, CAP negotiation hung, etc.) and we bail
    // without attempting PRIVMSGs.
    const regTimer = setTimeout(() => {
      flog(`registration timeout fired at ${FALLBACK_REG_TIMEOUT_MS}ms`)
      try { client.quit() } catch { /* socket may already be dead */ }
      finish()
    }, FALLBACK_REG_TIMEOUT_MS)

    // Flush deadline: armed only AFTER PRIVMSGs are sent + quit() called.
    // Lets us wait for the 'disconnected' event (proof quit() drained the
    // outbound buffer) without racing the registration timer.
    let flushTimer: ReturnType<typeof setTimeout> | null = null

    let sent = false
    client.on('system', (kind, content) => {
      if ((kind === 'registered' || kind === 'cap-missing') && !sent) {
        sent = true
        clearTimeout(regTimer)
        // Both states mean the connection is ready for PRIVMSGs, but
        // cap-missing carries the reason (which cap wasn't advertised) and the
        // operator usually wants that signal. Keep "registered" as the
        // canonical grep prefix; append the cap-missing reason verbatim.
        flog(kind === 'cap-missing' ? `registered (cap-missing: ${String(content)})` : 'registered successfully')
        const lines = [
          `[${WORKER}] terminal fallback: ${reason}`,
          ...summary.split('\n').filter(l => l.trim()).map(l => `  ${l.trimEnd()}`),
          `(worker blocked on terminal — use \`roost tail ${WORKER}\` to see context, \`roost send ${WORKER} y\` to unblock)`,
        ]
        for (const l of lines) client.say(PERM_TARGET, l)
        flog(`PRIVMSGs sent (count=${lines.length})`)
        client.quit()
        flushTimer = setTimeout(() => {
          flog(`flush timeout fired at ${FALLBACK_FLUSH_TIMEOUT_MS}ms — DM may not have delivered`)
          finish()
        }, FALLBACK_FLUSH_TIMEOUT_MS)
      } else if (kind === 'disconnected') {
        flog('transient client disconnected (quit complete)')
        clearTimeout(regTimer)
        if (flushTimer) clearTimeout(flushTimer)
        finish()
      } else if (kind === 'registration-failed') {
        // The DM can't deliver on an unregistered nick, but name the cause so
        // it's greppable rather than a bare "registration failed". pnotify's
        // nick is longer than the permbot's, so it hits 432 even more readily.
        const detail = typeof content === 'object' && content !== null ? content : {}
        flog(`registration rejected — ${describeNickReject(detail)}`)
        clearTimeout(regTimer)
        if (flushTimer) clearTimeout(flushTimer)
        finish()
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
    process.stderr.write(`perm-hook[${WORKER}]: bad stdin JSON: ${e}\n`)
    emit('ask', 'hook input parse error')
  }

  const toolName      = String(payload!['tool_name'] ?? '')
  const toolInput     = (payload!['tool_input'] as Record<string, unknown> | null) ?? {}
  const transcriptPath = String(payload!['transcript_path'] ?? '')
  const agentId        = String(payload!['agent_id'] ?? '')

  // Passthrough check runs BEFORE the owner gate: roost-irc tool calls are
  // safe from any session (worker, nested, owner) and we never want to ask
  // the operator to approve them. Anything else falls through to the gate.
  if (PASSTHROUGH_PREFIXES.some(p => toolName.startsWith(p))) emit('allow', 'roost-irc passthrough')

  // Owner-gate short-circuit: nested claudes inherit the parent's
  // ROOST_DATA_DIR via tmux env, so the unix socket path resolves to the
  // owner's permbot. Routing a nested-claude's prompt there would DM the
  // operator about a tool call they didn't initiate. Defer to the local
  // terminal prompt before touching the socket at all.
  if (DATA_DIR && SESSION_ID) {
    const ownership = checkOwnership(DATA_DIR, SESSION_ID)
    if (ownership === 'passive') emit('ask', 'nested claude (non-owner session) — local prompt')
  }

  const intent = extractIntent(resolveTranscriptPath(transcriptPath, agentId))
  const summaryLines = summarize(toolName, toolInput)
  if (intent) {
    summaryLines.push(`last narration: ${intent}`)
    summaryLines.push(`(also check the agent's recent IRC messages)`)
  }
  const summary = summaryLines.join('\n')

  const res = await askDaemon(summary)
  if (res.kind === 'unreachable') {
    // Fail closed: the permbot is up but its IRC link never registered, so no
    // operator can answer. Deny with the cause instead of hanging at a terminal
    // prompt nobody is watching. Skip the fallback DM — pnotify's nick would hit
    // the same registration failure.
    process.stderr.write(`perm-hook[${WORKER}]: ${res.cause}\n`)
    emit('deny', res.cause)
  }
  if (res.kind !== 'reply') {
    await sendFallbackDm(summary, 'permbot unavailable / timed out')
    emit('ask', 'permbot unavailable / timed out; falling back to terminal')
  }

  const parts = res.reply.trim().split(/\s+/, 2)
  const norm = (parts[0] ?? '').toLowerCase()
  const msg  = parts[1] ?? ''
  if (['y', 'yes', 'allow', 'ok', 'approve'].includes(norm)) emit('allow', msg || 'operator approved via IRC')
  if (['n', 'no', 'deny', 'block'].includes(norm)) emit('deny', msg || 'operator denied via IRC')
  await sendFallbackDm(summary, `unrecognized reply ${JSON.stringify(res.reply)}`)
  emit('ask', `unrecognized reply ${JSON.stringify(res.reply)}; falling back to terminal`)
}
