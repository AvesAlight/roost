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

# --- agent_logins: autodetected (single-repo) ---

setup ""
cd "$TDIR"
if roost_init --repo "TestOwner/myproject" >/dev/null 2>&1 \
    && grep -q '"agent_logins": \["testuser"\]' "${TDIR}/.orchestrator/config.json"; then
  ok "agent_logins: autodetected"
else
  fail "agent_logins: autodetected"
fi
cd - >/dev/null
teardown

# --- agent_logins: single --agent-login ---

setup ""
cd "$TDIR"
if roost_init --repo "TestOwner/myproject" --agent-login alice >/dev/null 2>&1 \
    && grep -q '"agent_logins": \["alice"\]' "${TDIR}/.orchestrator/config.json"; then
  ok "agent_logins: single flag"
else
  fail "agent_logins: single flag"
fi
cd - >/dev/null
teardown

# --- agent_logins: multiple --agent-login ---

setup ""
cd "$TDIR"
if roost_init --repo "TestOwner/myproject" --agent-login alice --agent-login bob >/dev/null 2>&1 \
    && grep -q '"agent_logins": \["alice","bob"\]' "${TDIR}/.orchestrator/config.json"; then
  ok "agent_logins: multiple flags"
else
  fail "agent_logins: multiple flags"
fi
cd - >/dev/null
teardown

# --- --project override ---

setup ""
cd "$TDIR"
if roost_init --repo "TestOwner/myproject" --project custom-name >/dev/null 2>&1 \
    && grep -q '"project": "custom-name"' "${TDIR}/.orchestrator/config.json"; then
  ok "--project override"
else
  fail "--project override"
fi
cd - >/dev/null
teardown

# --- --repo flag wires single-repo ---

setup ""
cd "$TDIR"
if roost_init --repo "SomeOwner/other-repo" >/dev/null 2>&1 \
    && grep -q '"repo": "SomeOwner/other-repo"' "${TDIR}/.orchestrator/config.json"; then
  ok "--repo: wires single-repo"
else
  fail "--repo: wires single-repo"
fi
cd - >/dev/null
teardown

# --- --dry-run: prints content, writes nothing ---

setup ""
cd "$TDIR"
dry_out="$(roost_init --repo "TestOwner/myproject" --dry-run 2>/dev/null)"
if echo "$dry_out" | grep -q '"project"' \
    && echo "$dry_out" | grep -q '"repo"' \
    && echo "$dry_out" | grep -q 'config.local.json' \
    && [ ! -f "${TDIR}/.orchestrator/config.json" ] \
    && [ ! -f "${TDIR}/.orchestrator/config.local.json" ]; then
  ok "--dry-run: no files written, content printed"
else
  fail "--dry-run: no files written, content printed"
fi
cd - >/dev/null
teardown

# --- --dry-run on existing config: works without --force ---

setup ""
cd "$TDIR"
mkdir -p .orchestrator
echo '{"old": true}' > .orchestrator/config.json
dry_out="$(roost_init --repo "TestOwner/myproject" --dry-run 2>/dev/null)"
if echo "$dry_out" | grep -q '"project"' \
    && echo "$dry_out" | grep -q 'state.json'; then
  ok "--dry-run: bypasses existing-config guard"
else
  fail "--dry-run: bypasses existing-config guard"
fi
cd - >/dev/null
teardown

# --- --dry-run: lists prompts/agents even when they already exist ---

setup ""
cd "$TDIR"
dry_out=""
if roost_init --repo "TestOwner/myproject" >/dev/null 2>&1; then
  dry_out="$(roost_init --repo "TestOwner/myproject" --dry-run 2>/dev/null)"
fi
if echo "$dry_out" | grep -q 'worker.md' \
    && echo "$dry_out" | grep -q 'lead-pm.md'; then
  ok "--dry-run: shows prompts/agents unconditionally when files exist"
else
  fail "--dry-run: shows prompts/agents unconditionally when files exist"
fi
cd - >/dev/null
teardown

