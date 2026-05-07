import { describe, it, expect } from 'bun:test'
import * as net from 'node:net'
import { join } from 'node:path'

const HOOK = join(import.meta.dirname, '../src/permission-prompt.ts')
const PAYLOAD = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'rm /tmp/x', description: 'test' }, transcript_path: '' })

/**
 * Spin up a minimal IRC stub that handles CAP negotiation (RoostIrcClientImpl
 * sends CAP LS before NICK/USER), sends 001 after CAP END, and closes on QUIT.
 */
function captureIRC(): Promise<{ port: number; lines: () => Promise<string[]> }> {
  return new Promise((resolve) => {
    const collected: string[] = []
    let closed!: () => void
    const done = new Promise<string[]>((res) => { closed = () => res(collected) })

    const server = net.createServer((sock) => {
      let buf = '', nick = 'unknown', sentWelcome = false
      sock.on('data', (d) => {
        buf += d.toString()
        const lines = buf.split('\r\n'); buf = lines.pop() ?? ''
        for (const line of lines) {
          if (!line) continue
          if (line.startsWith('CAP LS')) {
            sock.write(':s CAP * LS :\r\n')
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
      })
      sock.on('close', () => { server.close(); closed() })
    })

    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port
      resolve({ port, lines: () => done })
    })
  })
}

async function runHook(env: Record<string, string>): Promise<void> {
  const proc = Bun.spawn(['bun', HOOK], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
    stdin: new TextEncoder().encode(PAYLOAD),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  await proc.exited
}

describe('irc-permission-prompt fallback DM', () => {
  it('sends PRIVMSG to target when daemon unreachable', async () => {
    const { port, lines } = await captureIRC()
    const [received] = await Promise.all([
      lines(),
      runHook({
        ROOST_IRC_NICK: 'worker-test',
        ROOST_PERM_TARGET: 'operator',
        ROOST_PERM_HOST: '127.0.0.1',
        ROOST_PERM_PORT: String(port),
        // no ROOST_PERM_SOCK → daemon unreachable path
      }),
    ])
    const privmsgs = received.filter(l => l.startsWith('PRIVMSG operator :'))
    expect(privmsgs.length).toBeGreaterThan(0)
    expect(privmsgs.some(m => m.includes('fallback'))).toBe(true)
    expect(privmsgs.some(m => m.includes('Bash'))).toBe(true)
  }, 15_000)

  it('skips DM when ROOST_PERM_TARGET not set', async () => {
    let connected = false
    const server = net.createServer(() => { connected = true })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as net.AddressInfo).port

    await runHook({
      ROOST_IRC_NICK: 'worker-test',
      ROOST_PERM_HOST: '127.0.0.1',
      ROOST_PERM_PORT: String(port),
      // no ROOST_PERM_TARGET
    })
    await Bun.sleep(100)
    server.close()
    expect(connected).toBe(false)
  })
})
