# orchestrator_poll

Polls GitHub for changes to watched issues and PRs, then dispatches events to IRC channels.

Each watched item routes to `#issue-{number}`. The project channel is a fallback for errors and
project-level events.

## Setup

Create `.orchestrator/config.json`:

```json
{
  "repo": "AlexSc/roost",
  "agent_logins": ["TeakBuilds"],
  "irc": {
    "nick": "dispatcher-roost",
    "project_channel": "#roost",
    "server": "127.0.0.1",
    "port": 6667,
    "interval_seconds": 60
  },
  "watched_prs": [22, 25],
  "watched_issues": [15, 18]
}
```

`agent_logins` tags comments by those GitHub users as `is_worker_reply: true` — currently
informational. Bare ints use the top-level `repo`; use `{"repo": "OWNER/NAME", "number": N}`
to watch items in a different repo.

## Running

```sh
# Seed initial state (no events emitted)
bin/orchestrator_poll --seed

# Daemon mode (production)
bin/orchestrator_poll --daemon

# One-shot tick to stdout (debugging)
bin/orchestrator_poll --dry-run
```

Daemon mode holds a persistent IRC connection, re-reads config each tick (so you can add/remove
watched items without restarting), and handles reconnects automatically.

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

State lives in `.orchestrator/` — `config.json` is tracked in git, everything else is ignored.
