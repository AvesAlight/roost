# perm-irc ↔ Claude Code divergence audit — June 2026

Investigation for #604. Hypothesis: `--perm-irc` fires IRC permission prompts
for actions Claude Code's auto permission-mode would grant on its own. Pairs
with #598 and gates the 0.8.6 perm batch.

This audit had two passes. The first read CC's classifier out of the 2.1.196
binary and *inferred* behavior. Alex (#609) asked the literal operational
question that inference can't answer, so the second pass ran real auto-mode
Claude Code sessions and *observed* it. The observed pass is authoritative and
is first below. The binary pass follows, corrected where observation overturned
it — the gap between the two is itself a finding.

## Empirical answer (authoritative)

**Q1: in auto mode, does Claude Code still stop and request permission for a
classified bash expression? NO.**
**Q2: with auto mode + perm-irc, does roost relay permission requests that are
unnecessary because auto mode already let the agent proceed? YES.**

Evidence below. Method: real `claude --permission-mode auto` 2.1.196 sessions
(the production config — the box's user settings already set `defaultMode:
auto`, which is what an everyday roost worker runs), with observation-only hooks
that log the exact tool-call and whether CC routed a prompt, plus a positive
control proving the harness detects a real block. The subshell shape was run in
both headless and an interactive tmux session and behaved identically (auto-
granted, no prompt), so a "no prompt" result is a genuine grant, not a headless
artifact.

### Probe A — what CC's *native* auto mode does (no roost classifier present)

Each command's exact tool-call string was confirmed verbatim from the
PreToolUse log before reading the result (the inner model passed every shape
unmodified, including subshell parens and newlines).

| command (tool-call verbatim) | shape roost's classifyBash would flag | CC auto mode (observed) |
|---|---|---|
| `(echo TOK)` | shell-operators | executed, no prompt |
| `cd /tmp /usr` | cd-multi-positional | ran (errored at bash level), no prompt |
| `cd /tmp; echo TOK` | cd-compound | executed, no prompt |
| `echo TOK` (control) | none (`null`) | executed, no prompt |
| `rm -rf <throwaway-dir>` (**positive control**) | none (`null`) | **auto: executed, no prompt** · **default: BLOCKED (no exec)** |

The positive control is load-bearing: `--permission-mode default` blocks the
`rm` (the harness sees a real non-execution) while `auto` runs it. So (a) the
harness can detect a block when one occurs, and (b) `--permission-mode` genuinely
overrides the settings default. PermissionRequest never fired in auto mode for
any row. So: **auto mode grants the classified shapes outright, no prompt.**

### Probe B — what roost adds on top (real `classifyBash` PreToolUse hook)

The real `src/pretooluse-prompt.ts` hook, driven against a permbot stub, for
shapes Probe A just proved auto mode grants:

| command | relayed to operator? | trigger shown | hook decision |
|---|---|---|---|
| `cd /tmp; ls` | **YES** | `safety-check trigger: cd-compound` | allow |
| `(echo hi)` | **YES** | `safety-check trigger: shell-operators` | allow |
| `cd /tmp\necho hi\nls` (#598 shape) | **YES** | `safety-check trigger: cd-multi-positional` | allow |
| `echo hi` (control) | NO (passes through) | — | — |

roost's PreToolUse classifier fires *upstream* of CC's permission decision and
relays the flagged shapes to the operator. Auto mode would have granted all
three silently. The plain read-only control passes through (classifyBash returns
`null`), so the relay is specifically the classifier's doing. That is the
spurious prompt in Q2, and it lives entirely in `classifyBash`, not in CC.

### The inversion: classifyBash keys on syntax, which tracks neither danger nor hang-risk

Same exported `classifyBash`, two batteries:

- **Over-fire — benign-but-complex syntax, flagged + relayed:** `cd /tmp; ls`
  (cd-compound), `(grep -rn foo src/)` (shell-operators), the multi-line `cd`
  block (cd-multi-positional). All three *executed* in Probe A, so they are not
  hang-risks. Pure friction.
- **Under-fire — dangerous-but-simple syntax, returns `null` (not flagged):**
  all nine of `rm -rf /important`, `rm -rf ~/work`, `dd if=/dev/zero of=/dev/diskN`,
  `curl … | sh`, `git push --force`, `chmod -R 777 /etc`, `mv ~/.ssh/id_rsa /tmp/x`,
  `echo pwned > ~/.bashrc`, `kill -9 -1`. Zero flagged.

Syntax (has a subshell / two cd args / a `;`) correlates with neither what's
destructive nor what hangs. So classifyBash over-fires on harmless commands and
under-fires on destructive ones at the same time.

### This is false safety, not just friction

The prompts don't merely waste an ack. They actively mislead. An operator
watching `cd-compound` and `shell-operators` prompts roll past reasonably
concludes that the dangerous stuff is being gated too. It isn't: `rm -rf`, `dd`,
`chmod -R 777`, `curl … | sh` sail through silently in auto mode. The relay
manufactures confidence that a safety layer exists where there is none.

## The lesson: what the analyzer DECIDES vs what auto mode ENFORCES

The binary pass (below) established that CC's structural analyzer *returns*
`{behavior:"ask", bashMissKind:…}` for these shapes, and inferred from that:
"CC prompts → a `--perm-irc` worker would hang → roost's relay prevents the
hang → pass-through ≠ auto-grant." Observation overturned that premise: auto
mode does **not** enforce the analyzer's syntactic "ask" as a prompt. It grants
the command. The analyzer's decision and the mode's enforcement are two
different things, and a binary-only read conflated them and got the conclusion
backwards.

That miss is worth preserving rather than editing away. It is the §449/§591
trap in the wild: reading what a system *says it decides* is not the same as
observing what it *does* in the configuration the question is actually asked
against. The fix for the audit was to run the real thing.

## Binary analysis (corrected by observation)

Still-accurate mechanism, useful for whoever writes the fix. Extracted from
`~/.local/share/claude/versions/2.1.196` (Bun-compiled Mach-O, JS bundle
embedded; `strings` + windowed grep). roost's `classifyBash` comments cite
2.1.139; installed is 2.1.196.

These facts hold (they describe what the analyzer computes and what classifyBash
does, independent of mode enforcement):

1. **CC parses with tree-sitter, per statement.** `U_(command)` calls
   `HD().parse(e)` and walks the AST into command nodes; the statement separator
   is `[;|\n\r]|&&`. Newlines are separators, not flattened. The cd validator
   (`E1p`) counts arguments on the *parsed* cd statement.
2. **CC's `shell-operators` fires only on subshell / command group** (`Pkm`:
   `treeSitter ? hasSubshell || hasCommandGroup : U_().length>1`). Bare `&&`/`|`
   don't trigger it on the tree-sitter path.
3. **CC's cd-compound family is three tail-gated kinds:** `cd-compound-write`,
   `cd-compound-redirect`, `cd-git-compound`. There is no kind for `cd <dir>;
   <readonly>`.
4. **`shell-expansion` and `net-redirect` are real 2.1.196 bashMissKinds** with
   no analog in roost's table.
5. **A "simple read-only command" fast-path** auto-allows, rejecting only
   subshells and `&`.

What observation **corrected**:

- **"pass-through ≠ auto-grant / hang-risk" (the old headline): WRONG for auto
  mode.** Probe A: pass-through *does* auto-grant these shapes; no hang occurs.
  The hang premise came from 2.1.139-era reasoning and does not hold for a
  2.1.196 auto worker.
- **The old "under-fire = hang" rows (shell-expansion, net-redirect, path-command
  flag-validation, redirect-target expansion): NOT hangs in auto mode.** Auto
  mode grants, it doesn't prompt, so a missed bashMissKind is a missed *grant*,
  not a hang. The real under-fire is danger (below), not the bashMissKind set
  difference.
- **The old "correct mirror" rows: also over-fire in auto mode.** They were
  scored "correct" on the assumption CC prompts for them. CC doesn't (in auto
  mode), so relaying them is friction too.

What observation **confirmed**:

- **#598 is a roost bug, mechanism misdiagnosed.** #598 reports the classifier
  "flattens newlines→spaces." It doesn't. roost's `cd-multi-positional` regex
  (`pretooluse-prompt.ts:94`) uses `\s+`, and `\s` matches `\n`, so
  `cd /path\necho` reads as `cd` with two positional args. No flatten step
  exists (the only flatten is `clip()` in the display path,
  `permission-prompt.ts:51`, cosmetic and downstream). The proposed fix (a)
  "preserve newlines" does nothing for the false flag; (b) "split on statement
  separators" is the real fix. #598 is **one instance** of the syntax-keying
  over-fire, not the whole story.

## Recommendation

Two distinct failure modes. Same root cause (syntax is the wrong axis), but they
are not one finding and should not be filed as one.

**1. Friction — over-fire on benign syntax. Alex's original hypothesis,
confirmed.** classifyBash relays harmless shapes (cd-compound, shell-operators,
cd-multi-positional including #598) that auto mode would grant. Cleanup-priority.
The narrow version is #598; the general version is "stop flagging benign
syntactic shapes."

**2. Latent safety gap — under-fire on destructive commands. New, and more
serious than the friction.** The nine destructive commands tested fall through
`classifyBash` (`null`) and, for the one safe to run live (`rm -rf
<throwaway>`), through auto mode unprompted. An auto worker can run those today
with no human in the loop, while the friction prompts imply otherwise (false
safety). This warrants its own follow-up at higher priority than the friction
cleanup.

**Bounded claim (don't over-read).** What's tested: all nine return `null` from
classifyBash; auto mode executed `rm -rf <throwaway>` with no prompt while
default blocked it. What's *not* tested: I did not live-run the other eight
(they're destructive/networked), and I did not probe CC's critical-path guards
(no `rm -rf /`). The binary shows CC retains some native critical-dir rm checks
I did not map. So the precise statement is "these nine are ungated by
classifyBash, and auto mode ran the one destructive command I tested
unprompted," not "auto mode runs everything."

**Fix axis.** Re-key on what a command *does* (destructive / irreversible /
exfiltrating), not on its *syntax*. Syntax tracks neither.

**Design call for Alex, not a foregone fix.** Whether roost *should* add a
danger gate at all is a product decision and partly CC's job (CC owns the
permission model; roost shouldn't reimplement it). The audit's job is to show
the current classifier gives false safety on the danger axis and friction on the
syntax axis. If a gate is wanted, it must key on danger; if not, classifyBash's
syntactic flagging should be dropped or narrowed so it stops implying a gate
that isn't there.

## Reproducibility

roost side is deterministic — every classifyBash claim is a one-liner:

```
bun -e 'import {classifyBash} from "./src/pretooluse-prompt.ts"; console.log(classifyBash(<command>))'
```

CC side: Probe A ran real `claude --permission-mode auto` (and `default`/`plan`
for controls) 2.1.196 sessions with two observation hooks — a PreToolUse:Bash
logger that passes through, and a PermissionRequest logger that emits allow — in
a clean cwd with roost's env stripped, so the inner session uses only the probe
hooks. Each row confirmed the logged tool-call matched the intended expression
before the result was read. The subshell shape was cross-checked in both
headless `claude -p` and interactive tmux and agreed. Probe B drove the real
`src/pretooluse-prompt.ts` against a logging permbot stub. The harness lives in the session scratchpad
(observation hooks, settings, headless/interactive drivers, Probe B script);
the binary-extraction function names are `U_` (splitter), `E1p` (cd/path
validator), `Pkm` (shell-operators), `iBa`/`aBa` (sed).
