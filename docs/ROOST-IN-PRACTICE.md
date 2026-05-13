# Roost in practice

Suppose you're sitting on a milestone — a dozen GitHub issues you'd
like to ship together. Some block others, some are independent.
You'd like to point coding agents at them and have them all making
progress in parallel, but you've also seen what happens when you
spawn five Claude sessions in five terminals: it stops being software
delivery and starts being terminal whack-a-mole. The agents can't
talk to each other. You can't watch them all. When one of them
wedges on a permission prompt, you don't notice for half an hour.

Roost is the answer to that. It's a local IRC server, a small MCP
that lets each Claude session join channels and exchange messages,
a small TypeScript **dispatcher** that watches GitHub and posts
events to the right channels, and a handful of slash-command
prompts that make the agents play their roles consistently. Each
agent connects with one nick. You connect from `weechat` (or any
IRC client) on the same box.
Suddenly the entire project is a single window — every agent's
chatter, every PR comment, every CI transition, in one feed.

The shape is easier to see by walking through what running a
project actually looks like.

## A milestone, end to end

You spawn one agent — the project manager — and hand it the name
of a GitHub milestone. It joins a channel called `#leads-<project>`
and posts its starting strategy: which issues are pickable right
now (nothing blocking them), which are deferred, which it wants to
sequence carefully. You read the strategy in your IRC client, push
back where you disagree, and bless it. From there the agent runs.

That agent is **lead-pm**. Its operational playbook lives at
`prompts/lead-pm.md` — issue pickup, plan pressure-testing,
draft PR → reviewer → ready flip → merge → cleanup, in order. It
sits in `#leads-<project>` continuously and joins each issue
channel while it's active.

For the first issue, lead-pm opens a channel called `#issue-42`,
DMs the dispatcher (`watch 42`) to subscribe to the issue (so
GitHub events for it route to that channel), creates an isolated
git worktree, and spawns a worker into it.

**worker-42** reads the issue, posts an implementation plan in
`#issue-42`, and waits. lead-pm reads the plan and pushes back —
this is where rework is cheap, so a few rounds of pressure-testing
are normal. Once the plan holds up, the worker implements, opens a
draft PR, and posts the link in the channel. Worker's playbook is
`prompts/worker.md`.

Now CI runs. The dispatcher is polling GitHub on a tick; when CI
flips green, it posts `ci_transitioned: SUCCESS` into `#issue-42`.
lead-pm sees it and spawns a **reviewer-42** against the PR. The reviewer reads the
diff cold, posts findings to GitHub, and exits. Its playbook is
`prompts/reviewer.md`. The worker addresses the findings; lead-pm
flips the PR ready and tags you as the human reviewer.

You approve. lead-pm merges, terminates the worker, parts the
channel, cleans up the worktree, DMs the dispatcher to unsubscribe
(`unwatch 42`, `unwatch pr 73`), and posts a one-paragraph
postmortem in `#leads-<project>` — what
went well, what was painful, what to fix next time. Then it picks
the next pickable issue off the DAG and the cycle repeats.

## Parallelism is the channel structure

Nothing in that walkthrough requires one issue at a time. The
second issue is also in flight in `#issue-43`, with its own worker,
its own reviewer cycle, its own CI pipeline. So is the third in
`#issue-44`. lead-pm is in all of them and `#leads-<project>`
simultaneously, picking the next pickable issue off the DAG when
bandwidth opens. You're in `#leads-<project>` watching the
through-line and dipping into individual issue channels when
something catches your eye.

The IRC channel is doing more work than it looks like. It's the
namespace boundary — one channel, one issue's scope. It's the
membership ledger — lead-pm spawns workers and reviewers into the
right channel, and the join/leave events mark pickup and
completion. It's the audit log — everything any agent did or said
is in the backlog. It's the subscription primitive — the
dispatcher posts to the channel; whoever's in it gets the event.
One mechanism for all of it, all of it transparent to you.

Three or four issues in flight is comfortable on a laptop. The
ceiling isn't Roost — it's how much review attention you have.

## What you get

Agents are cheap. A wedged worker is usually something to kick,
not something to debug. The fresh worker JOINs the same channel,
reads the backlog (replayed on JOIN via IRCv3 chathistory) and the
channel topic, and picks up. The issue channel is stable across PR
restarts too — a closed PR plus a fresh worker on the same issue
keeps the same `#issue-N`.

You stay in the loop without being in the way. You can answer a
worker's question in `#issue-42`, redirect a plan, or just lurk and
let the lead-pm handle it. Because everything routes through
channels, your messages land in the same feed the agents are
already reading. There's no second pathway for "human-to-agent" —
you're just another nick on the IRC server.

The slash-command prompts (`prompts/lead-pm.md`,
`prompts/worker.md`, `prompts/reviewer.md`) are the operational
source of truth — they're what the agents actually run, and they're
the right starting point for standing up your own project on Roost.
