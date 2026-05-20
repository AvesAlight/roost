import { mkdir, rename, unlink, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

// Schema version 3: GitHub plugin split into Prs/Issues; each owns its
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
    // Allowlist of nicks permitted to DM the dispatcher with watch/unwatch
    // commands. When unset, defaults to `[leadPmNick(project), apmNick(project)]`
    // — the lead-pm and APM that drive this project (see naming.ts).
    // Explicit `[]` disables remote control entirely.
    command_senders?: string[]
  }
  // Per-plugin config slice, symmetric with `state.plugins.{name}`. The set
  // of enabled plugins is `Object.keys(plugins)`. Each slice is shaped by
  // the owning plugin — typed locally via BasePlugin.pluginConfig.
  plugins?: Record<string, unknown>
  // External plugin modules to load before `buildPlugins`. Each entry is a
  // path to a module that calls `registerPlugin(name, factory)` at top
  // level. Relative paths resolve against the config directory
  // (`.orchestrator/`); absolute paths pass through unchanged. A failing
  // import is fatal — see docs/PLUGINS.md.
  plugin_paths?: string[]
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

// Two-file split: config.json (tracked, operator/project) + config.local.json
// (gitignored, dispatcher-mutated overlay). loadConfig returns the merged view;
// dispatcher writes never touch config.json. Operators can hand-edit either —
// re-watching a tracked entry is a no-op (idempotent), unwatching one is
// refused (hand-edit config.json to remove). See DISPATCHER.md.

export async function loadConfigBase(stateDir: string): Promise<OrchestratorConfig> {
  const path = join(stateDir, 'config.json')
  const file = Bun.file(path)
  if (!(await file.exists())) throw new Error(`config missing: ${path}`)
  return (await file.json()) as OrchestratorConfig
}

// Per-entry/per-slice repo-mode check shared by plugins that have an
// inheritable repo (e.g. github-prs/github-issues watched entries,
// github-new-issues' slice repo). Throws on violation with a uniform
// error message; plugins call it inside their own `assertRepoMode`.
//
// Mode invariants:
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

