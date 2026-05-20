#!/usr/bin/env bash
# Tests for bin/roost-compact-hook (PreCompact intercept).
# Plain bash — covers the two branches: auto (block + inject the baked-in
# DIRECTIVE constant), manual (pass through + SIGUSR1). Uses a mock tmux on
# PATH so we don't need a real pane.
# Run: bash test/compact-hook_test.sh
set -uo pipefail

HOOK="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )/bin/roost-compact-hook"
PASS=0
FAIL=0

ok()   { echo "PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "FAIL: $1 ${2:+— $2}"; FAIL=$((FAIL+1)); }

# Mock tmux: log the invocation + stdin (for load-buffer -) into a per-test
# trace file. has-session returns 0 so the hook treats the session as live.
# All other subcommands no-op successfully.
make_mock_tmux() {
  local mockdir="$1"
  local tracefile="$2"
  mkdir -p "$mockdir"
  cat > "$mockdir/tmux" <<EOF
#!/usr/bin/env bash
# Snapshot stdin (only relevant for load-buffer -) alongside the argv.
input=""
if [ ! -t 0 ]; then
  input="\$(cat 2>/dev/null || true)"
fi
printf 'tmux %s | stdin=%q\n' "\$*" "\$input" >> "$tracefile"
case "\$1" in
  has-session) exit 0 ;;
  *) exit 0 ;;
esac
EOF
  chmod +x "$mockdir/tmux"
}

setup_tmpdir() {
  TDIR="$(mktemp -d /tmp/roost-compact-hook-test-XXXXXXXX)"
  TRACE="$TDIR/tmux-trace.log"
  MOCK="$TDIR/mock-bin"
  make_mock_tmux "$MOCK" "$TRACE"
  trap 'rm -rf "$TDIR"' EXIT
}

teardown_tmpdir() {
  rm -rf "$TDIR"
  trap - EXIT
}

# -- Test 1: trigger=auto → block + injected ----------------------------------

setup_tmpdir
input='{"session_id":"s","transcript_path":"/tmp/t.jsonl","cwd":"/","hook_event_name":"PreCompact","trigger":"auto","custom_instructions":null}'
out="$(printf '%s' "$input" | env -i PATH="$MOCK:$PATH" ROOST_DATA_DIR="$TDIR" ROOST_IRC_NICK="testnick" "$HOOK" 2>"$TDIR/err")"
exit_code=$?

# Hook must return decision:block on stdout, exit 0.
if [ "$exit_code" -eq 0 ] && echo "$out" | grep -q '"decision":"block"'; then
  ok "auto: stdout carries decision:block"
else
  fail "auto: stdout carries decision:block" "exit=$exit_code out=$out err=$(cat "$TDIR/err" 2>/dev/null)"
fi

# Backgrounded subshell sleeps 0.15s before invoking tmux. Wait a touch
# longer than that, then assert tmux was called with load-buffer + paste +
# /compact + the baked-in directive's leading "retain:" marker.
sleep 0.5
if [ -s "$TRACE" ] \
    && grep -q "has-session" "$TRACE" \
    && grep -q "load-buffer" "$TRACE" \
    && grep -q "paste-buffer" "$TRACE" \
    && grep -q "send-keys.*Enter" "$TRACE" \
    && grep -qF '/compact' "$TRACE" \
    && grep -qF 'retain:' "$TRACE"; then
  ok "auto: tmux injection chain ran with /compact + baked-in directive"
else
  fail "auto: tmux injection chain ran with /compact + baked-in directive" "trace=$(cat "$TRACE" 2>/dev/null)"
fi
teardown_tmpdir

# -- Test 2: trigger=manual → pass through, no injection -----------------------

setup_tmpdir
input='{"session_id":"s","trigger":"manual","custom_instructions":"retain X"}'
out="$(printf '%s' "$input" | env -i PATH="$MOCK:$PATH" ROOST_DATA_DIR="$TDIR" ROOST_IRC_NICK="testnick" "$HOOK" 2>"$TDIR/err")"
exit_code=$?
sleep 0.3  # give any (incorrect) backgrounded send-keys a chance to land in trace

