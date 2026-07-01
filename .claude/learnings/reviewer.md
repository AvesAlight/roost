# Reviewer Learnings

Patterns extracted from postmortems. Loaded by the reviewer prompt at startup.

## 2026-07-01: Assert test behavior by explicit input, not a default a milestone is about to flip (from #620)

When a test asserts behavior through the default of a setting, and a milestone is set to change that default, the test becomes a landmine for the change. Assert by explicit input instead, so the default can flip without fighting the test. Concrete: #628's first cut pinned sonnet=acceptEdits, the exact default #603 flips to auto. Decoupling the tests to assert by explicit --permission-mode kept #628 single-purpose and out of #603's way.

## 2026-07-01: Catch non-timeless in-tree refs (everywhere) and shipped-artifact assumptions the reader can't resolve (from #646)

Two classes that read as stylistic nits but are blockers. Both slipped through reviews that waved them past (#642, #644).

- **Non-timeless in-tree refs — all code and docs, not just shipped artifacts.** Enforce the timeless-comment rule (CLAUDE.md "Comments") as a blocker, not a nit. A PR/issue/version ref in an in-tree *comment* (the forms CLAUDE.md lists: `(#276)`, `Issue #342`, `from #136`, `since v3`) means nothing to a future reader who lands there without that context. The carve-out is narrow: a full copy-pasteable `https://` URL survives, but a bare `#626`, `(issue #626)`, or "issue 626" does NOT — that distinction is the whole point. The scope word is *comment* on purpose: systems of record keep their refs (this learnings file included) per that same CLAUDE.md section, so don't flag refs in commit/PR bodies, learnings, or dated audits. Tests count: reviewer-642's miss was two `(issue #626)` refs in test comments, which never ship but still get read.
- **Shipped artifacts — assumptions the common consumer can't satisfy.** For skills/prompts/docs that install into unknown projects, ask what the *most common* consumer actually has on hand. This is a judgment call, not a keyword ban on file mentions. A shipped skill installs standalone, so a bare `README.md` cross-ref resolves to some other project's readme (or nothing), and "in your dev checkout" assumes a context most readers lack. reviewer-644 praised the SKILL.md → README.md cross-ref that was the actual bug.
