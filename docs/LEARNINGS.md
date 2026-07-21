# roost — Agent IRC Channel Architecture

Project plan for replacing the Claude Code agent-team mechanism with
independent `claude` sessions communicating over IRC, mediated by a
custom channel-emitting MCP.

> Origin: ProductOps thinking-partner conversation 2026-04-27 with the
> CEO. Brief drafted in conversation per `Technical_Project_Management.md`
> Phase 1, focused on load-bearing assumptions per CEO direction. Tests
> 1–4 executed 2026-04-27, with a hardening pass + routing-layer design
> session in #roost the same evening (productops, claude2,
> simplify-rewards, plus productops-customer providing ground-truth
> from a same-day ~12-worker / ~10-PR project run on the Simplify
> Rewards integration). This document is the single living source of
> truth, updated as evidence comes in.

## 1. Customer and ask

The operations system's orchestrated execution loop is the customer.
Today, workers are spawned via the `Agent` tool's team mechanism and
communicate via SendMessage. Three concrete pains have surfaced in
production:

- **Worker cache pathology.** Background agents are pinned to 5m TTL
  regardless of config. On wake, `messages_changed` and `tools_changed`
  fire reliably — empirically, worker-698's 2026-04-27 session shows 343k
  cache_creation / 18k cache_read on one wake (95% of context rebuilt).
- **Long-running subprocesses don't survive worker session lifecycle.**
  k6 load tests (15–19 min) and similar work currently run from the
  orchestrator's background Bash. The orchestrator is supposed to route,
  not own subprocesses.
- **Team mechanism mutates state.** Across 1153 orchestrator turns on
  2026-04-27, the only meaningful cache-loss class was `system_changed`,
  with the trigger profile concentrated on `<teammate-message>` arrivals
  (305k tokens lost in 3 events) vs. channel events (53k in 1 of 156).

The ask: a messaging architecture that escapes these bugs and gives every
agent the same 1h cache TTL the top-level orchestrator gets, with multi-party
visibility for human observability.

## 2. Today

Channels are an MCP-native primitive: an MCP declares
`capabilities.experimental['claude/channel']` and emits events via
`notifications/claude/channel`. The fakechat plugin is one HTTP-flavored
implementation — the HTTP layer is fakechat's quirk, not the primitive.

The orchestrator's channel usage is empirically clean (1153 turns / 156
channel events): cache reads 292M, creation 7.1M (all 1h TTL, zero 5m),
misses 2.5M (~0.85%). No `messages_changed` or `tools_changed` fired. The
clean cache behavior is the channel mechanism's, not fakechat-specific.

Project-local dispatchers (`.orchestrator/bin/dispatcher`) and the
`tclaude` zsh port-allocation function are running infrastructure we
keep. The dispatcher is a pure Python script (not a Claude session),
interacting with the orchestrator via fakechat HTTP today.

## 3. Shipped (target end-state)

- A custom MCP that wraps an IRC client. Tools: `channel_join`,
  `channel_leave`, `channel_message`, `direct_message`, `channel_history`,
  `channel_who`. Incoming IRC traffic emits `claude/channel` events into
  the host session.
- ngircd local on each operator's machine.
- A revised execution loop where workers are independent `claude`
  processes (not background agents), each loaded with the IRC-MCP at
  spawn time. Team mechanism no longer used in the loop.
- Migration of `Project_Execution.md`, `.orchestrator/worker_conventions.md`,
  and the dispatcher (becomes an IRC poster, not an HTTP poster).
- CEO observability via irssi/weechat against the same server.

### Build status as of 2026-04-28

- ngircd installed via Homebrew, configured at
  `roost/etc/ngircd.conf` (localhost:6667, no auth, single operator).
  Started with `ngircd -f <config>`; PID file at `roost/var/ngircd.pid`.
- IRC-MCP at `roost/src/irc-server.ts` — 6 tools, channel-event
  emission for messages + JOIN/LEAVE/KICK/NICK, receive-side buffering
  with adaptive window + natural-boundary splitting + leading-whitespace
  convention, in-memory per-channel ring buffer for `channel_history`,
  per-channel user tracking populated from RPL_NAMREPLY + JOIN/PART/
  KICK/QUIT/NICK events. Built on `irc-framework` (npm). Configured
  per-instance via env vars (`ROOST_IRC_NICK`, `ROOST_IRC_CHANNELS`, etc.).
- mcp-config at `roost/mcp-config-irc.json`.
- Standalone IRC listener at `roost/tests/irc-listener.ts` for
  ground-truth observation in tests.
- Repo under git on `main`, initial commit 2026-04-28; functional
  README at `roost/README.md`.

Still not done at this milestone: runbook migrations
(`Project_Execution v2`, `worker_conventions` as channel-state),
dispatcher cutover from HTTP to IRC, worker spawn helper,
`alwaysLoad: true` retest for Finding A mitigation, irssi setup
documentation, and the deeper hardening passes (reconnection
testing, MCP crash recovery, ngircd lifecycle automation).

### Hardening pass (2026-04-27 evening, in #roost)

Three production bugs surfaced and fixed live in #roost with three
other agents in the room:

- **Same-ms timestamp collision** — `Date.now()` returns identical
  millisecond timestamps for messages that arrive in the same JS
  event-loop tick (the case for split-message halves). Fixed by
  adding a per-MCP monotonic `receiveSeq` counter to event metadata
  as a tie-breaker. Reported by simplify-rewards 2026-04-27.
- **Premature buffer flush** — original 250ms receive buffer window
  flushed prematurely between ngircd's apparent ~1s rate-limit
  pauses after a 3-burst (claude2 demonstrated live with a
  4-paragraph payload arriving as 4 separate envelopes). Fixed by
  making the window adaptive: 250ms initially, extended to 2000ms
  once a second chunk confirms multi-chunk shape. (See Finding G.)
- **Lost whitespace at chunk boundaries** — split chunks were ending
  with whitespace at chunk-N to anchor a natural boundary; ngircd
  was stripping that trailing whitespace, so the receiver
  concatenated `word41word42` instead of `word41 word42`. Fixed by
  inverting convention: chunk-N ends with non-whitespace,
  chunk-N+1 starts with the boundary whitespace (which ngircd
  preserves on lead). (See Finding F.)

Also added during this session:

