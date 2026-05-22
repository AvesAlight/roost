// Side-effect import populates the registry with the shipped plugin set.
// Add new built-ins here; nothing else needs to change.
import { registerPlugin } from './plugin.js'
import { GitHubPrsPlugin } from './plugins/github/prs-plugin.js'
import { GitHubIssuesPlugin } from './plugins/github/issues-plugin.js'
import { GitHubNewIssuesPlugin } from './plugins/github/new-issues-plugin.js'
import { GitHubNewPrsPlugin } from './plugins/github/new-prs-plugin.js'
import { GitHubCommitsPlugin } from './plugins/github/commits-plugin.js'
import { LinearIssuesPlugin } from './plugins/linear/issues-plugin.js'
import { LinearNewIssuesPlugin } from './plugins/linear/new-issues-plugin.js'

registerPlugin('github-prs', (defaultChannel, log) => new GitHubPrsPlugin(defaultChannel, log), 'watches PR activity for tracked PR numbers')
registerPlugin('github-issues', (defaultChannel, log) => new GitHubIssuesPlugin(defaultChannel, log), 'watches issue activity for tracked issue numbers')
registerPlugin('github-new-issues', (defaultChannel, log) => new GitHubNewIssuesPlugin(defaultChannel, log), 'announces new GitHub issues in watched repos')
registerPlugin('github-new-prs', (defaultChannel, log) => new GitHubNewPrsPlugin(defaultChannel, log), 'announces new GitHub PRs from non-agent authors')
registerPlugin('github-commits', (defaultChannel, log) => new GitHubCommitsPlugin(defaultChannel, log), 'announces commits to watched repos/branches/paths')
registerPlugin('linear-issues', (defaultChannel, log) => new LinearIssuesPlugin(defaultChannel, log), 'watches Linear issue activity for tracked issue keys')
registerPlugin('linear-new-issues', (defaultChannel, log) => new LinearNewIssuesPlugin(defaultChannel, log), 'announces new Linear issues in watched teams')
