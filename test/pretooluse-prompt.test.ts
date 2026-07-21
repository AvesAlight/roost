import { describe, it, expect } from 'bun:test'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { classifyBash } from '../src/pretooluse-prompt.js'
import { suppressLateRejection } from './helpers/tool.js'
import { startPermbotStub, makeSock } from './helpers/permbot-stub.js'

const HOOK = path.join(import.meta.dirname, '../src/pretooluse-prompt.ts')

// ---- classifyBash() ---------------------------------------------------------
//
// One example per bashMissKind from the #276 table, plus negative cases that
// must fall through to the normal permission pipeline.

describe('classifyBash', () => {
  it('newline-hash: literal newline then # comment', () => {
    expect(classifyBash('bash -c "echo hi\n# comment"')).toBe('newline-hash')
  })

  it('newline-hash: heredoc with hash line (the worker-202 hang shape)', () => {
    expect(classifyBash("ruby -e 'puts 1\n# trailing comment'")).toBe('newline-hash')
  })

  it('process-substitution: <(...) form', () => {
    expect(classifyBash('diff <(echo a) <(echo b)')).toBe('process-substitution')
  })

  it('process-substitution: >(...) form', () => {
    expect(classifyBash('tee >(cat > out)')).toBe('process-substitution')
  })

  it('multi-cd: more than one cd', () => {
    expect(classifyBash('cd /tmp && ls && cd /var')).toBe('multi-cd')
  })

  it('multi-cd: pushd + popd', () => {
    expect(classifyBash('pushd /tmp && ls && popd')).toBe('multi-cd')
  })

  it('cd-compound: cd + git (cd-git-compound)', () => {
    expect(classifyBash('cd /tmp/repo && git status')).toBe('cd-compound')
  })

  it('cd-compound: cd + write redirection (cd-compound-write)', () => {
    expect(classifyBash('cd /tmp && echo x > out')).toBe('cd-compound')
  })

  it('cd-compound: cd + redirect (cd-compound-redirect)', () => {
    expect(classifyBash('cd /tmp && ls > out')).toBe('cd-compound')
  })

  it('cd-compound: cd + git via semicolon', () => {
    // Semicolon path still flags when the tail isn't read-only. A read-only
    // tail (`cd /tmp; ls`) is the O2 over-fire and now takes the fast-path —
    // see the read-only fast-path block below.
    expect(classifyBash('cd /tmp; git status')).toBe('cd-compound')
  })

  it('cd-multi-positional: zsh `cd OLD NEW`', () => {
    expect(classifyBash('cd OLD NEW')).toBe('cd-multi-positional')
  })

  it('cd-multi-positional: genuine two-arg cd on a later line of a script', () => {
    // A real `cd OLD NEW` still flags when it is not the first statement —
    // the newline-safety fix must not swallow legitimate multi-positional cds.
    expect(classifyBash('echo hi\ncd OLD NEW')).toBe('cd-multi-positional')
  })

  it('sed-dangerous: sed -i (in-place edit)', () => {
    expect(classifyBash("sed -i 's/x/y/' file.txt")).toBe('sed-dangerous')
  })

  it('sed-dangerous: sed with w command (writes file)', () => {
    expect(classifyBash("sed 'w /tmp/out' input")).toBe('sed-dangerous')
  })

  it('shell-operators: subshell at top level', () => {
    expect(classifyBash('(ls; pwd)')).toBe('shell-operators')
  })

  it('shell-operators: command group', () => {
    expect(classifyBash('{ ls; pwd; }')).toBe('shell-operators')
  })

  it('flag-validation: env --chdir=', () => {
    expect(classifyBash('env --chdir=/tmp ls')).toBe('flag-validation')
  })

  it('too-complex: arithmetic with non-literal', () => {
    expect(classifyBash('echo $((x+1))')).toBe('too-complex')
  })

  // ---- negative cases (must pass through) -----------------------------------

  it('null: plain ls', () => {
    expect(classifyBash('ls /tmp')).toBeNull()
  })

  it('null: single cd', () => {
    expect(classifyBash('cd /tmp')).toBeNull()
  })

  it('null: multi-line script whose first line is a single-arg cd', () => {
    // The reported shape. Newline is a statement separator, not an argument
    // gap — the next command must not be read as a second positional to cd.
    expect(classifyBash('cd /path/to/worktree\necho hi\ngrep -rn x src/')).toBeNull()
  })

  it('null: CRLF-separated script whose first line is a single-arg cd', () => {
    // `\r` is a statement separator too — `[ \t]+` excludes it, so a CRLF
    // (or bare-CR) script isn't read as a two-arg cd spanning the break.
    expect(classifyBash('cd /path/to/worktree\r\necho hi\r\ngrep -rn x src/')).toBeNull()
  })

  it('null: cd alone then a command on the next line', () => {
    // Guards the gap right after `cd`: it too is horizontal-only, so a bare
    // `cd` followed by a command on the next line is not a two-arg cd.
    expect(classifyBash('cd\n/a /b')).toBeNull()
  })

  it('null: cd with flag', () => {
    expect(classifyBash('cd -P /tmp')).toBeNull()
  })

  it('null: command substitution $(...)', () => {
    expect(classifyBash('echo $(date)')).toBeNull()
  })

  it('null: parameter expansion ${var}', () => {
    expect(classifyBash('echo ${HOME}')).toBeNull()
  })

  it('null: arithmetic with literals only', () => {
    expect(classifyBash('echo $((1+1))')).toBeNull()
  })

  it('null: typical pipeline', () => {
    expect(classifyBash('git status | head -10')).toBeNull()
  })

  it('null: empty command', () => {
    expect(classifyBash('')).toBeNull()
  })

  it('null: sed without dangerous flags', () => {
    expect(classifyBash("sed 's/x/y/' file.txt")).toBeNull()
  })

  it('null: cd-compound but only one cd (cd + && + non-cd)', () => {
    // Single cd, no zsh two-arg, but compound op present → cd-compound.
    // Negative case is "no cd at all": just a plain &&.
    expect(classifyBash('ls && pwd')).toBeNull()
  })

  // Real-world false-positive shapes worker traffic actually hits. Each of
  // these was caught by an earlier loose `\s` leading-context regex; we
  // anchor cd to command-start positions specifically to keep this traffic
  // out of the operator's inbox.
  it('null: git commit -m with "cd" in the message (false-positive guard)', () => {
    expect(classifyBash('git commit -m "fix: cd issue in worker"')).toBeNull()
  })

  it('null: git commit -m with "cd /tmp && ls" in the message', () => {
    expect(classifyBash('git commit -m "describe cd /tmp && ls trick"')).toBeNull()
  })

  it('null: echo of a string mentioning cd', () => {
    expect(classifyBash('echo "I will cd to /tmp"')).toBeNull()
  })
})

