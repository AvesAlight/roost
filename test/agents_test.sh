#!/usr/bin/env bash
# Tests for `roost agents` — the self-updating agent roster. Plain bash, no bats.
# Default = clean installed/spawnable list; --all = shipped roster + reconciliation.
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

# -- Test 1: default lists only spawnable — no roster, reconciliation, or desc --
# The clean "agents to hire" list. lead-pm is installed; associate-pm ships but
# isn't installed — the default must NOT mention it or the shipped roster.

setup
mkdir -p "$TDIR/proj/.claude/agents"
cp "$REPO/agents/lead-pm.md" "$TDIR/proj/.claude/agents/"
out="$(HOME="$TDIR/fakehome" "${ROOST_BIN}" agents --cwd "$TDIR/proj" 2>&1)"
if echo "$out" | grep -q "Spawnable here" \
    && echo "$out" | grep -qE 'lead-pm[[:space:]]+\(project\)' \
    && ! echo "$out" | grep -q "Shipped with roost" \
    && ! echo "$out" | grep -q "Shipped but not installed" \
    && ! echo "$out" | grep -q "associate-pm" \
    && ! echo "$out" | grep -q "Lead project manager"; then
  ok "default: only spawnable list, no roster/reconciliation/descriptions"
else
  fail "default: only spawnable list, no roster/reconciliation/descriptions" "out=$out"
fi
teardown

# -- Test 2: --all shows shipped roster (with descriptions) + reconciliation ----

setup
mkdir -p "$TDIR/proj/.claude/agents"
cp "$REPO/agents/lead-pm.md" "$TDIR/proj/.claude/agents/"
out="$(HOME="$TDIR/fakehome" "${ROOST_BIN}" agents --all --cwd "$TDIR/proj" 2>&1)"
if echo "$out" | grep -q "Shipped with roost" \
    && echo "$out" | grep -q "associate-pm" \
    && echo "$out" | grep -q "Lead project manager" \
    && echo "$out" | grep -qE 'lead-pm[[:space:]]+\(project\)' \
    && echo "$out" | grep -q "Shipped but not installed here: associate-pm" \
    && echo "$out" | grep -q "roost init --force-agents"; then
  ok "--all: shipped roster with descriptions + reconciliation for the missing one"
else
  fail "--all: shipped roster with descriptions + reconciliation for the missing one" "out=$out"
fi
teardown

# -- Test 3: default with nothing installed → empty-state pointer --------------
# A bare empty list reads as "broken", so the empty case (only) carries a
# one-line pointer to roost init / roost agents --all.

setup
mkdir -p "$TDIR/empty"
out="$(HOME="$TDIR/fakehome" "${ROOST_BIN}" agents --cwd "$TDIR/empty" 2>&1)"
if echo "$out" | grep -q "none installed" \
    && echo "$out" | grep -q "roost init" \
    && echo "$out" | grep -q "roost agents --all" \
    && ! echo "$out" | grep -q "Shipped with roost"; then
  ok "default, none installed: empty-state points at roost init / roost agents --all"
else
  fail "default, none installed: empty-state points at roost init / roost agents --all" "out=$out"
fi
teardown

# -- Test 4: --all with nothing installed → roster shown, empty-state refs above -

setup
mkdir -p "$TDIR/empty"
out="$(HOME="$TDIR/fakehome" "${ROOST_BIN}" agents --all --cwd "$TDIR/empty" 2>&1)"
if echo "$out" | grep -q "Shipped with roost" \
    && echo "$out" | grep -q "lead-pm" \
    && echo "$out" | grep -q "none installed" \
    && echo "$out" | grep -q "shipped agents above"; then
  ok "--all, none installed: roster shown, empty-state references the roster above"
else
  fail "--all, none installed: roster shown, empty-state references the roster above" "out=$out"
fi
teardown

# -- Test 5: default — project shadows user; user-only agent tagged (user) ------
# Mirrors the spawn resolver: project .claude/agents wins over ~/.claude/agents
# by basename. lead-pm lives in both → shown once as (project); associate-pm
# only in user scope → (user).

