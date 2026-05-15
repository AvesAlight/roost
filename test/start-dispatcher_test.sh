#!/usr/bin/env bash
# Tests for bin/start-dispatcher. Plain bash, no bats.
# Run: bash test/start-dispatcher_test.sh
#
# Uses ROOST_DISPATCHER_BIN to substitute a fake dispatcher that just writes
# the PID file (the same way the real daemon does on boot) and sleeps. No
# IRC required.

set -uo pipefail

ROOT="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"
START="$ROOT/bin/start-dispatcher"
PASS=0
FAIL=0

ok()   { echo "PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "FAIL: $1 ${2:+— $2}"; FAIL=$((FAIL+1)); }

make_fake_dispatcher() {
  # Args: <output-path> [extra-shell-prelude]
  # The fake honors --config-dir, writes a PID file in the daemon's own
  # format (JSON: pid, started_at_ms, cmdline), and sleeps. The prelude can
  # inject a delay or an early exit for race-window tests.
  local out="$1"
  local prelude="${2:-}"
  cat > "$out" <<EOF
#!/usr/bin/env bash
set -u
config_dir=""
while [ \$# -gt 0 ]; do
  case "\$1" in
    --config-dir) config_dir="\$2"; shift 2;;
    *) shift;;
  esac
done
${prelude}
# Mirror src/orchestrator/config.ts writeDispatcherPid: exclusive create.
if ! ( set -C; printf '{"pid":%d,"started_at_ms":%d,"cmdline":"%s"}\n' "\$\$" "\$(date +%s)" "fake-dispatcher --config-dir \${config_dir}" > "\${config_dir}/dispatcher.pid" ) 2>/dev/null; then
  echo "fake-dispatcher: PID file exists — bailing" >&2
  exit 1
fi
trap 'rm -f "\${config_dir}/dispatcher.pid"' EXIT
sleep 30
EOF
  chmod +x "$out"
}

# Clean up any descendants the test leaves behind. Belt-and-suspenders since
# fake daemons trap-clean their own PID files.
kill_descendants() {
  local pid_file="$1"
  if [ -f "$pid_file" ]; then
    local pid
    pid="$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$pid_file" | head -1)"
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  fi
}

# -- Test 1: single boot writes a PID file, exits 0 -----------------------

TDIR="$(mktemp -d /tmp/start-dispatcher-test-XXXXXXXX)"
make_fake_dispatcher "$TDIR/fake-dispatcher"
if ROOST_DISPATCHER_BIN="$TDIR/fake-dispatcher" "$START" "$TDIR" >/dev/null 2>&1 \
    && [ -f "$TDIR/dispatcher.pid" ]; then
  ok "single boot: PID file written, exit 0"
else
  fail "single boot"
fi
kill_descendants "$TDIR/dispatcher.pid"
rm -rf "$TDIR"

# -- Test 2: idempotent — second call reports already-running -------------

TDIR="$(mktemp -d /tmp/start-dispatcher-test-XXXXXXXX)"
make_fake_dispatcher "$TDIR/fake-dispatcher"
ROOST_DISPATCHER_BIN="$TDIR/fake-dispatcher" "$START" "$TDIR" >/dev/null 2>&1
first_pid="$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$TDIR/dispatcher.pid" | head -1)"
second_out="$(ROOST_DISPATCHER_BIN="$TDIR/fake-dispatcher" "$START" "$TDIR" 2>&1)"
second_pid="$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$TDIR/dispatcher.pid" | head -1)"
if echo "$second_out" | grep -q "already running" && [ "$first_pid" = "$second_pid" ]; then
  ok "idempotent: second call reports already-running, PID unchanged"
else
  fail "idempotent" "out=$second_out first=$first_pid second=$second_pid"
fi
kill_descendants "$TDIR/dispatcher.pid"
rm -rf "$TDIR"

# -- Test 3: stale PID cleanup --------------------------------------------

TDIR="$(mktemp -d /tmp/start-dispatcher-test-XXXXXXXX)"
make_fake_dispatcher "$TDIR/fake-dispatcher"
# Pre-populate a stale PID file with a definitely-dead PID.
printf '{"pid":999999,"started_at_ms":0,"cmdline":"old --config-dir %s"}\n' "$TDIR" > "$TDIR/dispatcher.pid"
if ROOST_DISPATCHER_BIN="$TDIR/fake-dispatcher" "$START" "$TDIR" >/dev/null 2>&1; then
  new_pid="$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$TDIR/dispatcher.pid" | head -1)"
  if [ "$new_pid" != "999999" ] && kill -0 "$new_pid" 2>/dev/null; then
    ok "stale PID cleanup: respawned, new PID alive"
  else
    fail "stale PID cleanup" "new_pid=$new_pid"
  fi
else
  fail "stale PID cleanup" "start-dispatcher exited non-zero"
