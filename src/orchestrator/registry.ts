// Built-in plugin registration. Importing this module for side effects
// populates the registry in plugin.ts with the shipped plugin set.
// Add a new built-in plugin here; nothing in orchestrator.ts needs to change.
import { registerPlugin } from './plugin.js'
import { GitHubPrsPlugin } from './plugins/github/prs-plugin.js'
import { GitHubIssuesPlugin } from './plugins/github/issues-plugin.js'
import { GitHubNewIssuesPlugin } from './plugins/github/new-issues-plugin.js'
import { GitHubCommitsPlugin } from './plugins/github/commits-plugin.js'

registerPlugin('github-prs', (defaultChannel, log) => new GitHubPrsPlugin(defaultChannel, log))
registerPlugin('github-issues', (defaultChannel, log) => new GitHubIssuesPlugin(defaultChannel, log))
registerPlugin('github-new-issues', (defaultChannel, log) => new GitHubNewIssuesPlugin(defaultChannel, log))
registerPlugin('github-commits', (defaultChannel, log) => new GitHubCommitsPlugin(defaultChannel, log))
