#!/usr/bin/env bun

// PreToolUse hook with a Bash matcher. Closes the bypass where Claude Code's
// structural safety analyzer skips PermissionRequest (issue #276) and shows
// a terminal-only prompt that workers spawned with --perm-irc never see.
// PreToolUse fires *before* the analyzer, so a routing decision here takes
// precedence over the analyzer's TUI path.
//
// Scope is narrow: only Bash commands whose shape matches the bashMissKind
// patterns extracted from the Claude Code 2.1.139 binary get routed to IRC;
// everything else falls through to the existing allowlist → PermissionRequest
// pipeline. Allowlist semantics for routine Bash calls are preserved.
//
// Reuses the permbot socket and DM fallback from permission-prompt.ts so the
// queue, nudge logic, and operator UX stay in one place.

import { checkOwnership } from './owner-gate.js'
import { socketRoundtrip } from './permbot-socket.js'
import {
  summarize,
  extractIntent,
  resolveTranscriptPath,
  sendFallbackDm,
} from './permission-prompt.js'

const HOOK_EVENT  = 'PreToolUse'
const WORKER      = process.env['ROOST_IRC_NICK'] ?? 'unknown'
const SOCK_PATH   = process.env['ROOST_PERM_SOCK'] ?? ''
const PERM_TARGET = process.env['ROOST_PERM_TARGET'] ?? ''
const DATA_DIR    = process.env['ROOST_DATA_DIR'] ?? ''
const SESSION_ID  = process.env['CLAUDE_CODE_SESSION_ID'] ?? ''
// 570s default — just under Claude Code's 600s hook timeout. Override via
// ROOST_PERM_TIMEOUT_SECS for tests that need to exercise the timeout path
// without waiting nine minutes.
const SOCKET_SAFETY_TIMEOUT = Math.min(570, Math.max(1, Number(process.env['ROOST_PERM_TIMEOUT_SECS'] ?? '570')))

// bashMissKind labels lifted from the 2.1.139 binary (issue #276). These are
// roost's *approximations* of the harness's classification — not literal
// `decisionReason` strings. We collapse several harness kinds (e.g.
// cd-git-compound / cd-compound-write / cd-compound-redirect → `cd-compound`)
// and rename others (`semantics` → `newline-hash` for legibility in operator
// summaries). Don't grep the Claude Code binary for these — they won't be
// there. Tests pin one example per kind from the issue table so any
// classifier drift surfaces as a test failure.
export type BashMissKind =
  | 'newline-hash'
  | 'process-substitution'
  | 'multi-cd'
  | 'cd-compound'
  | 'cd-multi-positional'
  | 'sed-dangerous'
  | 'shell-operators'
  | 'flag-validation'
  | 'too-complex'

/**
 * Returns the bashMissKind a command resembles, or null if it should pass
 * through to the normal permission pipeline. Heuristic — errs toward
 * over-matching where the AST is ambiguous (a false positive sends a benign
 * command to IRC; a false negative leaves the worker hanging on a TUI prompt).
 */
