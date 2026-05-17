#!/usr/bin/env bash
# Tests for bin/roost-compact-hook (v3 PreCompact intercept, issue #368).
# Plain bash — covers the three branches: auto+directive (block + inject),
# manual (pass through), no-directive (pass through). Uses a mock tmux on
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

# -- Test 1: trigger=auto + directive present → block + injected ----------------

setup_tmpdir
printf 'retain X' > "$TDIR/compact-directive.txt"
input='{"session_id":"s","transcript_path":"/tmp/t.jsonl","cwd":"/","hook_event_name":"PreCompact","trigger":"auto","custom_instructions":null}'
out="$(printf '%s' "$input" | env -i PATH="$MOCK:$PATH" ROOST_DATA_DIR="$TDIR" ROOST_IRC_NICK="testnick" "$HOOK" 2>"$TDIR/err")"
exit_code=$?

# Hook must return decision:block on stdout, exit 0.
if [ "$exit_code" -eq 0 ] && echo "$out" | grep -q '"decision":"block"'; then
  ok "auto+directive: stdout carries decision:block"
else
  fail "auto+directive: stdout carries decision:block" "exit=$exit_code out=$out err=$(cat "$TDIR/err" 2>/dev/null)"
fi

# Backgrounded subshell sleeps 0.15s before invoking tmux. Wait a touch
# longer than that, then assert tmux was called with load-buffer + paste.
sleep 0.5
if [ -s "$TRACE" ] \
    && grep -q "has-session" "$TRACE" \
    && grep -q "load-buffer" "$TRACE" \
    && grep -q "paste-buffer" "$TRACE" \
    && grep -q "send-keys.*Enter" "$TRACE" \
    && grep -qF '/compact' "$TRACE" \
    && grep -qF 'retain' "$TRACE"; then
  ok "auto+directive: tmux injection chain ran with /compact <directive>"
else
  fail "auto+directive: tmux injection chain ran with /compact <directive>" "trace=$(cat "$TRACE" 2>/dev/null)"
fi
teardown_tmpdir

# -- Test 2: trigger=manual → pass through, no injection -----------------------

setup_tmpdir
printf 'retain X' > "$TDIR/compact-directive.txt"
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

# -- Test 3: trigger=auto but no directive file → pass through -----------------

setup_tmpdir
# Intentionally no compact-directive.txt written.
input='{"trigger":"auto","custom_instructions":null}'
out="$(printf '%s' "$input" | env -i PATH="$MOCK:$PATH" ROOST_DATA_DIR="$TDIR" ROOST_IRC_NICK="testnick" "$HOOK" 2>"$TDIR/err")"
exit_code=$?
sleep 0.3

if [ "$exit_code" -eq 0 ] && [ -z "$out" ] && ! grep -q "load-buffer" "$TRACE" 2>/dev/null; then
  ok "auto without directive: pass-through"
else
  fail "auto without directive: pass-through" "exit=$exit_code out=$out trace=$(cat "$TRACE" 2>/dev/null)"
fi
teardown_tmpdir

# -- Test 4: trigger=auto, empty directive file → pass through -----------------
# `[ -s file ]` is the gate — zero-length file is treated as "no directive".

setup_tmpdir
: > "$TDIR/compact-directive.txt"
input='{"trigger":"auto"}'
out="$(printf '%s' "$input" | env -i PATH="$MOCK:$PATH" ROOST_DATA_DIR="$TDIR" ROOST_IRC_NICK="testnick" "$HOOK" 2>"$TDIR/err")"
exit_code=$?
sleep 0.3

if [ "$exit_code" -eq 0 ] && [ -z "$out" ] && ! grep -q "load-buffer" "$TRACE" 2>/dev/null; then
  ok "auto with empty directive file: pass-through"
else
  fail "auto with empty directive file: pass-through" "exit=$exit_code out=$out trace=$(cat "$TRACE" 2>/dev/null)"
fi
teardown_tmpdir

# -- Test 5: pass-through path sends SIGUSR1 to MCP pid -----------------------
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

# -- Test 6: malformed JSON → defaults to manual (pass through, no crash) -----

setup_tmpdir
printf 'retain X' > "$TDIR/compact-directive.txt"
out="$(printf 'not-json' | env -i PATH="$MOCK:$PATH" ROOST_DATA_DIR="$TDIR" ROOST_IRC_NICK="testnick" "$HOOK" 2>"$TDIR/err")"
exit_code=$?
sleep 0.3

if [ "$exit_code" -eq 0 ] && [ -z "$out" ] && ! grep -q "load-buffer" "$TRACE" 2>/dev/null; then
  ok "malformed JSON: defaults to manual, pass-through"
else
  fail "malformed JSON: defaults to manual, pass-through" "exit=$exit_code out=$out trace=$(cat "$TRACE" 2>/dev/null)"
fi
teardown_tmpdir

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ]