# --- --force: overwrites existing config ---

setup ""
cd "$TDIR"
mkdir -p .orchestrator
echo '{"old": true}' > .orchestrator/config.json
if roost_init --repo "TestOwner/myproject" --force >/dev/null 2>&1 \
    && grep -q '"project"' "${TDIR}/.orchestrator/config.json" \
    && ! grep -q '"old"' "${TDIR}/.orchestrator/config.json"; then
  ok "--force: overwrites existing"
else
  fail "--force: overwrites existing"
fi
cd - >/dev/null
teardown

# --- --force: also overwrites .gitignore ---

setup ""
cd "$TDIR"
mkdir -p .orchestrator
echo '{"old": true}' > .orchestrator/config.json
printf 'old-entry\n' > .orchestrator/.gitignore
if roost_init --repo "TestOwner/myproject" --force >/dev/null 2>&1 \
    && ! grep -q 'old-entry' "${TDIR}/.orchestrator/.gitignore" \
    && grep -q 'state.json' "${TDIR}/.orchestrator/.gitignore"; then
  ok "--force: overwrites .gitignore"
else
  fail "--force: overwrites .gitignore"
fi
cd - >/dev/null
teardown

# --- .gitignore written ---

setup ""
cd "$TDIR"
roost_init --repo "TestOwner/myproject" >/dev/null 2>&1
if grep -q 'config.local.json' "${TDIR}/.orchestrator/.gitignore" \
    && grep -q 'state.json'     "${TDIR}/.orchestrator/.gitignore" \
    && grep -q 'last-tick.txt'  "${TDIR}/.orchestrator/.gitignore" \
    && grep -q 'last-error.txt' "${TDIR}/.orchestrator/.gitignore" \
    && ! grep -q '^config\.json$' "${TDIR}/.orchestrator/.gitignore"; then
  ok ".gitignore: covers config.local.json + state, leaves config.json tracked"
else
  fail ".gitignore: covers config.local.json + state, leaves config.json tracked"
fi
cd - >/dev/null
teardown

# --- config.local.json scaffold written ---

setup ""
cd "$TDIR"
roost_init --repo "TestOwner/myproject" >/dev/null 2>&1
if [ -f "${TDIR}/.orchestrator/config.local.json" ] \
    && grep -q '"github-prs"' "${TDIR}/.orchestrator/config.local.json" \
    && grep -q '"github-issues"' "${TDIR}/.orchestrator/config.local.json"; then
  ok "config.local.json: scaffold written"
else
  fail "config.local.json: scaffold written"
fi
cd - >/dev/null
teardown

# --- --force overwrites config.local.json too ---

setup ""
cd "$TDIR"
mkdir -p .orchestrator
echo '{"old": true}' > .orchestrator/config.json
echo '{"stale": true}' > .orchestrator/config.local.json
if roost_init --repo "TestOwner/myproject" --force >/dev/null 2>&1 \
    && grep -q '"github-prs"' "${TDIR}/.orchestrator/config.local.json" \
    && ! grep -q '"stale"' "${TDIR}/.orchestrator/config.local.json"; then
  ok "--force: overwrites config.local.json"
else
  fail "--force: overwrites config.local.json"
fi
cd - >/dev/null
teardown

# --- error: existing config without --force ---

setup ""
cd "$TDIR"
mkdir -p .orchestrator
echo '{}' > .orchestrator/config.json
if ! roost_init --repo "TestOwner/myproject" >/dev/null 2>&1; then
  ok "error: existing config rejected without --force"
else
  fail "error: existing config rejected without --force"
fi
cd - >/dev/null
teardown

# --- outside-git + --repo: succeeds ---

TDIR="$(mktemp -d /tmp/roost-test-XXXXXXXX)"
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
cd "$TDIR"
if PATH="${STUBS}:${PATH}" "${ROOST_BIN}" init --repo "SomeOwner/cross-repo" >/dev/null 2>&1 \
    && grep -q '"repo": "SomeOwner/cross-repo"' "${TDIR}/.orchestrator/config.json"; then
  ok "outside-git + --repo: succeeds"
