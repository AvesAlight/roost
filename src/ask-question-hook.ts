#!/usr/bin/env bun

import { checkOwnership } from './owner-gate.js'
import { socketRoundtrip, CHAT_KEYWORDS, permbotNickFor, type DaemonResponse } from './permbot-socket.js'

const HOOK_EVENT   = 'PreToolUse'
const WORKER       = process.env['ROOST_IRC_NICK'] ?? 'unknown'
const SOCK_PATH    = process.env['ROOST_PERM_SOCK'] ?? ''
const ASK_CHANNEL  = process.env['ROOST_ASK_CHANNEL'] ?? ''
const ASK_TARGET   = process.env['ROOST_ASK_TARGET'] ?? ''
const DATA_DIR     = process.env['ROOST_DATA_DIR'] ?? ''
const SESSION_ID   = process.env['CLAUDE_CODE_SESSION_ID'] ?? ''
const TIMEOUT_SECS = Math.max(10, Number(process.env['ROOST_ASK_TIMEOUT_SECS'] ?? '300'))
const SOCKET_TIMEOUT = Math.min(TIMEOUT_SECS, 570) // stay under Claude Code's 600s hook default

// ---- Types ------------------------------------------------------------------

interface Option { label: string; description?: string }
interface Question {
  question: string
  header?: string
  options?: Option[]
  multiSelect?: boolean
}

// ---- Output helpers ---------------------------------------------------------

function passthrough(): never {
  process.exit(0)
}

function allow(questions: Question[], answers: Record<string, string>): never {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: HOOK_EVENT,
      permissionDecision: 'allow',
      updatedInput: { questions, answers },
    },
  }) + '\n')
  process.exit(0)
}

function deny(reason: string): never {
  process.stderr.write(`ask-question-hook[${WORKER}]: ${reason}\n`)
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: HOOK_EVENT,
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }) + '\n')
  process.exit(0)
}

// ---- Question formatting ----------------------------------------------------

/** permbotNick: when provided (channel mode), hint includes DM escape instruction.
 *  Omit for DM-mode routing where all replies are accepted as-is. */
export function formatQuestionsForIRC(questions: Question[], permbotNick?: string): string {
  const lines: string[] = []
  const isMultiQ = questions.length > 1
  questions.forEach((q, i) => {
    const prefix = isMultiQ ? `Q${i + 1}: ` : ''
    lines.push(`${prefix}${q.question}`)
    for (const [j, o] of (q.options ?? []).entries()) {
      const desc = o.description ? ` — ${o.description}` : ''
      lines.push(`  ${j + 1}. ${o.label}${desc}`)
    }
    if (q.multiSelect) {
      // In multi-question context commas separate questions, so inner choices use "/"
      lines.push(isMultiQ
        ? '  (multi-select: use / to separate choices, e.g. 1/3)'
        : '  (multi-select: comma-separate multiple choices)')
    }
  })
  const dmNote = permbotNick ? ` | DM @${permbotNick} for free text` : ''
  if (isMultiQ) {
    lines.push(`Reply: number per question, comma-separated (e.g. 1, 2)${dmNote} | 'chat' to skip`)
  } else {
    lines.push(permbotNick
      ? `Reply: number | DM @${permbotNick} for free text | 'chat' to skip`
      : "Reply: number, your own answer, or 'chat' to skip")
  }
  return lines.join('\n')
}

// ---- Reply parsing ----------------------------------------------------------

export function mapOneReply(raw: string, q: Question): string {
  const opts = q.options ?? []
  if (opts.length === 0) return raw.trim()
  const stripped = raw.trim()
  const num = parseInt(stripped, 10)
  if (!isNaN(num) && num >= 1 && num <= opts.length) return opts[num - 1].label
  const found = opts.find(o => o.label.toLowerCase() === stripped.toLowerCase())
  return found ? found.label : stripped
}

export function mapReplyToAnswers(reply: string, questions: Question[]): Record<string, string> {
  const answers: Record<string, string> = {}
  if (questions.length === 1) {
    const q = questions[0]
    if (q.multiSelect) {
      const parts = reply.split(',').map(p => mapOneReply(p.trim(), q))
      answers[q.question] = parts.join(',')
    } else {
      answers[q.question] = mapOneReply(reply, q)
    }
    return answers
  }
  // Multiple questions: split on comma, one answer per question
  const parts = reply.split(',')
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]
    const raw = (parts[i] ?? '').trim()
    // Strip leading "QN:" or "N." prefix that operators might add
    const body = raw.replace(/^(Q?\d+[.:\s]+)/, '').trim() || raw
    if (q.multiSelect) {
      // Multi-select within multi-question: "/" separates inner choices
      const inner = body.split('/').map(p => mapOneReply(p.trim(), q))
      answers[q.question] = inner.join(',')
    } else {
      answers[q.question] = mapOneReply(body, q)
    }
  }
  return answers
}

// ---- Socket round-trip to permbot -------------------------------------------

export async function askPermbot(summary: string): Promise<DaemonResponse> {
  const req: Record<string, unknown> = { summary, timeout: SOCKET_TIMEOUT, kind: 'question' }
  if (ASK_CHANNEL) req['channel'] = ASK_CHANNEL  // omit → DM mode
  if (ASK_TARGET) req['replyTarget'] = ASK_TARGET
  return socketRoundtrip(SOCK_PATH, req, (msg) => {
    process.stderr.write(`ask-question-hook[${WORKER}]: ${msg}\n`)
  })
}

// ---- Entrypoint -------------------------------------------------------------

if (import.meta.main) {
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(await Bun.stdin.text()) as Record<string, unknown>
  } catch (e) {
    process.stderr.write(`ask-question-hook[${WORKER}]: bad stdin JSON: ${e}\n`)
    passthrough()
  }

  const toolName = String(payload!['tool_name'] ?? '')
  if (toolName !== 'AskUserQuestion') passthrough()

  // Owner gate: nested claudes inherit ROOST_DATA_DIR and would route through
  // the owner's permbot. Fall through to UI for non-owner sessions.
  if (DATA_DIR && SESSION_ID) {
    const ownership = checkOwnership(DATA_DIR, SESSION_ID)
    if (ownership === 'passive') passthrough()
  }

  const toolInput = (payload!['tool_input'] as Record<string, unknown> | null) ?? {}
  const questions = (toolInput['questions'] as Question[] | undefined) ?? []
  if (questions.length === 0) passthrough()

  if (!SOCK_PATH || (!ASK_CHANNEL && !ASK_TARGET)) {
    process.stderr.write(`ask-question-hook[${WORKER}]: not configured (missing ROOST_PERM_SOCK or ask target/channel), falling through to UI\n`)
    passthrough()
  }

  // In channel mode include the permbot nick so the hint tells operators how to DM.
  const permbotNick = ASK_CHANNEL ? permbotNickFor(WORKER) : undefined
  const summary = formatQuestionsForIRC(questions, permbotNick)
  const res = await askPermbot(summary)

  if (res.kind === 'unreachable') {
    deny(`${res.cause}. Decide without user input or retry after the operator fixes it.`)
  }
  if (res.kind !== 'reply') {
    deny(`No IRC reply within ${SOCKET_TIMEOUT}s — permbot unavailable or timed out. Decide without user input or retry.`)
  }

  if (CHAT_KEYWORDS.has(res.reply.trim().toLowerCase())) {
    deny('operator requested to chat — decide without user input or re-ask via a follow-up message')
  }

  const answers = mapReplyToAnswers(res.reply, questions)
  allow(questions, answers)
}
