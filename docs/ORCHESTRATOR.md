# orchestrator_poll

A reference implementation of the polling pattern Roost teams use to wake
agents on GitHub activity. Polls GitHub for changes to watched issues and PRs,
then dispatches events to IRC channels where workers / leads are listening.

The dispatcher is a plain IRC client. It connects to the same ergo server, posts formatted messages
to the target channels, and disconnects. There is no special link to the roost-irc MCP — agents
receive dispatcher messages exactly like any other channel message.

This ships as an example. Run it from a Roost clone (or fork) and point the
config at your own repo / channel set, or fork and add plugins for whatever
upstream you actually care about — the dispatcher is plugin-agnostic
(see "Extending" below).

Each watched item routes to `#issue-{number}`. The project channel is a
fallback for errors and project-level events.

## Setup

Copy the template, then edit:

```sh
cp .orchestrator/config.example.json .orchestrator/config.json
```

Fields:

| Field | Meaning |
|---|---|
| `repo` | Default `OWNER/NAME` for watched items. Per-entry `repo` overrides. |
| `agent_logins` | GitHub logins whose comments are tagged `is_worker_reply: true` (informational). |
| `irc.nick` | Nick the dispatcher uses on the IRC server. |
| `irc.project_channel` | Fallback channel for errors and project-level events. |
| `irc.server` / `irc.port` | IRCv3 server address. Defaults to `127.0.0.1:6667`. |
| `irc.interval_seconds` | Tick interval. Min 5s; 60s is sane for most repos. |
| `watched_prs` | `[{"number": N, "repo"?: "OWNER/NAME", "channels"?: [...]}]` |
| `watched_issues` | Same shape as `watched_prs`. |

For watched entries, `repo` defaults to the top-level value. `channels` adds
destinations on top of the auto-routed `#issue-N` (PR events also go to
`#issue-N` for each linked issue).

## Running

```sh
# Seed initial state (no events emitted)
bin/orchestrator_poll --seed

# Daemon mode (production)
bin/orchestrator_poll --daemon

# One-shot tick to stdout (debugging)
bin/orchestrator_poll --dry-run
```

Daemon mode holds a persistent IRC connection, re-reads config each tick (so
you can add/remove watched items without restarting), and handles reconnects
automatically.

## Lifecycle

The daemon is dumb on purpose — it loops, ticks, sleeps. Bring it up under
whatever process supervisor your project already uses (tmux, systemd, launchd,
or roost's own service supervisor once it lands — see issue #67). Restart on
crash; the daemon picks up where it left off from `.orchestrator/state.json`.

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

## Extending

The dispatcher itself is upstream-agnostic — it iterates `TaggedEvent[]` and
writes to IRC. GitHub PRs and Issues are two plugins (`src/orchestrator/plugins/github/`)
implementing the `Plugin` interface in `src/orchestrator/plugin.ts`. To watch
something else (Linear, Slack, a build queue), implement `Plugin` and register
it in `buildPlugins()` in `src/orchestrator.ts`.
