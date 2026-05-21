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

## 2026-05-19: When fixing a prompt failure mode, audit whether the trigger is narrower than the right fix (from #448)

Adding a behavior rule to agent prompts to address a specific failure? Audit whether the failure mode is narrower than the rule needs to be. The #448 trigger was "inline PR thread comment" but the right fix covers all GitHub PR reply surfaces — inline diff threads, top-level review summaries, and PR conversation comments. Phrasing the rule against the trigger example leaves adjacent failure modes unpatched. Generalize at first draft; the reviewer agent will catch over-narrowing, but it's cheaper to think one level up while writing.

## 2026-05-20: Verify external-system behavior empirically before flipping ready (from #449)

When a PR's core logic depends on external system behavior — API field shape, platform feature firing, third-party side effect — unit tests of mocked responses prove your code handles the shape; they don't prove the shape exists in the wild. Verify empirically before lead-review.

Concrete: PR #462 routed cross-repo closure events. 666 mocked tests passed, but nobody had confirmed GitHub's `closingIssuesReferences` actually populates for cross-repo refs. A 15-min throwaway PR + GraphQL query confirmed both same-org and cross-org variants populate.

Gate this in the lead's pre-review pressure-test, not the worker's plan. Question: "what external-system fact is this code load-bearing on, and have we observed it?"

Different from §#410 (artifact-shape): that's about durable artifacts (prompts, conventions). This is about behavior shapes (does the API actually do X). Same load-bearing-assumption muscle.

## 2026-05-20: Run survey/audit issues before paired specific cleanup issues (from #457)

When a milestone pairs a survey/audit issue with specific cleanup issues, run the survey first. It either obsoletes the specifics (saving the work) or confirms them with concrete data — running specifics-first risks doing work the survey would have re-scoped.

Concrete: #457 (orchestrator rereview) paired with #473 (lock primitives) and #475 (tmux buffer-chain). Running the survey first confirmed both specifics were still valid and gave a concrete LOC baseline; running specifics-first would have risked work the survey then re-scoped.

## 2026-05-20: Add arg validation when extracting N inline copies into one shared helper (from #475)

When extracting N inline copies into one shared helper, add arg validation to the new helper even if the originals had none. The helper is now load-bearing across all callers, and a silent failure in one caller becomes everyone's problem.

## 2026-05-20: When migrating call sites to a new helper, scan within-function retry branches (from #473)

When migrating N call sites to a new helper, scan each migrated function for *every* invocation of the old primitive — including within-function retry/fallback branches that weren't the initial migration target. The #473 worker migrated `writeDispatcherPid`'s initial `wx` attempt to `exclusiveCreate` but left the function's stale-retry path on raw `writeFile(wx)`. Distinct from §#419 (adjacent files): same file, same function, different code branch. Migration is incomplete until every callsite of the old primitive within migrated scope uses the new helper.

## 2026-05-20: Filing a followup: check if it's service-of-future-milestone work before defaulting to current (from #458)

When filing a followup issue, ask whether the work is primarily in service of a future milestone before defaulting to the current one. If the followup's value lands in a later wave (e.g., a boot-time priority-tie warning is most useful when the Linear plugin lands in 0.8.0, not during a 0.7.0 cleanup pass), file it in that future milestone. The concrete test: "when does this followup's primary consumer arrive?"

## 2026-05-20: When you see N copies of the same intervention accumulating, debounce at the producer (from #470)

When N copies of the same intervention accumulate in a queue, debounce at the producer — not the receiver. The receiver can't tell stale from fresh; the producer knows it just fired. Add a TTL-gated lock at injection time rather than retrofitting dedup downstream. Pattern: lock-before-inject when an inject point has no idempotency guarantee.

Concrete: PreCompact fired 4× during one milestone, each invocation queued another /compact in tmux; none drained because each new IRC message triggered another auto-compact. Fix was atomic mkdir lock at injection; PR #471.

## 2026-05-21: "Describes output, not mechanism" gap means the research hasn't happened yet (from #424)

When an issue's body describes the output (add X to file Y) but not how the underlying primitive works, the deliverable is research — probe + document, not mechanical config. Size opus. The "describes output, not mechanism" gap is the research that hasn't happened yet.

## 2026-05-21: Treat reviewer "narrower than the failure mode" as a blocker, not a fyi (from #486)

Treat reviewer "fyi: this is narrower than the failure mode" as a blocker on the current PR, not a fyi to defer. §#448 covered this for prompts; same logic for code/test checks. Asymmetry: widening at plan/review costs a paragraph; shipping narrow costs a re-cycle (worker respawn, push, re-CI, re-review). The reviewer's narrowness flag is the signal, whether the artifact is a prompt rule or a code check.

## 2026-05-21: In prompt gates, the artifact instruction is the entire lever (from #496)

Agents reliably obey explicit output-shaping rules — an instruction to name one specific X produces one specific X. So in prompt gates, the artifact instruction IS the entire lever; "if you fail X, do Y" backstops and "gate failure" framing add no safety, only paranoia. Frame prompt gates around the team putting its best foot forward for leadership, not around catching skimping. The suspicion is decoration; the artifact instruction does the work.
