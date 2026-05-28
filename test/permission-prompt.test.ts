import { describe, it, expect, beforeAll } from 'bun:test'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { summarize, extractIntent, resolveTranscriptPath } from '../src/permission-prompt.js'
import { suppressLateRejection } from './helpers/tool.js'
import { startPermbotStub, makeSock, captureIRC } from './helpers/permbot-stub.js'
import { startErgo, isErgoAvailable, type ErgoContext } from './helpers/ergo.js'
import { connectPeer } from './helpers/peer.js'

const HOOK = path.join(import.meta.dirname, '../src/permission-prompt.ts')

// ---- summarize() ------------------------------------------------------------

describe('summarize', () => {
  it('Read with no range', () => {
    const lines = summarize('Read', { file_path: '/foo/bar.ts' })
    expect(lines).toEqual(['Read /foo/bar.ts'])
  })

  it('Read with offset and limit', () => {
    const lines = summarize('Read', { file_path: '/foo.ts', offset: 10, limit: 20 })
    expect(lines[0]).toContain('lines 10–29')
  })

  it('Write includes byte count and preview', () => {
    const lines = summarize('Write', { file_path: '/out.txt', content: 'hello' })
    expect(lines[0]).toContain('Write /out.txt (5 bytes)')
    expect(lines[1]).toContain('preview: hello')
  })

  it('Edit includes old/new', () => {
    const lines = summarize('Edit', { file_path: '/f.ts', old_string: 'foo', new_string: 'bar' })
    expect(lines[0]).toBe('Edit /f.ts')
    expect(lines[1]).toContain('old: foo')
    expect(lines[2]).toContain('new: bar')
  })

  it('Edit replace_all flag', () => {
    const lines = summarize('Edit', { file_path: '/f.ts', old_string: 'x', new_string: 'y', replace_all: true })
    expect(lines[0]).toContain('(replace_all)')
  })

  it('Bash with description', () => {
    const lines = summarize('Bash', { command: 'ls /tmp', description: 'list tmp' })
    expect(lines[0]).toBe('Bash (list tmp)')
    expect(lines[1]).toContain('$ ls /tmp')
  })

  it('Bash without description', () => {
    const lines = summarize('Bash', { command: 'pwd' })
    expect(lines[0]).toBe('Bash')
  })

  it('Grep with optional fields', () => {
    const lines = summarize('Grep', { pattern: 'foo', path: '/src', glob: '*.ts' })
    expect(lines[0]).toContain('pattern="foo"')
    expect(lines[0]).toContain('path=/src')
    expect(lines[0]).toContain('glob=*.ts')
  })

  it('WebFetch with prompt', () => {
    const lines = summarize('WebFetch', { url: 'https://example.com', prompt: 'get title' })
    expect(lines[0]).toContain('WebFetch https://example.com')
    expect(lines[1]).toContain('prompt: get title')
  })

  it('unknown tool serializes JSON', () => {
    const lines = summarize('MyTool', { x: 1 })
    expect(lines[0]).toContain('MyTool')
    expect(lines[0]).toContain('"x"')
  })

  it('Edit clips old/new strings', () => {
    const lines = summarize('Edit', { file_path: '/f.ts', old_string: '  indented', new_string: '  also' })
    expect(lines[1]).toContain('indented')
    expect(lines[2]).toContain('also')
  })
})

// ---- extractIntent() --------------------------------------------------------

describe('extractIntent', () => {
  it('returns empty string for missing file', () => {
    expect(extractIntent('/nonexistent/path.jsonl')).toBe('')
  })

  it('extracts most recent assistant text block', () => {
    const tmp = path.join(os.tmpdir(), `transcript-${process.pid}.jsonl`)
    const turn = {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'I will read the file now.' }],
      },
    }
    fs.writeFileSync(tmp, JSON.stringify(turn) + '\n')
    try {
      expect(extractIntent(tmp)).toBe('I will read the file now.')
    } finally {
      fs.unlinkSync(tmp)
    }
  })

  it('falls back to thinking when no text block', () => {
    const tmp = path.join(os.tmpdir(), `transcript-${process.pid}-b.jsonl`)
    const turn = {
      type: 'assistant',
      message: {
        content: [{ type: 'thinking', thinking: 'maybe I should check the file' }],
      },
    }
    fs.writeFileSync(tmp, JSON.stringify(turn) + '\n')
    try {
      expect(extractIntent(tmp)).toContain('maybe I should check')
    } finally {
      fs.unlinkSync(tmp)
    }
  })

  it('skips non-assistant turns', () => {
    const tmp = path.join(os.tmpdir(), `transcript-${process.pid}-c.jsonl`)
    const lines = [
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'do the thing' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok doing it' }] } }),
    ]
    fs.writeFileSync(tmp, lines.join('\n') + '\n')
    try {
      expect(extractIntent(tmp)).toBe('ok doing it')
    } finally {
      fs.unlinkSync(tmp)
    }
  })

})

