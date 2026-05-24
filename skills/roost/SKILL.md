---
name: roost
description: Use this skill when the user asks to spawn, launch, manage, attach to, list, tear down, or shut down roost agents — Claude Code sessions running on the local IRC roost. Trigger phrases include "spawn a worker", "bring up a roost claude", "start a session in #<project>-issue-<N>", "kill that worker", "tear down the test", "list the running agents", "spawn a sonnet/haiku worker with permission oversight", "approve its tool calls over IRC", or any reference to the bin/roost wrapper, tmux-claude lifecycle, or roost IRC sessions. Provides the command surface, naming conventions, channel topology, lifecycle rules, and the IRC permission-oversight pattern (Opus orchestrator gating a non-auto-mode worker's tool calls via DMs).
---

# roost — manage Claude sessions on the IRC roost

The `roost` command brings up, observes, and tears down Claude Code
sessions that join the local roost IRC server. Each session is a tmux
pane running `claude` with the `roost-irc` MCP loaded, joined to the
channels you specify. The wrapper hides the env-var dance, dev-channels
prompt dismissal, and tmux session naming convention.

## When to use

- The user asks to spawn or kill a roost agent / worker.
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
                   [--cwd PATH] [--prompt PROMPT] \
                   [--permission-mode MODE] [--cache-ttl 5m|1h] \
                   [--steer-compact] \
                   [--perm-irc --perm-target NICK] \
                   [--ask-irc CHANNEL --ask-target NICK]
roost shutdown <nick>
roost list
roost attach <nick>
roost tail <nick> [-n LINES]
roost status
```

Defaults:

- channels: `#roost`
- model: `opus`
- permission mode: with `--agent`, the wrapper passes nothing and claude
  code reads `permissionMode:` natively from the agent frontmatter; with
  `--model` (or the default opus), the wrapper defaults to `auto` for opus
  and `acceptEdits` for everything else. Explicit `--permission-mode` wins
  in both paths.
- cache-ttl: no wrapper default — if unset, neither env var is
  injected and claude-code's native cache behavior applies. Caller
  picks per session. Translated to claude-code's env knobs in the
  spawned session: `FORCE_PROMPT_CACHING_5M=1` or
  `ENABLE_PROMPT_CACHING_1H=1`. See `roost spawn --help`
  ("Agent class guidance") for the role→flag heuristic.
- cwd: current directory at spawn time
- session name: `roost-<nick>`
- mcp server: auto-loaded via plugin (override with `--mcp-config`)
- `--steer-compact`: opt-in. Wires a PreCompact hook that intercepts
  claude code's auto-compact and redirects it as a manual `/compact`
  with a directive (so the compactor runs with `custom_instructions`
  rather than its empty default). See `roost spawn --help`
  ("Agent class guidance") for which agents need this.

The wrapper handles the `ROOST_IRC_*` env vars, the
`--dangerously-load-development-channels server:roost-irc` flag, the
`--permission-mode` flag (with `--agent`, defers to the agent's native
`permissionMode:` frontmatter; with `--model`, smart-defaulted: `auto` for
opus, `acceptEdits` otherwise; explicit `--permission-mode` wins either
way), and the dev-channels confirmation prompt that appears on first
launch.

Anything passed after `--` is forwarded verbatim to claude — use this
for `--chrome`, `--system-prompt`, `--thinking-display`, or any other
claude flag the wrapper doesn't otherwise know about.

## IRC permission oversight (--perm-irc)

`--perm-irc` runs a permbot routing module inside the worker's MCP
process. It opens a second IRC connection on the stable nick
`permbot-{worker}` and serializes the worker's PermissionRequest
prompts as DMs to `--perm-target` (required). The operator replies
`y` / `n` / `yes` / `no` / `allow` / `deny` (case-insensitive); anything
else falls through to the regular terminal prompt as a safety net.
Permbot lifecycle is the MCP's lifecycle — `roost shutdown` reaps it
along with the worker.

Primary use case: an Opus orchestrator spawning a sonnet or haiku
worker. Non-Opus workers default to `acceptEdits` (edits auto-approved;
Bash and MCP still gate). With `--perm-irc --perm-target <orchestrator>`,
those remaining prompts come to the orchestrator over IRC instead of
blocking the terminal. Same pattern works for a human at any roost-attached
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
`roost spawn --perm-irc` injects the `PermissionRequest` hook into
the spawned session via `--settings`; sessions without `--perm-irc`
do not have the hook loaded.

The hook auto-passes any `mcp__roost-irc__*` tool through without
asking — otherwise the worker couldn't talk on IRC, including replying
to its own approver.

To find permbot logs for a running session:

```bash
dir=$(tmux show-environment -t roost-<nick> ROOST_DATA_DIR | sed 's/ROOST_DATA_DIR=//')
cat "$dir/permbot.log"
```

The data dir is also printed by `roost spawn` as "data dir: ...".

## AskUserQuestion routing (--ask-irc)

Routes AskUserQuestion calls to a channel instead of blocking the terminal; pair with --ask-target (the nick whose replies count).

```bash
# Lead-pm routes questions to the leads channel (human answers):
roost spawn myproject-lead-pm --agent lead-pm \
  --ask-irc '#myproject-leads' --ask-target <your-nick>

# APM routes questions to the leads channel (lead-pm answers):
roost spawn myproject-apm --agent associate-pm \
  --ask-irc '#myproject-leads' --ask-target myproject-lead-pm
```

`--ask-target` defaults to `--perm-target` when both are set. See
`roost spawn --help` ("Agent class guidance") for the full role→flag heuristic.

## Prerequisites

Ergo must be running on `127.0.0.1:6667`. `roost status` checks;
`roost spawn` aborts with a hint if it's down. Start with:

```bash
mkdir -p ~/roost-ircd/logs && cd ~/roost-ircd
nohup ergo run --conf "$(roost root)/etc/ergo.yaml" > /tmp/ergo.out 2>&1 &
```

Stop with `pkill -f 'ergo run.*roost/etc/ergo.yaml'`.

## Naming conventions

Multiple projects can share one ergo. To avoid IRC nick + channel
collisions, every per-project nick + channel carries a project prefix
(the project's lowercase slug, matching `^[a-z0-9][a-z0-9-]*$`):

- **Standing agents** — stable nicks for long-lived roles. One instance
  per role. In a project: `<project>-lead-pm`, `<project>-dispatcher`.
- **Per-issue workers** — `<project>-worker-<N>`, e.g. `myproj-worker-196`.
  Ephemeral; join their channel on assignment, leave on completion.
- **Per-PR reviewers** — `<project>-reviewer-<PR>`, e.g. `myproj-reviewer-123`.
  Join on CI green, leave on conclude.
- **Observers (ad-hoc)** — descriptive nicks (`ci-feed-monitor`, `metrics-A`).
- **Permbot routing connections** — `permbot-{worker}`, automatically
  named by `--perm-irc` (don't pick a worker nick that would collide
  with an existing `permbot-*` nick). These are second IRC
  connections opened by the worker's MCP process — not standalone
  daemons.

The prefix is for IRC nick uniqueness and GitHub comment attribution
when agents share one GH account. It is not an in-chat speaker label —
IRC nicks already show who said what.

Multi-repo mode (no top-level `config.repo`) inserts a `<slug>` segment
into every per-issue artifact: `#<project>-<slug>-issue-<N>`,
`<project>-<slug>-worker-<N>`, `<project>-<slug>-reviewer-<N>`. The slug
is the lowercased repo basename (`Owner/Foo` → `foo`). Cross-org name
overlap (`Org1/foo` + `Org2/foo`) is a known footgun. Single-repo mode
(with `config.repo` set) keeps the bare `<project>-issue-<N>` shape.

Ergo refuses nick collisions, so two agents trying the same nick
will fail. The wrapper doesn't enforce uniqueness for you — pick
nicks that won't collide with what's already on the server. Check
with `roost status` (which lists running tmux sessions).

## Channel conventions

- `#roost` — default landing channel. Cross-cutting only; no
  persistent per-PR worker traffic.
- `#<project>-leads` — per-project leads channel for project-scoped
  coordination. Lead-pm + APM + dispatcher live here.
- `#<project>-issue-<N>` — one per active issue. Created on first JOIN;
  dissolves when the last member leaves.
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
