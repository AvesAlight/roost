import { describe, it, expect } from 'bun:test'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { formatQuestionsForIRC, mapOneReply, mapReplyToAnswers } from '../src/ask-question-hook.js'
import { suppressLateRejection } from './helpers/tool.js'

const HOOK = path.join(import.meta.dirname, '../src/ask-question-hook.ts')

// ---- formatQuestionsForIRC --------------------------------------------------

describe('formatQuestionsForIRC', () => {
  it('single question with options (DM mode — no permbotNick)', () => {
    const text = formatQuestionsForIRC([{
      question: 'Which framework?',
      options: [{ label: 'React' }, { label: 'Vue' }],
    }])
    expect(text).toContain('Which framework?')
    expect(text).toContain('1. React')
    expect(text).toContain('2. Vue')
    expect(text).toContain("Reply: number, your own answer, or 'chat' to skip")
  })

  it('single question with options (channel mode — includes DM hint)', () => {
    const text = formatQuestionsForIRC([{
      question: 'Which framework?',
      options: [{ label: 'React' }, { label: 'Vue' }],
    }], 'permbot-worker')
    expect(text).toContain('Which framework?')
    expect(text).toContain('1. React')
    expect(text).toContain('2. Vue')
    expect(text).toContain('DM @permbot-worker')
    expect(text).toContain("'chat' to skip")
  })

  it('no Q prefix for single question', () => {
    const text = formatQuestionsForIRC([{ question: 'Pick one?', options: [{ label: 'A' }] }])
    expect(text).not.toContain('Q1:')
    expect(text).not.toContain('comma-separated')
  })

  it('Q prefix for multiple questions', () => {
    const text = formatQuestionsForIRC([
      { question: 'First?', options: [{ label: 'A' }] },
      { question: 'Second?', options: [{ label: 'B' }] },
    ])
    expect(text).toContain('Q1: First?')
    expect(text).toContain('Q2: Second?')
    expect(text).toContain('comma-separated')
    expect(text).toContain("'chat'")
  })

  it('multi-select hint uses / separator in multi-question context', () => {
    const text = formatQuestionsForIRC([
      { question: 'Q1?', options: [{ label: 'A' }], multiSelect: true },
      { question: 'Q2?', options: [{ label: 'B' }] },
    ])
    expect(text).toContain('use / to separate choices')
    expect(text).not.toContain('comma-separate multiple')
  })

  it('includes option description when present', () => {
    const text = formatQuestionsForIRC([{
      question: 'Method?',
      options: [{ label: 'OAuth', description: 'browser flow' }],
    }])
    expect(text).toContain('OAuth — browser flow')
  })

  it('marks multi-select questions', () => {
    const text = formatQuestionsForIRC([{
      question: 'Features?',
      options: [{ label: 'Cache' }, { label: 'Stream' }],
      multiSelect: true,
    }])
    expect(text).toContain('multi-select')
  })

  it('no options = just question text', () => {
    const text = formatQuestionsForIRC([{ question: 'Free text?' }])
    expect(text).toContain('Free text?')
  })
})

// ---- mapOneReply ------------------------------------------------------------

describe('mapOneReply', () => {
  const q = { question: 'Q', options: [{ label: 'React' }, { label: 'Vue' }] }

  it('maps number to option label (1-based)', () => {
    expect(mapOneReply('1', q)).toBe('React')
    expect(mapOneReply('2', q)).toBe('Vue')
  })

  it('maps case-insensitive label match', () => {
    expect(mapOneReply('react', q)).toBe('React')
    expect(mapOneReply('VUE', q)).toBe('Vue')
  })

  it('returns raw text when no match', () => {
    expect(mapOneReply('Angular', q)).toBe('Angular')
  })

  it('returns raw text for free-form question (no options)', () => {
    expect(mapOneReply('anything', { question: 'Q' })).toBe('anything')
  })

  it('ignores out-of-range numbers', () => {
    expect(mapOneReply('99', q)).toBe('99')
  })
})

// ---- mapReplyToAnswers ------------------------------------------------------