fi
kill_descendants "$TDIR/dispatcher.pid"
rm -rf "$TDIR"

# -- Test 4: PID-recycle defense ------------------------------------------
# Live PID but its cmdline does not reference our config-dir → treat as stale.

TDIR="$(mktemp -d /tmp/start-dispatcher-test-XXXXXXXX)"
make_fake_dispatcher "$TDIR/fake-dispatcher"
# Spawn a child whose cmdline does NOT include $TDIR.
sleep 30 &
unrelated_pid=$!
printf '{"pid":%d,"started_at_ms":0,"cmdline":"recycled"}\n' "$unrelated_pid" > "$TDIR/dispatcher.pid"
if ROOST_DISPATCHER_BIN="$TDIR/fake-dispatcher" "$START" "$TDIR" >/dev/null 2>&1; then
  new_pid="$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$TDIR/dispatcher.pid" | head -1)"
  if [ "$new_pid" != "$unrelated_pid" ] && kill -0 "$new_pid" 2>/dev/null; then
    ok "PID-recycle defense: respawned despite live unrelated PID"
  else
    fail "PID-recycle defense" "new_pid=$new_pid unrelated=$unrelated_pid"
  fi
else
  fail "PID-recycle defense" "start-dispatcher exited non-zero"
fi
kill "$unrelated_pid" 2>/dev/null || true
wait "$unrelated_pid" 2>/dev/null || true
kill_descendants "$TDIR/dispatcher.pid"
rm -rf "$TDIR"

# -- Test 5: concurrent-start serialization -------------------------------
# Two parallel start-dispatcher calls — exactly one daemon survives, both
# exit 0, PID file points at the survivor. Exercises the mkdir lock and
# wait_for_winner path; the daemon-side exclusive PID claim is covered by
# the unit tests in dispatcher-pid.test.ts.

TDIR="$(mktemp -d /tmp/start-dispatcher-test-XXXXXXXX)"
# Inject a small delay before the daemon writes its PID file, widening the
# race window so both callers reliably take the spawn branch.
make_fake_dispatcher "$TDIR/fake-dispatcher" "sleep 0.3"
ROOST_DISPATCHER_BIN="$TDIR/fake-dispatcher" "$START" "$TDIR" > "$TDIR/out1.log" 2>&1 &
a=$!
ROOST_DISPATCHER_BIN="$TDIR/fake-dispatcher" "$START" "$TDIR" > "$TDIR/out2.log" 2>&1 &
b=$!
wait "$a"; rc_a=$?
wait "$b"; rc_b=$?
sleep 0.5
pid_in_file="$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$TDIR/dispatcher.pid" | head -1)"
live_count=0
for p in $(pgrep -f "$TDIR/fake-dispatcher" || true); do
  live_count=$((live_count+1))
done
if [ "$rc_a" -eq 0 ] && [ "$rc_b" -eq 0 ] \
    && [ -n "$pid_in_file" ] && kill -0 "$pid_in_file" 2>/dev/null \
    && [ "$live_count" -eq 1 ]; then
  ok "concurrent-start serialization: both exit 0, exactly one daemon survives"
else
  fail "concurrent-start serialization" "rc_a=$rc_a rc_b=$rc_b pid_in_file=$pid_in_file live_count=$live_count"
  echo "--- out1 ---"; cat "$TDIR/out1.log"
  echo "--- out2 ---"; cat "$TDIR/out2.log"
fi
# kill all fake dispatchers we may have spawned
pkill -f "$TDIR/fake-dispatcher" 2>/dev/null || true
rm -rf "$TDIR"

# -- Test 6: stale lock recovery ------------------------------------------
# A leftover lock dir from a crashed start-dispatcher (no daemon, no PID
# file) should be cleaned up and we retry once.

TDIR="$(mktemp -d /tmp/start-dispatcher-test-XXXXXXXX)"
make_fake_dispatcher "$TDIR/fake-dispatcher"
mkdir -p "$TDIR/.dispatcher.start.lock"
if ROOST_DISPATCHER_BIN="$TDIR/fake-dispatcher" "$START" "$TDIR" > "$TDIR/out.log" 2>&1; then
  if [ -f "$TDIR/dispatcher.pid" ] && [ ! -d "$TDIR/.dispatcher.start.lock" ]; then
    ok "stale lock recovery: lock removed, daemon started"
  else
    fail "stale lock recovery" "pid_file=$( [ -f "$TDIR/dispatcher.pid" ] && echo y || echo n) lock=$( [ -d "$TDIR/.dispatcher.start.lock" ] && echo y || echo n)"
  fi
else
  fail "stale lock recovery" "start-dispatcher exited non-zero"
  cat "$TDIR/out.log"
fi
kill_descendants "$TDIR/dispatcher.pid"
rm -rf "$TDIR"

echo
echo "PASS: $PASS"
echo "FAIL: $FAIL"
[ "$FAIL" -eq 0 ]
