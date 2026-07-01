# Worker Learnings

Patterns extracted from postmortems. Loaded by the worker prompt at startup.

## 2026-05-19: When fixing an asymmetry, scan adjacent files for the same pattern (from #419)

When a fix adds the missing half of a pair (unpaired call, missing step, unmatched keyword), scan all touched-or-adjacent files for the same pattern before closing scope. Rolling symmetric fixes into one PR is cheap; a separate follow-up issue is not.

## 2026-05-19: When removing a guard, audit tests that passed because of it (from #415)

When you delete a guard (error check, validation, early-return), scan tests for ones that asserted the guard's error. Those tests will still pass if the new code triggers a different error — assert the new error verbatim, not just "some error."

## 2026-05-19: Restate approved naming/ordering decisions verbatim in the plan (from #434)

When the lead has approved a specific naming or ordering decision in chat (e.g. `<project>-<slug>-worker-<N>` rather than just "slug-aware nick"), restate the exact string in your plan back to the lead. Paraphrasing loses load-bearing detail and pushes the mismatch out to human review instead of catching it in plan review.

## 2026-05-19: Frame "could go either way" design calls as explicit questions, not defended picks (from #433)

When a worker hits a design call mid-plan with two plausible answers, surface it to the lead as an explicit question with the trade-offs spelled out. Don't pick one and defend it. A defended choice typically resurfaces as a rework round in human review; a framed question gets resolved cheaply at plan stage. The asymmetry of conviction is the lever — workers convey "I see two options" rather than "I chose option A," and the lead negotiates before code lands.

## 2026-05-20: Add arg validation when extracting N inline copies into one shared helper (from #475)

When extracting N inline copies into one shared helper, add arg validation to the new helper even if the originals had none. The helper is now load-bearing across all callers, and a silent failure in one caller becomes everyone's problem.

## 2026-05-20: When migrating call sites to a new helper, scan within-function retry branches (from #473)

When migrating N call sites to a new helper, scan each migrated function for *every* invocation of the old primitive — including within-function retry/fallback branches that weren't the initial migration target. The #473 worker migrated `writeDispatcherPid`'s initial `wx` attempt to `exclusiveCreate` but left the function's stale-retry path on raw `writeFile(wx)`. Distinct from §#419 (adjacent files): same file, same function, different code branch. Migration is incomplete until every callsite of the old primitive within migrated scope uses the new helper.

## 2026-05-26: irc-framework reconnect + PING/PONG timing gotchas for test authors (from #578)

irc-framework's auto_reconnect gates on `registered_ms_ago > 5000` — reconnect tests must sleep ≥6s after register before killing the server, or reconnect never fires. ping_interval is client-initiated (30s default), so PING/PONG line shapes are not observable in integration test windows; assert them in mock-based unit tests instead. The existing `test/reconnect.test.ts` already encodes the 6s wait — reuse it rather than re-discovering the constraint.

## 2026-05-26: Stage-entry timer arming: each stage's timer must arm at stage entry, not all at connect (from #579)

When splitting connect-time timers into stages (registration → ready → flush), arm each stage's timer at stage entry, not all at connect. Arming both upfront recreates the all-or-nothing race in two timers instead of one — the flush window collapses while you wait on registration. Also: irc-framework's `registration-failed` only fires on nick-collision numerics (432/433/436), not on stalled CAP or a silent server. Use a wall-clock regTimer for hung-handshake detection.

## 2026-05-26: Files in /tmp die on a schedule — don't store session-persistent state there (from #585)

macOS tmp_cleaner runs daily at midnight, wiping files with atime+mtime+ctime all >3d (verified via `/System/Library/LaunchDaemons/com.apple.tmp_cleaner.plist` + `strings /usr/libexec/tmp_cleaner`). Long-running sessions that don't touch a /tmp file for 3+ days will lose it. For any path re-used across days (shim, lock, socket, log), prefer a brew-symlink-stable or absolute-clone-stable location. Only use /tmp for transient single-session state.

## 2026-06-30: A comment documenting a future-required change is a hope, not a trigger (from #622)

A comment documenting a future-required change is a hope, not a trigger. When you encode a value that's correct-now but has a known future change date (e.g. a model's intro-pricing window that flips to standard on a fixed date), file a committed followup to make the change — don't lean on an in-code comment to remind someone. The comment documents WHY; the followup ensures it actually happens.

## 2026-06-30: Anchor audit/investigation findings to the tool's mission before grading severity (from #604)

Before grading how serious an audit or investigation finding is, ask what the tool is FOR — importance is relative to the mission, not how alarming the finding looks in isolation. perm-irc is a parity relay (relay iff Claude Code blocks), not a safety tool, so "the classifier doesn't catch rm -rf" was off-mission — yet it got graded the "more serious" finding and sharpened further. Alex's mission re-anchor inverted the priority: the scary under-fire was parity working as intended, and the boring over-fire was the whole bug. Pressure-test at plan time: "what is this tool for, and are we framing findings against that mission?" Sibling to §449/§591 (verify behavior empirically) — this one is "frame findings against mission."

## 2026-07-01: Assert test behavior by explicit input, not a default a milestone is about to flip (from #620)

When a test asserts behavior through the default of a setting, and a milestone is set to change that default, the test becomes a landmine for the change. Assert by explicit input instead, so the default can flip without fighting the test. Concrete: #628's first cut pinned sonnet=acceptEdits, the exact default #603 flips to auto. Decoupling the tests to assert by explicit --permission-mode kept #628 single-purpose and out of #603's way.

## 2026-05-20: When you see N copies of the same intervention accumulating, debounce at the producer (from #470)

When N copies of the same intervention accumulate in a queue, debounce at the producer — not the receiver. The receiver can't tell stale from fresh; the producer knows it just fired. Add a TTL-gated lock at injection time rather than retrofitting dedup downstream. Pattern: lock-before-inject when an inject point has no idempotency guarantee.

Concrete: PreCompact fired 4× during one milestone, each invocation queued another /compact in tmux; none drained because each new IRC message triggered another auto-compact. Fix was atomic mkdir lock at injection; PR #471.
