# Project Learnings

Patterns extracted from postmortems. Auto-loaded into worker/reviewer sessions.

## 2026-05-19: Use goal-framed deep review for artifact-shaped PRs (from #410)

For issues whose deliverable is a durable artifact (prompt change, new dance, written convention), follow the diff-level reviewer with a second `--effort max` pass framed against the project's three goals: minimize rework, maximize flexibility, maximize quality. The default reviewer underweights structural gaps in design-shaped PRs. Cheap insurance against a load-bearing artifact shipping with a flaw.
