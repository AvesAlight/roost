# Project Learnings

Patterns extracted from postmortems. Auto-loaded into worker/reviewer sessions.

## 2026-05-19: Use goal-framed deep review for artifact-shaped PRs (from #410)

For issues whose deliverable is a durable artifact (prompt change, new dance, written convention), follow the diff-level reviewer with a second `--effort max` pass framed against the project's three goals: minimize rework, maximize flexibility, maximize quality. The default reviewer underweights structural gaps in design-shaped PRs. Cheap insurance against a load-bearing artifact shipping with a flaw.

## 2026-05-19: When fixing an asymmetry, scan adjacent files for the same pattern (from #419)

When a fix adds the missing half of a pair (unpaired call, missing step, unmatched keyword), scan all touched-or-adjacent files for the same pattern before closing scope. Rolling symmetric fixes into one PR is cheap; a separate follow-up issue is not.

## 2026-05-19: Canonicalize wording verbatim when an invariant lives in 3+ surfaces (from #422)

When the same invariant lives in 3+ surfaces (operator help, agent prompts, learnings, etc.), pick one canonical sentence and copy it verbatim across all places. Paraphrasing looks fine at first but drifts on the next edit — and a future reader can't tell which copy is right. For ≤2 places, the duplication tax exceeds the drift risk; phrase each in context.

## 2026-05-19: Always spawn with bare model aliases, never full ids (from #422)

Use bare aliases (`opus`, `sonnet`, `haiku`) — full ids (`claude-opus-4-5` etc.) pin the session to that exact dated variant instead of tracking the latest version at spawn time. The APM was filling `<model>` placeholders in its templates with full ids and silently shipping work on stale models. Stick to aliases unless the lead explicitly asked for a pinned version (rollback test, regression repro, A/B). The wrapper now warns when `--model` looks like a full id — heed it. Next escalation if a warning is cited as ignored: hard error + `--pin-version` opt-in.

## 2026-05-19: When removing a guard, audit tests that passed because of it (from #415)

When you delete a guard (error check, validation, early-return), scan tests for ones that asserted the guard's error. Those tests will still pass if the new code triggers a different error — assert the new error verbatim, not just "some error."

## 2026-05-19: Write docs in IRC-conversational voice from the first draft (from #255)

Prose in this project needs one idea per sentence. Skip em-dashes. Don't use jargon without a concrete instruction next to it. Writing "claudey" the first time costs a full extra review round.

Self-check: read the sentence aloud. If it has more than one connector, split it.

## 2026-05-19: Restate approved naming/ordering decisions verbatim in the plan (from #434)

When the lead has approved a specific naming or ordering decision in chat (e.g. `<project>-<slug>-worker-<N>` rather than just "slug-aware nick"), restate the exact string in your plan back to the lead. Paraphrasing loses load-bearing detail and pushes the mismatch out to human review instead of catching it in plan review.

## 2026-05-19: Three repeats of a bug class in one milestone triggers escalation to worker-driven design (from #450)

Three repeats of a bug class in one milestone is the escalation signal — flip from lead-rolled-in fix to worker-driven design with review. Recurrence count, not severity, is what triggers the flip. Cheap fixes on operator-facing surfaces (config files, tracked templates, docs) rarely stay cheap; the cost compounds across every future operator.

## 2026-05-19: Frame "could go either way" design calls as explicit questions, not defended picks (from #433)

When a worker hits a design call mid-plan with two plausible answers, surface it to the lead as an explicit question with the trade-offs spelled out. Don't pick one and defend it. A defended choice typically resurfaces as a rework round in human review; a framed question gets resolved cheaply at plan stage. The asymmetry of conviction is the lever — workers convey "I see two options" rather than "I chose option A," and the lead negotiates before code lands.
