import { describe, it, expect } from 'bun:test'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { summarize, extractIntent } from '../src/permission-prompt.js'

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

  it('returns Agent prompt prefixed with label when sub-agent is active (same turn as text)', () => {
    const tmp = path.join(os.tmpdir(), `transcript-${process.pid}-sa1.jsonl`)
    const turn = {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Now spawning the Haiku agent.' },
          { type: 'tool_use', id: 'tu_001', name: 'Agent', input: { prompt: 'Run the test suite and report failures.', description: 'run tests' } },
        ],
      },
    }
    fs.writeFileSync(tmp, JSON.stringify(turn) + '\n')
    try {
      const result = extractIntent(tmp)
      expect(result).toContain('[sub-agent: run tests]')
      expect(result).toContain('Run the test suite')
      expect(result).not.toContain('Now spawning')
    } finally {
      fs.unlinkSync(tmp)
    }
  })

  it('returns Agent prompt when active Agent is in a more recent turn than last text', () => {
    const tmp = path.join(os.tmpdir(), `transcript-${process.pid}-sa2.jsonl`)
    const lines = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Doing analysis.' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_002', name: 'Agent', input: { prompt: 'Investigate the crash logs.', description: 'crash investigation' } }] } }),
    ]
    fs.writeFileSync(tmp, lines.join('\n') + '\n')
    try {
      const result = extractIntent(tmp)
      expect(result).toContain('[sub-agent: crash investigation]')
      expect(result).toContain('Investigate the crash logs')
    } finally {
      fs.unlinkSync(tmp)
    }
  })

  it('falls back to parent text when Agent tool_use has a matching tool_result (completed)', () => {
    const tmp = path.join(os.tmpdir(), `transcript-${process.pid}-sa3.jsonl`)
    const lines = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Spawning agent to check docs.' }, { type: 'tool_use', id: 'tu_003', name: 'Agent', input: { prompt: 'Summarize the README.' } }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_003', content: 'done' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Now writing the report.' }] } }),
    ]
    fs.writeFileSync(tmp, lines.join('\n') + '\n')
    try {
      const result = extractIntent(tmp)
      expect(result).toBe('Now writing the report.')
      expect(result).not.toContain('sub-agent')
    } finally {
      fs.unlinkSync(tmp)
    }
  })

  it('uses [sub-agent] label without description when Agent input has no description', () => {
    const tmp = path.join(os.tmpdir(), `transcript-${process.pid}-sa4.jsonl`)
    const turn = {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'tu_004', name: 'Agent', input: { prompt: 'Do the work.' } },
        ],
      },
    }
    fs.writeFileSync(tmp, JSON.stringify(turn) + '\n')
    try {
      const result = extractIntent(tmp)
      expect(result).toMatch(/^\[sub-agent\] Do the work\./)
    } finally {
      fs.unlinkSync(tmp)
    }
  })
})

// ---- hook integration (subprocess) -----------------------------------------

/**
 * Spin up a minimal IRC stub that handles CAP negotiation (needed by
 * RoostIrcClientImpl which sends CAP LS before NICK/USER). Sends 001 after
 * CAP END is received, collects all lines until the connection closes.
 */
function captureIRC(): Promise<{ port: number; lines: () => Promise<string[]> }> {
  return new Promise((resolve) => {
    const collected: string[] = []
    let closed!: () => void
    const done = new Promise<string[]>(res => { closed = () => res(collected) })
    const server = net.createServer((sock) => {
      let buf = ''
      let nick = 'unknown'
      let sentWelcome = false
      sock.on('data', (d) => {
        buf += d.toString()
        for (const line of buf.split('\r\n').slice(0, -1)) {
          if (line.startsWith('CAP LS')) {
            sock.write(':s CAP * LS :\r\n')  // advertise no caps
          } else if (line.startsWith('CAP END') && !sentWelcome) {
            sentWelcome = true
            sock.write(`:s 001 ${nick} :Welcome\r\n`)
          } else if (line.startsWith('NICK ')) {
            nick = line.slice(5).trim()
          } else if (line.startsWith('QUIT')) {
            sock.end()
          }
          collected.push(line)
        }
        buf = buf.slice(buf.lastIndexOf('\r\n') + 2)
      })
      sock.on('close', () => { server.close(); closed() })
    })
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port
      resolve({ port, lines: () => done })
    })
  })
}

const PAYLOAD = JSON.stringify({
  tool_name: 'Bash',
  tool_input: { command: 'rm /tmp/x', description: 'delete temp file' },
  transcript_path: '',
})

async function runHook(env: Record<string, string>): Promise<{ stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', HOOK], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
    stdin: new TextEncoder().encode(PAYLOAD),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  await proc.exited
  return {
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
  }
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
})
