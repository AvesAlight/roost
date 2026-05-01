---
name: roost
description: Use this skill when the user asks to spawn, launch, manage, attach to, list, tear down, or shut down roost agents — Claude Code sessions running on the local IRC roost. Trigger phrases include "spawn a worker", "bring up a roost claude", "start a session in #issue-NNN", "kill that worker", "tear down the test", "list the running agents", "spawn a sonnet/haiku worker with permission oversight", "approve its tool calls over IRC", or any reference to the bin/roost wrapper, tmux-claude lifecycle, or roost IRC sessions. Provides the command surface, naming conventions, channel topology, lifecycle rules, and the IRC permission-oversight pattern (Opus orchestrator gating a non-auto-mode worker's tool calls via DMs).
---

# roost — manage Claude sessions on the IRC roost

The `roost` command brings up, observes, and tears down Claude Code
sessions that join the local roost IRC server. Each session is a tmux
pane running `claude` with the `roost-irc` MCP loaded, joined to the
channels you specify. The wrapper hides the env-var dance, dev-channels
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
topology, what roost *is*), point them at `ARCHITECTURE.md` in the
roost plugin root (`roost root` prints the path) — that's prose, not
a tool surface.

## Command surface

```bash
roost spawn <nick> [-c CHANS] [-m MODEL] [-s SESSION] [--mcp-config PATH] \
                   [--cwd PATH] [-p PROMPT_FILE] \
                   [--perm-irc --perm-target NICK]
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
- cwd: current directory at spawn time
- session name: `roost-<nick>`
- mcp server: auto-loaded via plugin (override with `--mcp-config`)

The wrapper handles the `ROOST_IRC_*` env vars, the
`--dangerously-load-development-channels server:roost-irc` flag, the
`--permission-mode auto` flag (auto-mode classifier; only Opus 4.7
supports it — `-m` overrides to a non-Opus model will degrade auto
mode to manual permissioning), and the dev-channels confirmation
prompt that appears on first launch.

Anything passed after `--` is forwarded verbatim to claude — use this
for `--chrome`, `--system-prompt`, `--thinking-display`, or any other
claude flag the wrapper doesn't otherwise know about.

## IRC permission oversight (--perm-irc)

`--perm-irc` starts a side daemon (`bin/roost-permbot`) alongside the
worker. The daemon holds a stable IRC nick `permbot-{worker}` and
serializes the worker's PreToolUse permission prompts as DMs to
`--perm-target` (required). The operator replies `y` / `n` /
`yes` / `no` / `allow` / `deny` (case-insensitive); anything else or a
30s timeout falls through to the regular terminal prompt as a safety
net. `roost shutdown` reaps the daemon and its socket/pidfile.

Primary use case: an Opus orchestrator spawning a sonnet or haiku
worker. Non-Opus models can't use auto mode, so without oversight the
worker would hit the terminal permission prompt for every tool call —
unusable headlessly. With `--perm-irc --perm-target <orchestrator>`,
the prompts come to the orchestrator over IRC and the orchestrator
acts as the gate. Same pattern works for a human at any roost-attached
IRC client.

```bash
# Opus orchestrator gates a sonnet worker's tool calls:
roost spawn worker-123-A -c '#pr-123' -m sonnet \
  --perm-irc --perm-target orchestrator

# Human operator gates a haiku worker:
roost spawn scratch-h -c '#sandbox' -m haiku \
  --perm-irc --perm-target mynick
```

Worker prerequisite: the worker must have the roost plugin active.
The plugin's `hooks/hooks.json` wires `PreToolUse` to
`irc-permission-prompt` automatically. The hook degrades gracefully
when no daemon is running (returns `ask`, terminal prompt fires as
normal), so it's safe to have wired at all times.

The hook auto-passes any `mcp__roost-irc__*` tool through without
asking — otherwise the worker couldn't talk on IRC, including replying
to its own approver.

Daemon logs land at `/tmp/roost-permbot-{worker}.log` if anything looks
off (registration failures, IRC disconnects, etc.).

## Prerequisites

Ergo must be running on `127.0.0.1:6667`. `roost status` checks;
`roost spawn` aborts with a hint if it's down. Start with:

```bash
cd "$(roost root)/var/ergo"
nohup ./ergo run --conf "$(roost root)/etc/ergo.yaml" > /tmp/ergo.out 2>&1 &
```

Stop with `pkill -f 'ergo run.*roost/etc/ergo.yaml'`.

## Naming conventions

- **Standing agents** — stable nicks for long-lived roles. One instance
  per role.
- **Per-PR workers** — `worker-<PR>-<rev>`, e.g. `worker-123-A`.
  Ephemeral; join their channel on assignment, leave on completion.
- **Per-PR reviewers** — `reviewer-<PR>`, e.g. `reviewer-123`.
  Join on CI green, leave on conclude.
- **Watchers / observers** — descriptive (`ci-watcher`, `metrics-A`).
- **Permbot side daemons** — `permbot-{worker}`, automatically named
  by `--perm-irc` (don't pick a worker nick that would collide with an
  existing `permbot-*` nick).

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

- Worker pickup = `roost spawn worker-NNN-X -c '#pr-NNN' --cwd <worktree>`.
- Hard restart = `roost shutdown worker-NNN-X`, then spawn fresh.
- Assignment end = shutdown when the work is merged.
- A worker leaving `#pr-NNN` (via shutdown or channel_leave) ends
  the assignment. See `ARCHITECTURE.md`.

## Common patterns

**Pick up a PR:**

```bash
roost spawn worker-123-A -c '#pr-123' --cwd ~/Dev/myproject
roost attach worker-123-A   # one-time prompt to bootstrap, then detach
```

**Bring up a watcher on a noisy channel:**

```bash
roost spawn ci-watcher -c '#ci-feed'
```

**Coordinate via a shared channel:**

```bash
roost spawn reviewer-123 -c '#pr-123' --cwd ~/Dev/myproject
# worker-123-A and reviewer-123 now both on #pr-123
```

**See what's running:**

```bash
roost list
roost status
```

**Peek at a session's TUI without attaching:**

```bash
roost tail worker-123-A -n 50
```

**Tear down a session:**

```bash
roost shutdown worker-123-A
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

Use `roost root` to get the plugin directory, then read:

- `README.md` — how to use roost start to finish.
- `ARCHITECTURE.md` — channel topology, roles, routing, lifecycle.
- `docs/LEARNINGS.md` — empirical test log, findings, hardening passes.
