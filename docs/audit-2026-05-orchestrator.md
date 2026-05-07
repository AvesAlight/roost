# bin/orchestrator_poll simplify pass — May 2026

Audit of `bin/orchestrator_poll` (1466 LOC) scoped to the example poller,
prompted by issue #5 (beta milestone). Single read pass, hotspot-first. This
is the orchestrator half of a simplify pass originally scoped as #64 — the
MCP/IRC half is tracked separately.

13 findings: 9 delete, 2 correctness, 2 clarify. Acting on all of them yields
roughly **−294 LOC from production code paths** (with ~220 of that being a
production→test move, not a pure delete) and two latent-bug fixes.

## Categories

- **delete** — dead code, duplicate code, defensive-for-impossible code,
  speculative options or params with no callers, single-use wrappers that
  earn their wrapper status only by name.
- **clarify** — code that stays, but hides the happy path, leaks
  abstractions, or repeats a shape often enough that extraction reads better.
- **correctness** — live latent bugs, races, swallowed signals.

When ambiguous between delete and clarify I preferred delete.

## Top wins (read these first)

| # | Title | Cat | Δ LOC | Sev |
|---|---|---|---|---|
| D3 | Move `_run_self_test` out of `bin/orchestrator_poll` | delete (move) | −220 from prod | high |
| C1 | Daemon swallows config-reload errors | correctness | 0 | high |
| D1 | Delete `--dispatch-irc` (undocumented, no caller) | delete | −30 | medium |
| L7 | Split `_run_one_tick_collect` seeding from diffing | clarify | ~0 | medium |
| D2 | Delete `--config-dir` (no caller) | delete | −10 | low |

The remaining 8 are individually small (most −2 to −9 LOC) but consistent.

---

## bin/orchestrator_poll (1466 LOC)

Mixes GitHub API access, diffing, formatting, an in-process IRC client, the
daemon loop, and 220 lines of inline tests.

### D1. Delete `--dispatch-irc` flag and handler — delete · medium · −30 LOC

**Location:** `bin/orchestrator_poll:1162-1184` (handler), `:1433-1436` (arg),
`:1456-1457` (dispatch in `main`), `:11` (docstring).

Undocumented in `docs/ORCHESTRATOR.md`. Not invoked by any script, hook, or
test. Predates `--daemon` mode — the one-shot dispatch path was the original
cron-driven shape, superseded.

**Fix:** drop `_run_one_shot_dispatch_irc`, the `--dispatch-irc` arg, the
branch in `main`, and the docstring entry.

### D2. Delete `--config-dir` flag — delete · low · −10 LOC

**Location:** `bin/orchestrator_poll:1439-1449`.

Mutates 5 module globals (`STATE_DIR`, `CONFIG_PATH`, …). No caller passes it.

**Fix:** drop the arg and the global-mutation block.

### D3. Move `_run_self_test` out of production — delete (move) · high · −220 from prod

**Location:** `bin/orchestrator_poll:1198-1417`, `:1437-1438`, `:1452-1453`.

220 lines of inline self-tests in production code. `test/dispatcher.test.ts`
runs them by shelling out to `--self-test`. Tests cover pure functions:
`_event_channels`, `_initial_irc_channels`, `format_event`,
`_format_comment_header`, `_multiline_split_line`, `format_comment_event`,
`comment_privmsg`.

**Fix:** create `test/orchestrator_poll_test.py` that imports and asserts on
those functions. `dispatcher.test.ts` runs `python3 test/orchestrator_poll_test.py`.
Net total LOC roughly the same; production file shrinks by 220 and the test
shape becomes idiomatic.

### D4. `_pr_key` and `_issue_key` are identical — delete · low · −4 LOC

**Location:** `bin/orchestrator_poll:341-346`. Both return `f"{repo}#{number}"`.
Used 4 places total.

**Fix:** collapse to one helper, or inline at all four call sites — the
expression is shorter than the function name.

### D5. `label_names` str fallback is unreachable — delete · low · −3 LOC

**Location:** `bin/orchestrator_poll:189-200`, the `elif isinstance(label, str)`
branch.

GitHub's PR/issue API returns labels as a list of label objects. The string
branch only triggers if a caller fed `label_names` something the API never
emits.

**Fix:** drop the `elif` branch.

### D6. `fetch_pr` check_runs list-fallback is unreachable — delete · low · −3 LOC

**Location:** `bin/orchestrator_poll:219-222`.

The `repos/X/commits/Y/check-runs` endpoint always returns a dict with a
`check_runs` key. The `isinstance(check_runs_resp, list)` branch is dead.

