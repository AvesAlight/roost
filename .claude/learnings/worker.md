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

## 2026-05-20: When you see N copies of the same intervention accumulating, debounce at the producer (from #470)

When N copies of the same intervention accumulate in a queue, debounce at the producer — not the receiver. The receiver can't tell stale from fresh; the producer knows it just fired. Add a TTL-gated lock at injection time rather than retrofitting dedup downstream. Pattern: lock-before-inject when an inject point has no idempotency guarantee.

Concrete: PreCompact fired 4× during one milestone, each invocation queued another /compact in tmux; none drained because each new IRC message triggered another auto-compact. Fix was atomic mkdir lock at injection; PR #471.
