#!/usr/bin/env bun

// PreToolUse hook with a Bash matcher. Closes the bypass where Claude Code's
// structural safety analyzer skips PermissionRequest and shows
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
import { socketRoundtrip, type DaemonResponse } from './permbot-socket.js'
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
// keep in sync with src/permission-prompt.ts (SOCKET_SAFETY_TIMEOUT)
const SOCKET_SAFETY_TIMEOUT = Math.min(570, Math.max(1, Number(process.env['ROOST_PERM_TIMEOUT_SECS'] ?? '570')))

// bashMissKind labels approximate the harness's Bash safety classifier — not literal
// `decisionReason` strings. We collapse several harness kinds (e.g.
// cd-git-compound / cd-compound-write / cd-compound-redirect → `cd-compound`)
// and rename others (`semantics` → `newline-hash` for legibility in operator
// summaries). The literal Claude Code strings are listed in the trailing
// comment on each variant so a grep for the CC binary's `bashMissKind` value
// (e.g. `cd-git-compound`) lands here. Tests pin one example per kind from
// the issue table so any classifier drift surfaces as a test failure.
export type BashMissKind =
  | 'newline-hash'          // CC: "semantics"
  | 'process-substitution'  // CC: "process-substitution"
  | 'multi-cd'              // CC: "multi-cd"
  | 'cd-compound'           // CC: "cd-git-compound" | "cd-compound-write" | "cd-compound-redirect"
  | 'cd-multi-positional'   // CC: "cd-multi-positional"
  | 'sed-dangerous'         // CC: "sed-dangerous"
  | 'shell-operators'       // CC: "shell-operators"
  | 'flag-validation'       // CC: "flag-validation"
  | 'too-complex'           // CC: "too-complex"

// Shared with the bashMissKind detectors in classifyBash. isSimpleReadOnly
// must reject exactly the shapes those detectors flag, or the fast-path could
// drift into a false-positive accept — the one drift direction that loosens
// the gate. Referencing the same const in both places keeps the two in
// lockstep so a future tightening can't touch one without the other. (No `g`
// flag → safe to share a single .test() target.)
const NEWLINE_HASH    = /\n[ \t]*#/                     // CC: "semantics"
const TOP_SUBSHELL    = /(?:^|[\s;&|`])\((?!\s*\))/     // CC: "shell-operators" (subshell)
const TOP_CMD_GROUP   = /(?:^|[\s;&|`])\{\s/            // CC: "shell-operators" (command group)
const ARITH_WITH_VARS = /\$\(\([^)]*[a-zA-Z_][^)]*\)\)/ // CC: "too-complex"

// Command words the read-only fast-path treats as candidates. Membership rule:
// a command is listed only if it has *no mutating form under any flag or
// argument* — because the fast-path bites in default/acceptEdits mode (auto
// never blocks bash), where CC's own analyzer gates a mutating command with an
// input-wait TUI prompt that a --perm-irc worker can't answer. A name-level
// list can't gate on flags, so any command with a write form (`find -delete`,
// `sort -o`, `date -s`, `hostname NAME`) is left out entirely rather than
// half-covered — otherwise the fast-path would drop the relay CC-default needs,
// and the worker would hang on the prompt. Empirically confirmed against a live
// 2.1.217 default-mode TUI: read-only shapes here grant silently; the excluded
// mutating forms raise "…executes commands or modifies files… Do you want to
// proceed?" and wait. `git` is gated further to read-only subcommands below.
const READ_ONLY = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg',
  'echo', 'printf', 'pwd', 'cd', 'pushd', 'popd', 'which', 'type',
  'file', 'stat', 'tree', 'basename', 'dirname', 'realpath', 'readlink',
  'whoami', 'id', 'groups', 'uname', 'tty', 'locale',
  'true', 'false', 'test', 'uniq', 'cut', 'tr', 'comm', 'cmp',
  'diff', 'column', 'tac', 'nl', 'od', 'xxd', 'seq', 'du', 'df', 'ps',
  'printenv', 'sha1sum', 'sha256sum', 'sha512sum', 'md5sum', 'git',
])

