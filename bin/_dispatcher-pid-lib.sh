# shellcheck shell=bash
# _dispatcher-pid-lib.sh — source this; do not execute directly.
# Requires callers to set: PID_FILE, CONFIG_DIR

# Pull pid out of the JSON without depending on jq. Portable across BSD sed
# (darwin) and GNU sed (linux).
read_pid() {
  # shellcheck disable=SC2154
  [ -f "$PID_FILE" ] || return 1
  sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$PID_FILE" | head -1
}

# Returns 0 if the PID file points at a live dispatcher for *this* config-dir.
# Two-stage check: PID alive (`kill -0`) AND `ps` shows the config-dir arg,
# so a recycled PID owned by an unrelated process doesn't fool us.
pid_file_is_live() {
  local pid
  pid="$(read_pid)"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  # shellcheck disable=SC2154
  ps -p "$pid" -o args= 2>/dev/null | grep -Fq -- "$CONFIG_DIR" || return 1
  return 0
}
