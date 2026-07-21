# Project Learnings

Cross-cutting rules for this repo — entries here span 3+ roles. Auto-loaded into every Claude Code session in this repo. Hand-maintained.

## 2026-05-19: Canonicalize wording verbatim when an invariant lives in 3+ surfaces (from #422)

When the same invariant lives in 3+ surfaces (operator help, agent prompts, learnings, etc.), pick one canonical sentence and copy it verbatim across all places. Paraphrasing looks fine at first but drifts on the next edit — and a future reader can't tell which copy is right. For ≤2 places, the duplication tax exceeds the drift risk; phrase each in context.

Operational corollary: when a reviewer flags a duplicate-invariant gap on a 3+ surface invariant — even hedging with "fyi" or "probably intentional" — treat it as a blocker. The surface count fires the rule; the reviewer's confidence doesn't gate it.

## 2026-05-19: Write docs in IRC-conversational voice from the first draft (from #255)

Prose in this project needs one idea per sentence. Skip em-dashes. Don't use jargon without a concrete instruction next to it. Writing "claudey" the first time costs a full extra review round.

Self-check: read the sentence aloud. If it has more than one connector, split it.

## 2026-05-19: When fixing a prompt failure mode, audit whether the trigger is narrower than the right fix (from #448)

Adding a behavior rule to agent prompts to address a specific failure? Audit whether the failure mode is narrower than the rule needs to be. The #448 trigger was "inline PR thread comment" but the right fix covers all GitHub PR reply surfaces — inline diff threads, top-level review summaries, and PR conversation comments. Phrasing the rule against the trigger example leaves adjacent failure modes unpatched. Generalize at first draft; the reviewer agent will catch over-narrowing, but it's cheaper to think one level up while writing.

## 2026-05-21: Treat reviewer "narrower than the failure mode" as a blocker, not a fyi (from #486)

Treat reviewer "fyi: this is narrower than the failure mode" as a blocker on the current PR, not a fyi to defer. §#448 covered this for prompts; same logic for code/test checks. Asymmetry: widening at plan/review costs a paragraph; shipping narrow costs a re-cycle (worker respawn, push, re-CI, re-review). The reviewer's narrowness flag is the signal, whether the artifact is a prompt rule or a code check.

## 2026-05-21: CLAUDE.local.md is a doc, not a permission grant — credential workers need explicit onboarding (from #492) [audience=project-manager,apm]

CLAUDE.local.md is a doc, not a permission grant. When a worker needs to fetch a credential, the auto-mode classifier blocks the call regardless of the doc. The PM either pre-injects the retrieval chain via `roost send` before the worker's first credential-touching command, or approves via permbot when it fires. Required onboarding step for any credential-fetching worker.

## 2026-05-22: CLI auto-detect that can pick the wrong default for a primary consumer → require explicit mode instead (from #548)

When a CLI command's auto-detect can silently pick the wrong default for a primary consumer, require explicit mode selection rather than silent auto-detect. Small operator friction at init time saves footgun-driven rework when the default lands in the wrong context. Concrete: `roost init` auto-detected the git remote to set `config.repo`, so an operator running `roost init` inside `services` (a multi-repo orchestrator that is itself a git repo) would silently get single-repo config. Fix was `--repo` (single) vs `--multi-repo` (multi), bare = error.

## 2026-05-22: Anchoring language makes referenced defaults a design constraint (from #509)

When an issue body anchors a new artifact to an existing one (any "like X", "mirror of", "symmetric counterpart", "extends pattern X" language), X's defaults are a design constraint, not a starting suggestion. Worker default-deviation must be explicitly justified in plan; reviewer treats unjustified deviation as a blocker per §#486.

## 2026-05-24: Agent-facing tool responses describe the contract, not the implementation (from #562)

Wire details (batch mode, cache status, protocol variant) are invisible to the agent and not actionable. Surface only what the agent can observe and act on — for `channel_message`, that's the seen-by list, not how the message was transmitted. Before adding a detail to a tool response, ask: can the agent do anything differently based on this? If no, drop it.

## 2026-05-24: When a reviewer flags N-site drift, derive the pattern and grep before re-pushing (from #555)

Patching only the enumerated sites leaves the defect adjacent — the reviewer named examples, not an exhaustive list. On first remediation, derive the general grep pattern from the called-out instances and scan the full codebase before pushing. Worker self-check: "am I fixing what was named, or what was wrong?"

## 2026-05-23: §#422 corollary: blocker for literal-verbatim drift; pragmatic for substitution-target drift (from #553)

The key question: is the spelling literally what the operator or reader sees, or is it a template field they replace before use? Substitution targets (`<your-nick>`, `<project>`, `<I>`) substitute away — drift is real but not blocking, a followup is enough. Literal-verbatim surfaces (flag names like `--ask-irc`, channel pattern shape like `#<project>-leads`, CLI structure the operator copies directly) → strict corollary, promote to blocker. Concrete: `<answerer>` vs `<your-nick>` drift in #553 is substitution-target → followup (#557). A drift in `--ask-irc` spelling across surfaces would be literal-verbatim → blocker.

## 2026-07-01: Permbot/permission changes require live parity testing against the native TUI (from #598)

Any change to classifyBash or the permission-prompt relay needs an empirical pass against the native TUI before merge — spawn a bare agent with no --perm-irc, and confirm via tool_use→tool_result gap which commands actually hold. We require absolute parity with default TUI holds, no more and no less. The #598 fix (a regex narrowing) initially cited a control command as a "hold" that turned out to be a different over-fire (cd-compound), not a real hold — only checking against the bare TUI caught it. Cross-ref §#449 (verify external-system behavior empirically) / §#591 (a recovery probe must start from the actual failure state).
