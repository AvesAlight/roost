# perm-irc ↔ Claude Code divergence audit — June 2026

Investigation for #604. Hypothesis: `--perm-irc` fires IRC permission prompts
for actions Claude Code's auto permission-mode would grant on its own. Pairs
with #598 and gates the 0.8.6 perm batch.

**Mission anchor — what perm-irc is for.** roost is a *parity relay* for CC's
blocking permission requests, not a safety tool. The sole goal: when CC would
block on user input, route it over IRC so an operator can unblock the agent —
nothing more, nothing less. So the bar is parity. If CC asks, roost relays; if
CC doesn't ask, roost stays silent. Whether CC's gating is "right" is out of
scope — roost mirrors it. That makes "the classifier doesn't catch `rm -rf`" a
non-issue: CC auto-grants it, so roost correctly stays silent. The only defect
that matters is the inverse — roost relaying what CC would have granted.

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
| `rm -rf /tmp/<throwaway>` (**positive control**) | none (`null`) | **auto: executed, no prompt** · **default: BLOCKED** |

The positive control is load-bearing: it proves the harness can see a real
non-execution. `--permission-mode default` refuses `rm -rf /tmp/<throwaway>`
(a write outside the session working dir — CC's cwd sandbox, a gate separate
from the bash permission-request layer) and the marker never prints, while `auto`
runs it and prints the marker. So an auto-mode "no prompt → executed" row is a
genuine grant, not the harness being blind, and `--permission-mode` is honored
(default behaved like default, not like the box's `defaultMode: auto`).

That default-mode block also happened *upstream* of the hookable PermissionRequest
path, so the allow-emitting observation hook (see Reproducibility) never saw it.
PermissionRequest in fact never fired in *any* of the 13 runs, default or auto
(mechanism note below). So: **auto mode grants the classified shapes outright,
no prompt.**

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

### Mechanism: classifyBash is roost's only bash lever; the PermissionRequest hook is inert for bash

`--perm-irc` wires two hooks: PreToolUse:Bash (`irc-pretooluse-prompt`, i.e.
`classifyBash`) and PermissionRequest (`irc-permission-prompt`). Across all 13
probe runs — read-only, subshell, cd shapes, the `rm` control, in both default
and auto — the PermissionRequest hook never fired for a Bash call. CC 2.1.196
routes bash through the PreToolUse/native-analyzer path, not through
PermissionRequest. So the parity-correct relay — `irc-permission-prompt`, which
would fire on a real CC block — has nothing to relay for bash in auto mode,
because CC produces no blocking bash request. The only thing that *does* fire is
`classifyBash`, which predicts CC's decision from syntax and gets it wrong
(over-fires). `classifyBash` (PreToolUse) is roost's only active bash lever — a
fix to roost's bash handling changes `classifyBash` or nothing.

### Why classifyBash over-fires: it keys on syntax, not on what CC blocks

classifyBash decides what to relay from the *shape* of the command, not from
what CC would actually do with it. So it flags shapes CC auto-grants: `cd /tmp;
ls` (cd-compound), `(grep -rn foo src/)` (shell-operators), the multi-line `cd`
block (cd-multi-positional). All three executed in Probe A — CC produced no
blocking request, yet roost relayed them to the operator. That is the parity
violation, and it's the whole of the bug.

The same syntax-keying leaves classifyBash silent on simple destructive commands
(`rm -rf`, `dd`, `curl | sh`, etc. all return `null`). That is **not** a gap: CC
auto-grants those too, so both sides stay silent — parity working as intended.
roost is a parity relay, not a safety layer, and isn't trying to catch them. The
point is only the axis: classifyBash keys on syntax, orthogonal to what CC
blocks, so its relays don't track CC. The failure is one-directional — it relays
where CC wouldn't.

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
  not a hang. And a missed grant is parity-correct silence — CC didn't block, so
  neither should roost — not a defect to chase.
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

One bug, on the parity axis. classifyBash relays bash shapes CC's auto mode
auto-grants — it asks the operator when CC produced no blocking request. That is
the divergence from parity, and it's Alex's original hypothesis, confirmed.
The fix direction: relay a bash command only when CC would actually block it.
#598 is the narrow, shippable instance (the `cd`-multi-positional false flag);
the general goal is "no relay where CC produces no blocking request."

**Not a bug: the under-fire.** classifyBash returning `null` on `rm -rf`, `dd`,
`curl | sh`, etc. is parity working — CC auto-grants them, so roost correctly
stays silent. roost is a parity relay, not a safety layer; there is no danger
gate to add, and none should be added. Catching destructive commands is
explicitly out of scope.

**The mechanism question is open, not settled here.** classifyBash keys on syntax
(orthogonal to CC's decision), and across these probes the PermissionRequest hook
never fired for bash — even on the default-mode block — so "did CC actually block
this?" isn't cleanly available from either current path. Whoever takes the
followup gets to design how roost detects a real CC bash block; the audit's job
is to establish that the current syntactic relay isn't it, and that in auto mode
the parity-correct bash relay volume is essentially zero.

**Live-run scope (don't over-read).** Among the destructive shapes, only `rm -rf
/tmp/<throwaway>` was run live in CC (executed in auto, blocked in default — the
positive control); the rest were exercised only through `classifyBash`
(deterministic `null`). That's enough for the parity question — roost mirrors CC,
and we confirmed CC's auto-mode silence on the represented shapes — and I did not
probe CC's own critical-path guards (no `rm -rf /`).

## Reproducibility

roost side is deterministic — every classifyBash claim is a one-liner:

```
bun -e 'import {classifyBash} from "./src/pretooluse-prompt.ts"; console.log(classifyBash(<command>))'
```

CC side: Probe A ran real `claude --permission-mode auto` (and `default`/`plan`
for controls) 2.1.196 sessions with two observation hooks — a PreToolUse:Bash
logger that passes through, and a PermissionRequest logger that emits allow
(which never fired — see the positive control) — in
a clean cwd with roost's env stripped, so the inner session uses only the probe
hooks. Each row confirmed the logged tool-call matched the intended expression
before the result was read. The subshell shape was cross-checked in both
headless `claude -p` and interactive tmux and agreed. Probe B drove the real
`src/pretooluse-prompt.ts` against a logging permbot stub. The harness lives in the session scratchpad
(observation hooks, settings, headless/interactive drivers, Probe B script);
the binary-extraction function names are `U_` (splitter), `E1p` (cd/path
validator), `Pkm` (shell-operators), `iBa`/`aBa` (sed).