if [ "$exit_code" -eq 0 ] && [ -z "$out" ] && ! grep -q "load-buffer" "$TRACE" 2>/dev/null; then
  ok "manual: pass-through (no stdout, no tmux injection)"
else
  fail "manual: pass-through (no stdout, no tmux injection)" "exit=$exit_code out=$out trace=$(cat "$TRACE" 2>/dev/null)"
fi
teardown_tmpdir

# -- Test 3: pass-through path sends SIGUSR1 to MCP pid -----------------------
# Spawn a long-running sentinel (perl, so the trap stays installed across the
# parent's fork/exec — a bare bash subshell would exec sleep and lose the
# trap). The sentinel writes a marker on USR1 and exits.

setup_tmpdir
perl -e '$SIG{USR1} = sub { open my $fh, ">", "'"$TDIR"'/sigusr1-received" or die $!; close $fh; exit 0 }; sleep 5' &
victim_pid=$!
sleep 0.1
echo "$victim_pid" > "$TDIR/mcp.pid"
input='{"trigger":"manual"}'
printf '%s' "$input" | env -i PATH="$MOCK:$PATH" ROOST_DATA_DIR="$TDIR" ROOST_IRC_NICK="testnick" "$HOOK" >/dev/null 2>"$TDIR/err"
sleep 0.2

if [ -f "$TDIR/sigusr1-received" ]; then
  ok "pass-through: SIGUSR1 delivered to mcp.pid"
else
  fail "pass-through: SIGUSR1 delivered to mcp.pid" "victim_pid=$victim_pid err=$(cat "$TDIR/err" 2>/dev/null)"
fi
kill "$victim_pid" 2>/dev/null || true
wait 2>/dev/null || true
teardown_tmpdir

# -- Test 4: malformed JSON → defaults to manual (pass through, no crash) -----

setup_tmpdir
out="$(printf 'not-json' | env -i PATH="$MOCK:$PATH" ROOST_DATA_DIR="$TDIR" ROOST_IRC_NICK="testnick" "$HOOK" 2>"$TDIR/err")"
exit_code=$?
sleep 0.3

if [ "$exit_code" -eq 0 ] && [ -z "$out" ] && ! grep -q "load-buffer" "$TRACE" 2>/dev/null; then
  ok "malformed JSON: defaults to manual, pass-through"
else
  fail "malformed JSON: defaults to manual, pass-through" "exit=$exit_code out=$out trace=$(cat "$TRACE" 2>/dev/null)"
fi
teardown_tmpdir

# -- Test 5: session-name.txt honored over default convention -----------------
# `bin/roost spawn` writes session-name.txt so `-s/--session NAME` propagates.
# Hook reads it and falls back to `roost-${nick}` only if the file is absent.

setup_tmpdir
printf 'custom-session-name' > "$TDIR/session-name.txt"
input='{"trigger":"auto","custom_instructions":null}'
out="$(printf '%s' "$input" | env -i PATH="$MOCK:$PATH" ROOST_DATA_DIR="$TDIR" ROOST_IRC_NICK="testnick" "$HOOK" 2>"$TDIR/err")"
exit_code=$?
sleep 0.5

if [ "$exit_code" -eq 0 ] \
    && echo "$out" | grep -q '"decision":"block"' \
    && grep -qF 'custom-session-name' "$TRACE" \
    && ! grep -qF 'roost-testnick' "$TRACE"; then
  ok "session-name.txt: custom name targeted, default convention not used"
else
  fail "session-name.txt: custom name targeted, default convention not used" "exit=$exit_code trace=$(cat "$TRACE" 2>/dev/null)"
fi
teardown_tmpdir

# -- Test 6: fresh lock → debounce (block returned, no tmux inject) -----------

