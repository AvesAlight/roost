# Project execution — a worked example

How to drive a planned milestone through Roost, with multiple workers
in flight at once. Roost-on-Roost is the canonical example: this is
how the team actually runs the project, dogfooding the substrate.

This doc uses **lead-pm** for the project-driving agent;
`ARCHITECTURE.md` calls the same role per-project PO / productops.
Read alongside:

- `README.md` — install, ergo, the `roost` CLI surface.
- `ARCHITECTURE.md` — channel topology, identities, lifecycle.
- `prompts/lead-pm.md` — the lead-pm slash command (the playbook).
- `docs/ORCHESTRATOR.md` — dispatcher config + event list.

## What you need first

A milestone in GitHub with issues filed against it. Use GitHub's
blocking / blocked-by relationships — the lead-pm reads them to build
its DAG.

Roost installed and ergo running (`README.md` → "Setup").

## Bring-up

**1. Configure the dispatcher.** Edit `.orchestrator/config.json` for
your repo and project channel (shape in `docs/ORCHESTRATOR.md`).
Optionally seed initial state so a fresh run doesn't replay history:

```bash
bin/orchestrator_poll --seed     # one-shot, no events emitted
```

Don't start the daemon yourself — the watcher boots it on spawn.

**2. Spawn lead-pm.** This is the agent that drives the milestone:

```bash
roost spawn lead-pm \
  -c '#leads-<project>' \
  --prompt '/lead-pm <milestone>'
```

It spawns its own watcher (see `prompts/lead-pm.md`), and the watcher's
first action is `nohup bin/orchestrator_poll --daemon &`. lead-pm then
posts a starting strategy in `#leads-<project>` and waits for you to
approve the wave before spawning workers.

**3. Observe (optional).** `irssi -c 127.0.0.1 -n alex`, then
`/join #leads-<project>`.

## The per-issue loop

Driven by lead-pm against `prompts/lead-pm.md`, step-by-step:

1. lead-pm picks an issue, joins `#issue-N`, dm's the watcher to
   subscribe, runs `script/worktree feat/N-...` for an isolated tree.
2. Spawns `worker-N` in that worktree against `/worker N OWNER/REPO BRANCH`.
   Sonnet for routine work, Opus for cross-cutting design.
3. Worker posts a plan in `#issue-N` and waits. lead-pm pressure-tests
   it (this is where rework is cheap — multiple rounds are fine).
4. Worker drafts the PR, posts the link. lead-pm asks the watcher to
   `watch pr <N>`, then spawns a `reviewer-N` against `/reviewer ...`.
5. Reviewer comments on GitHub and exits. Worker addresses findings.
6. lead-pm flips the PR ready and adds the human as reviewer (workers
   never do this themselves).
7. Human approves → merge → terminate worker → unwatch → clean up
   worktree → postmortem in `#leads-<project>`.

## Where parallelism comes from

One channel per active issue (`#issue-N`), one worker per channel,
all running concurrently. lead-pm sits in `#leads-<project>` plus
every active `#issue-N`, so it sees every worker / reviewer / dispatcher
event in real time.

The DAG from GitHub blocks/blocked-by tells lead-pm what's pickable
right now. Anything unblocked is fair game for the next wave.

The ceiling on workers in flight is your laptop and your attention,
not Roost. Three or four workers across distinct issues is comfortable;
more is fine if the issues are small and the reviewers are fast.

## Observing

- `roost list` — every running session.
- `roost tail <nick>` — last N lines of a session's TUI without
  attaching (good for "is this stuck or alive?").
- `roost attach <nick>` — attach to a session's tmux pane.
- `irssi` — same channel feed the agents see, in real time.

Per-MCP logs live at
`~/Library/Caches/claude-cli-nodejs/<project>/mcp-logs-roost-irc/`,
where `<project>` is the session's cwd with slashes replaced by
dashes (e.g. `-Users-alex-Dev-GoCarrot-roost`).

## Gotchas

- **Permission flooding on non-Opus workers.** Sonnet/Haiku can't run
  `--permission-mode auto`. Use `--perm-irc --perm-target lead-pm` so
  prompts come to lead-pm over IRC instead of stalling the worker
  terminal. lead-pm's prompt sets this up by default.
- **Ambiguous issue body.** If the issue is < ~3 sentences or
  scope-ambiguous, lead-pm asks the human for a one-line clarification
  before spawning the worker. Cheaper than a wrong PR.
- **Channels outlive PRs.** `#issue-N`, not `#pr-N` — a closed PR plus
  a restart on the same issue keeps the same channel. See
  `ARCHITECTURE.md`.
- **Worktrees, not branches in the main checkout.** `script/worktree`
  bootstraps an isolated tree with deps installed and
  `.claude/settings.local.json` copied through. Workers run in their
  own worktree so multiple workers don't fight over the index.
