#!/usr/bin/env bash
# Tests for spawn's first-run prompt handling and IRC-join readiness gate.
# Plain bash, no bats. Run: bash test/spawn_readiness_test.sh
set -uo pipefail

ROOT="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"
PASS=0
FAIL=0

ok()   { echo "PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "FAIL: $1 ${2:+— $2}"; FAIL=$((FAIL+1)); }

# bin/roost guards its dispatch with BASH_SOURCE == $0, so sourcing gives us
# the helpers with no side effects.
# shellcheck disable=SC1091
source "${ROOT}/bin/roost"

# Pane fixtures are transcribed from real sessions, not paraphrased: the trust
# screen was captured from a never-opened checkout, the other two from a
# stalled spawn. Wording is the contract these matchers are written against.
trust_pane() {
  cat <<PANE

────────────────────────────────────────────────────────
 Accessing workspace:

 ${1}

 Quick safety check: Is this a project you created or one you trust? (Like your own code, a
 well-known open source project, or work from your team).

 Claude Code'll be able to read, edit, and execute files here.

 Security guide

 ${2:-❯ 1. Yes, I trust this folder}
 ${3:-  2. No, exit}

 Enter to confirm · Esc to cancel
PANE
}

imports_pane() {
  cat <<'PANE'
Allow external CLAUDE.md file imports?

This project's CLAUDE.md imports files outside the current working directory. Never allow this for third-party repositories.

External imports:
  /Users/alex/Dev/GoCarrot/employee-handbook/src/Engineering/Service_Map.md

❯ 1. Yes, allow external imports
  2. No, disable external imports

Enter to confirm · Esc to cancel
PANE
}

devchannels_pane() {
  cat <<'PANE'
WARNING: Loading development channels

--dangerously-load-development-channels is for local channel development only.

Channels: server:plugin:roost:roost-irc

❯ 1. I am using this for local development
  2. Exit

Enter to confirm · Esc to cancel
PANE
}

# -- startup_prompt_key ------------------------------------------------------

TDIR="$(mktemp -d /tmp/roost-ready-test-XXXXXXXX)"
trap 'rm -rf "$TDIR"' EXIT
REAL_TDIR="$(cd "$TDIR" && pwd -P)"

got="$(devchannels_pane | startup_prompt_key "$TDIR")"
[ "$got" = "Enter" ] && ok "dev-channels prompt answered" || fail "dev-channels prompt answered" "got='$got'"

got="$(imports_pane | startup_prompt_key "$TDIR")"
[ "$got" = "Enter" ] && ok "external-imports prompt answered" || fail "external-imports prompt answered" "got='$got'"

got="$(trust_pane "$REAL_TDIR" | startup_prompt_key "$TDIR")"
[ "$got" = "Enter" ] && ok "folder-trust prompt answered when the shown path is our cwd" \
  || fail "folder-trust prompt answered when the shown path is our cwd" "got='$got'"

# The pane prints the resolved path: on macOS a /tmp cwd renders as
# /private/tmp. A literal compare would never fire here, which is the silent
# stall this whole change exists to remove — so compare resolved forms.
if [ "$REAL_TDIR" != "$TDIR" ]; then
  got="$(trust_pane "$REAL_TDIR" | startup_prompt_key "$TDIR")"
  [ "$got" = "Enter" ] && ok "folder-trust matches through a symlinked cwd (${TDIR} -> ${REAL_TDIR})" \
    || fail "folder-trust matches through a symlinked cwd" "got='$got'"
else
  echo "SKIP: symlinked-cwd case (mktemp path is not symlinked here)"
fi

got="$(trust_pane "/" | startup_prompt_key "$TDIR")"
[ -z "$got" ] && ok "folder-trust NOT answered when the prompt names a different path" \
  || fail "folder-trust NOT answered when the prompt names a different path" "got='$got'"

got="$(trust_pane "$REAL_TDIR" "  1. Yes, I trust this folder" "❯ 2. No, exit" | startup_prompt_key "$TDIR")"
[ -z "$got" ] && ok "no key sent when the selected option is the refusal" \
  || fail "no key sent when the selected option is the refusal" "got='$got'"

got="$(printf 'Delete everything?\n\n❯ 1. Yes, delete it all\n  2. Cancel\n\nEnter to confirm · Esc to cancel\n' | startup_prompt_key "$TDIR")"
[ -z "$got" ] && ok "unrecognized prompt gets no key even with an affirmative default" \
  || fail "unrecognized prompt gets no key even with an affirmative default" "got='$got'"

# Identical to the passing trust case except the confirm footer is gone, so
# the footer gate is the only thing that can reject it. (An earlier version of
# this fixture also lacked the workspace path, which meant the path guard
# rejected it and the test stayed green with the footer gate deleted.)
got="$(trust_pane "$REAL_TDIR" | grep -v 'Enter to confirm' | startup_prompt_key "$TDIR")"
[ -z "$got" ] && ok "no key sent without the confirm footer" || fail "no key sent without the confirm footer" "got='$got'"

# -- await_spawn_ready -------------------------------------------------------
# Stub tmux and the IRC probe. STATE_DIR drives what the fake pane shows and
# when the fake nick 'joins', so the prompts stack the way they do live.

STATE="$TDIR/state"
mkdir -p "$STATE"
export STATE

tmux() {
  case "$1" in
    has-session) [ -f "$STATE/dead" ] && return 1; return 0 ;;
    capture-pane)
      local step; step="$(cat "$STATE/step" 2>/dev/null || echo 0)"
      case "$step" in
        0) devchannels_pane ;;
        1) trust_pane "$REAL_TDIR" ;;
        2) imports_pane ;;
        *) echo "welcome to claude code" ;;
      esac ;;
    send-keys)
      local step; step="$(cat "$STATE/step" 2>/dev/null || echo 0)"
      echo $((step + 1)) > "$STATE/step"
      echo "SENT:$*" >> "$STATE/keys" ;;
  esac
  return 0
}

