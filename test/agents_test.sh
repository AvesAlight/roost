#!/usr/bin/env bash
# Tests for `roost agents` — the self-updating agent roster. Plain bash, no bats.
# Run: bash test/agents_test.sh
set -uo pipefail

ROOST_BIN="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )/bin/roost"
REPO="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"
PASS=0
FAIL=0
TDIR=""

ok()   { echo "PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "FAIL: $1 ${2:+— $2}"; FAIL=$((FAIL+1)); }

setup() {
  TDIR="$(mktemp -d /tmp/roost-agents-test-XXXXXXXX)"
  trap 'rm -rf "$TDIR"' EXIT
}

teardown() {
  rm -rf "$TDIR"
  tmux kill-session -t "roost-testnick" 2>/dev/null || true
  trap - EXIT
  TDIR=""
}

# -- Test 1: shipped section lists the plugin-tree agents with descriptions ----
# ROOST_DIR resolves to this repo, so the shipped roster reads from ./agents.
# A newly added agent flows in here automatically — that's the whole mechanism.

setup
mkdir -p "$TDIR/empty"
out="$(HOME="$TDIR/fakehome" "${ROOST_BIN}" agents --cwd "$TDIR/empty" 2>&1)"
if echo "$out" | grep -q "Shipped with roost" \
    && echo "$out" | grep -q "lead-pm" \
    && echo "$out" | grep -q "associate-pm" \
    && echo "$out" | grep -q "Lead project manager"; then
  ok "shipped section lists lead-pm + associate-pm with descriptions"
else
  fail "shipped section lists lead-pm + associate-pm with descriptions" "out=$out"
fi
teardown

# -- Test 2: nothing installed → spawnable section says so + points at init -----

setup
mkdir -p "$TDIR/empty"
out="$(HOME="$TDIR/fakehome" "${ROOST_BIN}" agents --cwd "$TDIR/empty" 2>&1)"
if echo "$out" | grep -q "Spawnable here" \
    && echo "$out" | grep -q "none installed" \
    && echo "$out" | grep -q "roost init"; then
  ok "nothing installed: spawnable section empty, points at roost init"
else
  fail "nothing installed: spawnable section empty, points at roost init" "out=$out"
fi
teardown

# -- Test 3: partial install → reconciliation flags the missing shipped agent --
# Only lead-pm installed. associate-pm ships but isn't here, so it's flagged
# with the exact install command.

setup
mkdir -p "$TDIR/proj/.claude/agents"
cp "$REPO/agents/lead-pm.md" "$TDIR/proj/.claude/agents/"
out="$(HOME="$TDIR/fakehome" "${ROOST_BIN}" agents --cwd "$TDIR/proj" 2>&1)"
if echo "$out" | grep -qE 'lead-pm[[:space:]]+\(project\)' \
    && echo "$out" | grep -q "Shipped but not installed here: associate-pm" \
    && echo "$out" | grep -q "roost init --force-agents"; then
  ok "partial install: lead-pm spawnable (project), associate-pm flagged for install"
else
  fail "partial install: lead-pm spawnable (project), associate-pm flagged for install" "out=$out"
fi
teardown

# -- Test 4: project shadows user; user-only agent tagged (user) ---------------
# Mirrors the spawn resolver: project .claude/agents wins over ~/.claude/agents
# by basename. lead-pm lives in both → shown once as (project); associate-pm
# only in user scope → (user). Both installed → no reconciliation line.

setup
mkdir -p "$TDIR/proj/.claude/agents" "$TDIR/fakehome/.claude/agents"
cp "$REPO/agents/lead-pm.md" "$TDIR/proj/.claude/agents/"
cp "$REPO/agents/lead-pm.md" "$TDIR/fakehome/.claude/agents/"
cp "$REPO/agents/associate-pm.md" "$TDIR/fakehome/.claude/agents/"
out="$(HOME="$TDIR/fakehome" "${ROOST_BIN}" agents --cwd "$TDIR/proj" 2>&1)"
if echo "$out" | grep -qE 'lead-pm[[:space:]]+\(project\)' \
    && echo "$out" | grep -qE 'associate-pm[[:space:]]+\(user\)' \
    && ! echo "$out" | grep -qE 'lead-pm[[:space:]]+\(user\)' \
    && ! echo "$out" | grep -q "Shipped but not installed here"; then
  ok "project shadows user; user-only agent tagged (user); no reconciliation"
else
  fail "project shadows user; user-only agent tagged (user); no reconciliation" "out=$out"
fi
teardown

# -- Test 5: `roost agents` and the spawn not-found error agree on the set -----
# The consistency invariant: both surfaces list exactly what --agent resolves.

setup
mkdir -p "$TDIR/proj/.claude/agents"
cp "$REPO/agents/lead-pm.md" "$TDIR/proj/.claude/agents/"
cp "$REPO/agents/associate-pm.md" "$TDIR/proj/.claude/agents/"
agents_out="$(HOME="$TDIR/fakehome" "${ROOST_BIN}" agents --cwd "$TDIR/proj" 2>&1)"
spawn_err="$(HOME="$TDIR/fakehome" "${ROOST_BIN}" spawn testnick --agent nope --cwd "$TDIR/proj" 2>&1)"
avail="$(echo "$spawn_err" | sed -n 's/^available agents: //p')"
if echo "$avail" | grep -q "lead-pm" \
    && echo "$avail" | grep -q "associate-pm" \
    && echo "$agents_out" | grep -qE 'lead-pm[[:space:]]+\(project\)' \
    && echo "$agents_out" | grep -qE 'associate-pm[[:space:]]+\(project\)'; then
  ok "consistency: not-found 'available agents' matches 'roost agents' spawnable set"
else
  fail "consistency: not-found 'available agents' matches 'roost agents' spawnable set" "avail=$avail agents_out=$agents_out"
fi
teardown

# -- Test 6: unknown option exits non-zero with a clear message ----------------

setup
err="$("${ROOST_BIN}" agents --bogus 2>&1)"; exit_code=$?
if [ "$exit_code" -ne 0 ] && echo "$err" | grep -q "unknown option"; then
  ok "unknown option: exits non-zero with clear message"
else
  fail "unknown option: exits non-zero with clear message" "exit=$exit_code err=$err"
fi
teardown

# -- Test 7: --help prints the agents usage -----------------------------------

out="$("${ROOST_BIN}" agents --help 2>&1)"
if echo "$out" | grep -q "Usage: roost agents"; then
  ok "--help prints agents usage"
else
  fail "--help prints agents usage" "out=$out"
fi

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ]
