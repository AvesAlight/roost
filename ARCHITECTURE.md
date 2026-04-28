# roost — communication architecture

A local IRC server with multiple Claude Code sessions on it. Each
session runs a `roost-irc` MCP that turns inbound IRC into channel
notifications and exposes outbound IRC as tools. A human can join
from `irssi` and see everything.

## Topology

```
                     ngircd (127.0.0.1:6667)
                              │
        ┌─────────┬───────────┼───────────┬─────────┐
        │         │           │           │         │
   productops  dispatcher  worker-X  reviewer-Y   alex
   (standing)  (project)   (per-PR)   (per-PR)   (irssi)
```

## Channels

| Channel    | Purpose |
|------------|---------|
| `#staff`   | Standing senior agents (productops, cos, finance, sales, opsmanager, tooldev). Cross-cutting only. |
| `#pr-NNN`  | One per active PR. Dispatcher publishes events directly. Worker joins on pickup, leaves on merge. Reviewer joins on CI green, leaves on conclude. ProductOps observes; steps in only for needs-interpretation events. |

## Identities

- **Standing** — stable nicks (`productops`, `cos`, `tooldev`, …).
  Sit in `#staff`, visit project channels for unclaimed events.
- **Workers** — ephemeral (`worker-NNN-X`). Join `#pr-NNN` on
  assignment, leave on completion.
- **Dispatchers** — one per project. Publish per-PR events
  directly to `#pr-NNN`. Not Claude sessions; Python scripts.

## Routing

- **Routine signals** (CI green, CEO-APPROVED, CHANGES_REQUESTED):
  dispatcher → `#pr-NNN` → worker. ProductOps not in the path.
- **Ambiguous CEO directives**: land in channel with a
  needs-interpretation flag. Workers clear the flag by claiming
  ("I've got this") when the directive is unambiguous to them.
  Unclaimed = ProductOps's queue.
- **Worker ↔ reviewer**: co-located in `#pr-NNN`. No relay.

## Lifecycle = membership

- Worker pickup = `JOIN #pr-NNN`.
- Reviewer engagement = `JOIN #pr-NNN`.
- Hard restart = kick the worker, fresh worker `JOIN`s.
- Assignment end = `PART` (or merge → channel cleanup).

The MCP pushes `JOIN`/`PART`/`KICK` events as channel notifications,
so agents see the membership transitions in real time.

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
