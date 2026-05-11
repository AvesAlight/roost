import { mkdir, rename, unlink } from 'node:fs/promises'
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
