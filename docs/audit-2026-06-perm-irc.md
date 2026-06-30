# perm-irc ↔ Claude Code divergence audit — June 2026

Investigation for #604. Hypothesis: `--perm-irc` fires IRC permission
prompts for actions Claude Code's auto permission-mode would grant on its
own — spurious prompts that add friction without safety. Pairs with #598
(the cd-multi-positional specific) and gates the 0.8.6 perm batch.

Verdict: **hypothesis confirmed, but the mechanism is narrower and more
interesting than "the classifier is too aggressive."** Two real over-fires,
both in roost's own `classifyBash` heuristic (not CC). The shell-operators
seed repro does *not* reproduce as written. And the survey surfaced a more
dangerous divergence in the opposite direction: **under-fires** where roost
misses a CC bashMissKind, leaving a headless worker hung on a terminal prompt
it can't see.

## The headline finding: pass-through ≠ auto-grant

The intuitive fix for a spurious prompt is "make roost stop classifying it /
let it pass through." **That's wrong here**, and it reframes the whole batch.

`classifyBash` (in `src/pretooluse-prompt.ts`) exists for one reason: CC's
structural Bash safety analyzer escalates certain command *shapes*
(`bashMissKind`s) to a prompt that **bypasses the PermissionRequest hook and
shows terminal-only** — a `--perm-irc` worker never sees it and hangs. roost's
PreToolUse hook fires *before* that analyzer and routes those shapes to IRC
instead. So for a true bashMissKind, "pass through" doesn't mean "auto-grant"
— it means "let CC show a terminal prompt nobody can answer." Hang.

The actual lever is the other branch of the hook: it can `emit('allow')`
directly (see `pretooluse-prompt.ts:133`, used at `:212`). CC 2.1.196 has a
**"simple read-only command" fast-path** that auto-allows read-only commands
(rejecting only subshells and `&`). Where a command is read-only and CC would
auto-grant, roost should `emit('allow')` from the PreToolUse hook too — not
ask the operator, and not pass through. The fix for the over-fires is *teach
roost to grant the read-only subset*, not *narrow what it catches*.

## Verdicts (read these first)

| # | Divergence | Direction | roost | CC 2.1.196 | Verdict |
|---|---|---|---|---|---|
| O1 | multi-line `cd /p\n<readonly>` (#598) | over-fire | `cd-multi-positional` → IRC ask | per-statement parse → read-only → **allow** | **bug — roost** |
| O2 | `cd <dir>; <readonly>` / `cd <dir> && <readonly>` | over-fire | `cd-compound` → IRC ask | read-only tail, not write/redirect/git → **allow** | **bug — roost** |
| U1 | `cd $(...)` / runtime-determined path target | under-fire | `null` → pass through → hang | `shell-expansion` bashMissKind → ask | **bug — roost (hang risk)** |
| U2 | `cmd > /dev/tcp/...` (net redirect) | under-fire | `null` → hang | `net-redirect` bashMissKind → ask | **bug — roost (hang risk)** |
| U3 | path-command flags (`cp --target-directory=…`) | under-fire | `null` → hang | `flag-validation` bashMissKind → ask | **bug — roost (hang risk)** |
| U4 | redirect target is expansion (`> $(...)`) | under-fire | `null` → hang | `shell-expansion`/`redirected_statement` → ask | **bug — roost (hang risk)** |
| M1 | subshell `(…)` / command group `{…}` | match | `shell-operators` → IRC ask | `shell-operators` (`hasSubshell`/`hasCommandGroup`) → ask | correct |
| M2 | `cd … && git …`, `cd … && <write/redirect>` | match | `cd-compound` → IRC ask | `cd-git-compound` / `cd-compound-write/-redirect` → ask | correct |
| M3 | real zsh `cd OLD NEW` | match | `cd-multi-positional` → IRC ask | `cd-multi-positional` → ask | correct |
| M4 | bare `&&`/`\|` pipeline of read-only cmds | match | `null` → pass through | read-only fast-path → **allow** | correct (both grant) |

O1–O4 noise, U1–U4 hang. The under-fires matter more: a spurious prompt costs
an operator ack; a missed bashMissKind hangs the worker silently for minutes
(the original worker-202 failure this hook was built to prevent).

## How the perm-irc path decides to fire

Under `--perm-irc`, `bin/roost` wires two hooks sharing one permbot socket
(`bin/roost:822-864`):

- **PermissionRequest** → `src/permission-prompt.ts`. Catches CC's *normal*
  rule-based permission prompts (the ones CC routes through the hook). Routes
  to IRC via the permbot.
- **PreToolUse:Bash** → `src/pretooluse-prompt.ts`. Catches the *structural
  analyzer* escalations that bypass PermissionRequest. `classifyBash(command)`
  returns a `BashMissKind` or `null`; non-null → route to IRC, `null` → pass
  through to the normal pipeline.

`src/permbot.ts` is pure routing — no second classifier. So **the entire
firing decision for the structural path lives in `classifyBash`**, ~65 lines
of regexes approximating CC's analyzer.

The key architectural distinction for separating real gaps from non-gaps:

- A command CC escalates via a **bashMissKind** (structural analyzer) bypasses
  PermissionRequest → terminal-only → roost's *PreToolUse* hook must catch it,
  or the worker hangs.
- A command CC escalates via a **normal rule-based ask** (e.g. an un-allowlisted
  `cmd &`, which CC flags "not read-only" but not as a bashMissKind) goes
  through PermissionRequest → roost's *PermissionRequest* hook already catches
  it. No hang, no classifyBash gap.

That's why `&` (background) is *not* on the under-fire list even though roost's
`classifyBash` returns `null` for it: it's a normal ask, covered by the other
hook.

## How CC 2.1.196 actually behaves (grounded, not inferred)

roost's `classifyBash` comments cite Claude Code **2.1.139**; the installed
binary is **2.1.196**. Per §#449 (verify the real system, don't infer from a
doc) I extracted the live classifier from the binary
(`~/.local/share/claude/versions/2.1.196`, a Bun-compiled Mach-O with the JS
bundle embedded; `strings` + windowed grep). Load-bearing facts:

