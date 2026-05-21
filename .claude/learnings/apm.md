# APM Learnings

Patterns extracted from postmortems. Loaded by the associate-pm agent at startup.

## 2026-05-19: Always spawn with bare model aliases, never full ids (from #422)

Use bare aliases (`opus`, `sonnet`, `haiku`) — full ids (`claude-opus-4-5` etc.) pin the session to that exact dated variant instead of tracking the latest version at spawn time. The APM was filling `<model>` placeholders in its templates with full ids and silently shipping work on stale models. Stick to aliases unless the lead explicitly asked for a pinned version (rollback test, regression repro, A/B). The wrapper now warns when `--model` looks like a full id — heed it. Next escalation if a warning is cited as ignored: hard error + `--pin-version` opt-in.

## 2026-05-20: Filing a followup: check if it's service-of-future-milestone work before defaulting to current (from #458)

When filing a followup issue, ask whether the work is primarily in service of a future milestone before defaulting to the current one. If the followup's value lands in a later wave (e.g., a boot-time priority-tie warning is most useful when the Linear plugin lands in 0.8.0, not during a 0.7.0 cleanup pass), file it in that future milestone. The concrete test: "when does this followup's primary consumer arrive?"

## 2026-05-21: In prompt gates, the artifact instruction is the entire lever (from #496)

Agents reliably obey explicit output-shaping rules — an instruction to name one specific X produces one specific X. So in prompt gates, the artifact instruction IS the entire lever; "if you fail X, do Y" backstops and "gate failure" framing add no safety, only paranoia. Frame prompt gates around the team putting its best foot forward for leadership, not around catching skimping. The suspicion is decoration; the artifact instruction does the work.