// git subcommands with no mutating form. `git` sits in READ_ONLY only as a
// gate — the subcommand must land here or the fast-path declines. Subcommands
// with a write form are left out (branch/tag/remote/config, and reflog which
// has `expire --expire=now`, symbolic-ref which writes HEAD with an argument).
const GIT_READONLY = new Set([
  'status', 'log', 'diff', 'show', 'blame', 'ls-files',
  'rev-parse', 'rev-list', 'describe', 'cat-file', 'for-each-ref',
  'shortlog', 'grep', 'whatchanged', 'ls-tree', 'ls-remote', 'show-ref',
  'var', 'help', 'version',
])

/**
 * True if the command matches Claude Code's read-only fast-path — every
 * statement a read-only command (see READ_ONLY / GIT_READONLY), with no
 * subshell, background `&`, redirection, process substitution, variable
 * arithmetic, second cd, multi-positional cd, or cd-into-git. A true is safe to
 * return null on because the accept set is a strict subset of what CC-default
 * grants (allowlist restricted to commands with no mutating form; the
 * structural gates below reject every shape CC-default would prompt on), so a
 * dropped relay can never leave a worker hanging on a prompt CC would raise. A
 * false means "can't prove the fast-path shape", and the command falls through
 * to the bashMissKind checks unchanged.
 */