// ---- read-only fast-path (#641) --------------------------------------------
//
// CC auto-grants a "simple read-only command", so classifyBash must not relay
// it. The fast-path is monotonic: it only ever turns a would-be relay into
// null, never the reverse. The one observable flip vs. the prior classifier is
// O2 — `cd <dir>; <read-only>` going cd-compound → null.

describe('classifyBash read-only fast-path', () => {
  // The O2 over-fire: a read-only tail after cd. Was flagged cd-compound.
  it('O2: cd + read-only tail via semicolon → null', () => {
    expect(classifyBash('cd /tmp; ls')).toBeNull()
  })
  it('O2: cd + read-only tail via && → null', () => {
    expect(classifyBash('cd /tmp && grep -rn foo src/')).toBeNull()
  })
  it('read-only pipeline of allowlisted commands → null', () => {
    expect(classifyBash('git log --oneline | head -20 | cat')).toBeNull()
  })
  it('read-only git subcommand → null', () => {
    expect(classifyBash('git diff --stat')).toBeNull()
  })

  // Monotonicity: every other bashMissKind still flags. The fast-path declines
  // (falls through) rather than swallowing these — its accept set is a strict
  // subset of genuinely read-only commands.
  it('does not swallow multi-cd', () => {
    expect(classifyBash('cd /tmp && ls && cd /var')).toBe('multi-cd')
  })
  it('does not swallow cd-multi-positional', () => {
    expect(classifyBash('cd OLD NEW')).toBe('cd-multi-positional')
  })
  it('does not swallow too-complex (arith with vars)', () => {
    expect(classifyBash('echo $((x+1))')).toBe('too-complex')
  })
  it('does not swallow shell-operators (subshell of read-only cmds)', () => {
    expect(classifyBash('(ls; pwd)')).toBe('shell-operators')
  })
  it('does not swallow cd + git (cd-git-compound)', () => {
    expect(classifyBash('cd /repo && git status')).toBe('cd-compound')
  })
  it('does not swallow a read-only tail with a write redirect', () => {
    expect(classifyBash('cd /tmp && ls > out')).toBe('cd-compound')
  })

  // A non-allowlisted command declines the fast-path. It's null anyway (no
  // bashMissKind, parity-correct — CC auto-grants it) but via fall-through,
  // not the fast-path.
  it('declines a non-allowlisted command (null via fall-through)', () => {
    expect(classifyBash('curl -s https://example.com')).toBeNull()
  })
  // cd + a non-read-only tail stays cd-compound — the fast-path only removes
  // the read-only-tail over-fire, not every cd-compound.
  it('cd + non-read-only tail still flags cd-compound', () => {
    expect(classifyBash('cd /tmp; rm -rf x')).toBe('cd-compound')
  })
})