setup_tmpdir
mkdir "$TDIR/compact-inject.lock.d"
input='{"trigger":"auto","custom_instructions":null}'
out="$(printf '%s' "$input" | env -i PATH="$MOCK:$PATH" ROOST_DATA_DIR="$TDIR" ROOST_IRC_NICK="testnick" "$HOOK" 2>"$TDIR/err")"
exit_code=$?
sleep 0.5

if [ "$exit_code" -eq 0 ] \
    && echo "$out" | grep -q '"decision":"block"' \
    && ! grep -q "load-buffer" "$TRACE" 2>/dev/null; then
  ok "debounce: fresh lock → block without inject"
else
  fail "debounce: fresh lock → block without inject" "exit=$exit_code out=$out trace=$(cat "$TRACE" 2>/dev/null)"
fi
teardown_tmpdir

# -- Test 7: stale lock → inject fires, lock refreshed -----------------------
# Simulate a stale lock by setting its mtime to epoch (1970-01-01).

setup_tmpdir
mkdir "$TDIR/compact-inject.lock.d"
touch -t 197001010000.00 "$TDIR/compact-inject.lock.d"
input='{"trigger":"auto","custom_instructions":null}'
out="$(printf '%s' "$input" | env -i PATH="$MOCK:$PATH" ROOST_DATA_DIR="$TDIR" ROOST_IRC_NICK="testnick" "$HOOK" 2>"$TDIR/err")"
exit_code=$?
sleep 0.5

if [ "$exit_code" -eq 0 ] \
    && echo "$out" | grep -q '"decision":"block"' \
    && grep -q "load-buffer" "$TRACE" 2>/dev/null \
    && [ -d "$TDIR/compact-inject.lock.d" ]; then
  ok "debounce: stale lock → inject fires, lock re-claimed"
else
  fail "debounce: stale lock → inject fires, lock re-claimed" "exit=$exit_code out=$out trace=$(cat "$TRACE" 2>/dev/null)"
fi
teardown_tmpdir

# -- Test 8: PostCompact hook clears the lock dir -----------------------------

POST_HOOK="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )/bin/roost-post-compact-hook"

setup_tmpdir
mkdir "$TDIR/compact-inject.lock.d"
perl -e '$SIG{USR2} = sub { exit 0 }; sleep 5' &
victim_pid=$!
sleep 0.1
echo "$victim_pid" > "$TDIR/mcp.pid"
env -i ROOST_DATA_DIR="$TDIR" "$POST_HOOK" >/dev/null 2>/dev/null
kill "$victim_pid" 2>/dev/null || true
wait 2>/dev/null || true

if [ ! -d "$TDIR/compact-inject.lock.d" ]; then
  ok "post-compact: lock dir cleared after compact"
else
  fail "post-compact: lock dir cleared after compact" "lock still exists"
fi
teardown_tmpdir

# -- Test 9: PostCompact clears lock even when mcp.pid is missing -------------
# Lock cleanup must run regardless of the SIGUSR2 path's success.

setup_tmpdir
mkdir "$TDIR/compact-inject.lock.d"
# no mcp.pid written — simulates MCP died between PreCompact and PostCompact
env -i ROOST_DATA_DIR="$TDIR" "$POST_HOOK" >/dev/null 2>/dev/null

if [ ! -d "$TDIR/compact-inject.lock.d" ]; then
  ok "post-compact: lock cleared even when mcp.pid is missing"
else
  fail "post-compact: lock cleared even when mcp.pid is missing" "lock still exists"
fi
teardown_tmpdir

# -- Test 10: concurrent invocations — only one inject fires ------------------
# mkdir is POSIX-atomic: two simultaneous hook invocations can't both claim
# the lock. Exactly one should inject; the other should debounce.