**Fix:** drop the `elif` branch and the redundant null-coalescing.

### C1. Daemon swallows config-reload errors — correctness · high · 0 LOC delta

**Location:** `bin/orchestrator_poll:1083-1085`.

```python
try:
    config = load_config()
except Exception as e:
    sys.stderr.write(f"orchestrator_poll[daemon]: config load failed: {e}\n")
```

The daemon reloads config every tick. If `load_config()` throws — bad JSON,
missing file, schema mismatch — the exception is logged to stderr and the
daemon proceeds with the previous tick's `config` variable. Under
`tmux`, that stderr goes to a window nobody reads. A
malformed edit lands silently: dispatcher keeps emitting against the stale
watch list, heartbeat still ticks, IRC stays connected.

This is a live instance of the recurring **silent fall-through** shape that
bit the project in #87 (permbot reply parser), #92 (cache staleness on
reconnect), and #97 (deny reason not propagated): code encounters a problem,
writes a signal nobody reads, and continues as if everything is fine. Each
individual fix was small; the shape keeps reappearing because nothing in the
codebase makes "this case shouldn't happen" loud when it does.

**If only one finding from this audit gets acted on, fix C1.**

**Fix:** treat config-reload failure the same as tick failure (line 1108):
post a `dispatcher_error` event to the project channel. Or raise and let
the service-runner restart the daemon — both make the failure visible.

### C2. `_aggregate_ci` silently maps unknown states to PENDING — correctness · low · 0 LOC delta

**Location:** `bin/orchestrator_poll:170, 178`.

The fall-through `else: states.add("PENDING")` for unrecognized check-run
conclusions and combined-status states means a future GitHub status taxonomy
change (or a state we'd want to treat as FAILURE) silently presents as
"still running" forever. Same silent fall-through shape as C1, softer — won't
bite today, but when it does, the cause will be hard to trace without this note.

**Fix:** log unmapped values to stderr at minimum.

### D14. `diff_pr` builds the same `ci_transitioned` event in two branches — delete · low · −9 LOC

**Location:** `bin/orchestrator_poll:427-444`.

The "head changed and CI now terminal" branch and the "head unchanged but CI
state changed" branch each build the same dict shape with different `from`/`to`.

**Fix:** compute (`from`, `to`) up front, build the event once.

### D15. `_format_comment_header` duplicates `format_event` prefix logic — delete · low · −5 LOC

**Location:** `bin/orchestrator_poll:582-610` vs `:874-891`.

`format_event` renders "PR tag comment by author at path:line: snippet — url".
`_format_comment_header` renders "PR tag comment by author at path:line:".
The prefix logic (kind → tag → author → optional path:line) is duplicated.

**Fix:** extract a `_comment_prefix(event)` helper used by both.

### L7. `_run_one_tick_collect` seeding branch is half the body — clarify · medium · ~0 LOC

**Location:** `bin/orchestrator_poll:970-1041`.

The `seeding` flag changes ~half of what each loop iteration does (suppresses
regular events, emits `pr_added_to_watch`/`issue_added_to_watch` plus the
`*_has_existing_*` seed events). Two distinct flows entangled.

**Fix:** split into `_seed_state(config)` and `_diff_state(prev, config)`.
`main` chooses based on whether prev exists.

### D16. `_run_daemon` reconnect-on-error pattern repeated 4x — delete · low · −10 LOC

**Location:** `bin/orchestrator_poll:1094-1101, 1109-1114, 1123-1128, 1144-1150`.

Four near-identical try/`irc.reconnect()`/log/sleep blocks.

**Fix:** extract `_reconnect_with_log(irc, ctx) -> bool`.

### L9. `dispatch_events_irc` has symmetric-but-not-enforced branches — clarify · low · ~0 LOC

**Location:** `bin/orchestrator_poll:922-947`.

Outer `if` assigns `header`/`body`/`url`/`fallback` (multiline path) or `text`
(else). Inner `if` must match the outer to avoid `UnboundLocalError`. Two
parallel conditionals on the same key.

**Fix:** partition events into multiline and non-multiline lists, then iterate
each with its own loop.

---

## Suggested order of operations

1. **C1** first (correctness, small fix, makes the next failure visible).
2. **D3** (the self-test move) — biggest LOC win, mechanical.
3. **D1, D2** — clean deletes, no behavior change, can ride one PR.
4. **D4-D6, D14-D16** — duplicate-collapse refactors, can ride a separate PR.
5. **L7, L9** — clarifies; cherry-pick whichever's most painful next time you're in that file.
6. **C2** — bottom-of-list, accept the inertia.
