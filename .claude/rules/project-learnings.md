# Project Learnings

Patterns extracted from postmortems. Auto-loaded into worker/reviewer sessions.

## 2026-05-19: Use goal-framed deep review for artifact-shaped PRs (from #410)

For issues whose deliverable is a durable artifact (prompt change, new dance, written convention), follow the diff-level reviewer with a second `--effort max` pass framed against the project's three goals: minimize rework, maximize flexibility, maximize quality. The default reviewer underweights structural gaps in design-shaped PRs. Cheap insurance against a load-bearing artifact shipping with a flaw.

## 2026-05-19: Always spawn with bare model aliases, never full ids (from #422)

Use bare aliases (`opus`, `sonnet`, `haiku`) — full ids (`claude-opus-4-5` etc.) pin the session to that exact dated variant instead of tracking the latest version at spawn time. The APM was filling `<model>` placeholders in its templates with full ids and silently shipping work on stale models. Stick to aliases unless the lead explicitly asked for a pinned version (rollback test, regression repro, A/B). The wrapper now warns when `--model` looks like a full id — heed it. Next escalation if a warning is cited as ignored: hard error + `--pin-version` opt-in.
