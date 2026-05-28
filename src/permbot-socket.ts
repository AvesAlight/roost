import * as fs from 'node:fs'
import * as net from 'node:net'

export type PermBotKind = 'permission' | 'question'

export const CHAT_KEYWORDS = new Set(['chat', 'skip', 'cancel'])

export function permbotNickFor(nick: string): string { return `permbot-${nick}` }

/** Human-readable cause for an IRC registration rejection, with a remediation
 *  hint. Shared by the permbot daemon (deny reason + log) and the hook's
 *  pnotify fallback (log). The 432 hint names nicklen because an over-long
 *  derived nick is the dominant cause in this system. */
export function describeNickReject(c: { code?: number; nick?: string; reason?: string }): string {
  const code = c.code ?? '?'
  const reason = c.reason?.trim()
    || (c.code === 432 ? 'Erroneous nickname' : c.code === 433 ? 'Nickname in use' : 'registration rejected')
  const nick = c.nick || '(unknown)'
  const len = c.nick ? ` (${c.nick.length} chars)` : ''
  const hint = c.code === 432
    ? ' — likely exceeds the server nicklen; raise limits.nicklen in ergo.yaml if the nick exceeds it, then respawn the agent (a wedged permbot cannot self-heal)'
    : c.code === 433
      ? ' — nick already held by another client; respawn the agent'
      : ''
  return `${code} ${reason} for nick '${nick}'${len}${hint}`
}

/** Outcome of a permbot socket round-trip.
 *  - reply: operator answered (raw text).
 *  - unreachable: the daemon is up but its IRC link never registered (432, etc.);
 *    cause carries the reason. Callers fail closed — there's no point retrying.
 *  - timeout: the in-flight prompt expired with no operator answer.
 *  - unavailable: no socket, connect/parse failure, or a non-fatal daemon error. */
export type DaemonResponse =
  | { kind: 'reply'; reply: string }
  | { kind: 'unreachable'; cause: string }
  | { kind: 'timeout' }
  | { kind: 'unavailable' }

/** Connect to the permbot unix socket, send a JSON request, await the response. */
export async function socketRoundtrip(
  sockPath: string,
  req: Record<string, unknown>,
  logError?: (msg: string) => void,
): Promise<DaemonResponse> {
  if (!sockPath || !fs.existsSync(sockPath)) return { kind: 'unavailable' }
  return new Promise((resolve) => {
    const sock = net.createConnection(sockPath)
    const timeoutMs = Number(req['timeout'] ?? 30) * 1000
    sock.setTimeout(timeoutMs)
    let buf = ''
    sock.on('connect', () => sock.write(JSON.stringify(req) + '\n'))
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      if (!buf.includes('\n')) return
      const line = buf.split('\n')[0]
      sock.destroy()
      try {
        const resp = JSON.parse(line) as Record<string, unknown>
        if (resp['unreachable']) { resolve({ kind: 'unreachable', cause: String(resp['error'] ?? 'permbot unreachable') }); return }
        if (resp['timeout']) { resolve({ kind: 'timeout' }); return }
        if (resp['error']) { logError?.(`daemon error: ${resp['error']}`); resolve({ kind: 'unavailable' }); return }
        resolve({ kind: 'reply', reply: String(resp['reply'] ?? '') })
      } catch (e) {
        logError?.(`bad daemon response: ${e}`)
        resolve({ kind: 'unavailable' })
      }
    })
    sock.on('timeout', () => { sock.destroy(); resolve({ kind: 'unavailable' }) })
    sock.on('error', (e) => { logError?.(`connect ${sockPath} failed: ${e}`); resolve({ kind: 'unavailable' }) })
  })
}
