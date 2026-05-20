# dispatcher

Reference implementation of the polling pattern Roost teams use to wake agents
on GitHub activity. Polls watched issues/PRs and dispatches events to IRC
channels where workers/leads are listening.

The dispatcher is a plain IRC client — no special link to the roost-irc MCP.
Agents receive dispatcher messages like any other channel message. Ships as
an example: run it from a Roost clone (or fork) and point the config at your
own repo / channel set.

Each watched item routes to `#<project>-issue-{number}` in single-repo mode.
Multi-repo mode (no `config.repo`) inserts a slug: `#<project>-<slug>-issue-
{number}`, where `<slug>` is the lowercased basename of the entry's `repo`.
Worker / reviewer nicks pick up the same slug. Project channel (default
`#<project>-leads`) is a fallback for errors and project-level events.
See `src/orchestrator/naming.ts`.

## Setup

Run `bin/roost init` (writes both config files plus the gitignore), or do
it by hand:

```sh
cp .orchestrator/config.example.json       .orchestrator/config.json
cp .orchestrator/config.local.example.json .orchestrator/config.local.json
```

### Two-file split

`.orchestrator/config.json` is **tracked** and holds the shareable project
shape: `project`, `repo`, `agent_logins`, `irc`, plus static plugin slices
the team agrees on (currently `github-new-issues.watched` and
`github-commits.watched`). PR-reviewed changes go here.

`.orchestrator/config.local.json` is **gitignored** and holds the
dispatcher-mutated overlay: PR/issue watches from `watch <N>` DMs land in
`plugins.github-prs.watched` / `plugins.github-issues.watched` here.

The loader merges the two. Enabled plugins = union of `Object.keys(plugins)`
across both. Most fields are local-wins; `plugins.<name>.watched` is
**concatenated**. DMs mutate the overlay only — `unwatch <N>` on a tracked
entry returns `in tracked config.json — hand-edit to remove`.

Promoting a local entry to tracked: hand-edit `config.json` to add, then DM
`unwatch <N>` to prune the local copy. Skipping the unwatch leaves the same
key in both files — concat-merge would scrape it twice and `watch list`
shows the duplicate.

Fields:

| Field | Meaning |
|---|---|
| `project` | Lowercase slug used to namespace IRC nicks/channels (`<project>-worker-N`, `#<project>-issue-N`). Falls back to the basename of `repo` when set. Required in multi-repo mode. Must match `^[a-z0-9][a-z0-9-]*$`. |
| `repo` | Default `OWNER/NAME` for watched items in single-repo mode; per-entry `repo` may omit (inherits) or match this value, but cannot diverge. **Leave unset to enable multi-repo mode**, where every watched entry must carry its own `repo` and per-issue artifacts pick up a `<slug>` segment derived from the entry's repo basename. |
| `agent_logins` | GitHub logins whose comments are tagged `is_worker_reply: true` (informational). |
| `irc.nick` | Nick the dispatcher uses on the IRC server. Convention: `<project>-dispatcher`. |
| `irc.project_channel` | Fallback channel for errors and project-level events. Defaults to `#<project>-leads`. |
| `irc.server` / `irc.port` | IRCv3 server address. Defaults to `127.0.0.1:6667`. |
| `irc.interval_seconds` | Tick interval. Min 5s; 60s is sane for most repos. |
| `plugins.<name>` | Per-plugin config slice. Keys list the enabled plugins (in emission order). |
| `plugin_paths` | Optional `[path, ...]` of external plugin modules to load before the registry is walked. Relative paths resolve against `.orchestrator/`. See [PLUGINS.md](./PLUGINS.md). |
| `plugins.github-prs.watched` | `[{"number": N, "repo"?: "OWNER/NAME", "channels"?: [...]}]` |
| `plugins.github-issues.watched` | Same shape as `plugins.github-prs.watched`. |
| `plugins.github-new-issues.watched` | `[{"repo": "OWNER/NAME", "channels"?: [...]}]`. Multi-repo new-issue feed — `repo` required per entry, `channels` defaults to the project channel. |
| `plugins.github-commits.watched` | `[{"repo": "OWNER/NAME", "branch"?: "main", "path"?: "Formula/x.rb", "channels"?: [...]}]`. Multi-repo commit feed — `repo` required per entry, `branch` defaults to `main`, optional `path` filters to commits touching that file, `channels` defaults to the project channel. State key is `<repo>@<branch>` (or `<repo>@<branch>:<path>` when path is set). |