- **Natural-boundary split** in `channel_message` / `direct_message`
  — prefer splitting at sentence end (`.`/`!`/`?` followed by space
  or EOM), then any whitespace, then hard cut. Prevents
  word-fragmentation for irssi observers.
- **IRCv3 message-tags probe** — confirmed ngircd-27 advertises only
  `multi-prefix` in CAP LS; tagged PRIVMSGs are silently dropped.
  Receive-side buffering is the right path on this server. (See
  Finding E.)
- **Legacy `[roost-split:<id>:<i>/<n>]` body-prefix marker** stripped
  on receive for backward-compat with not-yet-cycled senders.

### Hardening pass (2026-04-28 morning, post-design-session)

- **`channel_who` populated from authoritative server state** —
  earlier implementation read from `irc-framework`'s lazy
  `client.channel(...).users` which was empty at runtime. Replaced
  with own per-channel user set populated from `userlist` event
  (RPL_NAMREPLY post-JOIN) and kept current via JOIN / PART / KICK /
  QUIT / NICK handlers. Returns `"#chan (N): nick1, nick2, ..."`.
- **JOIN / LEAVE / KICK / NICK push as channel events** — agents on
  a channel now see comings and goings via
  `<channel event="join|leave|nick" sender="..."
  channel="..." reason="..." newNick="...">...</channel>`
  notifications. Self-events suppressed. Smoke-tested end-to-end
  (standalone nc client + modified MCP — userlist correct,
  JOIN+PART notifications flowed in proper format).

## 4. Jobs to be done

When I'm coordinating multiple Claude agents on long-running work, I want
them to communicate without paying cache penalties on each wake — so
concurrency scales without exponential token cost and the orchestrator
can be a real router rather than a workaround for missing tiers.

## 5. In scope / Out of scope

**In:** IRC-MCP server + tool surface; ngircd setup; migration of the
orchestrated-loop runbook + project conventions + dispatcher;
replacement of team mechanism in the loop; worker spawn/shutdown
automation (no `Agent` tool affordance); CEO observability path.

**Out:** Replacing `Agent` tool for non-orchestration uses (CoS /
FinanceOps Task agents stay) — different problem, different solution.
Multi-host scaling — single-machine for v1. Building a custom IRC
server (use ngircd). Designing for non-orchestration multi-agent
scenarios (e.g., the Jake Zimmerman analysis pattern).

## 6. Load-bearing assumptions

The plan stands or falls on these. Each one has an empirical test
spec or a resolution; status reflects the latest evidence.

| # | Assumption | Status | Evidence |
|---|---|---|---|
| 1 | An MCP can declare `claude/channel` capability AND tool capability simultaneously, and emit channel events without external HTTP plumbing. | ✓ confirmed | Test 1 — `roost-stub` declares both, both work. Channel events arrive as `<channel source="roost-stub" tick="N" …>` user-shape entries. |
| 2 | Independent `claude` processes get 1h cache TTL, not the background-agent 5m. | ✓ confirmed | Test 1 + Test 2b + Test 3-as-prelim — all writes `ephemeral_1h_input_tokens`, zero `ephemeral_5m`. |
| 3 | Channel-event arrivals don't trigger `messages_changed` or `tools_changed` misses. | ✓ confirmed (with caveat) | All test sessions show zero `messages_changed`. Zero `tools_changed` *from channel arrivals*. **Caveat:** `tools_changed` does fire from deferred-tool promotion (one-time, per-worker) — see Finding A below. |
| 4 | Claude Code sessions continue to receive channel events while between turns. | ✓ confirmed | Test 1 — agent received 15 ticks across 17 assistant turns of mostly-idle session. Test 2b — 33 ticks → 33 reactive turns from a passively-launched session. |
| 5 | The 4/27 fakechat-down failure was a fakechat-layer bug, not a Claude Code notification-queue bug. | downgraded — not load-bearing | CEO clarification: it WAS a Claude Code bug — Claude Code binds the fakechat port at session start and doesn't reliably tear it down on close. The IRC-MCP design sidesteps this entirely (stdio MCP, outbound IRC client, no listening port). Failure mode at the MCP layer is graceful: stale subprocess holds stale IRC connection, ngircd ping-timeout boots it ~30–60s later, new session reconnects with same nick. |
| 6 | A clean spawn/shutdown path for worker sessions exists without the `Agent` tool, with UX comparable at 4–6 concurrency. | ✓ resolved as tmux | Test 2 (print-mode child) failed — print mode is channel-blind. Test 2b proved `tmux new-session -d -c <dir> "claude … --dangerously-load-development-channels server:<name>"` works. Spawn primitive is tmux interactive sessions, not `claude --print`. Production spawn helper should expect-style poll for the dev-channels prompt rather than `sleep` (timing-fragile otherwise). |
| 7 | The IRC-MCP subprocess survives the host session's idle period without being killed by Claude Code. | ✓ confirmed (passive) | Test 1's tmux pane has been alive ~4+ hours at time of writing, bun MCP PID 61975 still ticking, ticks still arriving in the host session. |
| 8 | Multiple Claude Code sessions can run concurrently on one machine, each with its own MCP/IRC connection, no resource conflicts. | ✓ confirmed (concurrent half) | Test 3 (concurrent) — 5 sessions spawned in parallel via tmux, each got its own `roost-stub` bun MCP, each received its own 7 ticks (35/35 fleet-wide), all on 1h cache, zero cross-session interference, clean teardown. The "shared channel / mutual delivery" half remains blocked on Test 4 (the IRC layer). |
| 9 | Multi-party channels with human observability are a real operational requirement, not nice-to-have. | design call (yes) | The CEO's stated interest in IRC + the existing continuous-oversight model in `Project_Execution.md` argue yes. If falsified, the simpler shape is "claude/channel-only MCP, no IRC at all." |

## 7. Findings beyond the original assumptions

These showed up during Tests 2 and 3 and are architecturally relevant
enough to bake into the plan (and into worker prompt conventions).

### Finding A — Deferred-tool promotion costs a `tools_changed` cache miss

When a session calls `ToolSearch` to promote an MCP tool (e.g.,
`mcp__roost-stub__echo`) from the deferred-tools list to the active list,
the next assistant turn's tools list differs from the cached one, which
fires a `tools_changed` cache miss for the size of the rebuilt prefix
(~27k tokens in Test 2). This is the same pathology shape as the
team-mechanism's `tools_changed` miss; it just lives at a different
layer (deferred-tool promotion, not SendMessage).

