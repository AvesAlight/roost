---
paths:
  - agents/**/*.md
  - prompts/**/*.md
  - .claude/commands/**/*.md
---
# Shipped Prompt Authoring

Patterns for writing agent prompts, slash commands, and role prompts that ship with roost and install into arbitrary projects.

## 2026-05-21: In shipped agent prompts, don't enumerate project-specific role names (from #489)

Hardcoding a "Valid roles: worker, reviewer, lead-pm, apm" list in a shipped agent prompt couples the artifact to one project's role set. Downstream operators would need to fork the prompt to add their own roles. Use the audience= mechanism instead — let the lead's call at filing time determine scope. Catch this at plan stage: if you see a role enumeration in a shipped prompt, flag it before code lands.
