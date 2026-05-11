// GhBase — shared scaffolding for the two GitHub plugins (PRs, issues).
// Owns the agent-login set, the `<issue-channel> + entry.channels` collector,
// and the convention that every GhBase plugin reads its watch list from a
// `{ watched?: WatchedEntry[] }` slice under `config.plugins[name]`. Channel
// resolution + default-channel fallback come from BasePlugin.
import type { OrchestratorConfig, WatchedEntry } from '../../config.js'
import { resolveRepoEntry } from '../../config.js'
import { defaultProject, issueChannel } from '../../naming.js'
import { BasePlugin } from '../../plugin.js'

interface GhPluginConfig {
  watched?: WatchedEntry[]
}

export abstract class GhBase extends BasePlugin {
  protected agentLogins(config: OrchestratorConfig): Set<string> {
    return new Set(config.agent_logins ?? [])
  }

  // The plugin's `watched` list from `config.plugins[name].watched` — the
  // shared shape for every GhBase plugin.
  protected watched(config: OrchestratorConfig): WatchedEntry[] {
    return this.pluginConfig<GhPluginConfig>(config)?.watched ?? []
  }

  // No watches → no project lookup (avoids requiring `project`/`repo` on
  // minimal configs).
  protected entryChannels(config: OrchestratorConfig, entries: WatchedEntry[] | undefined): string[] {
    if (!entries?.length) return []
    const project = defaultProject(config)
    const chans = new Set<string>()
    for (const entry of entries) {
      const { number, channels } = resolveRepoEntry(entry, config.repo)
      chans.add(issueChannel(project, number))
      for (const c of channels) chans.add(c)
    }
    return [...chans]
  }
}
