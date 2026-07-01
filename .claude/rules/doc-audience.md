---
paths:
  - skills/**
  - README.md
---

# Doc Audience

Patterns extracted from postmortems. Loaded when files matching `skills/**` or `README.md` are read.

## 2026-07-01: User-facing shipped docs address roost users, not maintainers (from #608)

SKILL.md and README install into user projects and address someone USING roost, not someone working on it. Surface what the user does and sees. Cut implementation details and maintenance reassurances: which directory a command reads, that a doc self-updates, internal frontmatter mechanics. Concrete: #608's first SKILL.md gloss explained the .claude/agents/ path and said a new agent "surfaces without editing this skill". That's maintainer framing a user doesn't need, and it cost a review round. Kin to §#562 (tool responses describe the contract, not the wire); same instinct, different artifact.
