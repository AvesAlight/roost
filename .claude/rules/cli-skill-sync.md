---
paths:
  - bin/roost
---

# CLI Skill Sync

Patterns for keeping skills/roost/SKILL.md in sync with the CLI.

## 2026-07-01: When you touch bin/roost, review skills/roost/SKILL.md (from #608)

When you add, change, or remove a command or flag in bin/roost, read skills/roost/SKILL.md and update it to match — the skill teaches agents the CLI surface. README.md and the agent prompts in agents/ mirror the CLI too, so glance at them, but SKILL.md is the one that drifts silently, because it's not the obvious doc to update. In #608 the worker updated README and lead-pm.md on its own; only SKILL.md was missed, until human review.
