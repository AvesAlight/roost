# Reviewer Learnings

Patterns extracted from postmortems. Loaded by the reviewer prompt at startup.

## 2026-07-01: Assert test behavior by explicit input, not a default a milestone is about to flip (from #620)

When a test asserts behavior through the default of a setting, and a milestone is set to change that default, the test becomes a landmine for the change. Assert by explicit input instead, so the default can flip without fighting the test. Concrete: #628's first cut pinned sonnet=acceptEdits, the exact default #603 flips to auto. Decoupling the tests to assert by explicit --permission-mode kept #628 single-purpose and out of #603's way.
