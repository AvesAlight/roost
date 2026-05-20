import { mkdir, rename, unlink, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { exclusiveCreate } from '../fs-lock.js'

const execFileP = promisify(execFile)

// Bump triggers a one-time re-seed via loadState().
export const SCHEMA_VERSION = 4

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
    // Unset → `[leadPmNick(project), apmNick(project)]`. Explicit `[]` disables DMs.
    command_senders?: string[]
  }
  plugins?: Record<string, unknown>
  // External plugin modules loaded before `buildPlugins`; each module calls
  // `registerPlugin` at top level. Relative paths resolve against the config
  // directory. See docs/PLUGINS.md.
  plugin_paths?: string[]
  // Operator override for grammar-claim ordering — higher wins. Replaces the
  // plugin's static `grammarPriority` outright (no max/sum). Used when two
  // plugins overlap on a shape (e.g. a 3rd-party plugin claiming `watch <N>`
  // alongside `github-issues`). See `Plugin.parseCommand`.
  plugin_priorities?: Record<string, number>
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

// Two-file split (config.json tracked + config.local.json overlay) — see DISPATCHER.md.

export async function loadConfigBase(stateDir: string): Promise<OrchestratorConfig> {
  const path = join(stateDir, 'config.json')
  const file = Bun.file(path)
  if (!(await file.exists())) throw new Error(`config missing: ${path}`)
  return (await file.json()) as OrchestratorConfig
}

// Tracked-only; see `Plugin.assertRepoMode` for rationale. Mode invariants:
//   single-repo (topRepo set):   entryRepo must be absent or equal topRepo.
//   multi-repo  (topRepo unset): entryRepo must be set — no inherit target.
export function assertEntryRepoMode(
  pluginName: string,
  entryId: string,
  entryRepo: string | undefined,
  topRepo: string | undefined,
): void {
  if (topRepo) {
    if (entryRepo != null && entryRepo !== topRepo) {
      throw new Error(
        `single-repo mode (config.repo=${topRepo}) but ${pluginName} ${entryId} pins repo=${entryRepo}; remove or align`
      )
    }
  } else {
    if (!entryRepo) {
      throw new Error(
        `multi-repo mode (no config.repo) requires repo on every entry — ${pluginName} ${entryId} is missing one`
      )
    }
  }
}

export async function loadLocalOverlay(stateDir: string): Promise<OrchestratorConfig> {
  const path = join(stateDir, 'config.local.json')
  const file = Bun.file(path)
  if (!(await file.exists())) return {}
  return file.json() as Promise<OrchestratorConfig>
}

export async function loadConfig(stateDir: string): Promise<OrchestratorConfig> {
  const [base, local] = await Promise.all([loadConfigBase(stateDir), loadLocalOverlay(stateDir)])
  return mergeConfigs(base, local)
}

// Local-wins for every field except `plugins.<name>.watched` (concatenated)
// and `irc` (field-level merge).
export function mergeConfigs(base: OrchestratorConfig, local: OrchestratorConfig): OrchestratorConfig {
  const result: OrchestratorConfig = { ...base }
  if (local.project !== undefined) result.project = local.project
  if (local.repo !== undefined) result.repo = local.repo
  if (local.agent_logins !== undefined) result.agent_logins = local.agent_logins
  if (local.plugin_paths !== undefined) result.plugin_paths = local.plugin_paths
  if (local.plugin_priorities !== undefined) result.plugin_priorities = local.plugin_priorities
  if (base.irc !== undefined || local.irc !== undefined) {
    result.irc = { ...base.irc, ...local.irc }
  }
  if (base.plugins !== undefined || local.plugins !== undefined) {
    const merged: Record<string, unknown> = {}
    const names = new Set([
      ...Object.keys(base.plugins ?? {}),
      ...Object.keys(local.plugins ?? {}),
    ])
    for (const name of names) {
      const b = base.plugins?.[name]
      const l = local.plugins?.[name]
      merged[name] = mergePluginSlice(b, l)
    }
    result.plugins = merged
  }
  return result
}

function mergePluginSlice(base: unknown, local: unknown): unknown {
  if (base == null) return local
  if (local == null) return base
  if (typeof base !== 'object' || typeof local !== 'object' || Array.isArray(base) || Array.isArray(local)) {
    return local
  }
  // structuredClone the concatenated entries so a plugin mutating the merged
  // view can't reach back into base/local — the contract is "mutate local only".
  const merged = { ...(base as Record<string, unknown>), ...(local as Record<string, unknown>) }
  const baseWatched = (base as Record<string, unknown>).watched
  const localWatched = (local as Record<string, unknown>).watched
  if (Array.isArray(baseWatched) && Array.isArray(localWatched)) {
    merged.watched = structuredClone([...baseWatched, ...localWatched])
  }
  return merged
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
  await writeAtomicJson(stateDir, 'state.json', state)
}

// `bin/roost init` and tests write config.json directly — dispatcher mutations
// go through mutateConfig (which targets config.local.json).
export async function writeConfig(stateDir: string, config: OrchestratorConfig): Promise<void> {
  await writeAtomicJson(stateDir, 'config.json', config)
}

export async function writeLocalConfig(stateDir: string, local: OrchestratorConfig): Promise<void> {
  await writeAtomicJson(stateDir, 'config.local.json', local)
}

