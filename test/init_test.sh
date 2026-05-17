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
  # Cleanup on exit in case a test panics before teardown.
  trap 'cd / 2>/dev/null; rm -rf "$TDIR"' EXIT
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
dry_out="$(roost_init --dry-run 2>/dev/null)"
if echo "$dry_out" | grep -q '"project"' \
    && [ ! -f "${TDIR}/.orchestrator/config.json" ]; then
  ok "--dry-run: no files written, content printed"
else
  fail "--dry-run: no files written, content printed"
fi
cd - >/dev/null
teardown

# --- --dry-run on existing config: works without --force ---

setup "https://github.com/TestOwner/myproject.git"
cd "$TDIR"
mkdir -p .orchestrator
echo '{"old": true}' > .orchestrator/config.json
dry_out="$(roost_init --dry-run 2>/dev/null)"
if echo "$dry_out" | grep -q '"project"' \
    && echo "$dry_out" | grep -q 'state.json'; then
  ok "--dry-run: bypasses existing-config guard"
else
  fail "--dry-run: bypasses existing-config guard"
fi
cd - >/dev/null
teardown

# --- --dry-run: lists prompts/agents even when they already exist ---

setup "https://github.com/TestOwner/myproject.git"
cd "$TDIR"
roost_init >/dev/null 2>&1
dry_out="$(roost_init --dry-run 2>/dev/null)"
if echo "$dry_out" | grep -q 'worker.md' \
    && echo "$dry_out" | grep -q 'lead-pm.md'; then
  ok "--dry-run: shows prompts/agents unconditionally when files exist"
else
  fail "--dry-run: shows prompts/agents unconditionally when files exist"
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

# --- --force: also overwrites .gitignore ---

setup "https://github.com/TestOwner/myproject.git"
cd "$TDIR"
mkdir -p .orchestrator
echo '{"old": true}' > .orchestrator/config.json
printf 'old-entry\n' > .orchestrator/.gitignore
if roost_init --force >/dev/null 2>&1 \
    && ! grep -q 'old-entry' "${TDIR}/.orchestrator/.gitignore" \
    && grep -q 'state.json' "${TDIR}/.orchestrator/.gitignore"; then
  ok "--force: overwrites .gitignore"
else
  fail "--force: overwrites .gitignore"
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

# --- prompts: fresh copy ---

setup "https://github.com/TestOwner/myproject.git"
cd "$TDIR"
if roost_init >/dev/null 2>&1 \
    && [ -f "${TDIR}/.claude/commands/worker.md" ] \
    && [ -f "${TDIR}/.claude/commands/reviewer.md" ] \
    && [ -f "${TDIR}/.claude/commands/watcher.md" ]; then
  ok "prompts: fresh copy to .claude/commands/"
else
  fail "prompts: fresh copy to .claude/commands/"
fi
cd - >/dev/null
teardown

# --- agents: fresh copy ---

setup "https://github.com/TestOwner/myproject.git"
cd "$TDIR"
if roost_init >/dev/null 2>&1 \
    && [ -f "${TDIR}/.claude/agents/lead-pm.md" ] \
    && [ -f "${TDIR}/.claude/agents/associate-pm.md" ]; then
  ok "agents: fresh copy to .claude/agents/"
else
  fail "agents: fresh copy to .claude/agents/"
fi
cd - >/dev/null
teardown

# --- prompts: skip existing (idempotent) ---

setup "https://github.com/TestOwner/myproject.git"
cd "$TDIR"
mkdir -p .claude/commands
echo 'custom content' > .claude/commands/worker.md
roost_init >/dev/null 2>&1
if grep -q 'custom content' "${TDIR}/.claude/commands/worker.md"; then
  ok "prompts: existing file not overwritten without --force-prompts"
else
  fail "prompts: existing file not overwritten without --force-prompts"
fi
cd - >/dev/null
teardown

# --- prompts: --force overwrites (implies --force-prompts) ---

setup "https://github.com/TestOwner/myproject.git"
cd "$TDIR"
mkdir -p .claude/commands .orchestrator
echo '{"old": true}' > .orchestrator/config.json
echo 'custom content' > .claude/commands/worker.md
if roost_init --force >/dev/null 2>&1 \
    && ! grep -q 'custom content' "${TDIR}/.claude/commands/worker.md" \
    && grep -q 'description' "${TDIR}/.claude/commands/worker.md"; then
  ok "prompts: --force overwrites prompts"
else
  fail "prompts: --force overwrites prompts"
fi
cd - >/dev/null
teardown

# --- prompts: --force-prompts overwrites ---

setup "https://github.com/TestOwner/myproject.git"
cd "$TDIR"
mkdir -p .claude/commands
echo 'custom content' > .claude/commands/worker.md
roost_init --force-prompts >/dev/null 2>&1
if ! grep -q 'custom content' "${TDIR}/.claude/commands/worker.md" \
    && grep -q 'description' "${TDIR}/.claude/commands/worker.md"; then
  ok "prompts: --force-prompts overwrites existing"
else
  fail "prompts: --force-prompts overwrites existing"
fi
cd - >/dev/null
teardown

# --- prompts: --no-prompts skips copy ---

setup "https://github.com/TestOwner/myproject.git"
cd "$TDIR"
roost_init --no-prompts >/dev/null 2>&1
if [ ! -d "${TDIR}/.claude/commands" ] \
    || [ ! -f "${TDIR}/.claude/commands/worker.md" ]; then
  ok "prompts: --no-prompts skips copy"
else
  fail "prompts: --no-prompts skips copy"
fi
cd - >/dev/null
teardown

# --- agents: existing file not overwritten without --force-agents ---

setup "https://github.com/TestOwner/myproject.git"
cd "$TDIR"
mkdir -p .claude/agents
echo 'custom content' > .claude/agents/lead-pm.md
roost_init >/dev/null 2>&1
if grep -q 'custom content' "${TDIR}/.claude/agents/lead-pm.md"; then
  ok "agents: existing file not overwritten without --force-agents"
else
  fail "agents: existing file not overwritten without --force-agents"
fi
cd - >/dev/null
teardown

# --- agents: --force-agents overwrites existing ---

setup "https://github.com/TestOwner/myproject.git"
cd "$TDIR"
mkdir -p .claude/agents
echo 'custom content' > .claude/agents/lead-pm.md
roost_init --force-agents >/dev/null 2>&1
if ! grep -q 'custom content' "${TDIR}/.claude/agents/lead-pm.md" \
    && grep -q 'name' "${TDIR}/.claude/agents/lead-pm.md"; then
  ok "agents: --force-agents overwrites existing"
else
  fail "agents: --force-agents overwrites existing"
fi
cd - >/dev/null
teardown

# --- agents: --no-agents skips copy ---

setup "https://github.com/TestOwner/myproject.git"
cd "$TDIR"
roost_init --no-agents >/dev/null 2>&1
if [ ! -d "${TDIR}/.claude/agents" ] \
    || [ ! -f "${TDIR}/.claude/agents/lead-pm.md" ]; then
  ok "agents: --no-agents skips copy"
else
  fail "agents: --no-agents skips copy"
fi
cd - >/dev/null
teardown

# --- summary ---

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ]