probe="$TDIR/probe"
cat > "$probe" <<'PROBE'
#!/usr/bin/env bash
# present only once every prompt has been answered
step="$(cat "$STATE/step" 2>/dev/null || echo 0)"
[ -f "$STATE/probe_broken" ] && exit 2
[ "$step" -ge 3 ] && exit 0
exit 1
PROBE
chmod +x "$probe"
export ROOST_READY_PROBE="$probe"

out="$(await_spawn_ready roost-x testnick "$TDIR" 30 2>&1)"; rc=$?
answered="$(grep -c 'answered first-run prompt' <<<"$out")"
if [ "$rc" -eq 0 ] && [ "$answered" -eq 3 ] && grep -q "joined IRC as testnick" <<<"$out"; then
  ok "stacked prompts are drained in sequence and readiness is an observed join"
else
  fail "stacked prompts are drained in sequence and readiness is an observed join" "rc=$rc answered=$answered out=$out"
fi

# A screen we do not recognize must stall loudly, not get a blind keypress.
echo 0 > "$STATE/step"; rm -f "$STATE/keys"
tmux() {
  case "$1" in
    has-session) return 0 ;;
    capture-pane) printf 'Some new prompt nobody taught me\n\n❯ 1. Sure\n  2. No\n\nEnter to confirm · Esc to cancel\n' ;;
    send-keys) echo "SENT:$*" >> "$STATE/keys" ;;
  esac
  return 0
}
out="$(await_spawn_ready roost-x testnick "$TDIR" 2 2>&1)"; rc=$?
if [ "$rc" -eq 6 ] && grep -q "never joined IRC within 2s" <<<"$out" \
   && grep -q "Some new prompt nobody taught me" <<<"$out" && [ ! -f "$STATE/keys" ]; then
  ok "unrecognized prompt: non-zero exit, screen quoted, no key sent"
else
  fail "unrecognized prompt: non-zero exit, screen quoted, no key sent" "rc=$rc out=$out keys=$(cat "$STATE/keys" 2>/dev/null)"
fi

# An unreachable ircd is 'we could not look', not 'the agent never joined'.
touch "$STATE/probe_broken"
out="$(await_spawn_ready roost-x testnick "$TDIR" 2 2>&1)"; rc=$?
if [ "$rc" -eq 6 ] && grep -q "unverified, not failed" <<<"$out"; then
  ok "probe failure is reported as unverified rather than as a stall"
else
  fail "probe failure is reported as unverified rather than as a stall" "rc=$rc out=$out"
fi
rm -f "$STATE/probe_broken"

# A session that dies fails immediately instead of burning the timeout.
touch "$STATE/dead"
tmux() { case "$1" in has-session) return 1 ;; esac; return 0; }
out="$(await_spawn_ready roost-x testnick "$TDIR" 60 2>&1)"; rc=$?
if [ "$rc" -eq 6 ] && grep -q "exited before joining IRC" <<<"$out"; then
  ok "dead session fails fast"
else
  fail "dead session fails fast" "rc=$rc out=$out"
fi

# -- irc_nick_present against a real ircd -------------------------------------
# The loop tests above stub the probe, so on their own they'd stay green even
# if the probe were completely broken — which it was once: the first version
# used bash 4.1 dynamic fd allocation (`exec {fd}<>`), and on macOS's bash 3.2
# that failed `exec` terminated the whole spawn instantly, reported as success.
# These cases talk to a live ergo, or skip.

# The loop tests above export a stub probe; these cases need the real one.
unset ROOST_READY_PROBE

if (echo > /dev/tcp/"${IRC_HOST}"/"${IRC_PORT}") 2>/dev/null; then
  irc_nick_present "roost-definitely-absent-$$"; rc=$?
  [ "$rc" -eq 1 ] && ok "live probe: absent nick reports absent" \
    || fail "live probe: absent nick reports absent" "rc=$rc"

  # Hold a registered nick open, then look for it.
  present_nick="roostpresence$$"
  (
    exec 9<>/dev/tcp/"${IRC_HOST}"/"${IRC_PORT}" || exit 0
    printf 'NICK %s\r\nUSER %s 0 * :presence fixture\r\n' "$present_nick" "$present_nick" >&9
    while IFS= read -r -t 20 -u 9 line; do
      case "$line" in PING\ *) printf 'PONG %s\r\n' "${line#PING }" >&9 ;; esac
      [ -f "$TDIR/stop_presence" ] && break
    done
  ) &
  presence_pid=$!
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    irc_nick_present "$present_nick" && break
    command sleep 0.5
  done
  irc_nick_present "$present_nick"; rc=$?
  [ "$rc" -eq 0 ] && ok "live probe: registered nick reports present" \
    || fail "live probe: registered nick reports present" "rc=$rc"
  touch "$TDIR/stop_presence"
  kill "$presence_pid" 2>/dev/null
  wait "$presence_pid" 2>/dev/null

  # A port with nothing listening is 'could not look' (2), never 'absent' (1).
  ( IRC_PORT=6699; irc_nick_present "$present_nick" ); rc=$?
  [ "$rc" -eq 2 ] && ok "live probe: unreachable ircd reports probe failure, not absence" \
    || fail "live probe: unreachable ircd reports probe failure, not absence" "rc=$rc"
else
  echo "SKIP: live probe cases (no ircd on ${IRC_HOST}:${IRC_PORT})"
fi

echo
echo "passed: $PASS  failed: $FAIL"
[ "$FAIL" -eq 0 ]
