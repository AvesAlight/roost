import type { OrchestratorConfig } from './config.js'
import type { PluginLogger } from './plugin.js'

// Floor for any poll interval, global or per plugin, so a config value can't
// hammer an API.
export const MIN_INTERVAL_SECONDS = 5

// The daemon loop wakes this often to see whether any plugin is due.
export const LOOP_TICK_MS = 1000

// `irc.interval_seconds`: the interval of every plugin that doesn't set its own.
export function defaultIntervalSeconds(config: OrchestratorConfig): number {
  return Math.max(MIN_INTERVAL_SECONDS, config.irc?.interval_seconds ?? 60)
}

// What a plugin did the last time it ran. A tick that skips the plugin
// re-emits `channels` so its scraped channels aren't parted in between.
export interface PluginSchedule {
  lastRun: number
  channels: string[]
}

// Seconds between runs for `plugin`: its `config.plugins[plugin].interval_seconds`,
// else the default interval. A value that isn't a positive finite number is
// ignored with a log line, so a typo can't silence a plugin.
export function pluginIntervalSeconds(
  config: OrchestratorConfig,
  plugin: string,
  log: PluginLogger,
): number {
  const slice = config.plugins?.[plugin]
  if (slice === null || typeof slice !== 'object') return defaultIntervalSeconds(config)
  const raw = (slice as { interval_seconds?: unknown }).interval_seconds
  if (raw === undefined) return defaultIntervalSeconds(config)
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    log(`orchestrator: plugins.${plugin}.interval_seconds=${JSON.stringify(raw)} is not a positive number, using the default interval\n`)
    return defaultIntervalSeconds(config)
  }
  return Math.max(MIN_INTERVAL_SECONDS, raw)
}

export function pluginIsDue(
  schedule: ReadonlyMap<string, PluginSchedule>,
  plugin: string,
  intervalSeconds: number,
  now: number,
): boolean {
  const last = schedule.get(plugin)
  return !last || now - last.lastRun >= intervalSeconds * 1000
}

// True when at least one plugin is due. The daemon wakes every LOOP_TICK_MS
// and does its per-pass work (config, state, IRC sync, delivery) only then.
export function anyPluginDue(
  plugins: ReadonlyArray<{ name: string }>,
  schedule: ReadonlyMap<string, PluginSchedule>,
  config: OrchestratorConfig,
  now: number,
): boolean {
  const quiet = () => {}
  return plugins.some(p => pluginIsDue(schedule, p.name, pluginIntervalSeconds(config, p.name, quiet), now))
}
