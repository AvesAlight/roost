#!/usr/bin/env bash
# Tests for `roost --version` / `-v`. Plain bash, no bats.
# Run: bash test/version_test.sh
set -uo pipefail

ROOST_BIN="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )/bin/roost"
REPO="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"
PASS=0
FAIL=0

ok()   { echo "PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "FAIL: $1 ${2:+— $2}"; FAIL=$((FAIL+1)); }

expected_version="$(grep -m1 '"version"' "${REPO}/package.json" | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/')"
expected="roost ${expected_version}"

out_long="$("${ROOST_BIN}" --version)"
if [ "$out_long" = "$expected" ]; then
  ok "roost --version prints the package.json version"
else
  fail "roost --version prints the package.json version" "got=[$out_long] want=[$expected]"
fi

out_short="$("${ROOST_BIN}" -v)"
if [ "$out_short" = "$expected" ]; then
  ok "roost -v prints the package.json version"
else
  fail "roost -v prints the package.json version" "got=[$out_short] want=[$expected]"
fi

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ]