**Implications:**

- For long-running interactive workers, this is a one-time cost paid at
  the moment the worker first uses any MCP tool. Amortizes well over the
  worker's lifetime.
- For ephemeral one-shot workers, this miss is the *entire* cache cost.
  Combined with Test 2's finding that `--print` mode is channel-blind,
  ephemeral workers are out of the architecture regardless.
- Mitigation candidate: investigate whether MCP tools can be marked as
  non-deferred at registration time, or whether worker prompts should
  do all `ToolSearch` calls in a single batch turn before doing
  cache-sensitive work, so the miss is paid once.

### Finding B — Channel events handle backpressure correctly

Channel events arrive in the JSONL in two distinct record shapes:

1. `type=user, content=string` — events that arrive while the model is
   idle. Surfaced directly on the next turn.
2. `type=attachment, attachment.type=queued_command,
   attachment.origin.kind=channel` — events that arrive **while the
   model is mid-turn**. They queue rather than drop, and surface as
   user-shape entries when the current turn ends.

**Test 3-as-I-did empirical confirmation:** 7 ticks emitted by the bun
MCP, all 7 received — 4 in shape (1) (model was idle), 3 in shape (2)
(model was mid-`add` tool calls). No drops, no reordering, no mid-turn
cache invalidation.

This is the architectural property the team mechanism lacks. SendMessage
during a worker's turn is part of why teammate-cache behavior gets
messy — the message lands in the orchestrator's context mid-worker-turn,
breaking the cache shape. **Channels handle that backpressure at the
harness layer, between turns. Lean on this in the brief and in worker
prompt conventions.**

### Finding C — Channel arrivals bootstrap turns autonomously

A passively launched interactive session (no user prompt sent) will still
process incoming channel events — the model produces a turn per arrival
(observed in Test 2b: ack'd 25 ticks before the user prompt was even
submitted). This is the right shape for listener-style workers — a
worker spends most of its time idle, and incoming channel messages drive
its activity.