// Local-wins on conflict for every field except `plugins.<name>.watched`,
// which is concatenated (both sources contribute live entries). `irc` is
// merged at the field level so operators can override a single nested key
// without restating the whole block.
export function mergeConfigs(base: OrchestratorConfig, local: OrchestratorConfig): OrchestratorConfig {
  const result: OrchestratorConfig = { ...base }
  if (local.project !== undefined) result.project = local.project
  if (local.repo !== undefined) result.repo = local.repo
  if (local.agent_logins !== undefined) result.agent_logins = local.agent_logins
  if (local.plugin_paths !== undefined) result.plugin_paths = local.plugin_paths
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
  const merged = { ...(base as Record<string, unknown>), ...(local as Record<string, unknown>) }
  const baseWatched = (base as Record<string, unknown>).watched
  const localWatched = (local as Record<string, unknown>).watched
  if (Array.isArray(baseWatched) && Array.isArray(localWatched)) {
    merged.watched = [...baseWatched, ...localWatched]
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

// Raw atomic write of config.json. Used by `bin/roost init` and tests —
// dispatcher-side mutations write through mutateConfig (which targets
// config.local.json instead, keeping config.json reviewer-tracked).
export async function writeConfig(stateDir: string, config: OrchestratorConfig): Promise<void> {
  await writeAtomic(stateDir, 'config.json', config)
}

export async function writeLocalConfig(stateDir: string, local: OrchestratorConfig): Promise<void> {
  await writeAtomic(stateDir, 'config.local.json', local)
}

async function writeAtomic(stateDir: string, name: string, value: OrchestratorConfig): Promise<void> {
  await mkdir(stateDir, { recursive: true })
  // tmp must share a filesystem with the target so rename is atomic;
  // os.tmpdir() can be a different mount on macOS.
  const tmp = join(stateDir, `.${name}.${process.pid}.${Date.now()}.tmp`)
  try {
    await Bun.write(tmp, sortedJson(value))
    await rename(tmp, join(stateDir, name))
  } catch (e) {
    try { await unlink(tmp) } catch { /* ignore */ }
    throw e
  }
}

// In-process promise queue — serializes concurrent DM handlers (and any
// future mutators) within the dispatcher process. writeState has no
// equivalent because only the poll loop writes state; config is
// multi-writer once DM handlers land.
// Single-process writer assumption: if a second process writes config
// concurrently, last-writer-wins. Operator hand-edits while the
// dispatcher runs are on the operator.
let configMutex: Promise<void> = Promise.resolve()

// Reads base + local, hands both to the callback, writes only the local
// overlay back. Callers should mutate `local` for any change they want
// persisted; `base` is provided so handlers can re-merge inside the
// callback to see prior in-batch mutations (see dispatcher-dm-handler).
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
// contractual today — `bin/start-dispatcher` reads it for the front-door
// liveness check. `started_at_ms` and `cmdline` are written for operator
// inspection and as the substrate for future tooling (e.g. a shutdown helper)
// — extend with care once a consumer lands.
export const DISPATCHER_PID_FILE = 'dispatcher.pid'

export interface DispatcherPidInfo {
  pid: number
  started_at_ms: number
  cmdline: string
}

// Cross-platform: `ps -p <pid> -o args=` returns the full command line on
// both darwin and linux. Empty string on dead PID. We grep for a substring
// (the config-dir arg) to defend against PID recycle.
async function readPsArgs(pid: number): Promise<string> {
  try {
    const { stdout } = await execFileP('ps', ['-p', String(pid), '-o', 'args='])
    return stdout.trim()
  } catch {
    return ''
  }
}

// signal-0 distinguishes "no such process" (ESRCH) from "process exists but
// you can't signal it" (EPERM, e.g. daemon owned by a different uid). Both
// kill -0 failures look identical in shell, but in TS we can keep the
// safer answer: EPERM means alive, treat as not-ours-but-still-running.
function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// Returns the live dispatcher's PID info if the PID file exists, the PID is
// alive, AND its cmdline includes our stateDir (cheap PID-recycle defense).
// Returns null if no file, file unreadable, PID dead, or cmdline mismatch —
// in any of those cases the caller should clean up and proceed to start.
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
  const args = await readPsArgs(info.pid)
  // cmdline must reference our stateDir to rule out PID recycle. We compare
  // against the absolute path the daemon recorded — if the operator moved
  // the dir, the recorded cmdline still pins identity.
  if (!args.includes(stateDir)) return null
  return info
}

// Write the PID file exclusively (O_EXCL via `wx`). Caller (the daemon) has
// already verified no live dispatcher owns the stateDir. If the file exists
// but is stale (held by no live owner), clean it up and retry once.
//
// Uses node:fs/promises rather than Bun.write because the latter has no
// exclusive-create flag — `wx` is the load-bearing primitive here.
export async function writeDispatcherPid(stateDir: string): Promise<DispatcherPidInfo> {
  await mkdir(stateDir, { recursive: true })
  const path = join(stateDir, DISPATCHER_PID_FILE)
  const info: DispatcherPidInfo = {
    pid: process.pid,
    started_at_ms: Date.now(),
    cmdline: [process.execPath, ...process.argv.slice(1)].join(' '),
  }
  const payload = JSON.stringify(info) + '\n'
  try {
    await writeFile(path, payload, { flag: 'wx' })
    return info
  } catch {
    const existing = await readDispatcherPid(stateDir)
    if (existing) throw new Error(`dispatcher already running (pid ${existing.pid})`)
    // Stale file with no live owner — remove and try once more.
    try { await unlink(path) } catch { /* race with another cleaner */ }
    await writeFile(path, payload, { flag: 'wx' })
    return info
  }
}

export async function removeDispatcherPid(stateDir: string): Promise<void> {
  try { await unlink(join(stateDir, DISPATCHER_PID_FILE)) } catch { /* ignore */ }
}

// Snapshot of channels the dispatcher believes it's joined to, written each
// tick alongside the heartbeat. Operators read this to verify the dispatcher
// is in the channels they expect. Freshness == last successful tick (the
// dispatcher's view at boundary), not "right now" — see DISPATCHER.md.
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
