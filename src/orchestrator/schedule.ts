import type { OrchestratorConfig } from './config.js'
import type { PluginLogger } from './plugin.js'

// Same floor as the global tick, so a per-plugin value can't poll faster than
// the dispatcher is willing to.
export const MIN_INTERVAL_SECONDS = 5

// What a plugin did the last time it ran. A tick that skips the plugin
// re-emits `channels` so its scraped channels aren't parted in between.
export interface PluginSchedule {
  lastRun: number
  channels: string[]
}

// Seconds between runs for `plugin`, from `config.plugins[plugin].interval_seconds`.
// Undefined means "every tick". A value that isn't a positive finite number is
// ignored with a log line, so a typo can't silence a plugin.
export function pluginIntervalSeconds(
  config: OrchestratorConfig,
  plugin: string,
  log: PluginLogger,
): number | undefined {
  const slice = config.plugins?.[plugin]
  if (slice === null || typeof slice !== 'object') return undefined
  const raw = (slice as { interval_seconds?: unknown }).interval_seconds
  if (raw === undefined) return undefined
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    log(`orchestrator: plugins.${plugin}.interval_seconds=${JSON.stringify(raw)} is not a positive number, using the global tick\n`)
    return undefined
  }
  return Math.max(MIN_INTERVAL_SECONDS, raw)
}

export function pluginIsDue(
  schedule: ReadonlyMap<string, PluginSchedule>,
  plugin: string,
  intervalSeconds: number | undefined,
  now: number,
): boolean {
  const last = schedule.get(plugin)
  if (!last || intervalSeconds === undefined) return true
  return now - last.lastRun >= intervalSeconds * 1000
}
