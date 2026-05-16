#!/usr/bin/env bash
# Tests for bin/stop-dispatcher. Plain bash, no bats.
# Run: bash test/stop-dispatcher_test.sh

set -uo pipefail

ROOT="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"
STOP="$ROOT/bin/stop-dispatcher"
PASS=0
FAIL=0

ok()   { echo "PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "FAIL: $1 ${2:+— $2}"; FAIL=$((FAIL+1)); }

# Write a fake PID file in the same JSON format the daemon uses.
write_pid_file() {
  local dir="$1" pid="$2"
  printf '{"pid":%d,"started_at_ms":%d,"cmdline":"fake-daemon --config-dir %s"}\n' \
    "$pid" "$(date +%s)000" "$dir" > "$dir/dispatcher.pid"
}

# -- Test 1: no PID file → exit 0 (already stopped) -----------------------

TDIR="$(mktemp -d /tmp/stop-dispatcher-test-XXXXXXXX)"
out="$("$STOP" "$TDIR" 2>&1)"
rc=$?
if [ "$rc" -eq 0 ] && echo "$out" | grep -qi "not running"; then
  ok "no PID file: exit 0, reports not running"
else
  fail "no PID file" "rc=$rc out=$out"
fi
rm -rf "$TDIR"

# -- Test 2: stale PID file (dead PID) → exit 0, file removed -------------

TDIR="$(mktemp -d /tmp/stop-dispatcher-test-XXXXXXXX)"
write_pid_file "$TDIR" 999999
out="$("$STOP" "$TDIR" 2>&1)"
rc=$?
if [ "$rc" -eq 0 ] && ! [ -f "$TDIR/dispatcher.pid" ]; then
  ok "stale PID (dead process): exit 0, PID file cleaned up"
else
  fail "stale PID" "rc=$rc pid_file_exists=$( [ -f "$TDIR/dispatcher.pid" ] && echo y || echo n) out=$out"
fi
rm -rf "$TDIR"

# -- Test 3: PID-recycle (live but ps args don't reference $TDIR) → exit 0, file removed --
# pid_file_is_live checks the real ps args for the process, not the JSON cmdline field.
# The JSON cmdline value in the PID file is decorative from stop-dispatcher's perspective;
# what matters is that `ps -p $PID -o args=` doesn't mention $TDIR.

TDIR="$(mktemp -d /tmp/stop-dispatcher-test-XXXXXXXX)"
sleep 30 &
unrelated_pid=$!
# Write a PID file pointing at the live sleep process. Its real `ps args` are "sleep 30",
# which don't include $TDIR — so pid_file_is_live returns false (PID-recycle defense).
printf '{"pid":%d,"started_at_ms":0,"cmdline":"unrelated"}\n' "$unrelated_pid" > "$TDIR/dispatcher.pid"
out="$("$STOP" "$TDIR" 2>&1)"
rc=$?
kill "$unrelated_pid" 2>/dev/null || true
wait "$unrelated_pid" 2>/dev/null || true
if [ "$rc" -eq 0 ] && ! [ -f "$TDIR/dispatcher.pid" ]; then
  ok "PID-recycle (live unrelated PID): exit 0, stale PID file cleaned up"
else
  fail "PID-recycle" "rc=$rc pid_file_exists=$( [ -f "$TDIR/dispatcher.pid" ] && echo y || echo n) out=$out"
fi
rm -rf "$TDIR"

# -- Test 4: live dispatcher → SIGTERM sent, exits 0, PID file removed ----

TDIR="$(mktemp -d /tmp/stop-dispatcher-test-XXXXXXXX)"
# Spawn a sleeper whose cmdline includes $TDIR so pid_file_is_live returns true.
# Using a wrapper script so the dir appears in ps args.
fake_script="$TDIR/fake-daemon.sh"
cat > "$fake_script" <<SCRIPT
#!/usr/bin/env bash
trap 'exit 0' TERM
sleep 30 &
wait
SCRIPT
chmod +x "$fake_script"
bash "$fake_script" "$TDIR" &
live_pid=$!
# Brief poll until ps shows the dir in the process args. The dir is passed
# as an arg so it appears in ps output.
for _i in $(seq 1 20); do
  ps_out="$(ps -p "$live_pid" -o args= 2>/dev/null || true)"
  echo "$ps_out" | grep -Fq -- "$TDIR" && break
  sleep 0.1
done
write_pid_file "$TDIR" "$live_pid"
out="$("$STOP" "$TDIR" 2>&1)"
rc=$?
wait "$live_pid" 2>/dev/null || true
if [ "$rc" -eq 0 ] && ! [ -f "$TDIR/dispatcher.pid" ] && ! kill -0 "$live_pid" 2>/dev/null; then
  ok "live dispatcher: SIGTERM sent, exit 0, PID file removed"
else
  fail "live dispatcher" "rc=$rc pid_file_exists=$( [ -f "$TDIR/dispatcher.pid" ] && echo y || echo n) pid_alive=$( kill -0 "$live_pid" 2>/dev/null && echo y || echo n) out=$out"
  kill "$live_pid" 2>/dev/null || true
fi
rm -rf "$TDIR"

# -- Test 5: STOP_TIMEOUT respected — stubborn process → exit 1 -----------

TDIR="$(mktemp -d /tmp/stop-dispatcher-test-XXXXXXXX)"
# Spawn a process that ignores SIGTERM.
fake_script="$TDIR/fake-daemon.sh"
cat > "$fake_script" <<SCRIPT
#!/usr/bin/env bash
trap '' TERM
sleep 30 &
wait
SCRIPT
chmod +x "$fake_script"
bash "$fake_script" "$TDIR" &
stubborn_pid=$!
for _i in $(seq 1 20); do
  ps_out="$(ps -p "$stubborn_pid" -o args= 2>/dev/null || true)"
  echo "$ps_out" | grep -Fq -- "$TDIR" && break
  sleep 0.1
done
write_pid_file "$TDIR" "$stubborn_pid"
out="$(STOP_TIMEOUT=2 "$STOP" "$TDIR" 2>&1)"
rc=$?
kill "$stubborn_pid" 2>/dev/null || true
wait "$stubborn_pid" 2>/dev/null || true
if [ "$rc" -eq 1 ] && echo "$out" | grep -q "FAIL"; then
  ok "STOP_TIMEOUT respected: stubborn process, exit 1 with FAIL diagnostic"
else
  fail "STOP_TIMEOUT" "rc=$rc out=$out"
fi
rm -rf "$TDIR"

echo
echo "PASS: $PASS"
echo "FAIL: $FAIL"
[ "$FAIL" -eq 0 ]