1. **CC parses with tree-sitter, per statement.** `U_(command)` calls
   `HD().parse(e)` and walks the AST, splitting into individual command nodes;
   `redirected_statement` and compound nodes are descended into. The
   statement-separator regex is `[;|\n\r]|&&` — **newlines are separators, not
   flattened.** The cd validator (`E1p`) counts arguments on the *parsed* cd
   statement.

2. **`shell-operators` fires only on subshell / command group.** The function
   (`Pkm`): `if (treeSitter ? compoundStructure.hasSubshell ||
   compoundStructure.hasCommandGroup : U_(command).length > 1)`. With
   tree-sitter (normal path) bare `&&`/`|` do **not** trigger it. The
   `U_().length>1` branch is a *parse-failure fallback* only.

3. **The cd-compound family is three kinds, each gated on the tail:**
   `cd-compound-write` (compound has a write), `cd-compound-redirect` (output
   redirection), and `cd-git-compound` (git in the compound, plus bare-repo
   indicator checks). There is **no bashMissKind for `cd <dir>; <readonly>`** —
   a read-only tail hits the read-only fast-path and is allowed.

4. **`shell-expansion` and `net-redirect` are real 2.1.196 bashMissKinds** with
   no analog in roost's table — runtime-determined path targets
   (command-substitution / untracked variable in a path arg) and
   `/dev/tcp`-`/dev/udp` redirects, respectively.

5. **"simple read-only command" fast-path** auto-allows; it rejects only
   "contains a subshell" and "`&` defers execution past approval-time checks."

## Findings

### O1 — multi-line `cd` over-fires `cd-multi-positional` (this is #598)

```
cd /path/to/wt
echo "=== refs ==="
grep -rn foo src/
ls -la
```

roost → `cd-multi-positional` → IRC ask. Reproduce:
`bun -e 'import {classifyBash} from "./src/pretooluse-prompt.ts"; console.log(classifyBash("cd /p\necho x\nls"))'`.

**Mechanism — and #598 has it wrong.** #598 reports "the permission classifier
flattens newlines→spaces before classifying." It doesn't. roost's
`cd-multi-positional` regex (`pretooluse-prompt.ts:94`) uses `\s+` between the
cd target and the next token, and **`\s` matches `\n`**. So `cd /path\necho`
reads as `cd` with two positional args (`/path`, `echo`) with no flattening
step anywhere. The only flattening in roost is `clip()` in the *display* path
(`permission-prompt.ts:51`) — cosmetic, downstream of classification.

CC handles the same input correctly (tree-sitter splits the statements; cd has
one arg) and the block is read-only → CC **auto-allows**. So this is a pure
roost false positive: spurious prompt, and not even hang-prevention, since CC
would have granted.

**#598 verdict: confirmed real, mechanism misdiagnosed, fix re-scoped.**
- The proposed fix (a) "preserve newlines in classify+display" does *not* fix
  the false flag — roost already has the newlines; `\s+` eats them. It only
  fixes the cosmetic display.
- The proposed fix (b) "treat newlines as statement separators in the
  classifier" is the real fix: split on `[;|\n\r]|&&` (mirror CC) before
  counting cd args, or tighten the `cd-multi-positional` regex so it can't
  cross a newline/operator. Better still, per the headline, also `emit('allow')`
  for the read-only result.

### O2 — `cd-compound` over-fires on read-only tails

