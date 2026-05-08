// GhBase — shared scaffolding for the two GitHub plugins (PRs, issues).
// Owns nothing except a tiny ergonomic surface: agent-login set, default repo,
// and a shared helper for collecting `#issue-N + entry.channels` from a
// WatchedEntry list. Channel resolution + default-channel fallback come from
// BasePlugin.
import type { OrchestratorConfig, WatchedEntry } from '../../config.js'
import { resolveRepoEntry } from '../../config.js'
import { BasePlugin } from '../../plugin.js'

export abstract class GhBase extends BasePlugin {
  protected agentLogins(config: OrchestratorConfig): Set<string> {
    return new Set(config.agent_logins ?? [])
  }

  // Static channel set for a list of watched entries: `#issue-N` for each
  // entry, plus the entry's declared channels. Used for boot-time joins.
  protected entryChannels(entries: WatchedEntry[] | undefined, defaultRepo: string | undefined): string[] {
    const chans = new Set<string>()
    for (const entry of entries ?? []) {
      const { number, channels } = resolveRepoEntry(entry, defaultRepo)
      chans.add(`#issue-${number}`)
      for (const c of channels) chans.add(c)
    }
    return [...chans]
  }
}
