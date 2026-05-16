// Built-in plugin registration. Importing this module for side effects
// populates the registry in plugin.ts with `github-prs` and `github-issues`.
// Add a new built-in plugin here; nothing in orchestrator.ts needs to change.
import { registerPlugin } from './plugin.js'
import { GitHubPrsPlugin } from './plugins/github/prs-plugin.js'
import { GitHubIssuesPlugin } from './plugins/github/issues-plugin.js'
import { setRetryLogger } from './plugins/github/github-api.js'

// Both github factories share the same retry-log sink — last writer wins,
// but since they receive the same `log` from buildPlugins it's a no-op
// re-set.
registerPlugin('github-prs', (defaultChannel, log) => {
  setRetryLogger(log)
  return new GitHubPrsPlugin(defaultChannel)
})
registerPlugin('github-issues', (defaultChannel, log) => {
  setRetryLogger(log)
  return new GitHubIssuesPlugin(defaultChannel)
})
