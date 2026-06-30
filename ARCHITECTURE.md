# roost — communication architecture

A local IRC server with multiple Claude Code sessions on it. Each
session runs a `roost-irc` MCP that turns inbound IRC into channel
notifications and exposes outbound IRC as tools. A human can join
from `irssi` and see everything.

## Topology

```
                       ergo (127.0.0.1:6667)
                               │
   ┌─────────────┬──────────────┬─────────────┬──────────┐
   │             │              │             │          │
 lead-pm     dispatcher     worker-N      reviewer-N   alex
 + APM       (per           (#<project>-  (#<project>- (irssi /
 (#<project>- project,       issue-N,      issue-N,    weechat)
  leads +     event-pub)     ephemeral)    ephemeral)
  every
  active
  issue
  channel)
```

The channel-of-record for an active piece of work is
`#<project>-issue-<N>`, not `#<project>-pr-<N>` — issues outlive any
single PR attempt (a PR close + restart on the same issue means the
channel needs to be stable across restarts; per-issue gives that,
per-PR doesn't).

## Channels

| Channel                | Purpose |
|------------------------|---------|
| `#<project>-leads`     | Per-project leadership channel. lead-pm + APM live here continuously; dispatcher posts cross-issue events (new PRs/issues for the watched repo, milestone-level signals). |
| `#<project>-issue-<N>` | One per active issue. Dispatcher publishes per-issue events. Worker joins on pickup, leaves on completion. Reviewer joins for the review pass, leaves on conclude. lead-pm + APM join while the issue is active. Stable across PR restarts (old PR closes, new PR opens = same `#<project>-issue-<N>`). |

## Identities

- **lead-pm** — `<project>-lead-pm`. Owns a project end-to-end:
  picks issues off the milestone DAG, pressure-tests worker plans,
  coordinates with the human, posts postmortems. Lives in
  `#<project>-leads` continuously and joins each
  `#<project>-issue-<N>` while it's active. Long-running; opts into
  `--steer-compact` so the in-process compactor preserves role and
  channels.
- **APM** — `<project>-apm`. Operational support for lead-pm: runs
  the mechanical dances — worktree + watch + worker-spawn setup,
  reviewer-agent spawn on draft-PR-open, flip PRs draft → ready +
  tag the human + re-request review, merge + cleanup, follow-up
  filing, release-bump mechanics. Lives in the same channels as
  lead-pm.
- **Triage** — `<project>-triage`. Autonomous milestone hygiene:
  assigns genuinely-new issues (off the dispatcher's new-issue
  announcement) to the right milestone unattended, and gates the
  riskier moves — backlog sweeps and milestone creation — behind a
  human confirm in `#<project>-leads`. Never touches a milestone it
  can't prove it set: all agents share one GitHub login, so a
  `[<project>-triage]` stamp comment is its only reliable provenance,
  and anything unstamped is hands-off. Standing and long-running like
  the APM — lives in `#<project>-leads`, opts into `--steer-compact` —
  but opt-in on the spawn mechanism: an operator spawns it once at
  project setup; lead-pm auto-spawns the APM, not triage.
- **Workers** — ephemeral (`<project>-worker-<N>`, or
  `<project>-<slug>-worker-<N>` in multi-repo mode). Join
  `#<project>-issue-<N>` on assignment, leave on completion.
- **Reviewers** — ephemeral (`<project>-reviewer-<N>`). Join
  `#<project>-issue-<N>` for the review pass, leave on conclude.
- **Dispatchers** — one per project (`<project>-dispatcher`). Not
  Claude sessions; a TypeScript daemon (`src/orchestrator/`).
  Publish per-issue events to `#<project>-issue-<N>` and
  cross-issue events to `#<project>-leads`.

## Routing

Routing happens in the channel — there's no separate broker. The
dispatcher is a plain IRC client writing to channels; every agent
present receives the message identically via its roost-irc MCP.

- **Per-issue events** (CI transitions, PR comments, review
  submissions): dispatcher → `#<project>-issue-<N>`. Worker,
  reviewer, lead-pm, and APM are all in the channel and read the
  event off the same notification.
- **Cross-issue events** (new PRs / issues for the watched repo,
  milestone-level signals): dispatcher → `#<project>-leads`.
  lead-pm and APM read these and route to per-issue work.
- **Ambiguous human directives**: land in channel as ordinary
  messages. Workers claim what's unambiguous to them ("I've got
  this"); anything left unclaimed is lead-pm's to interpret.
- **Worker ↔ reviewer**: co-located in `#<project>-issue-<N>`.
  No relay.
- **Worker ↔ lead-pm**: co-located in `#<project>-issue-<N>` for
  plan pressure-testing, structural updates, ready-flip signaling.
  APM picks up the operational dances (ready flip, follow-up
  filing) off the same channel without round-tripping through
  lead-pm.

### PR review flow

Sequencing — each step bumps the next:

1. Worker drafts → opens PR (with `Closes #<N>` in the body) and
   posts the link in `#<project>-issue-<N>`.
2. APM spawns **reviewer-<N>** against the draft (cold lens — no
   project context). Trigger is draft-PR-open, not CI-green;
   reviewer + CI run in parallel.
3. Reviewer reads the diff, posts findings to GitHub, parts the
   channel.
4. Worker addresses findings, pushes, runs the last-look gate,
   signals ready in `#<project>-issue-<N>` (with a
   `highest-risk specific:` and a `surprises:` line).
5. APM flips the PR draft → ready and adds the human as reviewer.
6. Human reviews and merges (or sends back; on send-back the
   worker addresses without toggling draft, and APM re-requests
   review).
7. After merge: lead-pm posts a one-paragraph postmortem in
   `#<project>-leads`; APM runs cleanup (unwatch the PR/issue,
   tear down the worktree, close milestones if applicable).

## Lifecycle = membership

- Worker pickup = `JOIN #<project>-issue-<N>`.
- Reviewer engagement = `JOIN #<project>-issue-<N>`.
- Hard restart = kick the worker, fresh worker `JOIN`s the same
  `#<project>-issue-<N>` (channel persists across PR restarts).
- Assignment end = `PART` (or issue-resolved → channel cleanup).

The MCP pushes `JOIN`/`PART`/`KICK` events as channel notifications,
so agents see the membership transitions in real time.

A fresh worker on `JOIN` (whether first pickup or post-kick restart)
orients from dispatcher state + channel topic + spawn prompt — not
from scrolling channel history. Same context-economy logic as
standing-agent rejoin (below): scrollback burns context on routine
event volume; the actionable view lives at the dispatcher.

## Spawning agents

Use the `bin/roost` wrapper (or invoke the `roost` Claude Code skill
from a model context — installed at `~/.claude/skills/roost` when
the symlink is in place). The wrapper hides the env-var dance,
mcp-config path, dev-channels prompt dismissal, and tmux session
naming.

```bash
roost spawn <nick> [-c CHANS] [-m MODEL] [-s SESSION] [-p PROMPT-FILE] [--mcp-config PATH]
roost shutdown <nick>
roost list / status / attach <nick> / tail <nick>
```

Common spawns:

```bash
# Worker pickup on a fresh issue:
roost spawn <project>-worker-718-A -c '#<project>-issue-718'

# Reviewer joining for the review pass:
roost spawn <project>-reviewer-718 -c '#<project>-issue-718'

# Triage agent (long-running milestone hygiene; opus/auto, self-authorizing).
# -c is its audit channel; on boot it derives + self-joins every channel the
# github-new-issues feed announces to (default: the same #<project>-leads):
roost spawn <project>-triage --agent triage --cache-ttl 1h --steer-compact \
  -c '#<project>-leads' --prompt 'human=<human>' \
  --ask-irc '#<project>-leads' --ask-target <project>-lead-pm

# Hard restart (channel-as-lifecycle: kick + new worker JOINs same
# channel, orients from dispatcher state + channel topic + spawn
# prompt, not from scrollback):
roost shutdown <project>-worker-718-A
roost spawn <project>-worker-718-B -c '#<project>-issue-718'
```

### Restarting a long-running lead-pm

lead-pm runs for the lifetime of a milestone, so it has to survive
both auto-compact and full respawn cleanly.

In-process recovery is `--steer-compact` at spawn — see Rejoin
below for the mechanics. That covers most cases.

For a full respawn (process loss, hard kick, intentional restart),
an operator (human or APM) drafts a handoff prompt from durable
artifacts:

1. Project journal + recent `#<project>-leads` topic / pinned
   conventions.
2. Dispatcher's view of every watched issue in the project (open
   PRs, CI state, pending human threads).
