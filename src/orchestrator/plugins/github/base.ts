import type { Command } from '../../dm-handler.js'
import type { OrchestratorConfig, WatchedEntry } from '../../config.js'
import { resolveRepoEntry } from '../../config.js'
import { defaultProject, issueChannel } from '../../naming.js'
import { BasePlugin, defaultPluginLogger, type PluginLogger } from '../../plugin.js'
import { GhClient } from './github-api.js'

// Thin shared base for any plugin that needs GhClient but not watch-list
// scaffolding. GhBase extends this; non-watching plugins (e.g.
// GitHubNewIssuesPlugin) extend it directly.
export abstract class GhPluginBase extends BasePlugin {
  protected readonly client: GhClient

  constructor(defaultChannel: string, log: PluginLogger = defaultPluginLogger) {
    super(defaultChannel)
    this.client = new GhClient(log)
  }

  protected agentLogins(config: OrchestratorConfig): Set<string> {
    return new Set(config.agent_logins ?? [])
  }
}

interface GhPluginConfig {
  watched?: WatchedEntry[]
}

// Watch-list scaffolding for the two GitHub plugins (PRs, issues). Owns the
// `<issue-channel> + entry.channels` collector, `{ watched?: WatchedEntry[] }`
// slice convention, and `handleCommand` for watch/unwatch/list/help.
// Each subclass declares the target keyword it claims and a singular label.
export abstract class GhBase extends GhPluginBase {
  // Target keyword this plugin claims for watch/unwatch. `null` = no keyword
  // (bare `watch <N>`). The dispatcher's parser is target-agnostic; plugins
  // declare which keyword (if any) they own here.
  protected abstract readonly target: string | null
  // Singular noun used in reply lines (e.g. "issue", "pr"). Plural is the
  // plugin name slice.
  protected abstract readonly label: string

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

  // ---- DM command handling --------------------------------------------

  // Inbound DM command surface. The dispatcher (dm-handler.ts) calls this
  // once per parsed command inside its mutateConfig pass — we mutate our
  // own slice in place. Returns the reply line(s) when we handle the
  // command, null when the command isn't ours. Never throws.
  handleCommand(config: OrchestratorConfig, cmd: Command): string | null {
    if (cmd.kind === 'list') return this.formatListSection(config)
    if (cmd.kind === 'help') return this.formatHelpSection()
    if (cmd.kind === 'watch') {
      if (cmd.target !== this.target) return null
      return this.applyWatch(config, cmd.number, cmd.channels)
    }
    if (cmd.kind === 'unwatch') {
      if (cmd.target !== this.target) return null
      return this.applyUnwatch(config, cmd.number)
    }
    return null
  }

  // Read-or-create the typed slice under `config.plugins[name]`. Plugins
  // own their slice shape; this is the one mutation seam.
  private slice(config: OrchestratorConfig): GhPluginConfig {
    config.plugins ??= {}
    const existing = config.plugins[this.name]
    if (existing && typeof existing === 'object') return existing as GhPluginConfig
    const fresh: GhPluginConfig = {}
    config.plugins[this.name] = fresh
    return fresh
  }

  private applyWatch(config: OrchestratorConfig, number: number, channels: string[]): string {
    const slice = this.slice(config)
    slice.watched ??= []
    const watched = slice.watched
    let entry = watched.find(e => e.number === number)
    if (!entry) {
      entry = { number }
      if (channels.length) entry.channels = [...channels]
      watched.push(entry)
      return channels.length
        ? `watching ${this.label} #${number} + ${channels.join(' ')}`
        : `watching ${this.label} #${number}`
    }
    if (!channels.length) return `already watching ${this.label} #${number}`
    const existing = new Set(entry.channels ?? [])
    const added: string[] = []
    for (const c of channels) if (!existing.has(c)) { existing.add(c); added.push(c) }
    if (!added.length) return `${this.label} #${number} channels unchanged`
    entry.channels = [...existing]
    return `${this.label} #${number} + ${added.join(' ')}`
  }

  private applyUnwatch(config: OrchestratorConfig, number: number): string {
    const slice = this.slice(config)
    const watched = slice.watched ?? []
    const idx = watched.findIndex(e => e.number === number)
    if (idx < 0) return `not watching ${this.label} #${number}`
    watched.splice(idx, 1)
    return `unwatched ${this.label} #${number}`
  }

  private formatListSection(config: OrchestratorConfig): string {
    const entries = this.watched(config)
    const header = `${this.name} (${entries.length}):`
    if (!entries.length) return `${header}\n  (none)`
    const lines = entries.map(e => {
      const chans = e.channels?.length ? ` + ${e.channels.join(' ')}` : ''
      return `  #${e.number}${chans}`
    })
    return [header, ...lines].join('\n')
  }

  private formatHelpSection(): string {
    const t = this.target ? `${this.target} ` : ''
    return [
      `${this.name} commands (DM only):`,
      `  watch ${t}<N> [#chan ...]    — watch ${this.label} N, route extra channels`,
      `  unwatch ${t}<N>              — stop watching ${this.label} N`,
      `  watch list                  — include this plugin's watched ${this.name} in the reply`,
    ].join('\n')
  }
}