// tmp must share a filesystem with the target so rename is atomic — os.tmpdir()
// can be a different mount on macOS.
async function writeAtomicJson(stateDir: string, name: string, value: unknown): Promise<void> {
  await mkdir(stateDir, { recursive: true })
  const tmp = join(stateDir, `.${name}.${process.pid}.${Date.now()}.tmp`)
  try {
    await Bun.write(tmp, sortedJson(value))
    await rename(tmp, join(stateDir, name))
  } catch (e) {
    try { await unlink(tmp) } catch { /* ignore */ }
    throw e
  }
}

// In-process serialization of concurrent DM mutations. Cross-process writes
// are last-writer-wins — operator hand-edits during a live dispatcher are on the operator.
let configMutex: Promise<void> = Promise.resolve()

// Reads base+local, hands both to `fn`, writes only the local overlay.
// `base` lets handlers re-merge mid-batch for in-batch idempotency.
export async function mutateConfig(
  stateDir: string,
  fn: (base: OrchestratorConfig, local: OrchestratorConfig) => void | Promise<void>
): Promise<void> {
  const prev = configMutex
  let release!: () => void
  configMutex = new Promise(r => { release = r })
  try {
    await prev.catch(() => {})
    const [base, local] = await Promise.all([loadConfigBase(stateDir), loadLocalOverlay(stateDir)])
    // Freeze base so an accidental mutation in `fn` throws at the bug site
    // (only `local` is persisted). Shallow is enough — nested slices reached
    // from base arrive through the cloned merged view (see mergePluginSlice).
    Object.freeze(base)
    await fn(base, local)
    await writeLocalConfig(stateDir, local)
  } finally {
    release()
  }
}

export async function writeHeartbeat(stateDir: string): Promise<void> {
  await mkdir(stateDir, { recursive: true })
  await Bun.write(join(stateDir, 'last-tick.txt'), new Date().toISOString() + '\n')
}

// Dispatcher PID file. JSON `{pid, started_at_ms, cmdline}`. Only `pid` is
// contractual today; `bin/start-dispatcher` reads it for the liveness check.
export const DISPATCHER_PID_FILE = 'dispatcher.pid'

export interface DispatcherPidInfo {
  pid: number
  started_at_ms: number
  cmdline: string
}

// Full command line on darwin and linux; empty on dead PID.
async function readPsArgs(pid: number): Promise<string> {
  try {
    const { stdout } = await execFileP('ps', ['-p', String(pid), '-o', 'args='])
    return stdout.trim()
  } catch {
    return ''
  }
}

// signal-0 distinguishes ESRCH (dead) from EPERM (alive but owned by another uid).
function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// PID info iff the file exists, the PID is alive, AND its cmdline includes
// stateDir (PID-recycle defense). Null on any miss.
export async function readDispatcherPid(stateDir: string): Promise<DispatcherPidInfo | null> {
  const path = join(stateDir, DISPATCHER_PID_FILE)
  let raw: string
  try { raw = await readFile(path, 'utf8') } catch { return null }
  let info: DispatcherPidInfo
  try {
    info = JSON.parse(raw) as DispatcherPidInfo
    if (typeof info.pid !== 'number') return null
  } catch { return null }
  if (!isAlive(info.pid)) return null
  // cmdline must reference our stateDir to rule out PID recycle.
  const args = await readPsArgs(info.pid)
  if (!args.includes(stateDir)) return null
  return info
}

// Stale file (no live owner) → unlink and retry once.
export async function writeDispatcherPid(stateDir: string): Promise<DispatcherPidInfo> {
  await mkdir(stateDir, { recursive: true })
  const path = join(stateDir, DISPATCHER_PID_FILE)
  const info: DispatcherPidInfo = {
    pid: process.pid,
    started_at_ms: Date.now(),
    cmdline: [process.execPath, ...process.argv.slice(1)].join(' '),
  }
  const payload = JSON.stringify(info) + '\n'
  const result = await exclusiveCreate(path, payload)
  if (!result.created) {
    const existing = await readDispatcherPid(stateDir)
    if (existing) throw new Error(`dispatcher already running (pid ${existing.pid})`)
    // Stale file with no live owner — remove and try once more.
    try { await unlink(path) } catch { /* race with another cleaner */ }
    const retry = await exclusiveCreate(path, payload)
    if (!retry.created) {
      // Lost retry race — a concurrent dispatcher just claimed this dir.
      const winner = await readDispatcherPid(stateDir)
      if (winner) throw new Error(`dispatcher already running (pid ${winner.pid})`)
    }
  }
  return info
}

export async function removeDispatcherPid(stateDir: string): Promise<void> {
  try { await unlink(join(stateDir, DISPATCHER_PID_FILE)) } catch { /* ignore */ }
}

// Per-tick snapshot of joined channels. Freshness == last successful tick,
// not "right now" — see DISPATCHER.md.
export async function writeJoinedChannels(stateDir: string, channels: string[]): Promise<void> {
  await mkdir(stateDir, { recursive: true })
  const body = channels.length ? channels.join('\n') + '\n' : ''
  await Bun.write(join(stateDir, 'joined-channels.txt'), body)
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
