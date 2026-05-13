import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'

// Bumped to 3 in #116 — split GitHub plugin into Prs/Issues, each owns its
// own state slice. Schema bumps trigger a one-time re-seed via loadState().
export const SCHEMA_VERSION = 3

export interface WatchedEntry {
  repo?: string
  number: number
  channels?: string[]
}

export interface OrchestratorConfig {
  // See src/orchestrator/naming.ts for shape + fallback rules.
  project?: string
  repo?: string
  agent_logins?: string[]
  irc?: {
    nick?: string
    project_channel?: string
    server?: string
    port?: number
    interval_seconds?: number
  }
  // Per-plugin config slice, symmetric with `state.plugins.{name}`. The set
  // of enabled plugins is `Object.keys(plugins)`. Each slice is shaped by
  // the owning plugin — typed locally via BasePlugin.pluginConfig.
  plugins?: Record<string, unknown>
}

export interface OrchestratorState {
  schema_version: number
  generated_at: string
  plugins: Record<string, unknown>
}

function sortedJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      )
    }
    return v
  }, 2) + '\n'
}

export async function loadConfig(stateDir: string): Promise<OrchestratorConfig> {
  const path = join(stateDir, 'config.json')
  const file = Bun.file(path)
  if (!(await file.exists())) throw new Error(`config missing: ${path}`)
  return file.json() as Promise<OrchestratorConfig>
}

export async function loadState(stateDir: string): Promise<OrchestratorState | null> {
  const path = join(stateDir, 'state.json')
  const file = Bun.file(path)
  if (!(await file.exists())) return null
  const text = (await file.text()).trim()
  if (!text) return null
  const state = JSON.parse(text) as OrchestratorState
  if (state.schema_version !== SCHEMA_VERSION) {
    process.stderr.write(
      `state.json schema mismatch: got ${state.schema_version}, expected ${SCHEMA_VERSION}; re-seeding.\n`
    )
    return null
  }
  return state
}

export async function writeState(stateDir: string, state: OrchestratorState): Promise<void> {
  await mkdir(stateDir, { recursive: true })
  const tmp = join(stateDir, `.state.${process.pid}.${Date.now()}.tmp`)
  try {
    await Bun.write(tmp, sortedJson(state))
    await rename(tmp, join(stateDir, 'state.json'))
  } catch (e) {
    try { await unlink(tmp) } catch { /* ignore */ }
    throw e
  }
}

// Raw atomic write. Use mutateConfig for any read-modify-write — it
// serializes concurrent callers via the advisory lock.
export async function writeConfig(stateDir: string, config: OrchestratorConfig): Promise<void> {
  await mkdir(stateDir, { recursive: true })
  const tmp = join(stateDir, `.config.${process.pid}.${Date.now()}.tmp`)
  try {
    await Bun.write(tmp, sortedJson(config))
    await rename(tmp, join(stateDir, 'config.json'))
  } catch (e) {
    try { await unlink(tmp) } catch { /* ignore */ }
    throw e
  }
}

// File-based lock rather than an in-memory mutex because cross-process writers
// (operator scripts, future second dispatcher) need the same guarantee.
async function acquireConfigLock(stateDir: string): Promise<() => Promise<void>> {
  const lockPath = join(stateDir, 'config.lock')
  const deadline = Date.now() + 5000
  let holderPid: number | undefined
  while (true) {
    try {
      const fh = await open(lockPath, 'wx')
      try {
        await fh.writeFile(`${process.pid}\n`)
      } finally {
        await fh.close()
      }
      return async () => { try { await unlink(lockPath) } catch { /* ignore */ } }
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      // Stale lock check: if PID is dead, clear and retry immediately.
      try {
        const content = await readFile(lockPath, 'utf8')
        const parsed = parseInt(content.trim(), 10)
        holderPid = parsed > 0 ? parsed : undefined
        if (holderPid) {
          let alive = true
          try { process.kill(holderPid, 0) } catch { alive = false }
          if (!alive) { await unlink(lockPath); continue }
        }
      } catch { /* unreadable — fall through to retry */ }
      if (Date.now() >= deadline) throw new Error(`config lock timed out (held by pid ${holderPid ?? '?'}): ${lockPath}`)
      await new Promise(r => setTimeout(r, 15 + Math.floor(Math.random() * 11)))
    }
  }
}

// Serializes concurrent DM handlers (and any other future mutators) via an
// advisory file lock. writeState has no equivalent because only the poll loop
// writes state; config is multi-writer once DM handlers land.
export async function mutateConfig(
  stateDir: string,
  fn: (config: OrchestratorConfig) => void | Promise<void>
): Promise<void> {
  const release = await acquireConfigLock(stateDir)
  try {
    const config = await loadConfig(stateDir)
    await fn(config)
    await writeConfig(stateDir, config)
  } finally {
    await release()
  }
}

export async function writeHeartbeat(stateDir: string): Promise<void> {
  await mkdir(stateDir, { recursive: true })
  await Bun.write(join(stateDir, 'last-tick.txt'), new Date().toISOString() + '\n')
}

export async function writeLastError(stateDir: string, tb: string): Promise<void> {
  try {
    await mkdir(stateDir, { recursive: true })
    await Bun.write(join(stateDir, 'last-error.txt'), tb)
  } catch { /* best-effort */ }
}

export async function clearLastError(stateDir: string): Promise<void> {
  try { await unlink(join(stateDir, 'last-error.txt')) } catch { /* ignore if missing */ }
}

export function resolveRepoEntry(entry: WatchedEntry, defaultRepo?: string): { repo: string; number: number; channels: string[] } {
  const repo = entry.repo ?? defaultRepo
  if (!repo) throw new Error(`watched entry missing repo: ${JSON.stringify(entry)}`)
  return { repo, number: entry.number, channels: entry.channels ?? [] }
}

export function getPluginState<T>(state: OrchestratorState | null, pluginName: string): T | null {
  if (!state) return null
  const slice = state.plugins?.[pluginName]
  return (slice as T) ?? null
}