else
  fail "outside-git + --repo: succeeds"
fi
cd - >/dev/null
rm -rf "$TDIR"

# --- error: no mode flag → clear usage hint ---

TDIR="$(mktemp -d /tmp/roost-test-XXXXXXXX)"
STUBS="${TDIR}/.stubs"
mkdir -p "$STUBS"
cat > "${STUBS}/gh" <<'EOF'
#!/usr/bin/env bash
case "$1 ${2:-}" in
  "auth status")  exit 0 ;;
  *)              echo "gh-stub: unhandled: $*" >&2; exit 1 ;;
esac
EOF
chmod +x "${STUBS}/gh"
cd "$TDIR"
err_out="$(PATH="${STUBS}:${PATH}" "${ROOST_BIN}" init 2>&1)"
exit_code=$?
if [ "$exit_code" -ne 0 ] \
    && echo "$err_out" | grep -q "\-\-repo" \
    && echo "$err_out" | grep -q "\-\-multi-repo"; then
  ok "error: no mode flag gives usage hint naming both modes"
else
  fail "error: no mode flag gives usage hint naming both modes"
fi
cd - >/dev/null
rm -rf "$TDIR"

# --- error: --repo and --multi-repo together ---

setup ""
cd "$TDIR"
err_out="$(roost_init --repo "TestOwner/myproject" --multi-repo 2>&1)"
exit_code=$?
if [ "$exit_code" -ne 0 ] && echo "$err_out" | grep -q "mutually exclusive"; then
  ok "error: --repo and --multi-repo are mutually exclusive"
else
  fail "error: --repo and --multi-repo are mutually exclusive"
fi
cd - >/dev/null
teardown

# --- prompts: fresh copy ---

setup ""
cd "$TDIR"
if roost_init --repo "TestOwner/myproject" >/dev/null 2>&1 \
    && [ -f "${TDIR}/.claude/commands/worker.md" ]; then
  ok "prompts: fresh copy to .claude/commands/"
else
  fail "prompts: fresh copy to .claude/commands/"
fi
cd - >/dev/null
teardown

# --- agents: fresh copy ---

setup ""
cd "$TDIR"
if roost_init --repo "TestOwner/myproject" >/dev/null 2>&1 \
    && [ -f "${TDIR}/.claude/agents/lead-pm.md" ] \
    && [ -f "${TDIR}/.claude/agents/associate-pm.md" ] \
    && [ -f "${TDIR}/.claude/agents/reviewer.md" ]; then
  ok "agents: fresh copy to .claude/agents/"
else
  fail "agents: fresh copy to .claude/agents/"
fi
cd - >/dev/null
teardown

# --- prompts: skip existing (idempotent) ---

setup ""
cd "$TDIR"
mkdir -p .claude/commands
echo 'custom content' > .claude/commands/worker.md
roost_init --repo "TestOwner/myproject" >/dev/null 2>&1
if grep -q 'custom content' "${TDIR}/.claude/commands/worker.md"; then
  ok "prompts: existing file not overwritten without --force-prompts"
else
  fail "prompts: existing file not overwritten without --force-prompts"
fi
cd - >/dev/null
teardown

# --- prompts: --force overwrites (implies --force-prompts) ---

setup ""
cd "$TDIR"
mkdir -p .claude/commands .orchestrator
echo '{"old": true}' > .orchestrator/config.json
echo 'custom content' > .claude/commands/worker.md
if roost_init --repo "TestOwner/myproject" --force >/dev/null 2>&1 \
    && ! grep -q 'custom content' "${TDIR}/.claude/commands/worker.md" \
    && grep -q 'description' "${TDIR}/.claude/commands/worker.md"; then
  ok "prompts: --force overwrites prompts"
else
  fail "prompts: --force overwrites prompts"
fi
cd - >/dev/null
teardown

# --- prompts: --force-prompts overwrites (no mode flag when config.json exists) ---

