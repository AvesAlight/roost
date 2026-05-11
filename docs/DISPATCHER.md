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
See `src/orchestrator/naming.ts` for the full namespacing convention (#196).

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

For watched entries, `repo` defaults to the top-level value. `channels` adds
destinations on top of the auto-routed `#<project>-issue-N` (PR events also go
to `#<project>-issue-N` for each linked issue).

A plugin not listed under `plugins` is not instantiated — there is no top-level
fallback.

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
whatever process supervisor your project already uses (tmux, systemd, launchd).

Run from your project root — `.orchestrator/` is resolved relative to `process.cwd()`.

State files in `.orchestrator/`:

| File | Purpose |
|---|---|
| `config.json` | Tracked in git. Hand-edited or mutated by a watcher agent. |
| `config.example.json` | Tracked. Template for forks. |
| `state.json` | Last seen GH state per watched entry. Re-seedable. |
| `last-tick.txt` | Heartbeat timestamp. Use for healthchecks. |
| `last-error.txt` | Last fatal tick error. Cleared on success. |
| `daemon.log` | Per-tick log line. Tail this when debugging. |

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