setup_tmpdir
input='{"trigger":"auto","custom_instructions":null}'
printf '%s' "$input" | env -i PATH="$MOCK:$PATH" ROOST_DATA_DIR="$TDIR" ROOST_IRC_NICK="testnick" "$HOOK" >/dev/null 2>/dev/null &
pid1=$!
printf '%s' "$input" | env -i PATH="$MOCK:$PATH" ROOST_DATA_DIR="$TDIR" ROOST_IRC_NICK="testnick" "$HOOK" >/dev/null 2>/dev/null &
pid2=$!
wait $pid1 $pid2
sleep 0.5

inject_count=$(grep -c "load-buffer" "$TRACE" 2>/dev/null || echo 0)
if [ "$inject_count" -eq 1 ]; then
  ok "concurrent: exactly one inject (mkdir atomicity)"
else
  fail "concurrent: exactly one inject (mkdir atomicity)" "inject_count=$inject_count trace=$(cat "$TRACE" 2>/dev/null)"
fi
teardown_tmpdir

# -- Test 11: PostCompact injects channel-verify directive via tmux ------------
# When ROOST_IRC_NICK is set and tmux session is live, the hook should
# background a load-buffer/paste-buffer/send-keys chain carrying the
# channel_list verification directive.

setup_tmpdir
perl -e '$SIG{USR2} = sub { exit 0 }; sleep 5' &
victim_pid=$!
sleep 0.1
echo "$victim_pid" > "$TDIR/mcp.pid"
env -i PATH="$MOCK:$PATH" ROOST_DATA_DIR="$TDIR" ROOST_IRC_NICK="testnick" "$POST_HOOK" >/dev/null 2>/dev/null
sleep 0.5
kill "$victim_pid" 2>/dev/null || true
wait 2>/dev/null || true

if [ -s "$TRACE" ] \
    && grep -q "has-session" "$TRACE" \
    && grep -q "load-buffer" "$TRACE" \
    && grep -q "paste-buffer" "$TRACE" \
    && grep -q "send-keys.*Enter" "$TRACE" \
    && grep -qF 'channel_list' "$TRACE" \
    && grep -qF 'rejoin' "$TRACE"; then
  ok "post-compact: channel-verify directive injected via tmux"
else
  fail "post-compact: channel-verify directive injected via tmux" "trace=$(cat "$TRACE" 2>/dev/null)"
fi
teardown_tmpdir

# -- Test 12: PostCompact inject fires even when mcp.pid is missing -----------
# Proves the tmux inject path is decoupled from the SIGUSR2 path.

setup_tmpdir
# no mcp.pid written — SIGUSR2 skipped but inject should still fire
env -i PATH="$MOCK:$PATH" ROOST_DATA_DIR="$TDIR" ROOST_IRC_NICK="testnick" "$POST_HOOK" >/dev/null 2>/dev/null
sleep 0.5

if [ -s "$TRACE" ] \
    && grep -q "load-buffer" "$TRACE" \
    && grep -qF 'channel_list' "$TRACE"; then
  ok "post-compact: inject fires independently of mcp.pid"
else
  fail "post-compact: inject fires independently of mcp.pid" "trace=$(cat "$TRACE" 2>/dev/null)"
fi
teardown_tmpdir

# -- Test 13: ROOST_IRC_NICK unset → no tmux call ----------------------------

setup_tmpdir
perl -e '$SIG{USR2} = sub { exit 0 }; sleep 5' &
victim_pid=$!
sleep 0.1
echo "$victim_pid" > "$TDIR/mcp.pid"
env -i PATH="$MOCK:$PATH" ROOST_DATA_DIR="$TDIR" "$POST_HOOK" >/dev/null 2>/dev/null
sleep 0.5
kill "$victim_pid" 2>/dev/null || true
wait 2>/dev/null || true

if ! grep -q "load-buffer" "$TRACE" 2>/dev/null; then
  ok "post-compact: ROOST_IRC_NICK unset → no tmux inject"
else
  fail "post-compact: ROOST_IRC_NICK unset → no tmux inject" "trace=$(cat "$TRACE" 2>/dev/null)"
fi
teardown_tmpdir

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ]
