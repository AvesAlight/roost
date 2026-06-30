---
paths:
  - src/orchestrator/**
---

# Orchestrator Error Isolation Learnings

Patterns extracted from postmortems. Loaded when files matching `src/orchestrator/**` are read.

## 2026-06-30: Audit error-isolation granularity before patching just the trigger (from #602)

When an issue blames a crash on a specific trigger, audit error-isolation granularity before patching just the trigger. An unguarded `Promise.all` over independent work collapses the entire batch on any single rejection — the right fix is per-item isolation, not per-trigger handling. Concrete smell: `await Promise.all(units.map(fn))` where the units are independent and one failing shouldn't sink the rest — a tick/poll loop is the common case, but a one-shot batch op has the same collapse.