`cd /tmp; ls`, `cd src && grep -rn foo .`, `cd build | wc -l` → roost
`cd-compound` → IRC ask. CC escalates cd-compound **only** for write, output
redirection, or git tails (finding #3 above); a read-only tail is allowed.

roost collapses CC's three distinct kinds into one detector
(`pretooluse-prompt.ts:100`) that fires on `cd … (&&|\|\||;)` regardless of the
tail. The git/write/redirect tails are correct mirrors (M2); the read-only
tails are the over-fire. **Fix:** gate roost's `cd-compound` on the tail
containing a write/redirect/git — or, simpler and aligned with the headline,
`emit('allow')` when the compound is entirely read-only.

### U1–U4 — under-fires: bashMissKinds roost misses (hang risk)

These are the dangerous ones. CC 2.1.196 escalates them via a bashMissKind
(bypassing PermissionRequest → terminal-only); roost's `classifyBash` returns
`null` → passes through → the worker hangs on a prompt it can't see.

- **U1 `shell-expansion`** — `cd $(git rev-parse --show-toplevel)`, and likely
  bare `cd $VAR` with an untracked variable. roost has no detector for a
  runtime-determined path target.
- **U2 `net-redirect`** — `echo x > /dev/tcp/host/80`. No roost analog.
- **U3 `flag-validation` on path-commands** — `cp a b --target-directory=/tmp`.
  roost's `flag-validation` (`pretooluse-prompt.ts:117`) only matches the
  *wrapper* set `env|timeout|xargs|nice|nohup` with `--chdir`-shaped flags; CC's
  applies to path-commands (cd/cp/mv) with flags like `--target-directory`.
  Different surfaces — roost misses CC's.
- **U4 redirect-target expansion** — `cat foo > $(somecmd)`. CC flags the
  runtime-determined redirect target; roost only catches the cd-compound
  redirect variant.

**Confidence / caveat.** U1–U4 are confirmed as real 2.1.196 bashMissKinds in
the binary, and roost demonstrably returns `null` for them. The hang
*prediction* rests on one load-bearing assumption carried from the 2.1.139 era:
that bashMissKind "ask"s still bypass the PermissionRequest hook in 2.1.196. I
could not verify the bypass statically. **The fix PR should behaviorally
confirm** (run 2.1.196 on one U-case under `--perm-irc`, observe hang vs IRC
route) before committing detectors — cheap, and it pins the assumption the
whole hook rests on.

### M-rows — correct mirrors (no action)

shell-operators on subshell/group (M1), cd-compound on git/write/redirect tails
(M2), real `cd OLD NEW` (M3), and read-only pipelines passing through (M4) all
match CC 2.1.196. **The shell-operators seed repro in #604's comment does not
reproduce as written**: `echo "…" && grep … | head` has no subshell/group, so
roost returns `null` and CC's read-only fast-path allows it — neither prompts.
The real observed command must have contained a top-level `(…)`/`{…}` (which
*is* a correct route — CC would have shown a terminal prompt). The operator's
"fired purely on the `&&`/`|`" reading is the misattribution; the trigger was
the subshell.

## Recommendations: bug vs intended

**Intended, leave alone:** M1–M4. roost correctly mirrors CC; routing these to
IRC is the hook doing its job (the alternative is a hang).

**Bugs to fix (over-fire, noise):**
- O1 (#598): fix `cd-multi-positional` to not cross statement separators.
  Re-scope #598 — the "flatten" framing and the "preserve newlines" fix are
  both wrong; this is a roost regex bug.
- O2: gate `cd-compound` on a write/redirect/git tail.
- Both O1 and O2 are best fixed by adding a **read-only fast-path that
  `emit('allow')`s** — same shape as CC's, and it generalizes beyond these two
  to any future read-only shape that trips a shape detector.

**Bugs to fix (under-fire, hang — higher severity):**
- U1–U4: add detectors for `shell-expansion`, `net-redirect`,
  path-command `flag-validation`, and redirect-target expansion, after
  behaviorally confirming the bypass assumption (see U-caveat).

**Sibling structuring for the batch.** The over-fires and under-fires share one
root cause: roost's `classifyBash` is a **hand-rolled regex approximation of a
tree-sitter analyzer**, frozen at 2.1.139, and CC has since drifted (new kinds,
the read-only fast-path, the three-way cd-compound split). The durable fix is
to (a) add the read-only fast-path, (b) realign the detector set to 2.1.196's
bashMissKinds, and (c) add a version-drift tripwire (the existing
one-example-per-kind test is good but only catches *renames*, not *new* kinds —
consider a periodic re-extraction check). #598 is one symptom; O2/U1–U4 are
its siblings and belong in the same realignment, not separate one-off patches.

## Reproducibility

roost side is deterministic — every table row is a one-liner against the
exported `classifyBash`:

```
bun -e 'import {classifyBash} from "./src/pretooluse-prompt.ts"; console.log(classifyBash(<command>))'
```

CC side was read from the 2.1.196 binary (function names minified: `U_` =
statement splitter, `E1p` = path-command/cd validator, `Pkm` = shell-operators,
`iBa`/`aBa` = sed). The U-row hang predictions are the only claims not yet
behaviorally confirmed; flagged inline.