describe('mapReplyToAnswers', () => {
  const qs = [
    { question: 'Framework?', options: [{ label: 'React' }, { label: 'Vue' }] },
    { question: 'Tests?', options: [{ label: 'Yes' }, { label: 'No' }] },
  ]

  it('single question by number', () => {
    const ans = mapReplyToAnswers('1', [qs[0]])
    expect(ans).toEqual({ 'Framework?': 'React' })
  })

  it('multiple questions comma-separated', () => {
    const ans = mapReplyToAnswers('1, 2', qs)
    expect(ans).toEqual({ 'Framework?': 'React', 'Tests?': 'No' })
  })

  it('multi-select single question: comma-separated choices', () => {
    const q = { question: 'Pick?', options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }], multiSelect: true }
    const ans = mapReplyToAnswers('1, 3', [q])
    expect(ans['Pick?']).toBe('A,C')
  })

  it('strips QN: prefix in multi-question replies', () => {
    const ans = mapReplyToAnswers('Q1: React, Q2: Yes', qs)
    expect(ans).toEqual({ 'Framework?': 'React', 'Tests?': 'Yes' })
  })

  it('missing part for a question maps to empty reply → raw', () => {
    const ans = mapReplyToAnswers('React', qs)
    expect(ans['Framework?']).toBe('React')
    // second question gets empty string → falls back to raw ''
    expect(typeof ans['Tests?']).toBe('string')
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
  return path.join(os.tmpdir(), `ask-hook-test-${process.pid}-${Math.random().toString(36).slice(2)}.sock`)
}

const QUESTION_PAYLOAD = JSON.stringify({
  tool_name: 'AskUserQuestion',
  tool_input: {
    questions: [
      { question: 'Which framework?', header: 'Framework', options: [{ label: 'React' }, { label: 'Vue' }], multiSelect: false },
    ],
  },
})

async function runHook(env: Record<string, string>, stdin = QUESTION_PAYLOAD): Promise<{ stdout: string; stderr: string; exit: number }> {
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

describe('ask-question-hook subprocess', () => {
  it('resolves via permbot socket and returns allow + answers', async () => {
    const sockPath = makeSock()
    const stub = startPermbotStub(sockPath, { reply: '1' })
    await stub.ready  // ensure server is listening before hook tries to connect

    const [{ stdout }] = await Promise.all([
      runHook({
        ROOST_IRC_NICK: 'worker-test',
        ROOST_PERM_SOCK: sockPath,
        ROOST_ASK_CHANNEL: '#ask-channel',
        ROOST_ASK_TARGET: 'operator',
      }),
      stub.done,
    ])

    const out = JSON.parse(stdout.trim()) as { hookSpecificOutput: { permissionDecision: string; updatedInput: { answers: Record<string, string> } } }
    expect(out.hookSpecificOutput.permissionDecision).toBe('allow')
    expect(out.hookSpecificOutput.updatedInput.answers['Which framework?']).toBe('React')
  }, 10_000)

  it('returns deny when permbot times out', async () => {
    const sockPath = makeSock()
    // Stub that accepts connections but never responds → triggers socket timeout
    const server = net.createServer(() => {})
    await suppressLateRejection(new Promise<void>(r => server.listen(sockPath, r)))

    try {
      const { stdout, stderr } = await runHook({
        ROOST_IRC_NICK: 'worker-test',
        ROOST_PERM_SOCK: sockPath,
        ROOST_ASK_CHANNEL: '#ask-channel',
        ROOST_ASK_TIMEOUT_SECS: '1',
      })
      const out = JSON.parse(stdout.trim()) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason?: string } }
      expect(out.hookSpecificOutput.permissionDecision).toBe('deny')
      expect(out.hookSpecificOutput.permissionDecisionReason).toContain('timed out')
      expect(stderr).toContain('timed out')
    } finally {
      server.close()
      try { fs.unlinkSync(sockPath) } catch { /* ignore */ }
    }
  }, 15_000)

  it('denies when socket is configured but missing (permbot not running)', async () => {
    const { stdout, exit } = await runHook({
      ROOST_IRC_NICK: 'worker-test',
      ROOST_PERM_SOCK: '/tmp/nonexistent-ask-hook-test.sock',
      ROOST_ASK_CHANNEL: '#ask-channel',
    })
    expect(exit).toBe(0)
    const out = JSON.parse(stdout.trim()) as { hookSpecificOutput: { permissionDecision: string } }
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny')
  }, 5_000)

  it('falls through (exit 0, no stdout) when not configured (no SOCK_PATH)', async () => {
    const { stdout, exit } = await runHook({
      ROOST_IRC_NICK: 'worker-test',
      // ROOST_PERM_SOCK not set → passthrough regardless of channel/target
      ROOST_ASK_CHANNEL: '#ask-channel',
      ROOST_ASK_TARGET: 'operator',
    })
    expect(exit).toBe(0)
    expect(stdout.trim()).toBe('')
  }, 5_000)

  it('falls through when no SOCK_PATH and no target (fully unconfigured)', async () => {
    const { stdout, exit } = await runHook({
      ROOST_IRC_NICK: 'worker-test',
      // neither ROOST_PERM_SOCK nor ROOST_ASK_TARGET → passthrough
    })
    expect(exit).toBe(0)
    expect(stdout.trim()).toBe('')
  }, 5_000)

  it('falls through when tool is not AskUserQuestion', async () => {
    const { stdout, exit } = await runHook(
      { ROOST_IRC_NICK: 'worker-test' },
      JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }),
    )
    expect(exit).toBe(0)
    expect(stdout.trim()).toBe('')
  }, 5_000)

  it('returns deny when operator replies with chat keyword', async () => {
    const sockPath = makeSock()
    const stub = startPermbotStub(sockPath, { reply: 'chat' })
    await stub.ready

    const [{ stdout }] = await Promise.all([
      runHook({
        ROOST_IRC_NICK: 'worker-test',
        ROOST_PERM_SOCK: sockPath,
        ROOST_ASK_CHANNEL: '#ask-channel',
      }),
      stub.done,
    ])

    const out = JSON.parse(stdout.trim()) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason?: string } }
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('chat')
  }, 10_000)

  it('passes the questions array through to updatedInput', async () => {
    const sockPath = makeSock()
    const stub = startPermbotStub(sockPath, { reply: 'Vue' })
    await stub.ready

    const [{ stdout }] = await Promise.all([
      runHook({
        ROOST_IRC_NICK: 'worker-test',
        ROOST_PERM_SOCK: sockPath,
        ROOST_ASK_CHANNEL: '#ask-channel',
      }),
      stub.done,
    ])

    const out = JSON.parse(stdout.trim()) as { hookSpecificOutput: { updatedInput: { questions: unknown[] } } }
    expect(Array.isArray(out.hookSpecificOutput.updatedInput.questions)).toBe(true)
    expect(out.hookSpecificOutput.updatedInput.questions.length).toBe(1)
  }, 10_000)
})