setup
mkdir -p "$TDIR/proj/.claude/agents" "$TDIR/fakehome/.claude/agents"
cp "$REPO/agents/lead-pm.md" "$TDIR/proj/.claude/agents/"
cp "$REPO/agents/lead-pm.md" "$TDIR/fakehome/.claude/agents/"
cp "$REPO/agents/associate-pm.md" "$TDIR/fakehome/.claude/agents/"
out="$(HOME="$TDIR/fakehome" "${ROOST_BIN}" agents --cwd "$TDIR/proj" 2>&1)"
if echo "$out" | grep -qE 'lead-pm[[:space:]]+\(project\)' \
    && echo "$out" | grep -qE 'associate-pm[[:space:]]+\(user\)' \
    && ! echo "$out" | grep -qE 'lead-pm[[:space:]]+\(user\)'; then
  ok "default: project shadows user; user-only agent tagged (user)"
else
  fail "default: project shadows user; user-only agent tagged (user)" "out=$out"
fi
teardown

# -- Test 6: default spawnable set == spawn not-found 'available agents' --------
# The consistency invariant: both read _resolvable_agents, so they can't drift.

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
  ok "consistency: not-found 'available agents' matches default spawnable set"
else
  fail "consistency: not-found 'available agents' matches default spawnable set" "avail=$avail agents_out=$agents_out"
fi
teardown

# -- Test 7: unknown option exits non-zero with a clear message ----------------

setup
err="$("${ROOST_BIN}" agents --bogus 2>&1)"; exit_code=$?
if [ "$exit_code" -ne 0 ] && echo "$err" | grep -q "unknown option"; then
  ok "unknown option: exits non-zero with clear message"
else
  fail "unknown option: exits non-zero with clear message" "exit=$exit_code err=$err"
fi
teardown

# -- Test 8: --help prints the agents usage (documenting --all) ----------------

out="$("${ROOST_BIN}" agents --help 2>&1)"
if echo "$out" | grep -q "Usage: roost agents" && echo "$out" | grep -q -- "--all"; then
  ok "--help prints agents usage documenting --all"
else
  fail "--help prints agents usage documenting --all" "out=$out"
fi

# -- Test 9: _agent_description folds YAML block scalars into one clean line ---
# `_shipped_agents` (backing `roost agents --all`) only reads from the real
# ${ROOST_DIR}/agents tree, so a folded-description regression can't be
# exercised through the CLI without editing shipped agent files. bin/roost
# guards its dispatch table behind `[[ "${BASH_SOURCE[0]}" == "${0}" ]]`,
# so sourcing it in an isolated `bash -c` subprocess to call the helper
# directly is safe — no dispatch runs, nothing leaks into this test's shell.

setup
printf -- '---\ndescription: >\n  A folded description\n  spanning multiple\n  source lines.\n---\nbody\n' > "$TDIR/folded.md"
printf -- '---\ndescription: |\n  Line one.\n  Line two.\n---\nbody\n' > "$TDIR/literal.md"
printf -- '---\ndescription: single line desc\n---\nbody\n' > "$TDIR/single.md"
printf -- '---\nname: nodesc\n---\nbody\n' > "$TDIR/nodesc.md"
folded_out="$(bash -c 'source "'"${ROOST_BIN}"'"; _agent_description "$1"' _ "$TDIR/folded.md")"
literal_out="$(bash -c 'source "'"${ROOST_BIN}"'"; _agent_description "$1"' _ "$TDIR/literal.md")"
single_out="$(bash -c 'source "'"${ROOST_BIN}"'"; _agent_description "$1"' _ "$TDIR/single.md")"
nodesc_out="$(bash -c 'source "'"${ROOST_BIN}"'"; _agent_description "$1"' _ "$TDIR/nodesc.md")"
if [ "$folded_out" = "A folded description spanning multiple source lines." ] \
    && [ "$literal_out" = "Line one. Line two." ] \
    && [ "$single_out" = "single line desc" ] \
    && [ "$nodesc_out" = "" ]; then
  ok "_agent_description: folds block scalars, leaves single-line/no-description behavior unchanged"
else
  fail "_agent_description: folds block scalars, leaves single-line/no-description behavior unchanged" \
    "folded=[$folded_out] literal=[$literal_out] single=[$single_out] nodesc=[$nodesc_out]"
fi
teardown

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ]
