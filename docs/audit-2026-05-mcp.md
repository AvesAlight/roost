# Roost simplify pass — MCP/IRC depth audit (May 2026)

Audit of the MCP server, IRC plumbing, perm-irc layer, and their test
helpers. Originally part of #64; the orchestrator-side findings split
to a separate PR against #5.

**Scope:** ~1772 LOC across 9 files

| File | LOC |
|---|---|
| `src/irc-server.ts` | 911 |
| `src/irc-lib.ts` | 74 |
| `src/constants.ts` | 3 |
| `test/helpers/mcp.ts` | 38 |
| `test/helpers/mcp-core.ts` | 100 |
| `test/helpers/mcp-inprocess.ts` | 63 |
| `bin/roost-irc-server` | 3 |
| `bin/irc-permission-prompt` | 262 |
| `bin/roost-permbot` | 318 |

**Headline:** the original 5-finding pass on `src/irc-server.ts` framed it as
"well-factored." That framing was wrong. The file has a tidy surface but
mixes two distinct concerns — IRC client semantics and MCP server plumbing
— in one 780-line closure. With the right lens (see [Rearchitect
proposal](#rearchitect-proposal-ircclient-extraction)), the MCP shim should
be ~300-400 LOC of mostly tool dispatch, and the IRC client should be its
own ~480-LOC file. Total LOC is roughly the same; the seam is what changes.

This pass: **19 findings** (6 delete, 1 correctness, 12 clarify) plus the
rearchitect proposal as its own deliverable. Up from 10 in the original
scope-flat first pass — the lens shift surfaced 5 new findings on
`src/irc-server.ts` (C1, L4, L5, L6, L7) that the "this looks
well-factored" framing missed, plus 4 on neighboring files in scope (L8,
L9, L10, L11).

## Categories

- **delete** — dead code, duplicate code, defensive-for-impossible code,
  speculative options or params with no callers, single-use wrappers that
  earn their wrapper status only by name.
- **clarify** — code that stays, but hides the happy path, leaks
  abstractions, or repeats a shape often enough that extraction reads better.
- **correctness** — live latent bugs, races, swallowed signals.

When ambiguous between delete and clarify I preferred delete. (Lesson from
the first pass: under-classified deletes initially, then over-corrected on
one — `pollUntilIrcReady`'s "not ready" filter was *intentional* defensive
code per its JSDoc. Now treating source comments as evidence, not noise.
See L12.)

## Meta-finding: silent fall-through, again

The previous audit pass surfaced this pattern across closed issues
#87/#92/#97/#100/#106. Within this scope (MCP/IRC + perm-irc), present-tense
instances:

- **C1** — `socket close` leaves pending join/part resolvers on their 5s
  timers instead of pre-empting. Caller gets "timed out" when the truth is
  "we lost the socket." Same shape: the unexpected condition surfaces as a
  generic timeout.
- **L8** — `irc-permission-prompt` falls back to the terminal prompt
  whenever permbot is unreachable, the daemon times out, or the reply is
  unrecognized. That's the architecturally documented design — but it's
  the same shape that made #90 a phantom-bug: under unattended worker
  spawn, "fall back to terminal" means "block forever, silently." The
  fix shape varies (this one's nontrivial) but flagging it here.
- **L4** — `multilineMaxLines` cap parser silently `continue`s on malformed
  values. Server contract says max-lines is a positive int; if it isn't,
  we keep the placeholder. Won't bite today; flagging the shape.

## Top wins (read these first)

| # | Title | Cat | Δ LOC | Sev |
|---|---|---|---|---|
| **R** | **Rearchitect: extract `RoostIrcClient` from `createMcpServer`** | architecture | shape, not LOC | high |
| D1 | Collapse `channel_message`/`direct_message` handlers | delete | −15 | medium |
| L1 | Lift `TOOL_SCHEMAS` to module-level constant | clarify | ~0 | medium |
| C1 | `socket close` leaves resolvers on 5s timer | correctness | +2 | medium |
| L2 | Three near-parallel emit functions | clarify | −5 | low |
| L3 | `setTimeout(...).unref?.()` repeated 3x | clarify | −6 | low |
| D2-D4 | `roost-permbot` dead state (`fileno`, `registered`, dlog gate) | delete | −6 | low |

The remaining 10 are individually small (most −2 to −5 LOC) but consistent.

---

## Rearchitect proposal: IrcClient extraction

The single biggest finding from re-reading `src/irc-server.ts` with the
"what if we built this as a JS IRC client first, MCP shim second?" lens.
Treated as a separate deliverable from the per-finding list because acting
on it subsumes several of the findings.

### Current shape

`createMcpServer(ircClient, config)` is a 780-line closure (lines 58-837)
that does five things at once:

1. Holds IRC client state (history, user sets, fingerprints, resolvers,
   multiline cap, ready flag).
2. Defines IRC event handlers (registered, join, part, kick, quit, nick,
   message, two batch-end variants, socket close/error).
3. Implements MCP tool dispatch (8 tools).
4. Bridges IRC events to MCP notifications via three emit-helpers.
5. Does send-side multiline batching.

The seam between "IRC client" and "MCP server" is loose: `createMcpServer`
takes `ircClient` as an arg, then mutates state that's MCP-internal
(`unread` tracking, `mcp.notification` calls) inside IRC event handlers.
The two layers are structurally entangled even though they're conceptually
independent.

A reader trying to add a new MCP tool today has to:
- understand which closure variables are IRC state vs MCP state,
- understand the multiline batching protocol to use `sendMultiline`,
- understand which IRC events are meant to bridge to notifications and
  which are internal-only.

### Proposed split

Three files (current `src/irc-server.ts` becomes the MCP shim):

| Proposed file | Responsibility | Est. LOC |
|---|---|---|
| `src/irc-client.ts` *(new)* | `RoostIrcClient` class — wraps `irc-framework`, owns IRC state, exposes typed methods + typed event surface | ~480 |
| `src/irc-server.ts` *(rewritten)* | MCP shim — declares tools, dispatches to `RoostIrcClient`, bridges client events to `mcp.notification` | ~300-400 |
| `src/irc-lib.ts` *(unchanged)* | pure functions: `splitLineForMultiline`, `findNaturalBoundary`, `newBatchId`, `reassembleMultilineBatch` | 74 |

`src/constants.ts` (3 lines) stays. `bin/roost-irc-server` (3 lines) stays
as-is.

### Proposed `RoostIrcClient` interface

```ts
export interface RoostIrcClient {
  // Lifecycle (caller still owns connect timing)
  connect(opts: ConnectOpts): void
  isReady(): boolean

  // Outbound
  join(channel: string, force?: boolean): Promise<boolean>
  leave(channel: string): Promise<boolean>
  say(target: string, text: string): { chunks: number; mode: 'single' | 'multiline' }
  whoisChannels(nick?: string): Promise<string[] | false>

  // State queries
  getHistory(key: string, limit?: number): IrcMessage[]
  getUsers(channel: string): string[]

  // Replay-dedupe (PreCompact handler)
  clearDedupeCache(): void

  // Typed event surface
  on(event: 'message',    handler: (msg: IrcMessage, meta: MessageMeta) => void): void
  on(event: 'membership', handler: (kind: 'join'|'leave'|'nick', nick: string, channel: string, extras: MembershipExtras) => void): void
  on(event: 'system',     handler: (kind: 'disconnected'|'reconnected', content: string) => void): void
}
```

`unread` tracking and `receiveSeq` stay in the MCP shim — see Open
Questions.

### Move table — every closure binding accounted for

Comprehensive, not curated. Every `let`/`const` and every IRC event handler
in `createMcpServer` (lines 58-837) gets a row. "Verdict" column says where
it lands; "Note" column flags subtleties or open questions.

#### State variables

| # | Today's location | Symbol | Verdict | Note |
|---|---|---|---|---|
| 1 | irc-server.ts:64 | `irc_ready` | → IrcClient internal | exposed via `isReady()` |
| 2 | irc-server.ts:65 | `hasRegistered` | → IrcClient internal | drives reconnect-vs-initial-register branching |
| 3 | irc-server.ts:66 | `join_resolvers` | → IrcClient internal | `join()` returns Promise; resolvers internal |
| 4 | irc-server.ts:67 | `part_resolvers` | → IrcClient internal | same |
| 5 | irc-server.ts:72 | `multilineMaxLines` | → IrcClient internal | derived from cap negotiation |
| 6 | irc-server.ts:76 | `history` Map | → IrcClient internal | exposed via `getHistory(key, limit)` |
| 7 | irc-server.ts:89 | `unread` Map | **stays in MCP shim** | open Q below — could go either way |
| 8 | irc-server.ts:107 | `seenFingerprints` Map | → IrcClient internal | exposed via `clearDedupeCache()` |
| 9 | irc-server.ts:138 | `receiveSeq` | **stays in MCP shim** | numbers MCP notifications, not IRC events |
| 10 | irc-server.ts:149 | `channelUsers` Map | → IrcClient internal | exposed via `getUsers(channel)` |

#### Inline helpers

| # | Today's location | Symbol | Verdict | Note |
|---|---|---|---|---|
| 11 | irc-server.ts:77-82 | `pushHistory(key, msg)` | → IrcClient private | mutates IRC state |
| 12 | irc-server.ts:91-96 | `formatUnreadLine(...)` | → MCP shim helper | presentation, not IRC |
| 13 | irc-server.ts:98-101 | `unreadSuffix()` | → MCP shim helper | composed with formatUnreadLine |
| 14 | irc-server.ts:109 | `msgFingerprint(msg)` | → IrcClient private | dedupe key |
| 15 | irc-server.ts:112-122 | `addFingerprint(msg)` | → IrcClient private | mutates seenFingerprints |
| 16 | irc-server.ts:124-125 | `hasFingerprint(msg)` | → IrcClient private | reads seenFingerprints |
| 17 | irc-server.ts:150-157 | `ensureChannelSet(channel)` | → IrcClient private | mutates channelUsers |
| 18 | irc-server.ts:159-210 | `sendMultiline(target, text)` | → IrcClient public method (`say`) | renamed |
| 19 | irc-server.ts:212-218 | `pushNotification(content, meta)` | → MCP shim helper | calls mcp.notification |
| 20 | irc-server.ts:221-249 | `emitChannelEvent(msg, extras)` | **splits**: IrcClient emits typed `message` event; MCP shim subscriber calls pushHistory→addFingerprint side-effects move to IrcClient, unread+pushNotification stay in shim | the conflated case from L2 |
| 21 | irc-server.ts:255-277 | `emitMembershipEvent(...)` | **splits**: IrcClient emits typed `membership` event; MCP shim subscriber formats summary + pushNotification | same shape |
| 22 | irc-server.ts:281-285 | `emitSystemEvent(...)` | **splits**: IrcClient emits typed `system` event; MCP shim formats + pushNotification | same shape |
| 23 | irc-server.ts:823-834 | `emitUnreadSummary` | → MCP shim method | uses `unread` (which stays in shim); SIGUSR2 wires to it |

#### MCP server pieces

| # | Today's location | Symbol | Verdict | Note |
|---|---|---|---|---|
| 24 | irc-server.ts:289-298 | `mcp = new Server(...)` instance | → MCP shim | base of the MCP module |
| 25 | irc-server.ts:300-402 | ListTools handler with inline tool schemas | → MCP shim, lift schemas to module const (see L1) | TOOL_SCHEMAS const |
| 26 | irc-server.ts:404-547 | CallTool handler (switch dispatch) | → MCP shim, **bodies become 1-3 line wrappers** around RoostIrcClient methods | L1+D1 collapse here |

#### IRC event handlers

| # | Today's location | Event | Verdict | Note |
|---|---|---|---|---|
| 27 | irc-server.ts:551-604 | `'registered'` | → IrcClient internal | cap parsing, auto-rejoin on reconnect |
| 28 | irc-server.ts:606-620 | `'join'` | **splits** | state mutation in client; emits `membership` for non-self joins |
| 29 | irc-server.ts:624-637 | `'userlist'` | → IrcClient internal | populates channelUsers; no MCP-visible event today |
| 30 | irc-server.ts:639-656 | `'part'` | **splits** | state mutation in client; resolves part_resolvers; emits `membership` for non-self |
| 31 | irc-server.ts:661-679 | `'kick'` | **splits** | same shape as part |
| 32 | irc-server.ts:683-695 | `'quit'` | **splits** | clears all channels for self; per-channel `membership` emit for non-self |
| 33 | irc-server.ts:700-712 | `'nick'` | **splits** | renames in every channel set; emits anchored to "first shared channel" — see C2 |
| 34 | irc-server.ts:714-736 | `'message'` | **splits** | history + fingerprint in client; `message` event to subscribers |
| 35 | irc-server.ts:739-768 | `'batch end draft/multiline'` | **splits** | reassembly + history in client; `message` event |
| 36 | irc-server.ts:771-811 | `'batch end chathistory'` | **splits** | dedup + history in client; `message` events with `historical` flag |
| 37 | irc-server.ts:813-817 | `'socket close'` | **splits** | client clears `irc_ready`; emits `system('disconnected')` — see C1 |
| 38 | irc-server.ts:819-821 | `'socket error'` | → IrcClient internal | stderr trace only |

#### Returned API

| # | Today's location | Symbol | Verdict |
|---|---|---|---|
| 39 | irc-server.ts:836 | `{ server, clearDedupeCache, emitUnreadSummary }` | shape changes — entrypoint constructs IrcClient, then MCP shim takes the client; `clearDedupeCache` becomes a method on IrcClient, `emitUnreadSummary` stays MCP-side |

### Open questions

Concrete decisions the implementer would have to make. Not faking answers.

**Q1. Where does `unread` live?** Today it's mutated inside
`emitChannelEvent` (alongside fingerprint addition). Two valid splits:

- **(a)** keep `unread` in the MCP shim. The shim subscribes to client
  `message` events and updates its own unread map. The MCP shim is the
  view layer; unread is presentation state.
- **(b)** move `unread` into the client. Some agent feature (a future
  status-bar tool, a re-read-on-demand) might want to query unread without
  going through MCP.

Default to (a) — fewer cross-cutting concerns in the client. Easy to revisit.

**Q2. Where does `receiveSeq` live?** It numbers `mcp.notification` calls
to disambiguate same-millisecond timestamps. Pure MCP concern → stays in
shim. (No actual ambiguity here, just naming it.)

**Q3. Should the multiline cap value be a typed object?** Today it's
parsed string-split style at irc-server.ts:561-566. Could be a small
`MultilineCapValues = { maxBytes: number; maxLines: number }` type with
a `parseMultilineCap(value: string)` function. Trivial extraction; helps
when the orchestrator's TS rewrite (if it ever happens — see Q5) needs the
same parsing.

**Q4. Does `channelUsers` belong with the IRC client or as a separate
state module?** Lead-pm's earlier scratch suggested `src/state.ts` for
shared state. After tracing the references: every read of `channelUsers`
flows through `channel_who` (one MCP tool) and the membership-tracking
event handlers (all IRC-layer). No external consumer wants this. **Verdict:
stays inside IrcClient, no `src/state.ts`.** The state-extraction premise
was reasonable a priori; the actual references didn't justify it.

**Q5. Should we consider migrating the orchestrator from Python to TS so
both processes share the same `RoostIrcClient`?** Plausible but **out of
scope for this audit** and warrants its own issue. The Python orchestrator
has its own ~160 LOC in-file IrcClient (see `bin/orchestrator_poll`); the
JS extraction makes a future TS port cheap, but the decision to do that is
much bigger than "extract IrcClient." Flagging here so the option is on
the radar; not arguing for it.

### What this unlocks

- **Typed IRC surface.** The `// @ts-expect-error — irc-framework lacks
  first-class type defs` annotation appears in three files today
  (`src/irc-server.ts:32`, `test/helpers/peer.ts:1`,
  `test/helpers/mcp-inprocess.ts:3`). After extraction, the typed surface
  lives in `src/irc-client.ts`; the suppression appears once, inside
  `RoostIrcClient`'s implementation.

- **MCP shim becomes scannable.** Adding a new MCP tool today requires
  understanding the closure's IRC state. After the split: add a method to
  `RoostIrcClient`, add a 3-line wrapper to the MCP `CallTool` switch,
  add tests. No closure spelunking.

- **Direct `RoostIrcClient` testability.** `test/helpers/mcp-inprocess.ts`
  today does `createMcpServer(ircClient, config)` and tests through MCP
  tool calls. Post-split: tests can talk to `RoostIrcClient` directly for
  IRC-level assertions, and through the MCP shim only for tool-surface
  assertions. Each test asserts at the right layer.

- **Replay-dedupe and history become inspectable.** Closure-scoped Maps
  are inaccessible from outside today. Methods on `RoostIrcClient` make
  them queryable from tests, future debug tools, etc. (No new API surface
  for end users — just doesn't disappear into the closure.)

### Estimated effort

S/M/L per extraction slice. Total: M-large, ~1-2 days mechanical, low
risk.

| Slice | Effort | Risk | Notes |
|---|---|---|---|
| Define `RoostIrcClient` interface in new file | S | low | mostly typing |
| Move `irc-framework` instantiation + `connect`/`registered` handler | S | low | localizes the @ts-expect-error |
| Move `history` + `pushHistory` + `getHistory` | S | low | pure state move |
| Move `channelUsers` + `getUsers` + userlist/join/part/kick/quit/nick handlers (inline emits become typed-event calls) | M | low | bulk of the move |
| Move `seenFingerprints` + `clearDedupeCache` | S | low |  |
| Move `sendMultiline` → `say` | S | low | rename + signature shift |
| Move `join_resolvers`/`part_resolvers` + `join`/`leave` methods | S | low |  |
| Move multiline-cap parsing | S | low | optional Q3 typing |
| Rewrite MCP shim's CallTool switch as 1-3 line wrappers | M | low | |
| Subscribe MCP shim to `RoostIrcClient` events; build typed `MessageMeta`/`MembershipExtras` | M | medium | the bridging is where bugs hide |
| Update `test/helpers/mcp-inprocess.ts` to construct `RoostIrcClient` directly | S | low |  |
| Run tests, hunt for closure-leak bugs (anything that accidentally captured a non-stable reference) | M | medium | |

Tests-first migration possible: write the interface, make the existing
`createMcpServer` *implement* `RoostIrcClient` by adding methods that read
its closure state, then move state out one slice at a time. Each slice is
a green commit.

---

## Findings — `src/irc-server.ts` (911 LOC)

Re-read with the rearchitect lens. Eight findings (vs. five in the first
pass). Most are subsumed or motivated by the rearchitect proposal —
flagging them individually so they survive a "we don't have time for the
extraction" decision.

### D1. `channel_message` and `direct_message` handlers duplicate — delete · medium · −15 LOC

**Location:** `src/irc-server.ts:415-440`.

Both call `sendMultiline`, both `unread.delete(target)`, both build the
same `note` / `preview` / `suffix` text. Differences: target arg name
(`channel` vs `nick`), prefix string (`sent to` vs `DM to`).

**Fix:** extract `formatSendResult(target, text, prefix)` shared by both.
Becomes trivially short post-rearchitect (where the two cases are
1-line wrappers around `client.say()`).

### L1. `TOOL_SCHEMAS` lifted to module-level constant — clarify · medium · ~0 LOC

**Location:** `src/irc-server.ts:300-402`.

103 lines of static tool-schema JSON declared inline in the
`ListToolsRequestSchema` handler inside `createMcpServer`. None of it
references closure state. ~13% of the function body is JSON literal.

**Fix:** lift to `const TOOL_SCHEMAS: Tool[] = [...]` at module scope.
Handler becomes `async () => ({ tools: TOOL_SCHEMAS })`. Stronger after
rearchitect — `TOOL_SCHEMAS` lives in the MCP shim file, where it
visually centers the file's purpose.

### L2. Three near-parallel emit functions — clarify · low · −5 LOC

**Location:** `src/irc-server.ts:221-285` — `emitChannelEvent`,
`emitMembershipEvent`, `emitSystemEvent`.

Each builds a meta record (channel/sender/isDirect/ts), calls
`pushNotification`, writes a stderr trace. The bodies are different but
the shape is consistent.

**Fix (interim):** extract `buildBaseMeta(channel, sender, ts)` helper.
Saves ~5 LOC, makes the shared shape visible.

**Fix (rearchitect):** subsumed. The three emits become three event-bridge
subscribers in the MCP shim, each ~6 lines, each declarative.

### L3. `setTimeout(...).unref?.()` idiom repeated 3x — clarify · low · −6 LOC

**Location:** `src/irc-server.ts:452, 468, 522`.

Each Promise-with-timeout repeats
`setTimeout(() => resolve(false), 5000).unref?.()`. The `.unref?.()` is
to keep the timer from holding the event loop open; the `?` chain handles
environments where Bun/Node return non-Timer (browser-shape) timer ids.

**Fix:** small `withTimeout<T>(operation: (resolve: ...) => void, ms: number)`
helper. Subsumed by rearchitect — `join`/`leave` end up in
`RoostIrcClient` as Promise-returning methods with the timeout internalized.

### L4. `multilineMaxLines` cap parser silently `continue`s on bad values — clarify · low · ~0 LOC

**Location:** `src/irc-server.ts:561-566`.

```ts
for (const kv of val.split(',')) {
  const [k, v] = kv.split('=')
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) continue
  if (k === 'max-lines') multilineMaxLines = n
}
```

If the server sends `draft/multiline=max-lines=0` or `=abc`, we silently
keep the placeholder `100`. That works (sends still go through) but is the
silent-fall-through shape. Won't bite today (we control both ends via
ergo), but the parser is brittle.

**Fix:** log a stderr warning when the value is malformed; or replace with
a typed parser (Q3 in the rearchitect proposal).

### C1. `socket close` leaves pending join/part resolvers on 5s timer — correctness · medium · +2 LOC

**Location:** `src/irc-server.ts:813-817` (the `'socket close'` handler);
resolvers at lines 446-453 (join), 463-468 (leave).

When the IRC socket drops mid-`channel_join`, the resolver registered at
`join_resolvers.get(channel)` stays alive. The 5s `setTimeout` eventually
fires and the caller gets `{ isError: true, text: 'join #foo timed out' }`.
That's misleading: the truth is "we lost the connection," not "the server
didn't ack."

**Fix:** in the `socket close` handler, walk both resolver maps and
resolve every entry with `false` immediately. The resolver code already
handles `false` correctly. Two-line fix.

### L5. `userlist` handler's `set.add(NICK)` is defensive-for-impossible — clarify · low · −1 LOC

**Location:** `src/irc-server.ts:631`.

```ts
const set = new Set<string>()
for (const u of event.users ?? []) {
  if (u?.nick) set.add(u.nick)
}
set.add(NICK) // we're definitely there
```

The userlist event fires post-`RPL_NAMREPLY/ENDOFNAMES`, which is sent
after our JOIN succeeds. Server-side membership *guarantees* our nick is
in `event.users`. The `set.add(NICK)` defends against the server omitting
us from a reply about a channel we're confirmed to be in.

(There's a contemporaneous comment at lines 622-623 that calls this out
but doesn't mark it obsolete.)

**Fix:** drop the line and the comment. Trust the protocol.

### L6. `'nick'` membership event anchors arbitrarily to "first shared channel" — clarify · low · ~0 LOC

**Location:** `src/irc-server.ts:700-712`.

```ts
let firstChan: string | null = null
for (const [chan, set] of channelUsers) {
  if (set.delete(event.nick)) {
    set.add(event.new_nick)
    if (!firstChan) firstChan = chan
  }
}
if (firstChan) {
  emitMembershipEvent('nick', event.nick, firstChan, { newNick: event.new_nick })
}
```

A nick change is global — the user is renamed in every channel they share
with us. We emit one membership event "scoped to the first shared
channel," which is a fiction (Maps iterate in insertion order; the
anchored channel is whichever we joined first). The meta says
`channel: X` for an event that's not really per-channel.

**Fix (preferred):** emit one membership event per channel the user is in.
Consumers that care can dedupe; the meta becomes truthful.

**Fix (alternate):** emit one event with `channel: ''` and a typed `event:
'nick'` flag — the system-event shape (irc-server.ts:281-285) has
precedent for empty-channel meta on global events.

Edge of correctness — the agents acting on these notifications today
don't care which path we pick, but the truthfulness gap will eventually
matter.

### L7. `mcp.notification(...).catch(() => {})` swallows silently — clarify · low · +2 LOC

**Location:** `src/irc-server.ts:217`.

```ts
mcp.notification({...}).catch(() => { /* transport closed during teardown */ })
```

The comment names the legit case. But the catch matches any rejection —
including bugs we'd want to know about. The catch handler should at
minimum log to stderr if the rejection is unexpected.

**Fix:** narrow the catch to known-OK error shapes:
```ts
mcp.notification({...}).catch((err) => {
  // Transport teardown is the only legit case; surface anything else.
  if (!String(err).includes('Connection closed')) {
    process.stderr.write(`roost-irc[${NICK}]: notification failed: ${err}\n`)
  }
})
```

---

## Findings — `bin/roost-permbot` (318 LOC)

Three small deletes carried over from the first pass; one new clarify on
the in-flight protocol shape.

### D2. `dlog` early-return is dead — delete · low · −2 LOC

**Location:** `bin/roost-permbot:57-58`.

`DEBUG_LOG = os.environ.get("ROOST_PERM_DEBUG_LOG") or os.path.join(...)`
is truthy unconditionally. The `if not DEBUG_LOG: return` guard never
fires.

**Fix:** drop it.

### D3. `IRC.fileno` method is unused — delete · low · −2 LOC

**Location:** `bin/roost-permbot:75-76`.

Defined on the `IRC` wrapper class; selectors register `irc.sock`
directly (line 135), not the wrapper. Method never called.

**Fix:** delete the method.

### D4. `IRC.registered` state is unused — delete · low · −2 LOC

**Location:** `bin/roost-permbot:73, 256`.

`self.registered = False` set in `__init__`, set to `True` when the daemon
sees `001`. Never read anywhere.

**Fix:** delete both lines.

### L9. In-flight tuple shape is positional, not named — clarify · low · ~0 LOC

**Location:** `bin/roost-permbot:140-141, 186, 271, 285`.

```python
in_flight = None
# ...
in_flight = (client_sock, req, time.time() + timeout)
# elsewhere:
client_sock, _req, _deadline = in_flight  # 3 unpacks across the file
```

The deadline-vs-timestamp distinction is positional-only. A future
addition (e.g. queue-depth metric, unique request id) means rewriting
every unpack.

**Fix:** use a `dataclass` (or `NamedTuple`) `InFlight(client_sock, req,
deadline)`. ~3 lines added at top, all unpacks become attribute access.

---

## Findings — `bin/irc-permission-prompt` (262 LOC)

### L8. Fall-back-to-terminal is invisible to remote operators — clarify · low · ~0 LOC

**Location:** `bin/irc-permission-prompt:39-40, 233, 248-249, 258`.

The `emit("ask", reason)` path defers to Claude Code's local terminal
prompt. That's the architecturally documented design — but for an
unattended worker spawn (most production cases), the local terminal has
no human watching. The result is a worker blocked indefinitely on a
prompt nobody sees, with only stderr output naming the cause.

This is the failure mode that made #90 a phantom bug to track down. It's
present-tense in the code today; #90 closed because the *specific*
secondary command-substitution gate was fixed upstream, not because the
fallback semantics changed.

**Fix:** when falling back to terminal, also DM the operator (if known via
`ROOST_PERM_TARGET`) with the reason and the tool summary. Doesn't
override the terminal prompt — but at least makes the failure visible to
the same human who owns the worker. Touches the `emit("ask", ...)` path
and adds an optional DM through the existing permbot socket.

(Listed as low because the underlying behavior is documented; promotable
to medium if oversight gaps recur.)

---

## Findings — `test/helpers/`

### D5. `startMcp` `extraEnv` parameter is unused — delete · low · −2 LOC

**Location:** `test/helpers/mcp.ts:13, 24`.

No test calls `startMcp` with a third argument. Speculative for a future
test that wants to override env.

**Fix:** drop the param.

### D6. `wireMcpClient` `clientName` parameter is cosmetic — delete · low · −3 LOC

**Location:** `test/helpers/mcp-core.ts:32, 40`; call site
`test/helpers/mcp-inprocess.ts:43` (`'roost-test-ip'`).

Flows to `new Client({ name, version })` and surfaces only in the MCP
initialize handshake. Not used by routing, not asserted in any test.

**Fix:** drop the param, hardcode `'roost-test'`.

### L10. Two near-identical `startMcp` shapes — clarify · low · ~0 LOC

**Location:** `test/helpers/mcp.ts` (out-of-process via stdio subprocess);
`test/helpers/mcp-inprocess.ts` (in-process via InMemoryTransport).

Both helpers do the same five things: choose a default nick, set up
transport, instantiate IRC client, request caps + connect, wire up the
MCP client + waiters via `wireMcpClient`. The differences are real (one
spawns a subprocess, the other constructs in-process) but the shared
shape isn't visible.

Post-rearchitect this becomes natural: both helpers construct a
`RoostIrcClient` directly (the subprocess shape stays for tests that need
process boundary, the in-process shape becomes the default), wire it to
either an in-process MCP shim or a subprocess shim.

**Fix:** subsumed by the rearchitect. Without it, this is low-priority;
the two helpers being parallel-but-different is a reasonable status quo.

### L11. `wireMcpClient`'s timeout/waiter cleanup uses identity comparison on `wrappedResolve` — clarify · low · ~0 LOC

**Location:** `test/helpers/mcp-core.ts:71-78`.

```ts
const wrappedResolve = (n: ChannelNotification) => { clearTimeout(timer); resolve(n) }
const timer = setTimeout(() => {
  const idx = waiters.findIndex(w => w.resolve === wrappedResolve)
  if (idx !== -1) waiters.splice(idx, 1)
  reject(new Error(`waitForNotification timed out after ${timeoutMs}ms`))
}, timeoutMs)
waiters.push({ pred, resolve: wrappedResolve })
```

Function identity drives waiter cleanup. Works because `wrappedResolve`
is closed-over per-call — but the dependency on identity is implicit. A
refactor that, say, memoizes resolvers would silently break cleanup.

**Fix:** assign each waiter a unique id (counter) at insert time; cleanup
on timeout indexes by id. Or: accept the identity-comparison shape and
add a `// identity-cleanup, see comment` comment.

### L12. `pollUntilIrcReady` couples to a string-literal sentinel — clarify · low · ~0 LOC

**Location:** `test/helpers/mcp-core.ts:96`; partner string at
`src/irc-server.ts:409`.

The `text.includes('not ready')` check is intentional — JSDoc on the
function (lines 85-88) documents that future error types should
short-circuit rather than loop until the deadline. Behavior is correct.

What's worth flagging is the coupling: the literal `'not ready'` is a
substring of `'IRC client not ready (still connecting).'` defined on the
server side. A wording change to either drift the pair silently —
`pollUntilIrcReady` would start treating the not-ready signal as
"ready enough" and short-circuit, masking real bring-up races in tests.

**Fix:** export a shared `NOT_READY_SENTINEL` constant from
`src/irc-server.ts` so server and test reference the same literal.

**Self-correction note:** this was originally classified delete
(`D12`) as "defensive-for-impossible." Lead-pm flagged that the JSDoc
explicitly documents the design — the filter defends against tomorrow's
error paths, not yesterday's. Reclassified to clarify. Lesson preserved
here: source comments are evidence, not noise.

---

## Findings — `bin/roost-irc-server` (3 LOC)

Skipped — single-purpose PATH-resolvable launcher referenced from
`.mcp.json`. Required as-is.

---

## Skipped / out of scope

- **`src/constants.ts` ↔ `bin/orchestrator_poll` `MULTILINE_LINE_BYTES`
  duplication**: cross-language constant; comment in `orchestrator_poll`
  documents the coupling. The orchestrator's findings live in the
  separate beta PR.
- **`bin/orchestrator_poll`'s in-file Python `IrcClient`**: addressed in
  the rearchitect proposal as "Q5 — out of scope for this audit, candidate
  for a separate Python→TS migration issue."
- **Adding new MCP tools**: orthogonal to this audit.

---

## Pattern issues — what shape enabled them, is it still here?

Per-issue traceback. The recurring shape (silent fall-through) is
discussed in [Meta-finding](#meta-finding-silent-fall-through-again).

- **#87 (permbot reply parser exact-match):** fixed in
  `bin/irc-permission-prompt:251-253` via first-token split. Shape was
  "match whole reply against literal tokens"; now matches first
  whitespace-delimited token. Shape gone.
- **#92 (cache staleness on reconnect):** fixed by reconnect cache
  invalidation + auto-rejoin (`src/irc-server.ts:582-595`). The local
  cache *can still drift* between disconnect detection and reconnect, but
  `channel_list` now goes to the server (PR #108) instead of reading the
  cache. Shape mostly addressed.
- **#97 (deny reason not propagated):** fixed in
  `bin/irc-permission-prompt:251-258` — first token decides allow/deny,
  rest becomes the message. Shape gone.
- **#100 (channel_leave fire-and-forget):** fixed in
  `src/irc-server.ts:461-475`, mirrors `channel_join` resolver pattern.
  Shape gone. (C1 in this audit is a sibling: the resolver pattern is
  correct, but neither resolver pre-empts on socket close.)

C1, L4, L8 in this audit are present-tense instances of the silent
fall-through family.

(#90 omitted — closed as "cannot reproduce — suspected fixed upstream"
per the issue thread; the previous audit pass cited it as still-present,
which was wrong.)

(#106 was orchestrator/CLI scope and lives in the separate beta PR's
pattern-issues section.)