// ---- resolveTranscriptPath() ------------------------------------------------

describe('resolveTranscriptPath', () => {
  it('returns transcript_path unchanged when no agent_id', () => {
    expect(resolveTranscriptPath('/path/to/session.jsonl', '')).toBe('/path/to/session.jsonl')
  })

  it('returns transcript_path unchanged when path already contains /subagents/', () => {
    const p = '/path/to/session/subagents/agent-abc.jsonl'
    expect(resolveTranscriptPath(p, 'abc')).toBe(p)
  })

  it('derives sub-agent path when agent_id present and file exists', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rtp-'))
    const sessionJsonl = path.join(tmp, 'session.jsonl')
    const subDir = path.join(tmp, 'session', 'subagents')
    fs.mkdirSync(subDir, { recursive: true })
    fs.writeFileSync(sessionJsonl, '')
    const subFile = path.join(subDir, 'agent-deadbeef.jsonl')
    fs.writeFileSync(subFile, '')
    try {
      expect(resolveTranscriptPath(sessionJsonl, 'deadbeef')).toBe(subFile)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('falls back to parent transcript when sub-agent file does not exist', () => {
    expect(resolveTranscriptPath('/nonexistent/session.jsonl', 'deadbeef')).toBe('/nonexistent/session.jsonl')
  })
})

// ---- hook integration (subprocess) -----------------------------------------

const PAYLOAD = JSON.stringify({
  tool_name: 'Bash',
  tool_input: { command: 'rm /tmp/x', description: 'delete temp file' },
  transcript_path: '',
})

async function runHook(env: Record<string, string>): Promise<{ stdout: string; stderr: string; exit: number }> {
  const proc = Bun.spawn(['bun', HOOK], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
    stdin: new TextEncoder().encode(PAYLOAD),
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

describe('permission-prompt hook', () => {
  it('sends fallback DM via RoostIrcClient when daemon unreachable', async () => {
    const { port, lines } = await captureIRC()
    const [received] = await Promise.all([
      lines(),
      runHook({
        ROOST_IRC_NICK: 'worker-test',
        ROOST_PERM_TARGET: 'operator',
        ROOST_PERM_HOST: '127.0.0.1',
        ROOST_PERM_PORT: String(port),
      }),
    ])
    const privmsgs = received.filter(l => l.startsWith('PRIVMSG operator :'))
    expect(privmsgs.length).toBeGreaterThan(0)
    expect(privmsgs.some(m => m.includes('fallback'))).toBe(true)
    expect(privmsgs.some(m => m.includes('Bash'))).toBe(true)
  }, 15_000)

  it('allows roost-irc passthrough tools without hitting daemon', async () => {
    const passthroughPayload = JSON.stringify({
      tool_name: 'mcp__roost-irc__channel_message',
      tool_input: { channel: '#roost', text: 'hi' },
      transcript_path: '',
    })
    const proc = Bun.spawn(['bun', HOOK], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ROOST_IRC_NICK: 'worker-test' },
      stdin: new TextEncoder().encode(passthroughPayload),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    const decision = JSON.parse(out.trim()) as { hookSpecificOutput: { decision: { behavior: string } } }
    expect(decision.hookSpecificOutput.decision.behavior).toBe('allow')
  })

  it('defers to terminal when no sock and no perm-target', async () => {
    const { stderr } = await runHook({ ROOST_IRC_NICK: 'worker-test' })
    expect(stderr).toContain('deferring to terminal')
  })

  it('allow carries default reason when operator replies with bare y', async () => {
    const sockPath = makeSock('perm-hook')
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

    const out = JSON.parse(stdout.trim()) as { hookSpecificOutput: { decision: { behavior: string; message?: string } } }
    expect(out.hookSpecificOutput.decision.behavior).toBe('allow')
    expect(out.hookSpecificOutput.decision.message).toBe('operator approved via IRC')
  }, 10_000)

  it('deny carries default reason when operator replies with bare n', async () => {
    const sockPath = makeSock('perm-hook')
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

    const out = JSON.parse(stdout.trim()) as { hookSpecificOutput: { decision: { behavior: string; message?: string } } }
    expect(out.hookSpecificOutput.decision.behavior).toBe('deny')
    expect(out.hookSpecificOutput.decision.message).toBe('operator denied via IRC')
  }, 10_000)

  it('fails closed (deny) with the cause when the daemon reports unreachable', async () => {
    const sockPath = makeSock('perm-hook')
    const cause = "permbot unreachable: 432 Erroneous nickname for nick 'permbot-worker-test' (19 chars) — likely exceeds the server nicklen; raise limits.nicklen in ergo.yaml if the nick exceeds it, then respawn the agent (a wedged permbot cannot self-heal)"
    const stub = startPermbotStub(sockPath, { error: cause, unreachable: true })
    await stub.ready

    const [{ stdout }] = await Promise.all([
      runHook({
        ROOST_IRC_NICK: 'worker-test',
        ROOST_PERM_SOCK: sockPath,
        ROOST_PERM_TARGET: 'operator',
        // No PERM_HOST/PORT: proves the unreachable path does NOT attempt a
        // fallback DM (which would hit the same registration failure).
      }),
      stub.done,
    ])

    const out = JSON.parse(stdout.trim()) as { hookSpecificOutput: { decision: { behavior: string; message?: string } } }
    expect(out.hookSpecificOutput.decision.behavior).toBe('deny')
    expect(out.hookSpecificOutput.decision.message).toBe(cause)
  }, 10_000)

  it('emits ask when operator reply is unrecognized', async () => {
    const sockPath = makeSock('perm-hook')
    const stub = startPermbotStub(sockPath, { reply: 'maybe later' })
    await stub.ready

    const [{ stderr, exit }] = await Promise.all([
      runHook({
        ROOST_IRC_NICK: 'worker-test',
        ROOST_PERM_SOCK: sockPath,
        ROOST_PERM_TARGET: 'operator',
        // No PERM_HOST/PORT → fallback DM fails silently; contract under test is ask emission.
      }),
      stub.done,
    ])

    expect(stderr).toContain('unrecognized')
    expect(stderr).toContain('deferring to terminal')
    expect(exit).toBe(0)
  }, 10_000)

  it('emits ask when permbot times out', async () => {
    const sockPath = makeSock('perm-hook')
    // Stub accepts connection but never responds — exercises the timeout path.
    const server = net.createServer(() => {})
    await suppressLateRejection(new Promise<void>(r => server.listen(sockPath, r)))

    try {
      const { stderr, exit } = await runHook({
        ROOST_IRC_NICK: 'worker-test',
        ROOST_PERM_SOCK: sockPath,
        ROOST_PERM_TARGET: 'operator',
        ROOST_PERM_TIMEOUT_SECS: '1',
        // No PERM_HOST/PORT → fallback DM fails silently.
      })
      expect(stderr).toContain('timed out')
      expect(stderr).toContain('deferring to terminal')
      expect(exit).toBe(0)
    } finally {
      server.close()
      try { fs.unlinkSync(sockPath) } catch { /* ignore */ }
    }
  }, 15_000)

  it('owner-gate short-circuits before any socket touch when nested (#188)', async () => {
    // Owner.session is held by sess-A; this hook run carries CLAUDE_CODE_SESSION_ID=sess-B,
    // so checkOwnership() must short-circuit BEFORE askDaemon connects to the unix socket.
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-hook-test-'))
    const sockPath = path.join(dataDir, 'permbot.sock')
    fs.writeFileSync(path.join(dataDir, 'owner.session'), 'sess-A')

    let connected = false
    const sockServer = net.createServer((s) => { connected = true; s.destroy() })
    await new Promise<void>(r => sockServer.listen(sockPath, () => r()))

    try {
      const { stdout, stderr } = await runHook({
        ROOST_IRC_NICK: 'worker-test',
        ROOST_DATA_DIR: dataDir,
        CLAUDE_CODE_SESSION_ID: 'sess-B',
        ROOST_PERM_SOCK: sockPath,
        ROOST_PERM_TARGET: 'operator',
      })
      expect(connected).toBe(false)
      expect(stderr).toContain('nested claude')
      expect(stdout).toBe('')  // emit('ask') is a no-stdout exit
    } finally {
      await new Promise<void>(r => sockServer.close(() => r()))
      fs.rmSync(dataDir, { recursive: true, force: true })
    }
  })
})

// ---- fallback DM against real ergo -----------------------------------------
//
// Wire-level coverage (test above, line ~191) verifies PRIVMSGs are emitted
// against a stub IRC server. That stub skips CAP negotiation timing, server
// caps the real ergo advertises, and the registered→say→quit→disconnected
// ordering — which is exactly where the production failure landed (the hook
// ran, the fallback path fired, but no DM reached the operator). This test
// drives the hook subprocess against a real ergo and asserts the ask-target
// receives the PRIVMSG, with a loose timing bound to catch regressions where
// delivery still works but takes 30s.

describe.if(isErgoAvailable())('sendFallbackDm against real ergo', () => {
  let ergo: ErgoContext

  beforeAll(async () => {
    ergo = (await startErgo())!
  })

  it('delivers DM to operator when permbot socket is absent', async () => {
    const operator = await connectPeer(ergo, 'op-real-1')
    // Hook sends a header PRIVMSG, then one PRIVMSG per summary line. Wait for
    // both: the header confirms the "terminal fallback" framing, the Bash line
    // confirms summary lines actually made it across before quit().
    const seenHeader = operator.waitForMessage(
      operator.nick,
      (m) => m.text.includes('terminal fallback') && m.nick.startsWith('pnotify-'),
      8000,
    )
    const seenSummary = operator.waitForMessage(
      operator.nick,
      (m) => m.text.includes('Bash') && m.nick.startsWith('pnotify-'),
      8000,
    )

    const start = Date.now()
    const proc = Bun.spawn(['bun', HOOK], {
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        ROOST_IRC_NICK: 'worker-real-1',
        ROOST_PERM_TARGET: operator.nick,
        ROOST_PERM_HOST: ergo.host,
        ROOST_PERM_PORT: String(ergo.port),
      },
      stdin: new TextEncoder().encode(PAYLOAD),
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const [stderr] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
    const [header, summary] = await Promise.all([seenHeader, seenSummary])
    const elapsed = Date.now() - start

    expect(header.text).toContain('permbot unavailable')
    expect(summary.text).toContain('Bash')
    expect(elapsed).toBeLessThan(8000)
    expect(stderr).toContain('starting transient connection')
    expect(stderr).toContain('registered successfully')
    expect(stderr).toContain('PRIVMSGs sent')
    expect(stderr).toContain('transient client disconnected (quit complete)')
  }, 15_000)

  it('logs registration timeout when ergo never answers', async () => {
    // Sink that accepts TCP but never speaks IRC — registration deadline must
    // fire and the hook must still exit 0 with the documented log line.
    const sink = net.createServer(() => { /* hold socket open, send nothing */ })
    await new Promise<void>(r => sink.listen(0, '127.0.0.1', () => r()))
    const { port } = sink.address() as net.AddressInfo

    try {
      const proc = Bun.spawn(['bun', HOOK], {
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          ROOST_IRC_NICK: 'worker-real-2',
          ROOST_PERM_TARGET: 'op-real-2',
          ROOST_PERM_HOST: '127.0.0.1',
          ROOST_PERM_PORT: String(port),
          ROOST_FALLBACK_REG_TIMEOUT_MS: '300',
          ROOST_FALLBACK_FLUSH_TIMEOUT_MS: '300',
        },
        stdin: new TextEncoder().encode(PAYLOAD),
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const stderr = await new Response(proc.stderr).text()
      await proc.exited

      expect(stderr).toContain('starting transient connection')
      expect(stderr).toContain('registration timeout fired')
      expect(proc.exitCode).toBe(0)
    } finally {
      await new Promise<void>(r => sink.close(() => r()))
    }
  }, 10_000)
})
