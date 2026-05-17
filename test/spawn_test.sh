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
if [ "$exit_code" -ne 0 ] && echo "$err" | grep -q "unsupported login shell"; then
  ok "unsupported SHELL: exits non-zero with clear message"
else
  fail "unsupported SHELL: exits non-zero with clear message" "exit=$exit_code err=$err"
fi
teardown

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ]
