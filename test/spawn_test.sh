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
    && echo "$err" | grep -q ".claude/agents/definitelynotanagent.md"; then
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
cwd_path="$TDIR/.claude/agents/missing.md"
home_path="$HOME/.claude/agents/missing.md"
if echo "$err" | grep -qF "$cwd_path" && echo "$err" | grep -qF "$home_path"; then
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

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ]
