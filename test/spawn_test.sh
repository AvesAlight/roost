#!/usr/bin/env bash
# Tests for `roost spawn --agent` validation. Plain bash, no bats.
# Run: bash test/spawn_test.sh
set -uo pipefail

ROOST_BIN="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )/bin/roost"
PASS=0
FAIL=0
TDIR=""

ok()   { echo "PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "FAIL: $1 ${2:+— $2}"; FAIL=$((FAIL+1)); }

setup() {
  TDIR="$(mktemp -d /tmp/roost-spawn-test-XXXXXXXX)"
  trap 'rm -rf "$TDIR"' EXIT
}

teardown() {
  rm -rf "$TDIR"
  # On dev boxes with ergo running, shell-resolution tests pass through to a
  # real tmux new-session — kill it so the next test gets a fresh "roost-testnick".
  tmux kill-session -t "roost-testnick" 2>/dev/null || true
  trap - EXIT
  TDIR=""
}

# -- Test 1: missing agent exits non-zero with clear message ------------------

setup
err="$("${ROOST_BIN}" spawn testnick --agent definitelynotanagent --cwd "$TDIR" 2>&1)"; exit_code=$?
if [ "$exit_code" -ne 0 ] \
    && echo "$err" | grep -q "agent 'definitelynotanagent' not found" \
    && echo "$err" | grep -q ".claude/agents/.*definitelynotanagent.md"; then
  ok "missing agent: exits non-zero with agent name and searched paths"
else
  fail "missing agent: exits non-zero with agent name and searched paths" "exit=$exit_code err=$err"
fi
teardown

# -- Test 2: agent in cwd path passes validation ------------------------------
# Assertion: the "not found" error does NOT appear. The script may still fail
# on missing tmux/ircd — this test only verifies agent validation doesn't trigger.

setup
mkdir -p "$TDIR/.claude/agents"
printf -- '---\ndescription: test agent\n---\nYou are a test agent.\n' > "$TDIR/.claude/agents/myagent.md"
err="$("${ROOST_BIN}" spawn testnick --agent myagent --cwd "$TDIR" 2>&1 || true)"
if ! echo "$err" | grep -q "agent 'myagent' not found"; then
  ok "cwd agent found: agent validation passes"
else
  fail "cwd agent found: agent validation passes" "err=$err"
fi
teardown

# -- Test 3: both searched paths appear in error output -----------------------

setup
err="$("${ROOST_BIN}" spawn testnick --agent missing --cwd "$TDIR" 2>&1)"; exit_code=$?
if echo "$err" | grep -qF "$TDIR/.claude/agents" && echo "$err" | grep -qF "$HOME/.claude/agents"; then
  ok "missing agent: both searched paths printed"
else
  fail "missing agent: both searched paths printed" "err=$err"
fi
teardown

# -- Test 4: no --agent flag is unaffected ------------------------------------

setup
err="$("${ROOST_BIN}" spawn testnick --cwd "$TDIR" 2>&1 || true)"
if ! echo "$err" | grep -q "agent.*not found"; then
  ok "no --agent: validation not triggered"
else
  fail "no --agent: validation not triggered" "err=$err"
fi
teardown

# -- Test 5: agent in home path passes validation -----------------------------
# Override HOME to a temp dir so we can plant an agent file there without
# touching the real ~/.claude/agents/.

setup
fake_home="$TDIR/fakehome"
mkdir -p "$fake_home/.claude/agents"
printf -- '---\ndescription: home agent\n---\nYou are a home agent.\n' > "$fake_home/.claude/agents/homeagent.md"
err="$(HOME="$fake_home" "${ROOST_BIN}" spawn testnick --agent homeagent --cwd "$TDIR" 2>&1 || true)"
if ! echo "$err" | grep -q "agent 'homeagent' not found"; then
  ok "home agent found: agent validation passes"
else
  fail "home agent found: agent validation passes" "err=$err"
fi
teardown

# -- Test 6: agent in subdirectory passes validation --------------------------

setup
mkdir -p "$TDIR/.claude/agents/sub"
printf -- '---\ndescription: nested agent\n---\nYou are a nested agent.\n' > "$TDIR/.claude/agents/sub/nestedagent.md"
err="$("${ROOST_BIN}" spawn testnick --agent nestedagent --cwd "$TDIR" 2>&1 || true)"
if ! echo "$err" | grep -q "agent 'nestedagent' not found"; then
  ok "nested cwd agent found: agent validation passes"
else
  fail "nested cwd agent found: agent validation passes" "err=$err"
fi
teardown

# -- Test 7: explicit --permission-mode is echoed verbatim -------------------
# The flag is passed through to claude as-is and shown in the spawn echo.

setup
out="$("${ROOST_BIN}" spawn testnick --permission-mode plan --cwd "$TDIR" 2>&1 || true)"
if echo "$out" | grep -q "permission-mode: plan"; then
  ok "explicit --permission-mode echoed verbatim"
else
  fail "explicit --permission-mode echoed verbatim" "out=$out"
fi
teardown

# -- Test 8: bare spawn → opus default → auto --------------------------------
# Without a flag, --model defaults to opus and the model-derived default
# kicks in (opus → auto).

setup
out="$("${ROOST_BIN}" spawn testnick --cwd "$TDIR" 2>&1 || true)"
if echo "$out" | grep -q "permission-mode: auto"; then
  ok "bare spawn → opus default → permission-mode: auto"
else
  fail "bare spawn → opus default → permission-mode: auto" "out=$out"
fi
teardown

# -- Test 9: --model sonnet (no agent) → acceptEdits -------------------------
# Non-opus models get acceptEdits via the model-derived default.

setup
out="$("${ROOST_BIN}" spawn testnick --model sonnet --cwd "$TDIR" 2>&1 || true)"
if echo "$out" | grep -q "permission-mode: acceptEdits"; then
  ok "--model sonnet → permission-mode: acceptEdits"
else
  fail "--model sonnet → permission-mode: acceptEdits" "out=$out"
fi
teardown

# -- Test 10: --model opus explicit → auto -----------------------------------
# Explicit opus also gets auto (sanity).

setup
out="$("${ROOST_BIN}" spawn testnick --model opus --cwd "$TDIR" 2>&1 || true)"
if echo "$out" | grep -q "permission-mode: auto"; then
  ok "--model opus → permission-mode: auto"
else
  fail "--model opus → permission-mode: auto" "out=$out"
fi
teardown

# -- Test 11: --agent path shows "(claude default)" --------------------------
# With --agent the wrapper passes no --permission-mode; the agent's
# frontmatter (project / user scope) is read natively by claude code. The
# echo says "(claude default)" so the operator knows the wrapper deferred.

setup
mkdir -p "$TDIR/.claude/agents"
printf -- '---\nname: opusauto\ndescription: opus auto agent\nmodel: opus\npermissionMode: auto\n---\nbody\n' > "$TDIR/.claude/agents/opusauto.md"
out="$("${ROOST_BIN}" spawn testnick --agent opusauto --cwd "$TDIR" 2>&1 || true)"
if echo "$out" | grep -qF "permission-mode: (claude default)"; then
  ok "--agent path: wrapper defers, echo shows (claude default)"
else
  fail "--agent path: wrapper defers, echo shows (claude default)" "out=$out"
fi
teardown

# -- Test 12: --agent + explicit --permission-mode → flag wins ---------------
# Explicit flag overrides the agent-defers default.

setup
mkdir -p "$TDIR/.claude/agents"
printf -- '---\nname: someagent\ndescription: x\nmodel: opus\npermissionMode: auto\n---\nbody\n' > "$TDIR/.claude/agents/someagent.md"
out="$("${ROOST_BIN}" spawn testnick --agent someagent --permission-mode plan --cwd "$TDIR" 2>&1 || true)"
if echo "$out" | grep -q "permission-mode: plan"; then
  ok "--agent + explicit --permission-mode → flag wins"
else
  fail "--agent + explicit --permission-mode → flag wins" "out=$out"
fi
teardown

# -- Test 13: no --cache-ttl → banner shows (claude default) -----------------
# Wrapper has no default; if the operator doesn't pass --cache-ttl, neither
# env var is injected and claude-code's native cache behavior applies.

setup
out="$("${ROOST_BIN}" spawn testnick --cwd "$TDIR" 2>&1 || true)"
if echo "$out" | grep -qF "cache-ttl: (claude default)"; then
  ok "no --cache-ttl → banner shows (claude default)"
else
  fail "no --cache-ttl → banner shows (claude default)" "out=$out"
fi
teardown

# -- Test 14: explicit --cache-ttl 5m echoed verbatim ------------------------

setup
out="$("${ROOST_BIN}" spawn testnick --cache-ttl 5m --cwd "$TDIR" 2>&1 || true)"
if echo "$out" | grep -q "cache-ttl: 5m"; then
  ok "explicit --cache-ttl 5m echoed verbatim"
else
  fail "explicit --cache-ttl 5m echoed verbatim" "out=$out"
fi
teardown

# -- Test 15: explicit --cache-ttl 1h echoed verbatim ------------------------

setup
out="$("${ROOST_BIN}" spawn testnick --cache-ttl 1h --cwd "$TDIR" 2>&1 || true)"
if echo "$out" | grep -q "cache-ttl: 1h"; then
  ok "explicit --cache-ttl 1h echoed verbatim"
else
  fail "explicit --cache-ttl 1h echoed verbatim" "out=$out"
fi
teardown

# -- Test 16: invalid --cache-ttl is rejected --------------------------------

setup
err="$("${ROOST_BIN}" spawn testnick --cache-ttl 30m --cwd "$TDIR" 2>&1)"; exit_code=$?
if [ "$exit_code" -ne 0 ] && echo "$err" | grep -q "must be 5m or 1h"; then
  ok "invalid --cache-ttl rejected with clear message"
else
  fail "invalid --cache-ttl rejected with clear message" "exit=$exit_code err=$err"
fi
teardown

# -- Test 17: SHELL=/bin/bash is accepted by spawn ----------------------------
# Shell resolution should not error for bash; the session may still fail for
# other reasons (no tmux, no ircd) — only the shell error is checked here.

setup
err="$(SHELL=/bin/bash "${ROOST_BIN}" spawn testnick --cwd "$TDIR" 2>&1 || true)"
if ! echo "$err" | grep -q "unsupported login shell" \
    && echo "$err" | grep -q "shell: bash"; then
  ok "SHELL=/bin/bash: shell resolution accepted, banner shows shell: bash"
else
  fail "SHELL=/bin/bash: shell resolution accepted, banner shows shell: bash" "err=$err"
fi
teardown

# -- Test 18: unsupported SHELL is rejected with clear error ------------------

setup
err="$(SHELL=/bin/tcsh "${ROOST_BIN}" spawn testnick --cwd "$TDIR" 2>&1)"; exit_code=$?
if [ "$exit_code" -ne 0 ] \
    && echo "$err" | grep -q "unsupported login shell" \
    && echo "$err" | grep -q "bash, zsh, fish (3.1+), sh, dash"; then
  ok "unsupported SHELL: exits non-zero with clear self-contained message"
else
  fail "unsupported SHELL: exits non-zero with clear self-contained message" "exit=$exit_code err=$err"
fi
teardown

# -- Test 18a: SHELL=fish is accepted, banner shows shell: fish ---------------
# Path doesn't need to exist — shell selection happens by basename before tmux
# preflight, so /usr/local/bin/fish is treated as fish regardless of presence.

setup
err="$(SHELL=/usr/local/bin/fish "${ROOST_BIN}" spawn testnick --cwd "$TDIR" 2>&1 || true)"
if ! echo "$err" | grep -q "unsupported login shell" \
    && echo "$err" | grep -q "shell: fish"; then
  ok "SHELL=fish: shell resolution accepted, banner shows shell: fish"
else
  fail "SHELL=fish: shell resolution accepted, banner shows shell: fish" "err=$err"
fi
teardown

# -- Test 18b: fish picks the fish-flavored prompt-read syntax ----------------
# inner-cmd.txt is staged to the data dir under ROOST_SPAWN_KEEP_DATA_DIR=1,
# before require_tmux/require_ircd — so the assertion works in CI where no
# IRC daemon is listening. fish must use `(string collect <$ROOST_PROMPT_FILE)`
# — `$(< file)` is bash/zsh shorthand fish doesn't grok.

setup
out="$(SHELL=/usr/local/bin/fish ROOST_SPAWN_KEEP_DATA_DIR=1 "${ROOST_BIN}" spawn testnick --cwd "$TDIR" --prompt hello 2>&1 || true)"
data_dir="$(echo "$out" | sed -n 's/.*data dir (preflight): //p' | head -1)"
inner_cmd="$(cat "$data_dir/inner-cmd.txt" 2>/dev/null)"
# Unquoted (string collect ...) is required: fish treats bare (...) inside
# double quotes as a literal, so quoting would silently disable substitution.
if [ -n "$inner_cmd" ] \
    && echo "$inner_cmd" | grep -qF -- '-- (string collect <$ROOST_PROMPT_FILE)' \
    && ! echo "$inner_cmd" | grep -qF '$(< "$ROOST_PROMPT_FILE")'; then
  ok "SHELL=fish + --prompt: inner_cmd uses unquoted string-collect, not \$(<file)"
else
  fail "SHELL=fish + --prompt: inner_cmd uses unquoted string-collect, not \$(<file)" "inner_cmd=$inner_cmd"
fi
[ -n "$data_dir" ] && rm -rf "$data_dir"
teardown

# -- Test 18c: bash uses $(cat ...) prompt-read syntax ------------------------

setup
out="$(SHELL=/bin/bash ROOST_SPAWN_KEEP_DATA_DIR=1 "${ROOST_BIN}" spawn testnick --cwd "$TDIR" --prompt hello 2>&1 || true)"
data_dir="$(echo "$out" | sed -n 's/.*data dir (preflight): //p' | head -1)"
inner_cmd="$(cat "$data_dir/inner-cmd.txt" 2>/dev/null)"
if [ -n "$inner_cmd" ] \
    && echo "$inner_cmd" | grep -qF '$(cat "$ROOST_PROMPT_FILE")' \
    && ! echo "$inner_cmd" | grep -qF '(string collect <$ROOST_PROMPT_FILE)'; then
  ok "SHELL=bash + --prompt: inner_cmd uses \$(cat ...), not string-collect"
else
  fail "SHELL=bash + --prompt: inner_cmd uses \$(cat ...), not string-collect" "inner_cmd=$inner_cmd"
fi
[ -n "$data_dir" ] && rm -rf "$data_dir"
teardown

# -- Test 18d: sh uses $(cat ...) prompt-read syntax, not $(< file) -----------

setup
out="$(SHELL=/bin/sh ROOST_SPAWN_KEEP_DATA_DIR=1 "${ROOST_BIN}" spawn testnick --cwd "$TDIR" --prompt hello 2>&1 || true)"
data_dir="$(echo "$out" | sed -n 's/.*data dir (preflight): //p' | head -1)"
inner_cmd="$(cat "$data_dir/inner-cmd.txt" 2>/dev/null)"
if [ -n "$inner_cmd" ] \
    && echo "$inner_cmd" | grep -qF '$(cat "$ROOST_PROMPT_FILE")' \
    && ! echo "$inner_cmd" | grep -qF '$(< "$ROOST_PROMPT_FILE")'; then
  ok "SHELL=sh + --prompt: inner_cmd uses \$(cat ...), not \$(<file)"
else
  fail "SHELL=sh + --prompt: inner_cmd uses \$(cat ...), not \$(<file)" "inner_cmd=$inner_cmd"
fi
[ -n "$data_dir" ] && rm -rf "$data_dir"
teardown

# -- Test 18e: dash uses $(cat ...) prompt-read syntax, not $(< file) ---------

setup
out="$(SHELL=/bin/dash ROOST_SPAWN_KEEP_DATA_DIR=1 "${ROOST_BIN}" spawn testnick --cwd "$TDIR" --prompt hello 2>&1 || true)"
data_dir="$(echo "$out" | sed -n 's/.*data dir (preflight): //p' | head -1)"
inner_cmd="$(cat "$data_dir/inner-cmd.txt" 2>/dev/null)"
if [ -n "$inner_cmd" ] \
    && echo "$inner_cmd" | grep -qF '$(cat "$ROOST_PROMPT_FILE")' \
    && ! echo "$inner_cmd" | grep -qF '$(< "$ROOST_PROMPT_FILE")'; then
  ok "SHELL=dash + --prompt: inner_cmd uses \$(cat ...), not \$(<file)"
else
  fail "SHELL=dash + --prompt: inner_cmd uses \$(cat ...), not \$(<file)" "inner_cmd=$inner_cmd"
fi
[ -n "$data_dir" ] && rm -rf "$data_dir"
teardown

# -- Test 19: --steer-compact wires PreCompact + writes session-name.txt -----
# ROOST_SPAWN_KEEP_DATA_DIR=1 keeps the data-dir alive after a preflight
# failure (tmux session not actually created), so we can inspect what the
# spawn wrote into roost-settings.json before it bailed.

setup
out="$(ROOST_SPAWN_KEEP_DATA_DIR=1 "${ROOST_BIN}" spawn testnick --cwd "$TDIR" --steer-compact 2>&1 || true)"
data_dir="$(echo "$out" | sed -n 's/.*data dir (preflight): //p' | head -1)"
if [ -n "$data_dir" ] \
    && [ -f "$data_dir/roost-settings.json" ] \
    && grep -qF '"PreCompact"' "$data_dir/roost-settings.json" \
    && grep -qF 'hook-exec roost-compact-hook' "$data_dir/roost-settings.json" \
    && [ -f "$data_dir/session-name.txt" ] \
    && [ "$(cat "$data_dir/session-name.txt")" = "roost-testnick" ]; then
  ok "--steer-compact: PreCompact entry wired + session-name.txt written"
else
  fail "--steer-compact: PreCompact entry wired + session-name.txt written" "data_dir=$data_dir settings=$(cat "$data_dir/roost-settings.json" 2>/dev/null)"
fi
[ -n "$data_dir" ] && rm -rf "$data_dir"
teardown

# -- Test 20: no --steer-compact → no PreCompact entry; session-name.txt written
# Default behavior: claude code's native auto-compact runs unmodified.
# session-name.txt is written unconditionally (PostCompact reads it too).

setup
out="$(ROOST_SPAWN_KEEP_DATA_DIR=1 "${ROOST_BIN}" spawn testnick --cwd "$TDIR" 2>&1 || true)"
data_dir="$(echo "$out" | sed -n 's/.*data dir (preflight): //p' | head -1)"
if [ -n "$data_dir" ] \
    && [ -f "$data_dir/roost-settings.json" ] \
    && ! grep -qF '"PreCompact"' "$data_dir/roost-settings.json" \
    && ! grep -qF 'hook-exec roost-compact-hook' "$data_dir/roost-settings.json" \
    && [ -f "$data_dir/session-name.txt" ]; then
  ok "no flag: PreCompact omitted from settings, session-name.txt written"
else
  fail "no flag: PreCompact omitted from settings, session-name.txt written" "data_dir=$data_dir settings=$(cat "$data_dir/roost-settings.json" 2>/dev/null)"
fi
[ -n "$data_dir" ] && rm -rf "$data_dir"
teardown

# -- Test 21: loopback IRC host stages trust file + wires --append-system-prompt-file ---
# Default channels (#roost), default host (127.0.0.1) — auto-mode classifier
# would otherwise block IRC outbound on the operator's first @-mention.
# Trust text goes through a file (not an inline flag value) to sidestep zsh
# extended_glob expanding the `#` in `#roost` to a "no matches" glob error
# before claude ever runs.

setup
out="$(ROOST_SPAWN_KEEP_DATA_DIR=1 "${ROOST_BIN}" spawn testnick --cwd "$TDIR" 2>&1 || true)"
data_dir="$(echo "$out" | sed -n 's/.*data dir (preflight): //p' | head -1)"
inner_cmd="$(cat "$data_dir/inner-cmd.txt" 2>/dev/null)"
trust_text="$(cat "$data_dir/trust-prompt.txt" 2>/dev/null)"
if [ -n "$inner_cmd" ] \
    && echo "$inner_cmd" | grep -qF -- "--append-system-prompt-file $data_dir/trust-prompt.txt" \
    && echo "$trust_text" | grep -qF 'joined channels #roost' \
    && echo "$trust_text" | grep -qF 'channel_message'; then
  ok "loopback default: inner_cmd wires --append-system-prompt-file; trust text has channels + reply hint"
else
  fail "loopback default: inner_cmd wires --append-system-prompt-file; trust text has channels + reply hint" "inner_cmd=$inner_cmd trust=$trust_text"
fi
[ -n "$data_dir" ] && rm -rf "$data_dir"
teardown

# -- Test 22: custom --channels list lands inside the trust statement ----------
# Whitespace inside the comma-separated list is stripped before rendering
# (operator may type `--channels '#a, #b'`); trust text uses _channels_for_trust
# rather than raw $channels for a clean comma-only join.

setup
out="$(ROOST_SPAWN_KEEP_DATA_DIR=1 "${ROOST_BIN}" spawn testnick --cwd "$TDIR" --channels '#scratch, #side' 2>&1 || true)"
data_dir="$(echo "$out" | sed -n 's/.*data dir (preflight): //p' | head -1)"
inner_cmd="$(cat "$data_dir/inner-cmd.txt" 2>/dev/null)"
trust_text="$(cat "$data_dir/trust-prompt.txt" 2>/dev/null)"
if [ -n "$inner_cmd" ] \
    && echo "$inner_cmd" | grep -qF -- '--append-system-prompt-file' \
    && echo "$trust_text" | grep -qF 'joined channels #scratch,#side' \
    && ! echo "$trust_text" | grep -qF '#scratch, #side'; then
  ok "custom --channels: trust statement names the channels with whitespace stripped"
else
  fail "custom --channels: trust statement names the channels with whitespace stripped" "inner_cmd=$inner_cmd trust=$trust_text"
fi
[ -n "$data_dir" ] && rm -rf "$data_dir"
teardown

# -- Test 23: non-loopback IRC host skips injection and warns ------------------
# Trust model only holds for local ergo; remote hosts get a warning + no injection
# so the operator knows why the auto-mode workaround applies.

setup
out="$(ROOST_IRC_SERVER=192.0.2.1 ROOST_SPAWN_KEEP_DATA_DIR=1 "${ROOST_BIN}" spawn testnick --cwd "$TDIR" 2>&1 || true)"
data_dir="$(echo "$out" | sed -n 's/.*data dir (preflight): //p' | head -1)"
inner_cmd="$(cat "$data_dir/inner-cmd.txt" 2>/dev/null)"
if [ -n "$inner_cmd" ] \
    && ! echo "$inner_cmd" | grep -qF -- '--append-system-prompt-file' \
    && [ ! -f "$data_dir/trust-prompt.txt" ] \
    && echo "$out" | grep -q "is not loopback" \
    && echo "$out" | grep -q "skipping auto-mode IRC trust injection"; then
  ok "non-loopback host: no flag, no trust file, warning printed"
else
  fail "non-loopback host: no flag, no trust file, warning printed" "out=$out inner_cmd=$inner_cmd"
fi
[ -n "$data_dir" ] && rm -rf "$data_dir"
teardown

# -- Test 24: empty --channels skips injection silently ------------------------
# No channels = nothing to authorize; skip without scaring the operator.

setup
out="$(ROOST_SPAWN_KEEP_DATA_DIR=1 "${ROOST_BIN}" spawn testnick --cwd "$TDIR" --channels '' 2>&1 || true)"
data_dir="$(echo "$out" | sed -n 's/.*data dir (preflight): //p' | head -1)"
inner_cmd="$(cat "$data_dir/inner-cmd.txt" 2>/dev/null)"
if [ -n "$inner_cmd" ] \
    && ! echo "$inner_cmd" | grep -qF -- '--append-system-prompt-file' \
    && [ ! -f "$data_dir/trust-prompt.txt" ] \
    && ! echo "$out" | grep -q "is not loopback"; then
  ok "empty --channels on loopback: no flag, no trust file, no warning"
else
  fail "empty --channels on loopback: no flag, no trust file, no warning" "out=$out inner_cmd=$inner_cmd"
fi
[ -n "$data_dir" ] && rm -rf "$data_dir"
teardown

# -- Test 25: --agent path also gets the trust injection -----------------------
# Trust applies regardless of permission-mode source; agent frontmatter
# permissionMode:auto would block IRC just like the --model auto path does.

setup
mkdir -p "$TDIR/.claude/agents"
printf -- '---\nname: opusauto\ndescription: opus auto agent\nmodel: opus\npermissionMode: auto\n---\nbody\n' > "$TDIR/.claude/agents/opusauto.md"
out="$(ROOST_SPAWN_KEEP_DATA_DIR=1 "${ROOST_BIN}" spawn testnick --agent opusauto --cwd "$TDIR" 2>&1 || true)"
data_dir="$(echo "$out" | sed -n 's/.*data dir (preflight): //p' | head -1)"
inner_cmd="$(cat "$data_dir/inner-cmd.txt" 2>/dev/null)"
trust_text="$(cat "$data_dir/trust-prompt.txt" 2>/dev/null)"
if [ -n "$inner_cmd" ] \
    && echo "$inner_cmd" | grep -qF -- '--append-system-prompt-file' \
    && echo "$trust_text" | grep -qF 'joined channels #roost'; then
  ok "--agent path: trust statement still injected"
else
  fail "--agent path: trust statement still injected" "inner_cmd=$inner_cmd trust=$trust_text"
fi
[ -n "$data_dir" ] && rm -rf "$data_dir"
teardown

# -- Test 26: loopback host injects permissions.allow into roost-settings.json --
# Non-perm-irc non-automode sessions would otherwise hit an in-pane permission
# dialog for every roost-irc MCP call. Gated on the same loopback check as
# trust injection so remote ergo doesn't get blanket auto-allow.

setup
out="$(ROOST_SPAWN_KEEP_DATA_DIR=1 "${ROOST_BIN}" spawn testnick --cwd "$TDIR" 2>&1 || true)"
data_dir="$(echo "$out" | sed -n 's/.*data dir (preflight): //p' | head -1)"
if [ -n "$data_dir" ] \
    && [ -f "$data_dir/roost-settings.json" ] \
    && grep -qF '"mcp__plugin_roost_roost-irc__*"' "$data_dir/roost-settings.json" \
    && grep -qF '"mcp__roost-irc__*"' "$data_dir/roost-settings.json" \
    && grep -qF '"permissions"' "$data_dir/roost-settings.json"; then
  ok "loopback: roost-settings.json has permissions.allow with both roost-irc wildcards"
else
  fail "loopback: roost-settings.json has permissions.allow with both roost-irc wildcards" "data_dir=$data_dir settings=$(cat "$data_dir/roost-settings.json" 2>/dev/null)"
fi
[ -n "$data_dir" ] && rm -rf "$data_dir"
teardown

# -- Test 27: non-loopback host omits permissions block from roost-settings.json -
# Remote ergo is outside the trusted single-user local environment; no auto-allow.

setup
out="$(ROOST_IRC_SERVER=192.0.2.1 ROOST_SPAWN_KEEP_DATA_DIR=1 "${ROOST_BIN}" spawn testnick --cwd "$TDIR" 2>&1 || true)"
data_dir="$(echo "$out" | sed -n 's/.*data dir (preflight): //p' | head -1)"
if [ -n "$data_dir" ] \
    && [ -f "$data_dir/roost-settings.json" ] \
    && ! grep -qF '"permissions"' "$data_dir/roost-settings.json"; then
  ok "non-loopback: roost-settings.json has no permissions block"
else
  fail "non-loopback: roost-settings.json has no permissions block" "data_dir=$data_dir settings=$(cat "$data_dir/roost-settings.json" 2>/dev/null)"
fi
[ -n "$data_dir" ] && rm -rf "$data_dir"
teardown

# -- Test 28: --perm-irc + opus default (auto) → bash PreToolUse hook skipped --
# Auto mode grants classified bash shapes outright, so wiring the relay would
# only produce spurious operator prompts for things claude never blocked on.

setup
out="$(ROOST_SPAWN_KEEP_DATA_DIR=1 "${ROOST_BIN}" spawn testnick --perm-irc --perm-target opnick --cwd "$TDIR" 2>&1 || true)"
data_dir="$(echo "$out" | sed -n 's/.*data dir (preflight): //p' | head -1)"
if [ -n "$data_dir" ] \
    && [ -f "$data_dir/roost-settings.json" ] \
    && grep -qF '"PermissionRequest"' "$data_dir/roost-settings.json" \
    && ! grep -qF '"matcher":"Bash"' "$data_dir/roost-settings.json" \
    && ! grep -qF 'hook-exec irc-pretooluse-prompt' "$data_dir/roost-settings.json"; then
  ok "--perm-irc + opus default (auto): bash PreToolUse hook skipped"
else
  fail "--perm-irc + opus default (auto): bash PreToolUse hook skipped" "data_dir=$data_dir settings=$(cat "$data_dir/roost-settings.json" 2>/dev/null)"
fi
[ -n "$data_dir" ] && rm -rf "$data_dir"
teardown

# -- Test 29: --perm-irc + --model sonnet (acceptEdits) → bash hook still wired --
# acceptEdits still blocks on bash, so the relay is needed — parity unaffected.

setup
out="$(ROOST_SPAWN_KEEP_DATA_DIR=1 "${ROOST_BIN}" spawn testnick --model sonnet --perm-irc --perm-target opnick --cwd "$TDIR" 2>&1 || true)"
data_dir="$(echo "$out" | sed -n 's/.*data dir (preflight): //p' | head -1)"
if [ -n "$data_dir" ] \
    && [ -f "$data_dir/roost-settings.json" ] \
    && grep -qF '"matcher":"Bash"' "$data_dir/roost-settings.json" \
    && grep -qF 'hook-exec irc-pretooluse-prompt' "$data_dir/roost-settings.json"; then
  ok "--perm-irc + sonnet (acceptEdits): bash PreToolUse hook still wired"
else
  fail "--perm-irc + sonnet (acceptEdits): bash PreToolUse hook still wired" "data_dir=$data_dir settings=$(cat "$data_dir/roost-settings.json" 2>/dev/null)"
fi
[ -n "$data_dir" ] && rm -rf "$data_dir"
teardown

# -- Test 30: --perm-irc + explicit --permission-mode bypassPermissions → skipped -
# bypassPermissions skips all permission checks by design — same no-block
# reasoning as auto, just via an explicit flag instead of the model default.

setup
out="$(ROOST_SPAWN_KEEP_DATA_DIR=1 "${ROOST_BIN}" spawn testnick --permission-mode bypassPermissions --perm-irc --perm-target opnick --cwd "$TDIR" 2>&1 || true)"
data_dir="$(echo "$out" | sed -n 's/.*data dir (preflight): //p' | head -1)"
if [ -n "$data_dir" ] \
    && [ -f "$data_dir/roost-settings.json" ] \
    && ! grep -qF '"matcher":"Bash"' "$data_dir/roost-settings.json"; then
  ok "--perm-irc + explicit bypassPermissions: bash PreToolUse hook skipped"
else
  fail "--perm-irc + explicit bypassPermissions: bash PreToolUse hook skipped" "data_dir=$data_dir settings=$(cat "$data_dir/roost-settings.json" 2>/dev/null)"
fi
[ -n "$data_dir" ] && rm -rf "$data_dir"
teardown

# -- Test 31: --agent frontmatter permissionMode:auto + --perm-irc → skipped ---
# The wrapper passes no --permission-mode on the --agent path, so the only way
# to know the resolved mode is a local peek at the frontmatter it defers to.

setup
mkdir -p "$TDIR/.claude/agents"
printf -- '---\nname: opusauto\ndescription: opus auto agent\nmodel: opus\npermissionMode: auto\n---\nbody\n' > "$TDIR/.claude/agents/opusauto.md"
out="$(ROOST_SPAWN_KEEP_DATA_DIR=1 "${ROOST_BIN}" spawn testnick --agent opusauto --perm-irc --perm-target opnick --cwd "$TDIR" 2>&1 || true)"
data_dir="$(echo "$out" | sed -n 's/.*data dir (preflight): //p' | head -1)"
if [ -n "$data_dir" ] \
    && [ -f "$data_dir/roost-settings.json" ] \
    && ! grep -qF '"matcher":"Bash"' "$data_dir/roost-settings.json"; then
  ok "--agent frontmatter permissionMode:auto + --perm-irc: bash hook skipped"
else
  fail "--agent frontmatter permissionMode:auto + --perm-irc: bash hook skipped" "data_dir=$data_dir settings=$(cat "$data_dir/roost-settings.json" 2>/dev/null)"
fi
[ -n "$data_dir" ] && rm -rf "$data_dir"
teardown

# -- Test 32: --agent frontmatter permissionMode:acceptEdits + --perm-irc → wired -

setup
mkdir -p "$TDIR/.claude/agents"
printf -- '---\nname: sonnetedits\ndescription: accept-edits agent\nmodel: sonnet\npermissionMode: acceptEdits\n---\nbody\n' > "$TDIR/.claude/agents/sonnetedits.md"
out="$(ROOST_SPAWN_KEEP_DATA_DIR=1 "${ROOST_BIN}" spawn testnick --agent sonnetedits --perm-irc --perm-target opnick --cwd "$TDIR" 2>&1 || true)"
data_dir="$(echo "$out" | sed -n 's/.*data dir (preflight): //p' | head -1)"
if [ -n "$data_dir" ] \
    && [ -f "$data_dir/roost-settings.json" ] \
    && grep -qF '"matcher":"Bash"' "$data_dir/roost-settings.json"; then
  ok "--agent frontmatter permissionMode:acceptEdits + --perm-irc: bash hook wired"
else
  fail "--agent frontmatter permissionMode:acceptEdits + --perm-irc: bash hook wired" "data_dir=$data_dir settings=$(cat "$data_dir/roost-settings.json" 2>/dev/null)"
fi
[ -n "$data_dir" ] && rm -rf "$data_dir"
teardown

# -- Test 33: explicit --permission-mode wins over a non-skip agent frontmatter --
# Agent declares acceptEdits (would wire); explicit auto flag overrides it and
# should skip — proves the gate keys off the resolved var, not the frontmatter
# peek, whenever an explicit flag is present.

setup
mkdir -p "$TDIR/.claude/agents"
printf -- '---\nname: sonnetedits2\ndescription: accept-edits agent\nmodel: sonnet\npermissionMode: acceptEdits\n---\nbody\n' > "$TDIR/.claude/agents/sonnetedits2.md"
out="$(ROOST_SPAWN_KEEP_DATA_DIR=1 "${ROOST_BIN}" spawn testnick --agent sonnetedits2 --permission-mode auto --perm-irc --perm-target opnick --cwd "$TDIR" 2>&1 || true)"
data_dir="$(echo "$out" | sed -n 's/.*data dir (preflight): //p' | head -1)"
if [ -n "$data_dir" ] \
    && [ -f "$data_dir/roost-settings.json" ] \
    && ! grep -qF '"matcher":"Bash"' "$data_dir/roost-settings.json"; then
  ok "explicit --permission-mode auto overrides non-skip agent frontmatter: bash hook skipped"
else
  fail "explicit --permission-mode auto overrides non-skip agent frontmatter: bash hook skipped" "data_dir=$data_dir settings=$(cat "$data_dir/roost-settings.json" 2>/dev/null)"
fi
[ -n "$data_dir" ] && rm -rf "$data_dir"
teardown

# -- Test 34: --agent with no declared permissionMode + --perm-irc → wired -----
# Unknown resolved mode is not a skip-set member — conservative default keeps
# the hook wired rather than risk silently dropping a real blocking relay.

setup
mkdir -p "$TDIR/.claude/agents"
printf -- '---\nname: noperm\ndescription: agent with no permissionMode\nmodel: sonnet\n---\nbody\n' > "$TDIR/.claude/agents/noperm.md"
out="$(ROOST_SPAWN_KEEP_DATA_DIR=1 "${ROOST_BIN}" spawn testnick --agent noperm --perm-irc --perm-target opnick --cwd "$TDIR" 2>&1 || true)"
data_dir="$(echo "$out" | sed -n 's/.*data dir (preflight): //p' | head -1)"
if [ -n "$data_dir" ] \
    && [ -f "$data_dir/roost-settings.json" ] \
    && grep -qF '"matcher":"Bash"' "$data_dir/roost-settings.json"; then
  ok "--agent with no permissionMode + --perm-irc: bash hook still wired (conservative default)"
else
  fail "--agent with no permissionMode + --perm-irc: bash hook still wired (conservative default)" "data_dir=$data_dir settings=$(cat "$data_dir/roost-settings.json" 2>/dev/null)"
fi
[ -n "$data_dir" ] && rm -rf "$data_dir"
teardown

# -- Test 35: --permission-mode dontAsk + --perm-irc → wired (unverified mode) --
# dontAsk isn't confirmed to skip bash prompts (unlike auto/bypassPermissions),
# so it's deliberately left out of the skip-set — conservative default wins.

setup
out="$(ROOST_SPAWN_KEEP_DATA_DIR=1 "${ROOST_BIN}" spawn testnick --permission-mode dontAsk --perm-irc --perm-target opnick --cwd "$TDIR" 2>&1 || true)"
data_dir="$(echo "$out" | sed -n 's/.*data dir (preflight): //p' | head -1)"
if [ -n "$data_dir" ] \
    && [ -f "$data_dir/roost-settings.json" ] \
    && grep -qF '"matcher":"Bash"' "$data_dir/roost-settings.json"; then
  ok "--perm-irc + explicit dontAsk: bash PreToolUse hook still wired (unverified mode, not in skip-set)"
else
  fail "--perm-irc + explicit dontAsk: bash PreToolUse hook still wired (unverified mode, not in skip-set)" "data_dir=$data_dir settings=$(cat "$data_dir/roost-settings.json" 2>/dev/null)"
fi
[ -n "$data_dir" ] && rm -rf "$data_dir"
teardown

# -- Test 36: auto mode skips the bash hook but leaves AskUserQuestion wired ---
# Scope check: the over-fire fix is bash-specific. --ask-irc's AskUserQuestion
# routing has no auto-mode over-fire evidence behind it, so it stays wired
# regardless of resolved permission mode.

setup
out="$(ROOST_SPAWN_KEEP_DATA_DIR=1 "${ROOST_BIN}" spawn testnick --perm-irc --perm-target opnick --ask-irc '#chan' --cwd "$TDIR" 2>&1 || true)"
data_dir="$(echo "$out" | sed -n 's/.*data dir (preflight): //p' | head -1)"
if [ -n "$data_dir" ] \
    && [ -f "$data_dir/roost-settings.json" ] \
    && ! grep -qF '"matcher":"Bash"' "$data_dir/roost-settings.json" \
    && grep -qF '"matcher":"AskUserQuestion"' "$data_dir/roost-settings.json" \
    && grep -qF 'hook-exec irc-ask-question' "$data_dir/roost-settings.json"; then
  ok "auto mode skips bash hook but leaves AskUserQuestion wired (scope check)"
else
  fail "auto mode skips bash hook but leaves AskUserQuestion wired (scope check)" "data_dir=$data_dir settings=$(cat "$data_dir/roost-settings.json" 2>/dev/null)"
fi
[ -n "$data_dir" ] && rm -rf "$data_dir"
teardown

# -- Test 37: --agent frontmatter with CRLF line endings + permissionMode:auto --
# CRLF delimiter/value lines carry a trailing \r that a naive awk match would
# miss entirely (silently falling through to the conservative wired default
# instead of correctly recognizing auto). Confirms the \r-stripping in the
# frontmatter peek makes the CRLF file parse identically to its LF equivalent.

setup
mkdir -p "$TDIR/.claude/agents"
printf -- '---\r\nname: crlfauto\r\ndescription: crlf agent\r\nmodel: opus\r\npermissionMode: auto\r\n---\r\nbody\r\n' > "$TDIR/.claude/agents/crlfauto.md"
out="$(ROOST_SPAWN_KEEP_DATA_DIR=1 "${ROOST_BIN}" spawn testnick --agent crlfauto --perm-irc --perm-target opnick --cwd "$TDIR" 2>&1 || true)"
data_dir="$(echo "$out" | sed -n 's/.*data dir (preflight): //p' | head -1)"
if [ -n "$data_dir" ] \
    && [ -f "$data_dir/roost-settings.json" ] \
    && ! grep -qF '"matcher":"Bash"' "$data_dir/roost-settings.json"; then
  ok "--agent CRLF frontmatter permissionMode:auto + --perm-irc: bash hook skipped"
else
  fail "--agent CRLF frontmatter permissionMode:auto + --perm-irc: bash hook skipped" "data_dir=$data_dir settings=$(cat "$data_dir/roost-settings.json" 2>/dev/null)"
fi
[ -n "$data_dir" ] && rm -rf "$data_dir"
teardown

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ]
