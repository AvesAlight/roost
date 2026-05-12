import { describe, it, expect } from 'bun:test'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { classifyBash } from '../src/pretooluse-prompt.js'
import { suppressLateRejection } from './helpers/tool.js'

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

  it('cd-compound: cd + semicolon', () => {
    expect(classifyBash('cd /tmp; ls')).toBe('cd-compound')
  })

  it('cd-multi-positional: zsh `cd OLD NEW`', () => {
    expect(classifyBash('cd OLD NEW')).toBe('cd-multi-positional')
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
})

// ---- Hook subprocess --------------------------------------------------------

/** Minimal permbot socket stub: reads one JSON line, responds immediately.
 *  Returns a ready promise (server is listening) and a done promise (response sent). */
function startPermbotStub(sockPath: string, reply: object): { ready: Promise<void>; done: Promise<void> } {
  let onReady!: () => void
  const ready = new Promise<void>(r => { onReady = r })
  let onDone!: () => void
  const done = new Promise<void>(r => { onDone = r })
  const server = net.createServer((sock) => {
    let buf = ''
    sock.on('data', (d) => {
      buf += d.toString('utf8')
      if (!buf.includes('\n')) return
      sock.write(JSON.stringify(reply) + '\n')
      sock.end()
      server.close()
      onDone()
    })
  })
  server.listen(sockPath, () => { onReady() })
  return { ready, done }
}

function makeSock(): string {
  return path.join(os.tmpdir(), `pretooluse-hook-test-${process.pid}-${Math.random().toString(36).slice(2)}.sock`)
}

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
    const sockPath = makeSock()
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
    const sockPath = makeSock()
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

  it('emits ask when permbot times out', async () => {
    const sockPath = makeSock()
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
