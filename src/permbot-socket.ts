import * as fs from 'node:fs'
import * as net from 'node:net'

export type PermBotKind = 'permission' | 'question'

export const CHAT_KEYWORDS = new Set(['chat', 'skip', 'cancel'])

export function permbotNickFor(nick: string): string { return `permbot-${nick}` }

/** Connect to the permbot unix socket, send a JSON request, await the response.
 *  Returns the raw `reply` string, or null on missing socket / timeout / error. */
export async function socketRoundtrip(
  sockPath: string,
  req: Record<string, unknown>,
  logError?: (msg: string) => void,
): Promise<string | null> {
  if (!sockPath || !fs.existsSync(sockPath)) return null
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
        if (resp['timeout']) { resolve(null); return }
        if (resp['error']) { logError?.(`daemon error: ${resp['error']}`); resolve(null); return }
        resolve(String(resp['reply'] ?? ''))
      } catch (e) {
        logError?.(`bad daemon response: ${e}`)
        resolve(null)
      }
    })
    sock.on('timeout', () => { sock.destroy(); resolve(null) })
    sock.on('error', (e) => { logError?.(`connect ${sockPath} failed: ${e}`); resolve(null) })
  })
}
