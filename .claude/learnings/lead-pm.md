# Lead-PM Learnings

Patterns extracted from postmortems. Loaded by the lead-pm agent at startup.

## 2026-05-19: Use goal-framed deep review for artifact-shaped PRs (from #410)

For issues whose deliverable is a durable artifact (prompt change, new dance, written convention), follow the diff-level reviewer with a second `--effort max` pass framed against the project's three goals: minimize rework, maximize flexibility, maximize quality. The default reviewer underweights structural gaps in design-shaped PRs. Cheap insurance against a load-bearing artifact shipping with a flaw.

## 2026-05-19: Always spawn with bare model aliases, never full ids (from #422)

Use bare aliases (`opus`, `sonnet`, `haiku`) — full ids (`claude-opus-4-5` etc.) pin the session to that exact dated variant instead of tracking the latest version at spawn time. The APM was filling `<model>` placeholders in its templates with full ids and silently shipping work on stale models. Stick to aliases unless the lead explicitly asked for a pinned version (rollback test, regression repro, A/B). The wrapper now warns when `--model` looks like a full id — heed it. Next escalation if a warning is cited as ignored: hard error + `--pin-version` opt-in.

## 2026-05-19: Three repeats of a bug class in one milestone triggers escalation to worker-driven design (from #450)

Three repeats of a bug class in one milestone is the escalation signal — flip from lead-rolled-in fix to worker-driven design with review. Recurrence count, not severity, is what triggers the flip. Cheap fixes on operator-facing surfaces (config files, tracked templates, docs) rarely stay cheap; the cost compounds across every future operator.

## 2026-05-20: Verify external-system behavior empirically before flipping ready (from #449)

When a PR's core logic depends on external system behavior — API field shape, platform feature firing, third-party side effect — unit tests of mocked responses prove your code handles the shape; they don't prove the shape exists in the wild. Verify empirically before lead-review.

Concrete: PR #462 routed cross-repo closure events. 666 mocked tests passed, but nobody had confirmed GitHub's `closingIssuesReferences` actually populates for cross-repo refs. A 15-min throwaway PR + GraphQL query confirmed both same-org and cross-org variants populate.

Gate this in the lead's pre-review pressure-test, not the worker's plan. Question: "what external-system fact is this code load-bearing on, and have we observed it?"

Different from §#410 (artifact-shape): that's about durable artifacts (prompts, conventions). This is about behavior shapes (does the API actually do X). Same load-bearing-assumption muscle.

## 2026-05-20: Run survey/audit issues before paired specific cleanup issues (from #457)

When a milestone pairs a survey/audit issue with specific cleanup issues, run the survey first. It either obsoletes the specifics (saving the work) or confirms them with concrete data — running specifics-first risks doing work the survey would have re-scoped.

Concrete: #457 (orchestrator rereview) paired with #473 (lock primitives) and #475 (tmux buffer-chain). Running the survey first confirmed both specifics were still valid and gave a concrete LOC baseline; running specifics-first would have risked work the survey then re-scoped.

## 2026-05-20: Filing a followup: check if it's service-of-future-milestone work before defaulting to current (from #458)

When filing a followup issue, ask whether the work is primarily in service of a future milestone before defaulting to the current one. If the followup's value lands in a later wave (e.g., a boot-time priority-tie warning is most useful when the Linear plugin lands in 0.8.0, not during a 0.7.0 cleanup pass), file it in that future milestone. The concrete test: "when does this followup's primary consumer arrive?"

## 2026-05-21: "Describes output, not mechanism" gap means the research hasn't happened yet (from #424)

When an issue's body describes the output (add X to file Y) but not how the underlying primitive works, the deliverable is research — probe + document, not mechanical config. Size opus. The "describes output, not mechanism" gap is the research that hasn't happened yet.

## 2026-05-21: In prompt gates, the artifact instruction is the entire lever (from #496)

Agents reliably obey explicit output-shaping rules — an instruction to name one specific X produces one specific X. So in prompt gates, the artifact instruction IS the entire lever; "if you fail X, do Y" backstops and "gate failure" framing add no safety, only paranoia. Frame prompt gates around the team putting its best foot forward for leadership, not around catching skimping. The suspicion is decoration; the artifact instruction does the work.

## 2026-05-21: Scope learnings by path when the rule is location-bound, not role-bound (from #494)

When a learning applies to "anyone touching these files" rather than to a specific role's behavior, path-scope beats audience-scope. Audience-scope limits reach to the named roles; path-scope fires for any agent reading matching files regardless of role. The test: does the rule hold because of who the agent is, or because of what code they're reading? If the latter, use paths: frontmatter.

## 2026-05-26: Park defense-in-depth fix and observe after direct fix ships (from #585)

When a symptom could plausibly be caused by two in-flight fixes (one direct, one defense-in-depth), park the defense-in-depth and observe after the direct fix ships. Shipping both at once means you can't tell which was load-bearing, and you may have spent budget on a band-aid that was solving a symptom of the real bug. Concrete: #585's data-dir-deletion fix (#586) and #580's classifyBash narrowness fix (#583) — parked #583, observed. If no escapes post-upgrade, #583 closes.

## 2026-05-21: Frame live-probe gating as milestone-savings, not pre-flip overhead (from #495)

Frame live-probe gating as milestone-savings, not pre-flip overhead. When a worker (or you) treats the probe as optional polish, the gate stops firing — but the catch (a rewrite from scratch) costs far less than shipping a query that 400s on every tick. #495's Linear schema bug and #519's zsh extended_glob bug were both caught this way; neither would have surfaced from mocked tests.

## 2026-06-30: A comment documenting a future-required change is a hope, not a trigger (from #622)

A comment documenting a future-required change is a hope, not a trigger. When you encode a value that's correct-now but has a known future change date (e.g. a model's intro-pricing window that flips to standard on a fixed date), file a committed followup to make the change — don't lean on an in-code comment to remind someone. The comment documents WHY; the followup ensures it actually happens.

## 2026-06-30: Anchor audit/investigation findings to the tool's mission before grading severity (from #604)

Before grading how serious an audit or investigation finding is, ask what the tool is FOR — importance is relative to the mission, not how alarming the finding looks in isolation. perm-irc is a parity relay (relay iff Claude Code blocks), not a safety tool, so "the classifier doesn't catch rm -rf" was off-mission — yet it got graded the "more serious" finding and sharpened further. Alex's mission re-anchor inverted the priority: the scary under-fire was parity working as intended, and the boring over-fire was the whole bug. Pressure-test at plan time: "what is this tool for, and are we framing findings against that mission?" Sibling to §449/§591 (verify behavior empirically) — this one is "frame findings against mission."

## 2026-05-28: §#449 corollary — a recovery probe must start from the actual failure state, not an adjacent happy path (from #591)

When you verify that a system recovers from failure X, the probe's starting state must BE failure X. A fresh-connection probe proves new-registration works at the new config; it does NOT prove an already-wedged client self-heals — those are different tests. Concrete: I "verified" permbot recovery after the nicklen rehash by opening fresh probe sockets (each a new registration at nicklen 48 — all succeeded). But the wedged carrot reviewer was a client that had already been 432'd, and irc-framework never reconnects a client that never reached RPL_WELCOME. My probe validated a path the real failure never took. Worker-591 caught it by reading the reconnect-gating source. Pressure-test self-check: does the probe's initial state match the failure I'm claiming to recover from?

