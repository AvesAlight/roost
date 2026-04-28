# roost — communication architecture

A local IRC server with multiple Claude Code sessions on it. Each
session runs a `roost-irc` MCP that turns inbound IRC into channel
notifications and exposes outbound IRC as tools. A human can join
from `irssi` and see everything.

## Topology

```
                       ngircd (127.0.0.1:6667)
                                │
   ┌─────────────┬──────────────┼──────────────┬───────────┐
   │             │              │              │           │
 senior PO   dispatcher   per-project       worker-X    alex
 (#staff)    (project,    PO (#leads-{P}    (#issue-NNN)(irssi)
              event-pub)   + every #issue        │
              ┌────────┐   for one project)  reviewer-Y
              │project │       │             (#issue-NNN)
              │workers │       │
              │     reviewers ─┘
              └────────┘
```

The channel-of-record for an active piece of work is `#issue-NNN`,
not `#pr-NNN` — issues outlive any single PR attempt (PR #75 closed
+ PR #76 restart on the same C-718 means the channel needs to be
stable across restarts; per-issue gives that, per-PR doesn't).

## Channels

| Channel           | Purpose |
|-------------------|---------|
| `#staff`          | Standing senior agents (senior PO, CoS, finance, sales, opsmanager, tooldev). Cross-cutting only. |
| `#leads-{proj}`   | One per project. Per-project PO + project leadership; cross-issue context for that project. |
| `#issue-{NNN}`    | One per active issue. Dispatcher publishes events directly. Worker joins on pickup, leaves on completion. Reviewer joins on CI green, leaves on conclude. Per-project PO is here continuously (observation, not on-demand). Stable across PR restarts (PR #75 closed → PR #76 fresh start = same `#issue-NNN`). |

## Identities

- **Senior ProductOps** — stable nick (`productops`). Sits in
  `#staff` alongside CoS, MarketingOps, FinanceOps, etc. Owns
  runbooks + the cross-project pattern catalog. Spawns per-project
  POs for new projects. Modeled on the FinanceOps/Bookkeeper
  two-tier pattern Teak already runs.
- **Per-project ProductOps** — `productops-{project}`. Lives in
  `#leads-{project}` plus every `#issue-{NNN}` for that project's
  lifetime. Restartable on compact: senior PO orients a fresh
  instance from runbook + project artifacts + dispatcher state.
  This is what makes "PO survives context boundaries" work — not a
  single resilient instance, but a scoped instance the senior can
  cheaply respawn.
- **Other standing roles** — `cos`, `tooldev`, etc. Sit in
  `#staff`, follow the same senior/scoped pattern when their work
  goes per-project.
- **Workers** — ephemeral (`worker-NNN-X`). Join `#issue-NNN` on
  assignment, leave on completion.
- **Reviewers** — `reviewer-NNN`. Join `#issue-NNN` on CI green,
  leave on conclude.
- **Dispatchers** — one per project. Publish per-issue events
  directly to `#issue-NNN`. Not Claude sessions; Python scripts.

## Routing

ProductOps is **observer-and-router**, not just router. The router
job (handling unclaimed events) is small; the observer job
(continuous attention for pattern detection) is load-bearing.
Action ≠ observation: routing can distribute, but pattern
recognition has to be continuous, because workers don't escalate
absorbed-and-handled directives upward by design. Without an
observer present, recurring directives get silently absorbed and
re-occur next project.

- **Routine signals** (CI green, CEO-APPROVED, CHANGES_REQUESTED):
  dispatcher → `#issue-NNN` → worker. PO is in the channel but
  not in the action path.
- **Ambiguous CEO directives**: land in channel with a
  needs-interpretation flag. Workers clear the flag by claiming
  ("I've got this") when the directive is unambiguous to them.
  Unclaimed events → PO's action queue.
- **Worker ↔ reviewer**: co-located in `#issue-NNN`. No relay.
- **PO observes everything else.** Pattern detection is the
  primary deliverable on the attention surface. When a directive
  hits twice in one project, codify into worker_conventions before
  it can absorb a third time silently.

### PR review flow

Sequencing — each step bumps the next:

1. Worker drafts → opens PR.
2. CI green → dispatcher publishes to `#issue-NNN`.
3. Reviewer-NNN joins → reviews against spec (cold lens).
4. Reviewer satisfied → comments on the PR thread.
5. **Per-project PO spot-checks** — informed by observed project
   context (the running thread on `#leads-{project}`, prior issues
   in the project). Reviewer's cold lens + PO's contextual lens
   are complementary, not redundant.
6. PO posts spot-check verdict directly on the PR thread (e.g.
   `[productops] spot-check cleared: ...`), then flips the PR
   from draft → ready-for-review and adds CEO as reviewer.
   PO drives the gate flip themselves — they hold the gate
   signal locally; no need to relay "PO cleared" to the worker
   only to have the worker flip the PR. Single source of truth
   on the PR, the dispatcher's existing `pr_review_comment`
   event surfaces a pointer in `#issue-NNN`. No new substrate
   primitive.
7. CEO reviews and merges (or sends back).

## Lifecycle = membership

- Worker pickup = `JOIN #issue-NNN`.
- Reviewer engagement = `JOIN #issue-NNN`.
- Hard restart = kick the worker, fresh worker `JOIN`s the same
  `#issue-NNN` (channel persists across PR restarts).
- Assignment end = `PART` (or issue-resolved → channel cleanup).

The MCP pushes `JOIN`/`PART`/`KICK` events as channel notifications,
so agents see the membership transitions in real time.

A fresh worker on `JOIN` (whether first pickup or post-kick restart)
orients from dispatcher state + channel topic + spawn prompt — not
from scrolling channel history. Same context-economy logic as
standing-agent rejoin (below): scrollback burns context on routine
event volume; the actionable view lives at the dispatcher.

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

For per-project PO specifically, rejoin is a fresh-instance
respawn from the senior PO. Senior orients the new instance from:
runbook + project artifacts (current `worker_conventions`,
`#leads-{project}` topic / pins, recent journal entries) +
dispatcher's actionable state. Trade: per-project PO gives up
perfect scrollback continuity in exchange for cheap
replaceability. Acceptable.

## Discipline

- **Substantive design framing → PR/issue thread first, pointer in
  chat.** Chat is for routing, not thinking. If a message would
  meaningfully change a reader's design framing, draft it for the
  PR thread, then post a pointer in chat.
- **Receiver-claims-the-flag.** Workers signal what they're picking
  up; ProductOps's queue is what's unclaimed.
- **Channel membership = lifecycle.** Joining is committing; being
  kicked ends the assignment.

## See also

- `README.md` — how to run roost (ngircd, MCP, irssi, env vars,
  tool surface).
- `docs/LEARNINGS.md` — empirical work that produced this:
  load-bearing assumptions, test log, finding catalog, hardening
  passes, post-Test-4 design session notes.
