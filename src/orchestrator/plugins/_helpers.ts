// Bookkeeping plugins commonly need: failure reporting, seen ids, the per-tick post cap,
// and a spawn-with-timeout runner. Pure functions apart from the runner; the plugin keeps
// its own state shape, log lines and message text.
import type { PluginMessage } from '../plugin.js'

export type Say = (text: string) => PluginMessage

// One post per distinct failure. `prevError` is what the plugin last reported (null when
// healthy). Returns the error to store and the messages to send.
export function noteFailure(
  prevError: string | null, why: string, say: Say, failText: (why: string) => string,
): { error: string; messages: PluginMessage[] } {
  return { error: why, messages: prevError === why ? [] : [say(failText(why))] }
}

// One post when a failing source reads again.
export function noteRecovery(prevError: string | null, say: Say, text: string): PluginMessage[] {
  return prevError ? [say(text)] : []
}

// Ids already handled, newest first: this read's ids, then older ones it didn't repeat.
export function mergeSeen(ids: string[], prevSeen: string[], max: number): string[] {
  return [...ids, ...prevSeen.filter(id => !ids.includes(id))].slice(0, max)
}

// At most `max` posts for a batch, in the order given, then one line counting the rest.
export function capPosts<T>(
  items: T[], max: number, render: (item: T) => string, moreText: (n: number) => string, say: Say,
): PluginMessage[] {
  const out = items.slice(0, max).map(i => say(render(i)))
  if (items.length > max) out.push(say(moreText(items.length - max)))
  return out
}

export interface RunResult {
  code: number
  stdout: string
  stderr: string
  timedOut?: boolean
}
export type Runner = (args: string[]) => Promise<RunResult>

// Real runner. Args go straight to the binary, never through a shell.
export function runWithTimeout(timeoutMs: number, bin: string): Runner {
  return async (args) => {
    const proc = Bun.spawn([bin, ...args], { stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs })
    // Drain both pipes while it runs so a big result can't fill one and stall the process.
    const stdout = new Response(proc.stdout).text()
    const stderr = new Response(proc.stderr).text()
    const code = await proc.exited
    // Any signal kill (the timeout's included) is reported as timedOut. Don't wait on its
    // pipes after that: a child it left behind can hold them open.
    if (proc.signalCode !== null) return { code, stdout: '', stderr: '', timedOut: true }
    return { code, stdout: await stdout, stderr: await stderr, timedOut: false }
  }
}
