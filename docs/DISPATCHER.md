# dispatcher

A reference implementation of the polling pattern Roost teams use to wake
agents on GitHub activity. Polls GitHub for changes to watched issues and PRs,
then dispatches events to IRC channels where workers / leads are listening.

The dispatcher is a plain IRC client. It connects to the same ergo server, posts formatted messages
to the target channels, and disconnects. There is no special link to the roost-irc MCP — agents
receive dispatcher messages exactly like any other channel message.

This ships as an example. Run it from a Roost clone (or fork) and point the
config at your own repo / channel set.

Each watched item routes to `#<project>-issue-{number}` in single-repo mode
(top-level `config.repo` set). In multi-repo mode (no `config.repo`) the
channel picks up a slug segment: `#<project>-<slug>-issue-{number}`, where
`<slug>` is the lowercased basename of the entry's `repo`. Worker /
reviewer nicks pick up the same slug. The project channel (default
`#<project>-leads`) is a fallback for errors and project-level events.
See `src/orchestrator/naming.ts` for the full namespacing convention.

## Setup

Run `bin/roost init` (writes both config.json and config.local.json plus the
gitignore), or do it by hand:

```sh
cp .orchestrator/config.example.json .orchestrator/config.json
# config.local.json is created on first dispatcher write; an empty
# `{"plugins":{"github-prs":{"watched":[]},"github-issues":{"watched":[]}}}`
# is fine if you want it visible from day one.
```

### Two-file split

`.orchestrator/config.json` is **tracked** and holds the shareable project
shape: `project`, `repo`, `agent_logins`, `irc`, the enabled plugin set,
and any static plugin slices the team agrees on (e.g.
`github-commits.watched`, `github-new-issues.watched`). PR-reviewed
changes go here.

`.orchestrator/config.local.json` is **gitignored** and holds the
dispatcher-mutated overlay: PR/issue watches added via `watch <N>` DMs land
in `plugins.github-prs.watched` / `plugins.github-issues.watched` here.
Concurrent operators don't clobber each other's live entries.

The loader merges the two files. Most fields are local-wins on conflict.
`plugins.<name>.watched` arrays are **concatenated** — both sources
contribute live entries. DM commands operate on the local overlay only:
`unwatch <N>` on a tracked entry returns
`in tracked config.json — hand-edit to remove`, since the dispatcher won't
modify tracked operator/project state.

Existing operators upgrading from the single-file layout: your old
config.json keeps working as-is. The dispatcher stops writing to it on
the next watch; new entries land in config.local.json. To bring a
tracked entry under dispatcher control, hand-edit `config.json` to
remove it — the dispatcher will pick it up via a fresh `watch <N>`.
There's no automatic migration: refusing to mutate tracked entries is
the contract, not a bug.

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

For watched entries, `repo` defaults to the top-level value in single-repo
mode and is required per entry in multi-repo mode. `channels` adds
destinations on top of the auto-routed issue channel (PR events also route
to each linked issue's channel, slugged the same way in multi-repo mode).

A plugin not listed under `plugins` is not instantiated — there is no top-level
fallback. The first-party set shipped in this repo is `github-prs`,
`github-issues`, `github-new-issues`, `github-commits`. External plugins are
loaded via `plugin_paths` (see [PLUGINS.md](./PLUGINS.md)) before the registry
is walked, so their names become available alongside the built-ins.

`github-new-issues` needs an explicit `plugins.github-new-issues` entry with
at least one `watched` entry to run. `bin/roost init` writes one for new
projects; for existing projects add a `watched` list naming each repo to
watch.

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
| `config.json` | Tracked in git. Shareable project shape — hand-edited only; the dispatcher never writes here. See "Two-file split" above. |
| `config.local.json` | Gitignored. Dispatcher-mutated overlay for DM-driven watches (`watch <N>`, `unwatch <N>`, `watch pr <N>`). Concatenated onto config.json's `plugins.<name>.watched`. |
| `config.example.json` | Tracked. Template for `config.json` in forks. |
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
