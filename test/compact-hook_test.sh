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

# Poll until a command succeeds. Fixed sleeps flake on loaded runners; a poll
# returns as soon as the condition holds and only burns its cap on a real
# failure. Usage: wait_until <timeout_s> <cmd...>
wait_until() {
  local n=$(( $1 * 50 ))
  shift
  while [ "$n" -gt 0 ]; do
    "$@" && return 0
    sleep 0.02
    n=$((n-1))
  done
  return 1
}

# The inject chain ends with delete-buffer, so its line means the whole
# load-buffer/paste-buffer/send-keys chain ran.
inject_done() { grep -qs "delete-buffer" "$TRACE"; }

# Start a perl sentinel that traps <sig> by writing <marker> and exiting. It
# creates $TDIR/ready only once the trap is installed, so a signal sent after
# wait_until can't hit perl's default action. Sets victim_pid.
start_sentinel() {
  local sig="$1" marker="$2"
  perl -e '$SIG{'"$sig"'} = sub { open my $fh, ">", "'"$TDIR"'/'"$marker"'" or die $!; close $fh; exit 0 }; open my $r, ">", "'"$TDIR"'/ready" or die $!; close $r; sleep 5' &
  victim_pid=$!
  wait_until 10 test -f "$TDIR/ready"
  echo "$victim_pid" > "$TDIR/mcp.pid"
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

# Backgrounded subshell sleeps 0.15s before invoking tmux. Wait for the inject
# chain to finish, then assert tmux was called with load-buffer + paste +
# /compact + the baked-in directive's leading "retain:" marker.
wait_until 10 inject_done
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
start_sentinel USR1 sigusr1-received
input='{"trigger":"manual"}'
printf '%s' "$input" | env -i PATH="$MOCK:$PATH" ROOST_DATA_DIR="$TDIR" ROOST_IRC_NICK="testnick" "$HOOK" >/dev/null 2>"$TDIR/err"
wait_until 10 test -f "$TDIR/sigusr1-received"

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
wait_until 10 inject_done

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
wait_until 10 inject_done

if [ "$exit_code" -eq 0 ] \
    && echo "$out" | grep -q '"decision":"block"' \
    && grep -q "load-buffer" "$TRACE" 2>/dev/null \
    && [ -e "$TDIR/compact-inject.lock.d" ]; then
  ok "debounce: stale lock → inject fires, lock re-claimed"
else
  fail "debounce: stale lock → inject fires, lock re-claimed" "exit=$exit_code out=$out trace=$(cat "$TRACE" 2>/dev/null)"
fi
teardown_tmpdir

# -- Test 8: PostCompact hook clears the lock dir -----------------------------

POST_HOOK="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )/bin/roost-post-compact-hook"

setup_tmpdir
mkdir "$TDIR/compact-inject.lock.d"
start_sentinel USR2 sigusr2-received
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
# Four hook invocations that start at the same instant must not both claim the
# lock: exactly one injects, the other debounces. A single race is rarely
# lost, so run many rounds at once (each in its own dir) and count the rounds
# where the inject count != 1.
#
# race_rounds <rounds> <stale:0|1>  — sets RACE_BAD (rounds with count != 1) and
# RACE_COUNTS (the counts seen, space-separated).
race_rounds() {
  local rounds="$1" stale="$2" i rd pids k c
  local in='{"trigger":"auto","custom_instructions":null}'
  # Rounds run one after another so only a handful of processes spin at a
  # time. The inject chains finish in the background; counted after the loop.
  for i in $(seq 1 "$rounds"); do
    rd="$TDIR/r$i"
    make_mock_tmux "$rd/mock" "$rd/trace"
    if [ "$stale" = 1 ]; then
      mkdir "$rd/compact-inject.lock.d"
      touch -t 197001010000.00 "$rd/compact-inject.lock.d"
    fi
    pids=""
    for k in 1 2 3 4; do
      ( until [ -e "$rd/go" ]; do :; done
        printf '%s' "$in" | env -i PATH="$rd/mock:$PATH" ROOST_DATA_DIR="$rd" ROOST_IRC_NICK="testnick" "$HOOK" >/dev/null 2>/dev/null ) &
      pids="$pids $!"
    done
    touch "$rd/go"
    # shellcheck disable=SC2086
    wait $pids
  done
  # Let every round's inject chain finish, then a settle for a would-be second.
  for i in $(seq 1 "$rounds"); do
    TRACE="$TDIR/r$i/trace" wait_until 10 inject_done
  done
  sleep 0.5
  RACE_BAD=0
  RACE_COUNTS=""
  for i in $(seq 1 "$rounds"); do
    c="$(grep -c "load-buffer" "$TDIR/r$i/trace" 2>/dev/null)"
    c="${c:-0}"
    RACE_COUNTS="$RACE_COUNTS $c"
    [ "$c" -eq 1 ] || RACE_BAD=$((RACE_BAD+1))
  done
}

setup_tmpdir
race_rounds 40 0
if [ "$RACE_BAD" -eq 0 ]; then
  ok "concurrent: exactly one inject per round (40 rounds x 4 hooks)"
else
  fail "concurrent: exactly one inject per round (40 rounds x 4 hooks)" "bad_rounds=$RACE_BAD counts=$RACE_COUNTS"
fi
teardown_tmpdir

# -- Test 10b: concurrent invocations on a stale lock — only one inject --------
# Same contention, but the lock is already stale, so both invocations take the
# reclaim path. Reclaiming must not let both win.

setup_tmpdir
race_rounds 40 1
if [ "$RACE_BAD" -eq 0 ]; then
  ok "concurrent: stale lock, exactly one inject per round (40 rounds x 4 hooks)"
else
  fail "concurrent: stale lock, exactly one inject per round (40 rounds x 4 hooks)" "bad_rounds=$RACE_BAD counts=$RACE_COUNTS"
fi
teardown_tmpdir

# -- Test 10c: lib-level N-way acquire — exactly one winner -------------------
# acquire_dir_lock is the primitive under the hook's debounce and
# start-dispatcher's single-start guard. Race 8 claimants per round at one path;
# exactly one must win. This isolates the primitive from the hook's timing.

setup_tmpdir
LIB="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )/bin/_lock-lib.sh"
rounds=100
for i in $(seq 1 "$rounds"); do
  mkdir "$TDIR/a$i"
  pids=""
  for k in 1 2 3 4 5 6 7 8; do
    ( until [ -e "$TDIR/a$i/go" ]; do :; done
      # shellcheck disable=SC1090
      . "$LIB"
      acquire_dir_lock "$TDIR/a$i/lock" && : > "$TDIR/a$i/win.$k" ) &
    pids="$pids $!"
  done
  touch "$TDIR/a$i/go"
  # shellcheck disable=SC2086
  wait $pids
done
bad=0
counts=""
for i in $(seq 1 "$rounds"); do
  w="$(find "$TDIR/a$i" -name 'win.*' | wc -l | tr -d ' ')"
  [ "$w" -eq 1 ] || { bad=$((bad+1)); counts="$counts $w"; }
done
if [ "$bad" -eq 0 ]; then
  ok "acquire_dir_lock: exactly one winner per round (100 rounds x 8 claimants)"
else
  fail "acquire_dir_lock: exactly one winner per round (100 rounds x 8 claimants)" "bad_rounds=$bad winner_counts=$counts"
fi
teardown_tmpdir

# -- Test 11: PostCompact injects channel-verify directive via tmux ------------
# When ROOST_IRC_NICK is set and tmux session is live, the hook should
# background a load-buffer/paste-buffer/send-keys chain carrying the
# channel_list verification directive.

setup_tmpdir
start_sentinel USR2 sigusr2-received
env -i PATH="$MOCK:$PATH" ROOST_DATA_DIR="$TDIR" ROOST_IRC_NICK="testnick" "$POST_HOOK" >/dev/null 2>/dev/null
wait_until 10 inject_done
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
wait_until 10 inject_done

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
start_sentinel USR2 sigusr2-received
env -i PATH="$MOCK:$PATH" ROOST_DATA_DIR="$TDIR" "$POST_HOOK" >/dev/null 2>/dev/null
# Negative assertion: nothing to poll for, so a settle. It can only miss a
# bug (a late inject), never fail a healthy run.
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
