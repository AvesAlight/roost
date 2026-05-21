# Project Learnings

Cross-cutting patterns extracted from postmortems — entries here span 3+ roles. Auto-loaded into every Claude Code session in this repo.

Role-specific learnings live in `.claude/learnings/<role>.md` and are loaded by the role's prompt at startup. See `agents/associate-pm.md` historian dance for the audience-routing rules.

## 2026-05-19: Canonicalize wording verbatim when an invariant lives in 3+ surfaces (from #422)

When the same invariant lives in 3+ surfaces (operator help, agent prompts, learnings, etc.), pick one canonical sentence and copy it verbatim across all places. Paraphrasing looks fine at first but drifts on the next edit — and a future reader can't tell which copy is right. For ≤2 places, the duplication tax exceeds the drift risk; phrase each in context.

## 2026-05-19: Write docs in IRC-conversational voice from the first draft (from #255)

Prose in this project needs one idea per sentence. Skip em-dashes. Don't use jargon without a concrete instruction next to it. Writing "claudey" the first time costs a full extra review round.

Self-check: read the sentence aloud. If it has more than one connector, split it.

## 2026-05-19: When fixing a prompt failure mode, audit whether the trigger is narrower than the right fix (from #448)

Adding a behavior rule to agent prompts to address a specific failure? Audit whether the failure mode is narrower than the rule needs to be. The #448 trigger was "inline PR thread comment" but the right fix covers all GitHub PR reply surfaces — inline diff threads, top-level review summaries, and PR conversation comments. Phrasing the rule against the trigger example leaves adjacent failure modes unpatched. Generalize at first draft; the reviewer agent will catch over-narrowing, but it's cheaper to think one level up while writing.

## 2026-05-21: Treat reviewer "narrower than the failure mode" as a blocker, not a fyi (from #486)

Treat reviewer "fyi: this is narrower than the failure mode" as a blocker on the current PR, not a fyi to defer. §#448 covered this for prompts; same logic for code/test checks. Asymmetry: widening at plan/review costs a paragraph; shipping narrow costs a re-cycle (worker respawn, push, re-CI, re-review). The reviewer's narrowness flag is the signal, whether the artifact is a prompt rule or a code check.