For watched entries, `repo` defaults to the top-level in single mode and is
required per entry in multi mode. `channels` adds destinations on top of the
auto-routed issue channel.

### Cross-repo PR closures

`closingIssuesReferences` can cross repos — a PR in A may close an issue in
B. Each linked-issue channel is slugged from its own repo, not the PR's:

- **Multi-repo:** PR `org/a#25` closing `org/b#14` routes to
  `#<project>-b-issue-14`. If `org/b` is also watched, PR-side and issue-side
  events converge.
- **Single-repo, same-repo linked issue:** routes to `#<project>-issue-<N>`.
- **Single-repo, cross-repo linked issue:** dropped from routing; dispatcher
  emits one stderr line per drop with remediation. Debounced per `head_oid`
  (force-push re-triggers). The IRC channel still shows `now watching PR ...`
  (gh did return a linked issue, just not addressable) — read stderr when in doubt.

A plugin not listed under `plugins` is not instantiated. First-party set:
`github-prs`, `github-issues`, `github-new-issues`, `github-commits`. External
plugins load via `plugin_paths` (see [PLUGINS.md](./PLUGINS.md)) before the
registry walks.

`github-new-issues` needs an explicit slice with ≥1 `watched` entry to run.

## Running

```sh
# Seed initial state (no events emitted)
bin/dispatcher --seed

# Daemon mode (production)
bin/dispatcher --daemon

# One-shot tick to stdout (debugging)
bin/dispatcher --dry-run
```

Daemon mode holds a persistent IRC connection, re-reads config each tick, and
auto-reconnects.

## Lifecycle

The daemon loops, ticks, sleeps. Bring it up under whatever process supervisor
the project uses (tmux, systemd, launchd), or via `bin/start-dispatcher
<config-dir>` (idempotent — safe to call concurrently).

Run from your project root — `.orchestrator/` resolves against `process.cwd()`.

State files in `.orchestrator/`:

| File | Purpose |
|---|---|
| `config.json` | Tracked in git. Shareable project shape (operator-curated slices — `github-new-issues`, `github-commits`, plus any per-PR/issue entries the team agrees on). Hand-edited only; the dispatcher never writes here. See "Two-file split" above. |
| `config.local.json` | Gitignored. Dispatcher-mutated overlay for DM-driven watches. Concatenated onto config.json's `plugins.<name>.watched`. Every first-party plugin can both seed entries via tracked config.json **and** accept DM additions to the overlay — see "DM grammar" below. |
| `config.example.json` | Tracked. Template for `config.json` in forks (static shape). |
| `config.local.example.json` | Tracked. Template for `config.local.json` — empty `github-prs` / `github-issues` scaffolds that enable the DM-driven plugins. |
| `state.json` | Last seen GH state per watched entry. Re-seedable. |
| `last-tick.txt` | Heartbeat timestamp. Use for healthchecks. |
| `last-error.txt` | Last fatal tick error. Cleared on success. |
| `daemon.log` | Per-tick log line. Tail this when debugging. |
| `dispatcher.pid` | PID file for the running daemon (JSON `{pid, started_at_ms, cmdline}`). Written on boot via exclusive create, removed on graceful exit. |
| `joined-channels.txt` | Channels the dispatcher believes it's joined to, one per line. Refreshed each tick — freshness is "as of last successful poll", not "right now". |

### Readiness check (three signals)

Cheapest to most informative:

