// Built-in plugin registration. Importing this module for side effects
// populates the registry in plugin.ts with `github-prs` and `github-issues`.
// Add a new built-in plugin here; nothing in orchestrator.ts needs to change.
import { registerPlugin } from './plugin.js'
import { GitHubPrsPlugin } from './plugins/github/prs-plugin.js'
import { GitHubIssuesPlugin } from './plugins/github/issues-plugin.js'

registerPlugin('github-prs', (defaultChannel, log) => new GitHubPrsPlugin(defaultChannel, log))
registerPlugin('github-issues', (defaultChannel, log) => new GitHubIssuesPlugin(defaultChannel, log))