export function classifyBash(command: string): BashMissKind | null {
  if (!command) return null

  // newline-hash: literal newline followed by optional whitespace then '#'.
  // The original bug (worker-202 27-min hang) was a heredoc with this shape.
  // Checked against the raw command — the analyzer's trigger explicitly
  // requires the newline to be inside a quoted arg, env value, or redirect.
  if (/\n[ \t]*#/.test(command)) return 'newline-hash'

  // Command-start anchor for cd patterns: start-of-string, shell operator
  // (with optional trailing whitespace), or newline. Excludes plain
  // whitespace as a leading context to avoid false-positives on commit
  // messages and other strings containing the word "cd" (`git commit -m
  // "fix: cd issue"` would otherwise trip cd-multi-positional). Wrapper
  // forms like `time cd /tmp && ls` are missed by this anchor — those are
  // uncommon enough to accept the gap; commit messages are daily traffic.
  const CD_START = '(?:^|[;&|`(]\\s*|\\n\\s*)'

  // process-substitution: <(...) or >(...).
  if (/[<>]\(/.test(command)) return 'process-substitution'

  // multi-cd: more than one cd/pushd/popd at command-start positions.
  const cdMatches = command.match(new RegExp(`${CD_START}(?:cd|pushd|popd)(?=\\s|$)`, 'g')) ?? []
  if (cdMatches.length > 1) return 'multi-cd'

  // cd-multi-positional: zsh `cd OLD NEW`. Two non-flag non-operator words
  // after cd, terminated by end-of-string or a shell operator.
  if (new RegExp(`${CD_START}cd\\s+(?!-)[^\\s&|;<>(){}]+\\s+(?!-)[^\\s&|;<>(){}]+(?=\\s|$|[&|;<>])`).test(command)) {
    return 'cd-multi-positional'
  }

  // cd-compound: cd/pushd/popd followed by &&, ||, or ; — covers
  // cd-git-compound, cd-compound-write, cd-compound-redirect from the table.
  if (new RegExp(`${CD_START}(?:cd|pushd|popd)\\s+\\S+.*?(?:&&|\\|\\||;)`).test(command)) return 'cd-compound'

  // sed-dangerous: sed with -i (in-place) or w/e/W/E command letters.
  if (/\bsed\b(?:[^|&;<>]*?-[a-zA-Z]*i\b|[^|&;<>]*?['"]\s*[weWE])/.test(command)) {
    return 'sed-dangerous'
  }

  // shell-operators: top-level subshell ( ... ) or command group { ... }.
  // Excludes $( ), <( ), >( ), ${ }, and escaped \(.
  if (/(?:^|[\s;&|`])\((?!\s*\))/.test(command)) return 'shell-operators'
  if (/(?:^|[\s;&|`])\{\s/.test(command)) return 'shell-operators'

  // flag-validation: wrapper commands (env/timeout/xargs/nice/nohup) with
  // chdir-shaped flags that can change cwd outside the harness's view.
  if (/\b(?:env|timeout|xargs|nice|nohup)\b[^|;&\n]*--(?:chdir|directory|working-dir|workdir|cwd)=/.test(command)) {
    return 'flag-validation'
  }

  // too-complex: arithmetic expansion with non-literal contents.
  if (/\$\(\([^)]*[a-zA-Z_][^)]*\)\)/.test(command)) return 'too-complex'

  return null
}

// ---- Output -----------------------------------------------------------------

function passthrough(): never { process.exit(0) }

function emit(decision: 'allow' | 'deny' | 'ask', reason = ''): never {
  const out: Record<string, unknown> = {
    hookEventName: HOOK_EVENT,
    permissionDecision: decision,
  }
  if (reason) out['permissionDecisionReason'] = reason
  process.stdout.write(JSON.stringify({ hookSpecificOutput: out }) + '\n')
  process.exit(0)
}

// ---- Socket round-trip ------------------------------------------------------

async function askDaemon(summary: string): Promise<string | null> {
  const req: Record<string, unknown> = { summary, timeout: SOCKET_SAFETY_TIMEOUT, kind: 'permission' }
  if (PERM_TARGET) req['replyTarget'] = PERM_TARGET
  return socketRoundtrip(SOCK_PATH, req, (msg) => {
    process.stderr.write(`pretooluse-hook[${WORKER}]: ${msg}\n`)
  })
}

// ---- Entrypoint -------------------------------------------------------------

if (import.meta.main) {
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(await Bun.stdin.text()) as Record<string, unknown>
  } catch (e) {
    process.stderr.write(`pretooluse-hook[${WORKER}]: bad stdin JSON: ${e}\n`)
    passthrough()
  }

  const toolName = String(payload!['tool_name'] ?? '')
  if (toolName !== 'Bash') passthrough()

  const toolInput = (payload!['tool_input'] as Record<string, unknown> | null) ?? {}
  const command = String(toolInput['command'] ?? '')
  const kind = classifyBash(command)
  if (kind === null) passthrough()

  // Owner-gate short-circuit (#188): nested claudes inherit ROOST_DATA_DIR
  // via tmux env and would otherwise route the parent's prompt to the
  // owner's permbot. Fall through to the local TUI for non-owner sessions.
  if (DATA_DIR && SESSION_ID) {
    const ownership = checkOwnership(DATA_DIR, SESSION_ID)
    if (ownership === 'passive') passthrough()
  }

  if (!SOCK_PATH || !PERM_TARGET) {
    process.stderr.write(`pretooluse-hook[${WORKER}]: not configured (missing ROOST_PERM_SOCK or ROOST_PERM_TARGET), falling through\n`)
    passthrough()
  }

  const transcriptPath = String(payload!['transcript_path'] ?? '')
  const agentId        = String(payload!['agent_id'] ?? '')
  const intent = extractIntent(resolveTranscriptPath(transcriptPath, agentId))
  const summaryLines = summarize(toolName, toolInput)
  summaryLines.unshift(`safety-check trigger: ${kind}`)
  if (intent) {
    summaryLines.push(`last narration: ${intent}`)
    summaryLines.push(`(also check the agent's recent IRC messages)`)
  }
  const summary = summaryLines.join('\n')

  const reply = await askDaemon(summary)
  if (reply === null) {
    await sendFallbackDm(summary, 'permbot unavailable / timed out (PreToolUse Bash)')
    emit('ask', 'permbot unavailable / timed out; falling back to terminal')
  }

  const parts = reply!.trim().split(/\s+/, 2)
  const norm = (parts[0] ?? '').toLowerCase()
  const msg  = parts[1] ?? ''
  if (['y', 'yes', 'allow', 'ok', 'approve'].includes(norm)) emit('allow', msg || 'operator approved via IRC')
  if (['n', 'no', 'deny', 'block'].includes(norm)) emit('deny', msg || 'operator denied via IRC')
  await sendFallbackDm(summary, `unrecognized reply ${JSON.stringify(reply)}`)
  emit('ask', `unrecognized reply ${JSON.stringify(reply)}; falling back to terminal`)
}