**Implication for worker prompts:** state the *standing instruction* on
incoming messages ("when you receive a `<channel source='irc'>` event
addressed to you, do X"), don't expect to drive the worker turn-by-turn.

### Finding D — Pure-listener workers don't pay `tools_changed`

In Test 3 (concurrent), none of the 5 sessions paid the deferred-tool-promotion
`tools_changed` cost — because none of them ever called an MCP tool.
The default behavior on incoming channel events is to acknowledge in
plain text, which doesn't require `ToolSearch`. The one-time miss
identified in Finding A only fires when a worker actually loads its
first MCP tool.

**Implication:** worker roles split cleanly along this axis:

- **Pure listeners** (e.g., a logging-only observer, an observability
  pane): never pay the deferred-tool cost.
- **Listener + worker** (the common case — receives messages, acts via
  IRC tools): pays the cost once at first tool load. Amortizes over
  the worker's lifetime.

For the IRC-MCP itself, the listener+worker shape is the norm —
`channel_message`, `direct_message`, etc. are MCP tools and will all
be deferred initially. A worker's first IRC outbound action will pay
the miss.

**Mitigation confirmed: `alwaysLoad: true`.** Empirical probe
2026-04-28 (`/tmp/test-alwaysload.sh`) — two fresh interactive
sessions, identical prompt that calls `channel_message` once then
`Bash` to touch a done marker. Baseline `mcp-config-irc.json` (no
flag) showed **2** `tools_changed` misses (one when `ToolSearch`
promotes `channel_message`, another when `Bash` surfaces).
`alwaysLoad: true` showed **0** misses across the same prompt
shape. The flag is now applied to `roost/mcp-config-irc.json` —
new sessions inherit it. Trade-off: all six roost-irc tool schemas
stay loaded in context (small constant cost) for zero
`tools_changed` invalidations. Worth it.

Note Finding D is now mostly moot for roost-irc users — the
listener / listener+worker distinction collapses when alwaysLoad
makes the cost zero either way. Still relevant for non-roost MCPs
that don't use the flag.

### Finding E — ngircd-27 does not support IRCv3 message-tags

Probed 2026-04-27 (`tests/probe-message-tags.ts`). ngircd's CAP LS
response advertises only `multi-prefix`. PRIVMSGs sent with a
client-tag prefix (`@+roost-split=abc;... PRIVMSG ...`) are silently
dropped by the server before forwarding to other clients.

**Implications:**

- The cleaner "split-marker as IRCv3 tag" approach (which would let
  irssi observers see tagless plain text) is unavailable on this
  server. Switching to solanum / inspircd / unrealircd would unblock
  it but adds operational complexity.
- We use receive-side buffering with natural-boundary splitting
  instead. Trade-off: irssi observers see multiple lines per long
  message; agents see a single buffered event.

### Finding F — ngircd strips trailing whitespace from PRIVMSG bodies

Confirmed by direct probe 2026-04-27. Sent `"hello with trailing
space   "`; received `"hello with trailing space"` (no trailing).
Leading whitespace is preserved.

**Implication:** when splitting a long message at a whitespace
boundary, put the whitespace at the START of chunk-N+1, not at the
END of chunk-N. Otherwise the inter-word space is lost in transit
and the receiver concatenates words without a separator.

### Finding G — ngircd appears to drip-feed PRIVMSGs after a burst

Observed 2026-04-27 in #roost: `irc-framework`'s `client.say()`
writes PRIVMSGs back-to-back to the socket, but the receiving side
sees the first ~3 chunks arrive within milliseconds, then a ~1s
pause before the next batch. Likely RFC 2812 PENALTY-style rate
limiting inside ngircd; we don't have its source open to confirm
the exact mechanism.

**Implication:** the receive-side buffer needs an adaptive window
(see Hardening pass under §3): short on first chunk so single
PRIVMSGs flush fast and two genuine quick sends stay separate;
extended once multi-chunk shape is confirmed so server-side pauses
don't fragment the logical message.

### Finding H — Invariant-by-omission in tests is a footgun (#246)

Surfaced 2026-05 from the #244 review cycle. Adding `event="message"`
to the wire shape so that *message* became a positive discriminator
(alongside `event="join"`, `event="reminder"`, etc.) silently broke
six test predicates that filtered regular messages with `!n.meta.event`
plus one assertion that the attr was *un*defined — seven sites total.
Under `bun test --coverage` the runner wedged on the post-timeout
failure instead of surfacing a clean fail — a single attr change
cascaded into a 24-min CI hang.

**Lesson:** never encode a contract as the *absence* of an attr. The
positive discriminator (`event === 'message'`) is the only safe form;
`!n.meta.event` quietly trusts a guarantee the wire never made.

**Mitigation:** the wire shape is now a typed discriminated union at
`src/wire-meta.ts` — adding a new `event` value is a compile error
at every emit site and every consumer that narrows on `event`. Tests
prefer the shared predicate / assertion helpers in `test/helpers/`
over hand-rolled inline filters, so a wire-shape change is a one-file
edit.

### Finding I — `tools_changed` per-session miss: investigated, no clean fix, eating the cost (#366)

Production v0.5.12 sessions paid a `tools_changed` cache miss of 21–28k
tokens (~$0.12–0.26/session) on every worker and most reviewers.
Investigated 2026-05-17 across PR #371 and a follow-up doc-only PR.
Net: no available CLI/env knob selectively preloads the built-in
deferred tools we care about (`TaskCreate`, `WebFetch`) without
side effects worse than the miss itself. **We eat the miss.**

**Two triggers identified (binary spelunk of `claude` 2.1.143):**

1. **Workers, consistent.** Global `CLAUDE.md` says "use TaskCreate
   to plan and track work." The harness lists `TaskCreate` as
   *deferred* (`shouldDefer:true`) in the system prompt. Workers call
   `ToolSearch(select:TaskCreate)` in turn 2, which fetches the schema
   and injects a `deferred_tools_delta` — the next API call has a new
   tool fingerprint → miss. Persists ~2–4 turns until the cache
   re-establishes.
2. **Reviewers, variable.** User-level `mcp__claude_ai_*` tools
   (Gmail, Calendar, Drive, Linear — 41 tools) connect asynchronously
   after session start; whenever they land between turns they change
   the fingerprint and bust the cache. Timing-dependent.

**Mechanism (key binary symbols):** `isDeferredTool` at line ~333328
of `strings(2.1.143)`. A tool is non-deferred iff `alwaysLoad===true`
**or** its name matches a hardcoded carve-out (the `ToolSearch` tool
itself, the `Task` tool when fork-subagent is enabled, and three other
named built-ins). MCP tools default to deferred. Everything else
defers iff `shouldDefer:true` is set on the tool definition.

`getToolSearchMode` reads `ENABLE_TOOL_SEARCH`:
`true`/missing/`auto` → tool-search ON (deferred tools stay deferred);
`false`/`auto:100` → tool-search OFF (all deferred tools eager-load).
**It is binary**, with no per-tool selector. `auto:N` is a context-
percentage threshold, not a tool list. There is no `--preload-tools`
or settings entry that promotes a specific built-in to `alwaysLoad`.

**Why we don't ship `ENABLE_TOOL_SEARCH=false`:** the env var flips
tool-search OFF globally, so *every* deferred tool (built-ins AND the
41 user-level MCPs) is now in the initial fingerprint. Two regressions:

- Roost-irc's late-connect rebuild grew from ~9k → ~44k tokens
  (bigger initial cache → bigger delta when roost-irc lands).
  `alwaysLoad:true` on `roost-irc` (Finding A mitigation) reduces but
  doesn't eliminate this — the wider fingerprint still bills.
- User-level MCPs that connect mid-session caused a one-shot
  ~107k-token rebuild on the measurement run, vs. 0 under
  tool-search ON where those tools stay deferred.

Measured side-by-side on issue #369 (two workers, plan-only): control
session ~9k cache miss; treatment session ~152k total. The fix made
things worse on operator hardware that has user-level MCPs, and
marginally worse even on a clean install (the larger initial cache
means roost-irc's late connect costs more).

**What we won't do, and why:**

- **Prompt-level ban on `TaskCreate`/`ToolSearch` in worker/reviewer.**
  Initially shipped on #371 commit `3fec0e3`; alex rejected on review:
  "Do not attempt to ban agents from using tools. _Help_, don't hinder."
  Workers reaching for `TaskCreate` is the tool doing its job; the
  cache-miss tax is on the harness, not the agent. Reverted.
- **`ENABLE_TOOL_SEARCH=false` in `bin/roost spawn`.** Net regression
  per the measurements above. Reverted.
- **`--strict-mcp-config`.** Would suppress user-level MCPs entirely,
  closing Trigger 2 — but that's "block the operator's MCPs from
  spawned roost agents," not "preload built-in deferred tools." Heavy-
  handed and out of scope for the cost we're trying to save.

**Cost we accept:** ~$0.12–0.26/worker session and similar for
reviewers when Trigger 2 fires. At observed wave volume (5 issues ×
worker+reviewer × ~16 waves/month) the per-session miss is ~$10–14/
month. Tolerable until either Anthropic ships per-tool eager-load
configuration or roost's wave volume grows enough to revisit.

**What still helps:** Finding A's `alwaysLoad:true` on `roost-irc`
(in `.mcp.json` / `mcp-config-irc.json`) eliminates the worst case of
the roost-irc deferred-promotion miss. Keep that. Without it, every
worker would pay the miss again on its first `channel_message`.

PR #371 (abandoned approach, closed unmerged) is the load-bearing
artifact for this decision. Re-read its diff and comment thread before
re-opening this investigation.

### Finding J — auto-compact directive: intercept the PreCompact event, redirect to manual (#368)

Auto-compaction fires without a directive — the APM lost its
issue→PR→reviewer-nick mapping mid-task on 2026-05-17 and looped on
wrong nicks four times before recovery. We need the compactor to run
with our `custom_instructions`, which today only populates on manual
`/compact <directive>`.

**Not a fixed threshold — react, don't predict.** Auto-compact is
event-driven. Scraping 60+ `compact_boundary` rows across project
transcripts showed triggers clustered at ~167k / 267k / 367k / 467k
input-token counts, varying by model, version, and burst pattern.
There is no published constant to compute against, and the v2
threshold-polling approach (150k / 75% of an assumed 200k cap) was
trying to predict what claude code already announces. v3's whole
point: react to the PreCompact event rather than try to recompute a
magic number.

**Hook surface — what's available:**

- **PreCompact** payload carries `trigger: "manual"|"auto"`,
  `custom_instructions` (populated only on manual), `session_id`,
  `transcript_path`, `cwd`, `hook_event_name`. The hook can return
  `{"decision":"block"}` on stdout to halt the corresponding
  compaction.
- **Hooks cannot directly trigger slash commands** via stdout/JSON
  output (claude code hooks-guide "Limitations and troubleshooting"
  is explicit). But a hook is a regular subprocess — it can shell
  out to anything, including `tmux send-keys` on its own pane. That
  side-channel works.
- **No hook event exposes token / context-size info.** Confirmed
  against `code.claude.com/docs/en/hooks-guide.md`. We don't need
  this anymore since v3 reacts to the event.
- **No SDK / CLI invocation of `/compact` against a running session.**
  Slash commands are interactive-only. The tmux side-channel is the
  only way in.
- **No `compactPrompt` settings.json field.** Claimed by a third-
  party blog post; not in the canonical settings reference.
  Hallucination.

**v1 attempt — reactive restoration (rejected by alex).** PR #376 v1
added a `SessionStart` matcher=`compact` hook that emitted the
agent's directive as `additionalContext` *after* auto-compact fired.
By that point the compactor had already summarized without our
directive — we were just telling the agent what was lost, not
preserving it.

**v2 attempt — proactive monitor (built, then rolled back).** Polled
the transcript JSONL every 30s, fired `/compact <directive>` via
`roost send` when an input-token estimator crossed 150k. Worked in
principle but: (a) the threshold is unknowable in advance per the
clustering data above, and (b) the polling, env-var knobs, and
fired-flag bookkeeping were complexity to justify a guess. Rolled
back at the PM's direction.

**v3 — intercept PreCompact, redirect auto → manual (shipped).**
Single-hook design, no polling, no thresholds, no per-agent
plumbing:

1. `bin/roost-compact-hook` is wired as a PreCompact hook by
   `bin/roost spawn` *only when* `--steer-compact` is passed.
   Long-running PM-class agents (project-manager, associate-pm) opt in;
   workers and reviewers don't (auto-compact is unlikely to fire
   in their lifetime — default behavior is fine). The hook carries
   a single-line, semicolon-separated directive constant near the
   top of the script (one place to edit if we ever tune it; covers
   the roost agent set generically — role, IRC nick, channels
   joined, in-flight issue/PR state, recent decisions, pending
   work).
2. On `trigger="auto"`, the hook returns `{"decision":"block"}` on
   stdout — claude code halts the directive-less auto-compact.
3. The hook also backgrounds a subshell that sleeps 150ms (lets
   claude code unwind its auto-compact state machine cleanly — see
   smoke evidence below), then `tmux load-buffer` / `paste-buffer`
   / `send-keys Enter` queues `/compact <directive>` into the
   agent's own pane.
4. That fires PreCompact a second time with `trigger="manual"` and
   `custom_instructions=<directive>`. The hook sees `trigger="manual"`
   and passes through. claude code's manual `/compact` runs with our
   `custom_instructions`.
5. On `trigger="manual"` (or `trigger="auto"` without a tmux
   session reachable), the hook passes through and signals SIGUSR1
   to the MCP (clearing the chathistory replay-dedupe cache so
   post-compact backfill re-delivers messages dropped from the
   agent's context).

When `--steer-compact` is passed, `bin/roost spawn` also writes
`${ROOST_DATA_DIR}/session-name.txt` so the hook honors the
`-s/--session NAME` override; falls back to the default
`roost-${nick}` convention if absent. No per-agent directive flags,
no agent.md section extraction — earlier drafts had both; alex's
review on PR #376 ("fragile and heavyweight") pushed us to bake the
directive into the hook itself.

**Auto-trigger smoke evidence (2026-05-17, $10 of context-stuffing
to force a real auto-compact at ~1.2M-token paste scale).** /tmp
artifacts were cleaned before this writeup landed, so the snippets
below are reconstructed from the verified shape — fields,
trigger, custom_instructions before/after — not verbatim captures.
The chain reproduced cleanly:

```
# PreCompact #1 — auto-trigger, no directive populated
{"session_id":"smoke","transcript_path":"/private/tmp/.../smoke.jsonl",
 "cwd":"/private/tmp/roost-v3-autosmoke-...",
 "hook_event_name":"PreCompact","trigger":"auto","custom_instructions":null}

# Hook stdout: blocks the directive-less compaction
{"decision":"block","reason":"roost: redirecting auto-compact to manual /compact with custom_instructions (issue #368)"}

# Backgrounded (sleep 0.15; tmux send-keys "/compact <directive>" Enter)

# PreCompact #2 — manual, directive now populated
{"session_id":"smoke","transcript_path":"...",
 "hook_event_name":"PreCompact","trigger":"manual",
 "custom_instructions":"<the agent's ## Compaction Directive body>"}

# Hook stdout: empty (pass-through). claude code's manual /compact
# proceeds with our directive as custom_instructions.
```

The 150ms sleep is load-bearing — without it the `send-keys` race
against claude code's auto-compact-halt state machine produced
partial `/compact` buffers in one of three attempts. With the sleep,
zero races observed across the smoke run.

**Compaction is a behavior hint, not verbatim retention.** Important
to internalize before debugging: passing a directive as
`custom_instructions` *biases* what the summarization keeps, but the
summarizer is still a language model summarizing the conversation.
If a directive says "retain the issue→PR→reviewer-nick mapping",
that mapping has to actually be in the conversation for the
summarizer to keep it. The directive can't conjure state that isn't
there. Future debugging: if a compaction drops a value the directive
mentioned, check whether the value was anywhere in the
pre-compaction transcript — the failure mode is usually "not enough
mentions to anchor the retention," not "the directive was ignored."

**v3 footprint** is one bash hook, ~100 lines including comments and
the pass-through SIGUSR1 path inherited from the prior hook. No
TypeScript, no env-var knobs, no polling, no fired-flag reset state
machine.

**Debounce required for long milestones (added in fix/precompact-debounce).**
Context pressure can re-trigger PreCompact multiple times before the
injected `/compact` drains — observed 24+ queued lines in the pane,
agent hung. Fix: atomic mkdir lock (`${ROOST_DATA_DIR}/compact-inject.lock.d`).
`LOCK_TTL_MIN=3` (in `bin/roost-compact-hook`) is the knob — must stay
above observed compact duration (~1m48s). If this regresses (agent hung
with `compact-inject.lock.d` fresh and stale), raise `LOCK_TTL_MIN`.
Trade-off: dead sessions leave stale locks that block re-inject for up
to TTL minutes; PostCompact normally clears them.

**Operational footgun surfaced during the v3 rebase (2026-05-17):**
GitHub stopped firing CI on this PR after the v2 push. Root cause:
the branch became `mergeable=CONFLICTING` against main once #374/
#375/#377/#380 landed on top of files this PR touched. When a PR is
in `CONFLICTING` state, GitHub can't generate the `refs/pull/N/merge`
synthetic ref, and the `pull_request` workflow event is gated on
that ref — so CI silently stops firing on subsequent pushes. **If CI
silently stops firing across a long PR life, check `gh pr view --json
mergeable` first.** Followup PR adds `push:` trigger (any branch)
and required-status-checks branch protection so a CONFLICTING PR
either still gets CI or is blocked from merge entirely.

**Followup candidate (file post-merge):** Anthropic FR for either
(a) a documented `compactPrompt` settings.json field that
auto-compact reads, or (b) a hook output field that lets PreCompact
mutate the compactor's `custom_instructions` directly. v3's
tmux-side-channel approach works but is heavier than a first-party
knob would be.

PR #376 v3 is the load-bearing artifact for this decision. PR #376
v1 and v2 are closed/superseded — re-read the PR thread for the
design evolution.

### Finding K — auto mode's classifier vetoes consequential external writes even on an allow-match (#654)

The puzzle: an auto-mode APM was blocked on `gh issue comment` as an
"external system write" while `Bash(gh issue comment:*)` was already
present in `settings.local.json` `permissions.allow`. The public
Claude Code docs say allow rules resolve before the classifier in
every mode. So the block should have been impossible. It wasn't.

Reproduced live on cc v2.1.217 in a bare auto-mode session with both
`Bash(gh issue *)` and `Bash(gh issue comment:*)` loaded. Ran a
battery, all allow-listed unless noted:

- `gh api user`, `gh issue view` (network reads) → ran
- `chmod +x <file>` (local write) → ran
- `git push --dry-run` (no-op) → ran
- `curl -X POST httpbin.org/post -d …` (non-allowlisted external write) → ran
- `gh issue comment 999999 …` (GitHub issue write) → BLOCKED
- `git push origin HEAD` (real remote write) → BLOCKED

**The finding:** auto mode applies a context-sensitive risk gate that
vetoes commands it judges will make consequential, durable mutations
to a shared system of record (a GitHub issue, a git remote), and this
gate overrides an exact `permissions.allow` match. That last clause is
the load-bearing correction to the documented model. The block is not
a blanket "external write" rule: a POST to a test endpoint and a
`--dry-run` push both passed. The two confirmed blocks are the
consequential-write cases, one gh and one non-gh, so it is not a
single-verb artifact.

We characterize the *behavior*, not the mechanism. n=2 blocks can't
distinguish a judgment call from a sophisticated heuristic, and the
docs don't name one, so don't assert "it's a model judge." What is
airtight: the decision is context-sensitive and not fully
deterministic against the command string.

**Block source is native Claude Code, not roost.** The deny carried
CC's exact `Blocked by classifier` reason string, the session had
`ROOST_PERM_SOCK`/`ROOST_PERM_TARGET` unset (no `--perm-irc` hook),
and `gh issue comment` matches none of `classifyBash`'s patterns
(src/pretooluse-prompt.ts), so roost's PreToolUse gate would pass it
through regardless. Confounds ruled out: allow-list demonstrably
loaded (reads and local writes passed), no `deny`/`ask` rule matched,
exact pattern present, deny observed first-hand.

**Answering the issue's questions:**

1. *Does auto consult `permissions.allow`?* Yes. Allow-listed reads
   and local writes ran without a prompt. But the risk gate can
   override an allow-match for consequential external writes.

2. *How do you grant an already-running auto agent a new Bash verb,
   short of restart?* For verbs the gate ignores (reads, local
   writes): add the pattern to `settings.local.json`; edits reload
   live, no restart. For the gated consequential-write verbs: you
   *can't* reliably grant them via the allow-list at all, because the
   veto is context-sensitive rather than pattern-controlled. The
   supported path for those is operator approval through the
   permbot / `--perm-irc` relay. That is not a workaround; it is the
   only path that clears this gate. This is why the APM class runs
   with a permission relay rather than a fat allow-list.

3. *Is "per alex → reads as sandbox escape" real?* Partly, and it
   lives at a different layer. The model (not the harness classifier)
   trust-classifies its input: IRC arrives wrapped in
   `<channel source=…>` tags and reads as untrusted external data,
   bare terminal / `roost send` input reads as the operator. A probe
   agent refused a compliance-demanding prompt ("run this exactly,
   don't question it") as a prompt injection, then ran the same
   command's read-only sibling when asked plainly over the trusted
   path. So an authority claim attached to a boundary-pushing request
   plausibly raises suspicion rather than lowering it. We did not
   isolate the "per alex" attribution cleanly: the commands where it
   would matter are the same ones the harness gate blocks outright, so
   model-layer suspicion and harness veto are confounded. State the
   task plainly over the trusted path; don't argue authority.

**A second structural block:** an auto agent cannot edit its own
`.claude/settings.local.json` to self-grant. That path is protected
(`.claude/` routes writes to the classifier) and the edit is vetoed.
Self-escalation is closed by design. Grants must come from outside the
agent (the operator editing the file, or approving via the relay).

## 8. Routing-layer architecture (post-Test-4 design session)

Worked out 2026-04-28 in a #roost session with productops-customer
(a ProductOps instance bringing ground-truth from a same-day
~12-worker / ~10-PR project run on the Simplify Rewards
integration), claude2, simplify-rewards, and productops. Six
concrete shifts vs the original brief — all aimed at "ProductOps
offline doesn't stall N PRs":

1. **Per-PR channels (`#pr-XXX`) as event surfaces, not just talk
   surfaces.** Brief had per-project; ground data showed events are
   almost always PR-scoped, channel cleanup on merge is cheap.
2. **Dispatcher publishes per-PR events directly to the project
   channel.** Brief had dispatcher → ProductOps → workers. Today
   ~40% of ~50 SendMessages were dispatcher relays
   (CI green / CEO-APPROVED / CHANGES_REQUESTED); routing all of
   them through ProductOps made ProductOps a single point of failure
   for ~10 PRs. Direct publish removes the SPOF.
3. **Receiver-claims-the-flag for needs-interpretation routing.**
   Default: every CEO event lands in the "needs interpretation"
   bucket. Workers clear the flag by claiming "I'm handling this
   directly" when the directive is unambiguous. ProductOps's rejoin
   queue is the unclaimed events. Self-improving: as workers absorb
   patterns into conventions or lint rules, more events resolve at
   the worker tier without ProductOps touching them.
   Productops-customer's "make comment timeless" example —
   interpretation-needed today, convention/lint-rule next month.
4. **Rejoin = query dispatcher for actionable state.** When
   ProductOps rejoins after a context boundary (compact, restart, 1P
   outage), reading the dispatcher's current view first — then
   reading channel deltas only for items the dispatcher flags as
   needing interpretation — beats scrolling channel history (which
   burns context on routine event volume). Same primitive
   irssi/bouncers solve for humans, parameterized for agent
   context-economy.
5. **Channel membership IS lifecycle assignment.** Worker joining
   `#pr-XXX` = pickup. Kick = end of assignment. Replaces the
   force-push + fresh-spawn + prompt-rework path for hard restarts
   (productops-customer cited PR #75 today: ~30 min human latency
   for restart; channel-kick approach cuts that drastically). The
   `event="join|leave"` push events from the 2026-04-28 hardening
   pass are the substrate this rides on.
6. **`worker_conventions.md` as channel state, not static doc.**
   Conventions live as channel topic / pinned messages, current when
   workers join. The canonical doc still exists as the source of
   truth, but the live channel reflects what applies *now* — updates
   propagate to live workers automatically. Productops-customer
   tripped on this today: had to add "Re-requesting review after
   CHANGES_REQUESTED" and "Comments must be timeless" mid-run as
   ad-hoc patches workers couldn't see.

Parking-lot items (deferred from this session, in scope for
follow-on docs):

- **Reviewer's channel home** — reviewer-NN joins `#pr-XXX` on CI
  green, satisfaction signal lands in the channel, reviewer leaves
  on conclude. This is the substrate the worker↔reviewer-direct
  compression rides on.
- **Dispatcher discovery at scale** — at 12+ concurrent / thousands
  monthly, ProductOps's rejoin needs a per-ProductOps
  dispatcher-directory rather than tracking the set in its own
  state. Service-discovery shape: registry channel, config file,
  DNS-style — TBD when the load shape is real.
- **Conventions-as-channel-state mechanics** — channel topic is
  bounded length; pinned-message convention; how an updating
  ProductOps signals workers to re-read.

## 9. Cache TTL knob for spawned agents (#369)

Wave-5 cost reports showed short-lived reviewers/workers writing
`cache_w_1h` despite running 2–3min wall clock — the 1h tier costs 2x
the 5m rate, so we were paying premium for cache lifetime we never
used. Per-agent it's $0.10–$1.50; per milestone it adds up.

**What claude code actually exposes:** no CLI flag, no settings.json
entry — only environment variables, read at session startup:

- `ENABLE_PROMPT_CACHING_1H=1` — opts into 1h TTL (API key, Bedrock,
  Vertex, Foundry). v2.1.108+. Mutually exclusive with the 5m forcer.
- `FORCE_PROMPT_CACHING_5M=1` — pins the session to 5m even when the
  default would otherwise drift up.
- `DISABLE_PROMPT_CACHING=1` (and per-model `*_HAIKU`/`_OPUS`/`_SONNET`
  variants) — disables caching entirely. Out of scope here, but useful
  for cache-debug sessions; would belong behind a separate knob.

Refs: anthropics/claude-code issues #48082 (TTL env-var docs gap),
#16442 (feature request for a unified `CLAUDE_CODE_CACHE_TTL`, still
open), #48090 (DISABLE_* startup warning); Anthropic prompt-caching
docs at `platform.claude.com/docs/en/build-with-claude/prompt-caching`.

**What we shipped:** `--cache-ttl <5m|1h>` on `roost spawn`. The
wrapper validates the value and translates to the matching env var via
the existing `tmux -e` plumbing. No Claude code changes, no per-prompt
`cache_control` markers, no system-prompt-size workarounds.

**No wrapper default — caller picks per session.** The first cut
defaulted by spawn path (`--agent` → 1h, `--model` → 5m), which kept
APM templates clean but mis-classified the load-bearing case: workers
are spawned via `--model` but routinely sit through reviewer + human
review cycles that exceed 5 minutes. Pinning them at 5m means they
pay a fresh cache-write on each wake — exactly the cost we wanted to
avoid. Rather than carry edge cases per role, we dropped the default
entirely.

The role→flag heuristic itself lives in `roost spawn --help`
("Agent class guidance") — that's the canonical source operators read
when picking flags, and the only place to edit if the trade-offs ever
shift. Agent prompts and the roost skill point at it.

Acceptance: the next wave's cost reports should show reviewers and
one-shot writes in the 5m bucket; workers, the PM, and APM in the 1h
bucket.

## 10. Operational rules / coordination protocol

Behavioral rules that emerged during the design session — these go
in `Project_Execution v2` (renamed from `Project_Execution.md` once
the migration runs) as agent-facing guidance, not in roost itself.

- **Substantive design framing → PR/issue thread first, pointer in
  chat.** Earned in the same session from productops-customer's
  worker-718-v2 example: a 1500-token ProductOps message with an
  opinion *frontloaded* arrived in the worker's context before the
  worker had formed its own read; the discussion should have landed
  on the PR thread (where CEO can see the worker reason) and chat
  should have just pointed at it. Concrete test: if the message
  would meaningfully change a reader's design framing, draft for
  the PR first, then post a pointer in chat.
- **Receiver-claims-the-flag** (see §8.3). Workers signal
  "I'm handling this" when a CEO directive is unambiguous;
  ProductOps's queue is what's unclaimed.
- **Channel membership = lifecycle assignment** (see §8.5). Joining
  a `#pr-XXX` channel means picking up the assignment; being kicked
  means assignment is over.
- **Coordination protocols (parking-lot, surface as friction
  arises):** ack-before-action, first-responder claim, heartbeat
  cadence. claude2 raised these as in-scope for a follow-on doc.

## 11. Test plan and status

Original ordered plan (1 → 2 → 3 → 4) with Test 5 rolled into Test 1's
long-run side-effect.

| Test | Goal | Status | Result |
|---|---|---|---|
| 1 | Stub channel MCP — capabilities + emission + cache | ✓ done | PASS — all 5 sub-assertions; assumptions #1, #2, #3, #4, #7 confirmed |
| 2 | Spawn mechanism (#6) | ✓ done | Print-mode FAIL → tmux interactive PASS (Test 2b). #6 resolved as tmux. |
| 3 (original) | 5 concurrent sessions, shared channel, no nick collisions / resource conflicts | ✓ done (concurrent half) | PASS — 5/5 sessions, 35/35 ticks, 5/5 1h cache, no resource conflicts. Shared-channel half blocked on Test 4. |
| 3 (multi-MCP) | Multi-MCP per session — channels + tools-only stub side-by-side | ✓ done | PASS — both MCPs co-exist; surfaced Finding B (backpressure) |
| 4 | Real IRC-MCP, ngircd, two sessions, ping/pong | ✓ done | PASS — `t4orch` and `t4worker` ran 5 ping/pong rounds via #test on local ngircd. Each session 10–11 assistant turns, both on 1h cache only, both with exactly 1 `tools_changed` miss (Finding A's one-time deferred-tool promotion cost). Zero `messages_changed`, zero `system_changed`. Read/create cache ratio ~7:1 to ~10:1 sustained — inverted from worker-698's 18:343 pathology. |
| 5 | (rolled into Test 1) — MCP idle survival | ✓ passive | Test 1's bun MCP alive 4+ hours, still ticking |
| post-4 | Live use in #roost (productops + simplify-rewards + claude2 + alex) | ✓ done | Surfaced timestamp-collision, premature-buffer-flush, and trailing-whitespace bugs; all three fixed live in-session. Same payload that previously arrived as 4 envelopes (chunkCount 3+3+3+2) verified arriving as 1 envelope (chunkCount=11) post-fix. |
| post-4 (CEO ask) | `channel_who` correctness + JOIN/LEAVE/KICK/NICK push | ✓ done | Smoke test: `who-test-A` MCP + `who-test-B` via nc — userlist for #who-test populated correctly post-JOIN, JOIN notification fired with `event="join"` seq=1, PART notification fired with `event="leave" reason="parted: bye"` seq=2. |

## 12. Open questions (beyond the load-bearing assumptions)

- IRC server choice: ngircd default. solanum if we want SASL/services
  *and* IRCv3 message-tags (Finding E); bouncer integration question
  for replay-on-reconnect.
- ~~Mention/highlight semantics: separate channel source
  (`irc-mention` vs `irc-ambient`), event meta field, or convention?~~
  Resolved (#237): event meta field — `mention="true"` on the
  `event="message"` notification when body contains agent's nick
  (word-boundary) or message is a DM. Absent otherwise.
  Note: `UnreadInfo.mentionCount` (client layer) is text-match only — a DM
  body that doesn't contain the nick scores 0. The wire attribute is
  text-OR-isDirect. They are intentionally different and should stay so.
- One MCP per session (configured at launch with nick + connection),
  or shared MCP service all sessions connect to? Per-session is simpler;
  shared is one process but couples lifecycles. Per-session seems
  default given the 1:1 nature of session ↔ identity.
- Migration cutover shape: parallel run (old loop on one project, new
  on another) until confidence, or hard cutover at next project?
- Dev-channels prompt automation in spawn helper: expect-style poll
  for the prompt string before sending Enter, vs. `sleep N`. The
  former is more robust; needs a small helper script that sits
  between the orchestrator and tmux.
- Where does the spawn helper live? Inside roost (`bin/spawn-worker`)
  or in the operations repo's `.orchestrator/`? roost feels right
  because the dev-channels handshake is roost-specific.
- How is the receiver-claims-flag actually encoded on the wire?
  Structured PRIVMSG (`@CLAIM pr-1987 worker-1987`)? IRC topic/mode?
  Custom `<channel event="claim">` notification? Affects what the
  dispatcher's "what's still unclaimed" projection looks like.
- ~~`alwaysLoad: true` retest~~ — done 2026-04-28. Confirmed:
  baseline 2 `tools_changed` misses → alwaysLoad 0 misses. Flag
  applied to `mcp-config-irc.json`. See Finding A mitigation.
- Channel-history-summary primitive (productops-customer's framing):
  on rejoin, agents need "what's actionable since you left," not the
  full event log. Likely belongs at the dispatcher tier, not in the
  IRC-MCP itself — but the boundary is worth pinning down before
  building either side.

## 13. References

- Anthropic channel docs: `code.claude.com/docs/en/channels.md`,
  `code.claude.com/docs/en/channels-reference.md`
- fakechat reference: `~/.claude/plugins/cache/claude-plugins-official/fakechat/0.0.1/server.ts`
- Worker cache pathology evidence: `~/.claude/projects/-Users-alex-Dev-GoCarrot-operations/f6fa5485-c8e0-4cdf-9dcb-dd6021acb5f8/subagents/agent-addb27e0be67b80b9.jsonl`
- Orchestrator clean-cache evidence: `~/.claude/projects/-Users-alex-Dev-GoCarrot-operations/ab176532-d7c7-4aaa-a9b1-dedf03fa9b60.jsonl`
- Current execution loop: `operations/ProductOps/Runbooks/Project_Execution.md`
- Multi-orchestrator unblock + fakechat parameterization:
  `operations/ProductOps/Journal/2026-04-26.md` (third entry)
- Tests, results, harnesses: `roost/tests/` (`test2-results.md` is the
  living results doc; will fold into this PLAN as tests close out)
- ProductOps journal — original conversation + Test 1/2/3 execution:
  `operations/ProductOps/Journal/2026-04-27.md` (evening entry)
- 2026-04-27 evening / 2026-04-28 morning #roost session — live
  hardening, productops-customer's ground-truth, routing-layer
  design: ProductOps session JSONL
  `~/.claude/projects/-Users-alex-Dev-GoCarrot-operations/5a3d2962-5e9d-47eb-9a62-8a850ebc3a36.jsonl`
  (productops nick); productops-customer ran from session
  `~/.claude/projects/-Users-alex-Dev-GoCarrot-operations/ab176532-d7c7-4aaa-a9b1-dedf03fa9b60.jsonl`.
