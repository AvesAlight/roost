#!/usr/bin/env bash
# Tests for `roost init`. Plain bash, no bats required.
# Run: bash test/init_test.sh
set -uo pipefail

ROOST_BIN="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )/bin/roost"
PASS=0
FAIL=0
TDIR=""
STUBS=""

ok()   { echo "PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

setup() {
  local remote_url="${1:-}"
  # Template uses only dashes so basename matches the project-name regex.
  TDIR="$(mktemp -d /tmp/roost-test-XXXXXXXX)"
  git -C "$TDIR" init -q
  if [ -n "$remote_url" ]; then
    git -C "$TDIR" remote add origin "$remote_url"
  fi
  STUBS="${TDIR}/.stubs"
  mkdir -p "$STUBS"
  cat > "${STUBS}/gh" <<'EOF'
#!/usr/bin/env bash
case "$1 ${2:-}" in
  "auth status")  exit 0 ;;
  "api user")     echo "testuser" ;;
  "repo view")    exit 0 ;;
  *)              echo "gh-stub: unhandled: $*" >&2; exit 1 ;;
esac
EOF
  chmod +x "${STUBS}/gh"
}

teardown() { rm -rf "$TDIR"; }

roost_init() {
  PATH="${STUBS}:${PATH}" "${ROOST_BIN}" init "$@"
}

assert_json() {
  local file="$1" field="$2" expected="$3"
  local actual
  actual="$(grep "\"${field}\"" "$file" | sed 's/.*: //' | tr -d ' ,')"
  if [ "$actual" = "$expected" ]; then return 0; fi
  echo "  expected ${field}=${expected}, got ${actual}" >&2
  return 1
}

# --- URL parsing: all four remote shapes ---

for shape in \
  "git@github.com:TestOwner/myproject.git" \
  "https://github.com/TestOwner/myproject.git" \
  "https://github.com/TestOwner/myproject" \
  "ssh://git@github.com/TestOwner/myproject.git"; do
  setup "$shape"
  cd "$TDIR"
  if roost_init >/dev/null 2>&1 \
      && grep -q '"repo": "TestOwner/myproject"' "${TDIR}/.orchestrator/config.json"; then
    ok "url-parse: ${shape}"
  else
    fail "url-parse: ${shape}"
  fi
  cd - >/dev/null
  teardown
done

# --- agent_logins: autodetected (single) ---

setup "https://github.com/TestOwner/myproject.git"
cd "$TDIR"
if roost_init >/dev/null 2>&1 \
    && grep -q '"agent_logins": \["testuser"\]' "${TDIR}/.orchestrator/config.json"; then
  ok "agent_logins: autodetected"
else
  fail "agent_logins: autodetected"
fi
cd - >/dev/null
teardown

# --- agent_logins: single --agent-login ---

setup "https://github.com/TestOwner/myproject.git"
cd "$TDIR"
if roost_init --agent-login alice >/dev/null 2>&1 \
    && grep -q '"agent_logins": \["alice"\]' "${TDIR}/.orchestrator/config.json"; then
  ok "agent_logins: single flag"
else
  fail "agent_logins: single flag"
fi
cd - >/dev/null
teardown

# --- agent_logins: multiple --agent-login ---

setup "https://github.com/TestOwner/myproject.git"
cd "$TDIR"
if roost_init --agent-login alice --agent-login bob >/dev/null 2>&1 \
    && grep -q '"agent_logins": \["alice","bob"\]' "${TDIR}/.orchestrator/config.json"; then
  ok "agent_logins: multiple flags"
else
  fail "agent_logins: multiple flags"
fi
cd - >/dev/null
teardown

# --- --project override ---

setup "https://github.com/TestOwner/myproject.git"
cd "$TDIR"
if roost_init --project custom-name >/dev/null 2>&1 \
    && grep -q '"project": "custom-name"' "${TDIR}/.orchestrator/config.json"; then
  ok "--project override"
else
  fail "--project override"
fi
cd - >/dev/null
teardown

# --- --repo override (no remote needed) ---

setup ""
cd "$TDIR"
if roost_init --repo "SomeOwner/other-repo" >/dev/null 2>&1 \
    && grep -q '"repo": "SomeOwner/other-repo"' "${TDIR}/.orchestrator/config.json"; then
  ok "--repo override"
else
  fail "--repo override"
fi
cd - >/dev/null
teardown

# --- --dry-run: prints content, writes nothing ---

setup "https://github.com/TestOwner/myproject.git"
cd "$TDIR"
if roost_init --dry-run 2>/dev/null | grep -q '"project"' \
    && [ ! -f "${TDIR}/.orchestrator/config.json" ]; then
  ok "--dry-run: no files written, content printed"
else
  fail "--dry-run: no files written, content printed"
fi
cd - >/dev/null
teardown

# --- --force: overwrites existing config ---

setup "https://github.com/TestOwner/myproject.git"
cd "$TDIR"
mkdir -p .orchestrator
echo '{"old": true}' > .orchestrator/config.json
if roost_init --force >/dev/null 2>&1 \
    && grep -q '"project"' "${TDIR}/.orchestrator/config.json" \
    && ! grep -q '"old"' "${TDIR}/.orchestrator/config.json"; then
  ok "--force: overwrites existing"
else
  fail "--force: overwrites existing"
fi
cd - >/dev/null
teardown

# --- .gitignore written ---

setup "https://github.com/TestOwner/myproject.git"
cd "$TDIR"
roost_init >/dev/null 2>&1
if grep -q 'state.json'     "${TDIR}/.orchestrator/.gitignore" \
    && grep -q 'last-tick.txt'  "${TDIR}/.orchestrator/.gitignore" \
    && grep -q 'last-error.txt' "${TDIR}/.orchestrator/.gitignore"; then
  ok ".gitignore: correct entries"
else
  fail ".gitignore: correct entries"
fi
cd - >/dev/null
teardown

# --- error: existing config without --force ---

setup "https://github.com/TestOwner/myproject.git"
cd "$TDIR"
mkdir -p .orchestrator
echo '{}' > .orchestrator/config.json
if ! roost_init >/dev/null 2>&1; then
  ok "error: existing config rejected without --force"
else
  fail "error: existing config rejected without --force"
fi
cd - >/dev/null
teardown

# --- error: not a git repo ---

TDIR="$(mktemp -d /tmp/roost-test-XXXXXXXX)"
STUBS="${TDIR}/.stubs"
mkdir -p "$STUBS"
# gh stub not needed — should fail before gh is called
cd "$TDIR"
if ! "${ROOST_BIN}" init >/dev/null 2>&1; then
  ok "error: not a git repo"
else
  fail "error: not a git repo"
fi
cd - >/dev/null
rm -rf "$TDIR"

# --- error: no origin remote without --repo ---

setup ""
cd "$TDIR"
if ! roost_init >/dev/null 2>&1; then
  ok "error: no origin remote"
else
  fail "error: no origin remote"
fi
cd - >/dev/null
teardown

# --- summary ---

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ]