// ---- Hook subprocess --------------------------------------------------------

const SAFETY_CHECK_PAYLOAD = JSON.stringify({
  tool_name: 'Bash',
  tool_input: { command: 'cd /tmp && ls > out', description: 'compound with cd + redirect' },
  transcript_path: '',
})

const BENIGN_PAYLOAD = JSON.stringify({
  tool_name: 'Bash',
  tool_input: { command: 'ls /tmp', description: 'list tmp' },
  transcript_path: '',
})

async function runHook(env: Record<string, string>, stdin = SAFETY_CHECK_PAYLOAD): Promise<{ stdout: string; stderr: string; exit: number }> {
  const proc = Bun.spawn(['bun', HOOK], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
    stdin: new TextEncoder().encode(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  return { stdout, stderr, exit: proc.exitCode ?? 0 }
}

describe('pretooluse-prompt hook subprocess', () => {
  it('allows on operator y reply', async () => {
    const sockPath = makeSock('pretooluse-hook')
    const stub = startPermbotStub(sockPath, { reply: 'y' })
    await stub.ready

    const [{ stdout }] = await Promise.all([
      runHook({
        ROOST_IRC_NICK: 'worker-test',
        ROOST_PERM_SOCK: sockPath,
        ROOST_PERM_TARGET: 'operator',
      }),
      stub.done,
    ])

    const out = JSON.parse(stdout.trim()) as { hookSpecificOutput: { hookEventName: string; permissionDecision: string } }
    expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse')
    expect(out.hookSpecificOutput.permissionDecision).toBe('allow')
  }, 10_000)

  it('denies on operator n reply', async () => {
    const sockPath = makeSock('pretooluse-hook')
    const stub = startPermbotStub(sockPath, { reply: 'n' })
    await stub.ready

    const [{ stdout }] = await Promise.all([
      runHook({
        ROOST_IRC_NICK: 'worker-test',
        ROOST_PERM_SOCK: sockPath,
        ROOST_PERM_TARGET: 'operator',
      }),
      stub.done,
    ])

    const out = JSON.parse(stdout.trim()) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason?: string } }
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny')
  }, 10_000)

  it('fails closed (deny) with the cause when the daemon reports unreachable', async () => {
    const sockPath = makeSock('pretooluse-hook')
    const cause = "permbot unreachable: 432 Erroneous nickname for nick 'permbot-worker-test' (19 chars) — raise limits.nicklen in ergo.yaml"
    const stub = startPermbotStub(sockPath, { error: cause, unreachable: true })
    await stub.ready

    const [{ stdout }] = await Promise.all([
      runHook({
        ROOST_IRC_NICK: 'worker-test',
        ROOST_PERM_SOCK: sockPath,
        ROOST_PERM_TARGET: 'operator',
        // No PERM_HOST/PORT: the unreachable path must NOT attempt a fallback DM.
      }),
      stub.done,
    ])

    const out = JSON.parse(stdout.trim()) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason?: string } }
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(out.hookSpecificOutput.permissionDecisionReason).toBe(cause)
  }, 10_000)

  it('emits ask + falls back when operator reply is unrecognized', async () => {
    const sockPath = makeSock('pretooluse-hook')
    const stub = startPermbotStub(sockPath, { reply: 'maybe later' })
    await stub.ready

    const [{ stdout }] = await Promise.all([
      runHook({
        ROOST_IRC_NICK: 'worker-test',
        ROOST_PERM_SOCK: sockPath,
        ROOST_PERM_TARGET: 'operator',
        // No PERM_HOST/PORT → fallback DM fails silently; the hook still
        // emits ask, which is the contract under test here.
      }),
      stub.done,
    ])

    const out = JSON.parse(stdout.trim()) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason?: string } }
    expect(out.hookSpecificOutput.permissionDecision).toBe('ask')
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('unrecognized')
  }, 10_000)

  it('allow carries default reason when operator replies with bare y', async () => {
    const sockPath = makeSock('pretooluse-hook')
    const stub = startPermbotStub(sockPath, { reply: 'y' })
    await stub.ready

    const [{ stdout }] = await Promise.all([
      runHook({
        ROOST_IRC_NICK: 'worker-test',
        ROOST_PERM_SOCK: sockPath,
        ROOST_PERM_TARGET: 'operator',
      }),
      stub.done,
    ])

    const out = JSON.parse(stdout.trim()) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason?: string } }
    expect(out.hookSpecificOutput.permissionDecision).toBe('allow')
    expect(out.hookSpecificOutput.permissionDecisionReason).toBe('operator approved via IRC')
  }, 10_000)

  it('emits ask when permbot times out', async () => {
    const sockPath = makeSock('pretooluse-hook')
    // Stub accepts connection but never responds — socket-level timeout path.
    const server = net.createServer(() => {})
    await suppressLateRejection(new Promise<void>(r => server.listen(sockPath, r)))

    try {
      const { stdout } = await runHook({
        ROOST_IRC_NICK: 'worker-test',
        ROOST_PERM_SOCK: sockPath,
        ROOST_PERM_TARGET: 'operator',
        ROOST_PERM_TIMEOUT_SECS: '1',
        // No port set → fallback DM will fail silently; we only assert ask emission.
      })
      const out = JSON.parse(stdout.trim()) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason?: string } }
      expect(out.hookSpecificOutput.permissionDecision).toBe('ask')
      expect(out.hookSpecificOutput.permissionDecisionReason).toContain('timed out')
    } finally {
      server.close()
      try { fs.unlinkSync(sockPath) } catch { /* ignore */ }
    }
  }, 15_000)

  it('falls through (exit 0, empty stdout) for non-Bash tool', async () => {
    const { stdout, exit } = await runHook(
      { ROOST_IRC_NICK: 'worker-test' },
      JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/tmp/x' } }),
    )
    expect(exit).toBe(0)
    expect(stdout.trim()).toBe('')
  }, 5_000)

  it('falls through for benign Bash (no safety-check shape)', async () => {
    const { stdout, exit } = await runHook(
      { ROOST_IRC_NICK: 'worker-test' },
      BENIGN_PAYLOAD,
    )
    expect(exit).toBe(0)
    expect(stdout.trim()).toBe('')
  }, 5_000)

  it('falls through when not configured (no SOCK_PATH/TARGET)', async () => {
    const { stdout, exit } = await runHook(
      { ROOST_IRC_NICK: 'worker-test' },
      // safety-check command, but env is unconfigured → defer to terminal
    )
    expect(exit).toBe(0)
    expect(stdout.trim()).toBe('')
  }, 5_000)

  it('owner-gate short-circuits when nested (#188)', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pretooluse-gate-test-'))
    const sockPath = path.join(dataDir, 'permbot.sock')
    fs.writeFileSync(path.join(dataDir, 'owner.session'), 'sess-A')

    let connected = false
    const sockServer = net.createServer((s) => { connected = true; s.destroy() })
    await new Promise<void>(r => sockServer.listen(sockPath, () => r()))

    try {
      const { stdout, exit } = await runHook({
        ROOST_IRC_NICK: 'worker-test',
        ROOST_DATA_DIR: dataDir,
        CLAUDE_CODE_SESSION_ID: 'sess-B',
        ROOST_PERM_SOCK: sockPath,
        ROOST_PERM_TARGET: 'operator',
      })
      expect(exit).toBe(0)
      expect(stdout.trim()).toBe('')
      expect(connected).toBe(false)
    } finally {
      await new Promise<void>(r => sockServer.close(() => r()))
      fs.rmSync(dataDir, { recursive: true, force: true })
    }
  }, 10_000)
})