3. Open escalation items the previous instance was holding.
4. Active human threads needing translation.
5. Path to the project's `worker_conventions.md` (or equivalent).

Then spawn:

```bash
roost spawn <project>-lead-pm \
  -c '#<project>-leads,#<project>-issue-718,#<project>-issue-721,#<project>-issue-693' \
  --steer-compact --cache-ttl 1h \
  --ask-irc '#<project>-leads' --ask-target <your-nick> \
  --prompt-file /tmp/handoff.md
```

`--prompt-file` is the load-bearing primitive — it's what lets the
fresh instance pick up without scrolling channel history. The
wrapper waits for the dev-channels prompt, dismisses it, then
pastes the handoff prompt into the TUI and submits it.

### Debugging stalled agents

`roost tail <nick> -n 50` captures the recent TUI output without
attaching the full session. Useful for "is this agent alive but
stuck, or has it died?" without taking over the operator's view.
For deeper inspection — MCP stderr, IRC connection logs — check
`~/Library/Caches/claude-cli-nodejs/<project>/mcp-logs-roost-irc/`.

### When to use the skill vs raw shell

When an agent needs to spawn or manage another agent (lead-pm
spawning the APM at startup, APM spawning a worker or reviewer
agent, APM kicking a stuck worker, etc.), it should invoke the
`roost` skill rather than reach for raw shell — same command
surface, with naming and channel conventions baked into the skill
description so spawns are consistent across spawners. Raw shell is
fine for human operators running ad-hoc commands.

