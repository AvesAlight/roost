---
paths:
  - skills/**
  - README.md
---

# Doc Audience

Patterns extracted from postmortems. Loaded when files matching `skills/**` or `README.md` are read.

## 2026-07-01: User-facing docs address roost users, not maintainers (from #608)

SKILL.md installs into user projects, so it addresses someone USING roost, not someone working on it. README isn't installed anywhere, but it's the project's front door, so keep it user/intro focused too. Either way, surface what the user does and sees. Cut implementation details and maintenance reassurances: which directory a command reads, that a doc self-updates, internal frontmatter mechanics. Concrete: #608's first SKILL.md gloss explained the .claude/agents/ path and said a new agent "surfaces without editing this skill". That's maintainer framing a user doesn't need, and it cost a review round. Kin to §#562 (tool responses describe the contract, not the wire); same instinct, different artifact.