function isSimpleReadOnly(command: string): boolean {
  // Structural disqualifiers. Any of these means CC's fast-path declines, so
  // classifyBash must not treat the command as simply read-only. The four
  // named regexes are the exact detectors below (see the const definitions);
  // redirection and background are additional shapes CC's fast-path rejects.
  if (NEWLINE_HASH.test(command)) return false
  if (/[<>]/.test(command)) return false             // redirect / process-sub
  if (TOP_SUBSHELL.test(command)) return false
  if (TOP_CMD_GROUP.test(command)) return false
  if (/(?<!&)&(?!&)/.test(command)) return false     // background &
  if (ARITH_WITH_VARS.test(command)) return false
  // Command substitution runs an inner command the allowlist never sees
  // (`echo $(rm -rf x)`, `` echo `rm -rf x` ``). The word-level check would
  // pass on the outer `echo` and miss it, so decline outright — `$((` arith is
  // caught above, everything else with `$(` or a backtick can't be vetted.
  if (/\$\(/.test(command) || command.includes('`')) return false

  const statements = command.split(/&&|\|\||[;|\n\r]/)
  let cdCount = 0
  let hasGit = false
  for (const raw of statements) {
    const seg = raw.trim()
    if (!seg) continue
    const tokens = seg.split(/[ \t]+/)
    const cmd = tokens[0] ?? ''
    if (cmd.includes('=')) return false // leading env assignment — decline
    if (cmd === 'git') {
      hasGit = true
      if (!GIT_READONLY.has(tokens[1] ?? '')) return false
      continue
    }
    if (!READ_ONLY.has(cmd)) return false
    if (cmd === 'cd' || cmd === 'pushd' || cmd === 'popd') {
      cdCount++
      // Reject zsh `cd OLD NEW`: more than one non-flag argument.
      const positionals = tokens.slice(1).filter((t) => t && !t.startsWith('-'))
      if (positionals.length > 1) return false
    }
  }
  if (cdCount > 1) return false            // multi-cd
  if (cdCount >= 1 && hasGit) return false // cd + git (cd-git-compound: bare-repo attack)
  return true
}

/**
 * Returns the bashMissKind a command resembles, or null if it should pass
 * through to the normal permission pipeline. Heuristic — errs toward
 * over-matching where the AST is ambiguous (a false positive sends a benign
 * command to IRC; a false negative leaves the worker hanging on a TUI prompt).
 */
export function classifyBash(command: string): BashMissKind | null {
  if (!command) return null

  // Read-only fast-path. CC auto-grants a simply-read-only command, so relaying
  // it would diverge from parity. Runs first and is monotonic: it only ever
  // returns null (drops a relay), never a bashMissKind (adds one).
  if (isSimpleReadOnly(command)) return null

  // CC bashMissKind: "semantics" (newline-hash).
  // Literal newline followed by optional whitespace then '#'. The original
  // bug (worker-202 27-min hang) was a heredoc with this shape. Checked
  // against the raw command — the analyzer's trigger explicitly requires
  // the newline to be inside a quoted arg, env value, or redirect.
  if (NEWLINE_HASH.test(command)) return 'newline-hash'

  // Command-start anchor for cd patterns: start-of-string, shell operator
  // (with optional trailing whitespace), or newline. Excludes plain
  // whitespace as a leading context to avoid false-positives on commit
  // messages and other strings containing the word "cd" (`git commit -m
  // "fix: cd issue"` would otherwise trip cd-multi-positional). Wrapper
  // forms like `time cd /tmp && ls` are missed by this anchor — those are
  // uncommon enough to accept the gap; commit messages are daily traffic.
  const CD_START = '(?:^|[;&|`(]\\s*|\\n\\s*)'

  // CC bashMissKind: "process-substitution".
  // <(...) or >(...) anywhere in the command.
  if (/[<>]\(/.test(command)) return 'process-substitution'

  // CC bashMissKind: "multi-cd".
  // More than one cd/pushd/popd at command-start positions.
  const cdMatches = command.match(new RegExp(`${CD_START}(?:cd|pushd|popd)(?=\\s|$)`, 'g')) ?? []
  if (cdMatches.length > 1) return 'multi-cd'

  // CC bashMissKind: "cd-multi-positional".
  // zsh `cd OLD NEW`. Two non-flag non-operator words after cd, terminated
  // by end-of-string or a shell operator. Internal gaps are horizontal
  // whitespace ([ \t], not \s): the positional char class already excludes
  // every statement separator except newline/CR, so pinning the gaps to
  // spaces/tabs keeps both positionals inside one statement. A multi-line
  // script whose first line is `cd <dir>` is then not misread as a two-arg
  // cd spanning the newline into the next command.
  if (new RegExp(`${CD_START}cd[ \\t]+(?!-)[^\\s&|;<>(){}]+[ \\t]+(?!-)[^\\s&|;<>(){}]+(?=\\s|$|[&|;<>])`).test(command)) {
    return 'cd-multi-positional'
  }

  // CC bashMissKinds: "cd-git-compound", "cd-compound-write", "cd-compound-redirect".
  // Collapsed here into one detector: cd/pushd/popd followed by &&, ||, or ;.
  if (new RegExp(`${CD_START}(?:cd|pushd|popd)\\s+\\S+.*?(?:&&|\\|\\||;)`).test(command)) return 'cd-compound'

  // CC bashMissKind: "sed-dangerous".
  // sed with -i (in-place) or w/e/W/E command letters in the script.
  if (/\bsed\b(?:[^|&;<>]*?-[a-zA-Z]*i\b|[^|&;<>]*?['"]\s*[weWE])/.test(command)) {
    return 'sed-dangerous'
  }

  // CC bashMissKind: "shell-operators".
  // Top-level subshell ( ... ) or command group { ... }. Excludes $( ),
  // <( ), >( ), ${ }, and escaped \(.
  if (TOP_SUBSHELL.test(command)) return 'shell-operators'
  if (TOP_CMD_GROUP.test(command)) return 'shell-operators'

  // CC bashMissKind: "flag-validation".
  // Wrapper commands (env/timeout/xargs/nice/nohup) with chdir-shaped flags
  // that can change cwd outside the harness's view.
  if (/\b(?:env|timeout|xargs|nice|nohup)\b[^|;&\n]*--(?:chdir|directory|working-dir|workdir|cwd)=/.test(command)) {
    return 'flag-validation'
  }

  // CC bashMissKind: "too-complex".
  // Arithmetic expansion with non-literal contents (variables, function
  // refs) — the bash AST parser rejects these.
  if (ARITH_WITH_VARS.test(command)) return 'too-complex'

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

async function askDaemon(summary: string): Promise<DaemonResponse> {
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

  // Owner-gate short-circuit: nested claudes inherit ROOST_DATA_DIR
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

  const res = await askDaemon(summary)
  if (res.kind === 'unreachable') {
    // Fail closed with the cause — the permbot is up but its IRC link never
    // registered, so no operator can answer. No fallback DM: pnotify's nick
    // would hit the same registration failure.
    process.stderr.write(`pretooluse-hook[${WORKER}]: ${res.cause}\n`)
    emit('deny', res.cause)
  }
  if (res.kind !== 'reply') {
    await sendFallbackDm(summary, 'permbot unavailable / timed out (PreToolUse Bash)')
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