1. **PID file** — `cat .orchestrator/dispatcher.pid` and `kill -0 <pid>`. The
   file lives in this project's `.orchestrator/`, so it can't be confused with
   another team's daemon; `cmdline` also embeds the absolute config-dir path
   for PID-recycle defense.
2. **Heartbeat** — `cat .orchestrator/last-tick.txt`. Should be within the
   last `irc.interval_seconds * 2`.
3. **Joined channels** — `cat .orchestrator/joined-channels.txt`. Should
   contain `#<project>-leads` and every `#<project>-issue-N` for currently-
   watched items. Snapshot is "last successful tick" — may lag reality during
   an IRC blip.

### Stopping

At milestone end, the APM only sends `unwatch` DMs — the daemon keeps running for the next issue without a cold start. Use `stop-dispatcher` only for incidents, upgrades, decommission:

```sh
bin/stop-dispatcher <config-dir>
```

SIGTERM, waits up to 30s (`STOP_TIMEOUT=<seconds>` overrides). No SIGKILL escalation — kill manually if it hangs. Idempotent.

## DM grammar

The dispatcher accepts a small grammar via DM from nicks in
`irc.command_senders` (defaults to lead-pm + APM). Plugins claim target
keywords; the parser is target-agnostic.

```
watch [<target>] <N> [<owner>/<repo>] [#chan ...]      # github-prs, github-issues
unwatch [<target>] <N> [<owner>/<repo>]
watch <target> <owner>/<repo>[@<branch>[:<path>]] [#chan ...]  # github-commits (target=repo), github-new-issues (target=new-issues; no @/: allowed)
unwatch <target> <owner>/<repo>[@<branch>[:<path>]]
watch list      # every plugin's active entries
help            # synopsis + per-plugin help
```

Target keywords currently claimed by first-party plugins:

| `<target>` | Plugin | Grammar |
|---|---|---|
| (none) | `github-issues` | `watch <N> [<owner>/<repo>] [#chan ...]` |
| `pr` | `github-prs` | `watch pr <N> [<owner>/<repo>] [#chan ...]` |
| `repo` | `github-commits` | `watch repo <owner>/<repo>[@<branch>[:<path>]] [#chan ...]` |
| `new-issues` | `github-new-issues` | `watch new-issues <owner>/<repo> [#chan ...]` |

Notes:

- The optional `<owner>/<repo>` positional after `<N>` pins to a non-default
  repo (disambiguated from channels by containing `/`). Omit it to inherit
  `config.repo`; in multi-repo mode the bare form is rejected.
- The repo-shape grammar mirrors github-commits' state key, so a daemon.log
  line copy-pastes into a DM. Branch defaults to `main`; path is optional.
- DMs mutate `config.local.json` only. Re-watching a tracked entry is
  idempotent; unwatching one is refused with `… hand-edit to remove`.

### Repo-mode invariant — tracked-strict, local-loose

Plugins that own a `watched`/`repo` shape enforce single-vs-multi: in single
mode (top-level `repo` set) entries' `repo` must be absent or equal
`config.repo`; in multi mode every entry must carry its own `repo`.

The check runs only against tracked `config.json` entries — local-overlay
entries bypass because the DM parser validates OWNER/REPO at write time. The
tracked-only rule lets a single-repo operator `watch pr 5 OtherOrg/r` for a
cross-repo PR without losing the typo-guard on hand-edited entries. See
`Plugin.assertRepoMode` for the contract.

## Events dispatched

| Event | Fires when |
|---|---|
| `pr_ready_for_review` | PR marked ready |
| `pr_returned_to_draft` | PR marked draft |
| `pr_merged` / `pr_closed` | PR closes |
| `ci_transitioned` | CI reaches SUCCESS or FAILURE |
| `pr_review_comment` / `pr_conversation_comment` | new PR comment |
| `pr_review_submitted` | formal review submitted |
| `issue_comment` | new issue comment |
| `issue_state_changed` | issue closed |
| `labels_changed` | `phase:`, `plan:`, or `ready-for-merge` labels change |
