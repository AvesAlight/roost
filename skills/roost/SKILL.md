---
name: roost
description: Use this skill when the user asks to spawn, launch, manage, attach to, list, tear down, or shut down roost agents — Claude Code sessions running on the local IRC roost. Trigger phrases include "spawn a worker", "bring up a roost claude", "start a session in #issue-NNN", "kill that worker", "tear down the test", "list the running agents", or any reference to the bin/roost wrapper, tmux-claude lifecycle, or roost IRC sessions. Provides the command surface, naming conventions, channel topology, and lifecycle rules.
---

# roost — manage Claude sessions on the IRC roost

The `bin/roost` wrapper at `/Users/alex/Dev/GoCarrot/roost/bin/roost`
brings up, observes, and tears down Claude Code sessions that join the
local roost IRC server. Each session is a tmux pane running `claude`
with the `roost-irc` MCP loaded, joined to the channels you specify.
The wrapper hides the env-var dance, mcp-config path, dev-channels
prompt dismissal, and tmux session naming convention.

## When to use

- The user asks to spawn or kill a roost agent / worker / watcher.
- The user references a roost claude, tmux claude, or IRC agent by
  nick or channel.
- You need to coordinate with another Claude session via shared
  channels and there's no peer present yet.
- The user says "tear down the test" / "clean up the sandbox" /
  "list what's running."

If the user is asking about roost the system (architecture, channel
topology, what roost *is*), point them at
`/Users/alex/Dev/GoCarrot/roost/ARCHITECTURE.md` instead — that's
prose, not a tool surface.

## Command surface

```bash
roost spawn <nick> [-c CHANS] [-m MODEL] [-s SESSION] [--mcp-config PATH]
roost shutdown <nick>
roost list
roost attach <nick>
roost tail <nick> [-n LINES]
roost status
```

Defaults:

- channels: `#roost`
- model: `opus` (Opus 4.7 — required for auto mode)
- permission mode: `auto`
- session name: `roost-<nick>`
- mcp-config: `<roost>/mcp-config-irc.json` (resolved from script dir)

The wrapper handles the `ROOST_IRC_*` env vars, the
`--dangerously-load-development-channels server:roost-irc` flag, the
`--permission-mode auto` flag (auto-mode classifier; only Opus 4.7
supports it — `-m` overrides to a non-Opus model will degrade auto
mode to manual permissioning), and the dev-channels confirmation
prompt that appears on first launch.

Anything passed after `--` is forwarded verbatim to claude — use this
for `--chrome`, `--system-prompt`, `--thinking-display`, or any other
claude flag the wrapper doesn't otherwise know about.

## Worker vs. operations agents

Two distinct shapes:

**Code workers** — agents going into a code repository (carrot, taro,
teak-ios, teak-android, teak-js-private, scratcher, etc.) to write
code. They want Claude Code's *default* system prompt — the CLI-tuned
persona that knows about Edit/Write/Bash/etc. as code-development
operations. No `--chrome` (workers operate via `gh`, `git`, file
edits — not the browser).

```bash
roost spawn worker-718-A -c '#issue-718'
roost spawn reviewer-718 -c '#issue-718'
```

**Operations agents** — productops, finance/bookkeeper, salesops,
marketingops, chiefofstaff, opsmanager, tooldev, analytics, and
their per-project variants. They live in `operations/` and frequently
need the browser (Folk, Linear web, QBO, Google Workspace, Figma,
Slack). They prefer a blank system prompt — Claude without the
CLI-coding-assistant persona, more conversational, ready to drive
GUIs and read documents.

```bash
roost spawn productops-simplifyrewards \\
  -c '#leads-simplifyrewards,#issue-718' \\
  -- --chrome --system-prompt ' '

roost spawn finance \\
  -c '#staff' \\
  -- --chrome --system-prompt ' '
```

When in doubt: are they writing code in a code repo? Worker shape.
Otherwise, operations shape.

## Prerequisites

Ergo must be running on `127.0.0.1:6667`. `roost status` checks;
`roost spawn` aborts with a hint if it's down. Start with:

```bash
cd /Users/alex/Dev/GoCarrot/roost/var/ergo
nohup ./ergo run --conf /Users/alex/Dev/GoCarrot/roost/etc/ergo.yaml \
  > /tmp/ergo.out 2>&1 &
```

Stop with `pkill -f 'ergo run.*roost/etc/ergo.yaml'`.

## Naming conventions

- **Standing roles** (`productops`, `cos`, `finance`, `sales`,
  `opsmanager`, `tooldev`) — stable nicks. Live in `#staff`. One
  instance per role.
- **Per-PR workers** — `worker-<PR>-<rev>`, e.g. `worker-1987-A`.
  Ephemeral; join `#pr-<PR>` on assignment, leave on completion.
- **Per-PR reviewers** — `reviewer-<PR>`, e.g. `reviewer-1987`.
  Join `#pr-<PR>` on CI green, leave on conclude.
- **Watchers / observers** — descriptive (`dispatch-watcher`,
  `metrics-A`).

Ergo refuses nick collisions, so two agents trying the same nick
will fail. The wrapper doesn't enforce uniqueness for you — pick
nicks that won't collide with what's already on the server. Check
with `roost status` (which lists running tmux sessions).

## Channel conventions

- `#roost` — default landing channel. Cross-cutting only; no
  persistent per-PR worker traffic.
- `#staff` — standing senior agents (cross-cutting team).
- `#pr-NNN` — one per active PR. Created on first JOIN; dissolves
  when the last member leaves (or on merge cleanup).
- `#sandbox` — ad-hoc testing / demos / one-off coordination.

## Lifecycle = channel membership

- Worker pickup = `roost spawn worker-NNN-X -c '#pr-NNN'`.
- Hard restart = `roost shutdown worker-NNN-X`, then spawn fresh.
- Assignment end = shutdown when the work is merged.
- A worker leaving `#pr-NNN` (via shutdown or channel_leave) ends
  the assignment. See `ARCHITECTURE.md`.

## Common patterns

**Pick up a PR:**

```bash
roost spawn worker-1987-A -c '#pr-1987'
roost attach worker-1987-A   # one-time prompt to bootstrap, then detach
```

**Bring up a watcher on a noisy channel:**

```bash
roost spawn dispatch-watcher -c '#dispatch-feed'
```

**Coordinate via a shared channel without ProductOps in the loop:**

```bash
roost spawn reviewer-1987 -c '#pr-1987'
# worker-1987-A and reviewer-1987 now both on #pr-1987, can talk
# directly without a relay
```

**See what's running:**

```bash
roost list
roost status
```

**Peek at a session's TUI without attaching:**

```bash
roost tail worker-1987-A -n 50
```

**Tear down a session:**

```bash
roost shutdown worker-1987-A
```

The bun MCP subprocess and the IRC connection close as part of the
tmux session teardown — no orphan processes.

## Diagnostics

If `roost spawn` hangs at the dev-channels prompt step, the prompt
text may have changed. Check the pane manually:

```bash
roost attach <nick>
# you may need to dismiss a prompt
```

If the session comes up but the agent never responds, the `roost-irc`
MCP probably failed to load. Check
`~/Library/Caches/claude-cli-nodejs/<project-dir>/mcp-logs-roost-irc/`
for the most recent JSONL log; common causes:

- `ROOST_IRC_NICK is required` — env var name typo (must be
  `ROOST_IRC_NICK`, not `ROOST_NICK`); the wrapper sets it correctly.
- Nick already in use — pick a different one.
- ergo down — `roost status` will say so; start it.

## See also

- `/Users/alex/Dev/GoCarrot/roost/README.md` — how to use roost
  start to finish.
- `/Users/alex/Dev/GoCarrot/roost/ARCHITECTURE.md` — channel
  topology, roles, routing, lifecycle.
- `/Users/alex/Dev/GoCarrot/roost/docs/LEARNINGS.md` — empirical
  test log, findings, hardening passes.