setup ""
cd "$TDIR"
mkdir -p .claude/commands .orchestrator
echo '{"project":"test"}' > .orchestrator/config.json
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

# --- prompts: --force-prompts without config.json requires mode flag ---

setup ""
cd "$TDIR"
mkdir -p .claude/commands
echo 'custom content' > .claude/commands/worker.md
if ! roost_init --force-prompts >/dev/null 2>&1; then
  ok "prompts: --force-prompts without config.json requires mode flag"
else
  fail "prompts: --force-prompts without config.json requires mode flag"
fi
cd - >/dev/null
teardown

# --- prompts: --no-prompts skips copy ---

setup ""
cd "$TDIR"
roost_init --repo "TestOwner/myproject" --no-prompts >/dev/null 2>&1
if [ ! -d "${TDIR}/.claude/commands" ] \
    || [ ! -f "${TDIR}/.claude/commands/worker.md" ]; then
  ok "prompts: --no-prompts skips copy"
else
  fail "prompts: --no-prompts skips copy"
fi
cd - >/dev/null
teardown

# --- agents: existing file not overwritten without --force-agents ---

setup ""
cd "$TDIR"
mkdir -p .claude/agents
echo 'custom content' > .claude/agents/lead-pm.md
roost_init --repo "TestOwner/myproject" >/dev/null 2>&1
if grep -q 'custom content' "${TDIR}/.claude/agents/lead-pm.md"; then
  ok "agents: existing file not overwritten without --force-agents"
else
  fail "agents: existing file not overwritten without --force-agents"
fi
cd - >/dev/null
teardown

# --- agents: --force-agents overwrites existing (no mode flag when config.json exists) ---

setup ""
cd "$TDIR"
mkdir -p .claude/agents .orchestrator
echo '{"project":"test"}' > .orchestrator/config.json
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

setup ""
cd "$TDIR"
roost_init --repo "TestOwner/myproject" --no-agents >/dev/null 2>&1
if [ ! -d "${TDIR}/.claude/agents" ] \
    || [ ! -f "${TDIR}/.claude/agents/lead-pm.md" ]; then
  ok "agents: --no-agents skips copy"
else
  fail "agents: --no-agents skips copy"
fi
cd - >/dev/null
teardown

# --- multi-repo: skeleton has no repo field, plugins: {} ---

setup ""
cd "$TDIR"
if roost_init --multi-repo >/dev/null 2>&1 \
    && ! grep -q '"repo"' "${TDIR}/.orchestrator/config.json" \
    && grep -q '"plugins": {}' "${TDIR}/.orchestrator/config.json" \
    && grep -q '"project"' "${TDIR}/.orchestrator/config.json"; then
  ok "--multi-repo: skeleton has no repo key and plugins: {}"
else
  fail "--multi-repo: skeleton has no repo key and plugins: {}"
fi
cd - >/dev/null
teardown

# --- multi-repo: --project override ---

setup ""
cd "$TDIR"
if roost_init --multi-repo --project my-services >/dev/null 2>&1 \
    && grep -q '"project": "my-services"' "${TDIR}/.orchestrator/config.json" \
    && ! grep -q '"repo"' "${TDIR}/.orchestrator/config.json"; then
  ok "--multi-repo: --project override works"
else
  fail "--multi-repo: --project override works"
fi
cd - >/dev/null
teardown

# --- multi-repo: --dry-run shows multi-repo skeleton ---

setup ""
cd "$TDIR"
dry_out="$(roost_init --multi-repo --dry-run 2>/dev/null)"
if echo "$dry_out" | grep -q '"project"' \
    && echo "$dry_out" | grep -q '"plugins": {}' \
    && ! echo "$dry_out" | grep -q '"repo"' \
    && [ ! -f "${TDIR}/.orchestrator/config.json" ]; then
  ok "--multi-repo --dry-run: shows multi-repo content, writes nothing"
else
  fail "--multi-repo --dry-run: shows multi-repo content, writes nothing"
fi
cd - >/dev/null
teardown

# --- summary ---

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ]
