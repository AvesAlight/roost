# dispatcher

A reference implementation of the polling pattern Roost teams use to wake
agents on GitHub activity. Polls GitHub for changes to watched issues and PRs,
then dispatches events to IRC channels where workers / leads are listening.

The dispatcher is a plain IRC client. It connects to the same ergo server, posts formatted messages
to the target channels, and disconnects. There is no special link to the roost-irc MCP — agents
receive dispatcher messages exactly like any other channel message.

This ships as an example. Run it from a Roost clone (or fork) and point the
config at your own repo / channel set.

Each watched item routes to `#<project>-issue-{number}`. The project channel
(default `#<project>-leads`) is a fallback for errors and project-level events.
See `src/orchestrator/naming.ts` for the full namespacing convention.

## Setup

Copy the template, then edit:

```sh
cp .orchestrator/config.example.json .orchestrator/config.json
```

Fields:

| Field | Meaning |
|---|---|
| `project` | Lowercase slug used to namespace IRC nicks/channels (`<project>-worker-N`, `#<project>-issue-N`). Falls back to the basename of `repo`. Must match `^[a-z0-9][a-z0-9-]*$`. |
| `repo` | Default `OWNER/NAME` for watched items. Per-entry `repo` overrides. |
| `agent_logins` | GitHub logins whose comments are tagged `is_worker_reply: true` (informational). |
| `irc.nick` | Nick the dispatcher uses on the IRC server. Convention: `<project>-dispatcher`. |
| `irc.project_channel` | Fallback channel for errors and project-level events. Defaults to `#<project>-leads`. |
| `irc.server` / `irc.port` | IRCv3 server address. Defaults to `127.0.0.1:6667`. |
| `irc.interval_seconds` | Tick interval. Min 5s; 60s is sane for most repos. |
| `plugins.<name>` | Per-plugin config slice. Keys list the enabled plugins (in emission order). |
| `plugins.github-prs.watched` | `[{"number": N, "repo"?: "OWNER/NAME", "channels"?: [...]}]` |
| `plugins.github-issues.watched` | Same shape as `plugins.github-prs.watched`. |
| `plugins.github-new-issues` | Repo-wide new-issue feed: `{"repo"?: "OWNER/NAME", "channels"?: [...]}` (both optional; default = `repo` at top level + project channel). |
| `plugins.github-commits.watched` | `[{"repo": "OWNER/NAME", "branch"?: "main", "path"?: "Formula/x.rb", "channels"?: [...]}]`. Multi-repo commit feed — `repo` required per entry, `branch` defaults to `main`, optional `path` filters to commits touching that file, `channels` defaults to the project channel. State key is `<repo>@<branch>` (or `<repo>@<branch>:<path>` when path is set). |

For watched entries, `repo` defaults to the top-level value. `channels` adds
destinations on top of the auto-routed `#<project>-issue-N` (PR events also go
to `#<project>-issue-N` for each linked issue).

A plugin not listed under `plugins` is not instantiated — there is no top-level
fallback. The supported set is the first-party plugins shipped in this repo
(`github-prs`, `github-issues`, `github-new-issues`, `github-commits`); external
plugin discovery is not yet supported.

`github-new-issues` needs an explicit `plugins.github-new-issues`
entry to run. `bin/roost init` writes one for new projects; for existing
projects, add `"github-new-issues": {}` to enable the repo-wide new-issue
feed on the project channel.

## Running

```sh
# Seed initial state (no events emitted)
bin/dispatcher --seed

# Daemon mode (production)
bin/dispatcher --daemon

# One-shot tick to stdout (debugging)
bin/dispatcher --dry-run
```

Daemon mode holds a persistent IRC connection, re-reads config each tick (so
you can add/remove watched items without restarting), and handles reconnects
automatically.

## Lifecycle

The daemon is dumb on purpose — it loops, ticks, sleeps. Bring it up under
whatever process supervisor your project already uses (tmux, systemd, launchd),
or via the bundled `bin/start-dispatcher <config-dir>` helper, which is
idempotent — safe to call concurrently from multiple agents.

Run from your project root — `.orchestrator/` is resolved relative to `process.cwd()`.

State files in `.orchestrator/`:

| File | Purpose |
|---|---|
| `config.json` | Tracked in git. Hand-edited or mutated via DMs to the dispatcher (`watch <N>`, `unwatch <N>`, `watch pr <N>`, etc.). |
| `config.example.json` | Tracked. Template for forks. |
| `state.json` | Last seen GH state per watched entry. Re-seedable. |
| `last-tick.txt` | Heartbeat timestamp. Use for healthchecks. |
| `last-error.txt` | Last fatal tick error. Cleared on success. |
| `daemon.log` | Per-tick log line. Tail this when debugging. |
| `dispatcher.pid` | PID file for the running daemon (JSON `{pid, started_at_ms, cmdline}`). Written on boot via exclusive create, removed on graceful exit. |
| `joined-channels.txt` | Channels the dispatcher believes it's joined to, one per line. Refreshed each tick — freshness is "as of last successful poll", not "right now". |

### Readiness check (three signals)

To verify a dispatcher is running and healthy for *this* project, an operator
or agent can check three things, in order from cheapest to most informative:

1. **PID file** — `cat .orchestrator/dispatcher.pid` and `kill -0 <pid>`. The
   file lives inside this project's `.orchestrator/`, so it can't be confused
   with another team's daemon. The `cmdline` field also embeds the absolute
   config-dir path, which `bin/start-dispatcher` uses to defend against PID
   recycle.
2. **Heartbeat** — `cat .orchestrator/last-tick.txt`. Should be within the
   last `irc.interval_seconds * 2`.
3. **Joined channels** — `cat .orchestrator/joined-channels.txt`. Should
   contain the project channel (`#<project>-leads` by default) and every
   `#<project>-issue-N` for currently-watched items. Snapshot is "last
   successful tick" — during a brief IRC blip it may lag reality by one
   interval.

### Stopping

At milestone end, the APM only sends `unwatch` DMs — the daemon keeps running so it's ready for the next issue without a cold start. Don't call `stop-dispatcher` as part of normal teardown. Agents reach this via the milestone-teardown dance in associate-pm.md.

Use `stop-dispatcher` when you need to actually stop the daemon — incidents, upgrades, decommission:

```sh
bin/stop-dispatcher <config-dir>
```

Sends SIGTERM and waits up to 30s (override with `STOP_TIMEOUT=<seconds>`). No SIGKILL escalation — if the daemon hangs past 30s, kill it manually. Idempotent — exits 0 if no live dispatcher is found.

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