Parking-lot enhancements (not yet built):

- `--rejoin-project <name>` — auto-enumerate the project's channels
  (`#<project>-leads` + every `#<project>-issue-<N>` where the
  project's dispatcher is active) so a lead-pm respawn doesn't have
  to hand-list 5–10 channels.

## Conventions live as channel state

`worker_conventions.md` is the canonical source. The live channel
topic / pinned messages reflect what applies *now*. Workers read
channel state on `JOIN`; updates propagate without a respawn.

## Rejoin

When a standing agent rejoins after a context boundary (compact,
restart, outage), it queries the dispatcher for actionable state
*first*, then reads channel deltas only for items the dispatcher
flags as needing interpretation. Don't scroll history — it burns
context on routine event volume.

For auto-compaction specifically: claude code's auto-compact fires
event-driven (not at a fixed token count) and without a directive.
Long-running roost agents opt in to an intercept with the
`--steer-compact` flag at spawn — that wires `bin/roost-compact-hook`
as a PreCompact handler. On `trigger="auto"` the hook returns
`{"decision":"block"}` to halt the directive-less auto-compact, then
backgrounded-shells a `tmux send-keys` of `/compact <directive>`
into its own pane. That re-fires PreCompact with `trigger="manual"`
and `custom_instructions` populated; the hook passes through, and
the manual `/compact` actually steers the compactor with our
directive. The directive is a single-line constant inside the hook
script (one place to edit; covers the roost agent set generically).
Short-lived agents (workers, reviewers) skip the flag — auto-compact
is unlikely to fire in their lifetime and the default behavior is
fine.

For lead-pm specifically, in-process recovery via `--steer-compact`
covers most cases. For full respawn (process loss, hard kick), see
"Restarting a long-running lead-pm" above — orient the new instance
from runbook + recent `#<project>-leads` topic / pins + journal
entries + dispatcher's actionable state. Trade: lead-pm gives up
perfect scrollback continuity in exchange for cheap replaceability.
Acceptable.

## Discipline

- **Substantive design framing → PR/issue thread first, pointer in
  chat.** Chat is for routing, not thinking. If a message would
  meaningfully change a reader's design framing, draft it for the
  PR thread, then post a pointer in chat.
- **Receiver-claims-the-flag.** Workers signal what they're picking
  up; lead-pm's queue is what's unclaimed.
- **Channel membership = lifecycle.** Joining is committing; being
  kicked ends the assignment.

## See also

- `README.md` — how to run roost (ergo, MCP, irssi, env vars,
  tool surface).
- `docs/LEARNINGS.md` — empirical work that produced this:
  load-bearing assumptions, test log, finding catalog, hardening
  passes, post-Test-4 design session notes.
