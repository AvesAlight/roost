# shellcheck shell=bash
# _bun-lib.sh — source this; do not execute directly.
#
# find_bun  — resolve bun binary; prints path to stdout; exits 1 with a
#             diagnostic on stderr if bun cannot be found.
#
# Resolution order:
#   1. $BUN_BIN — explicit operator override; hard-errors if set but not executable
#   2. $BUN_INSTALL/bin/bun — bun installer convention
#   3. $HOME/.bun/bin/bun — default from-source install location
#   4. command -v bun — PATH fallback (homebrew, system packages)

find_bun() {
  local candidate
  local script
  script="$(basename "$0")"

  # Explicit operator override — hard-error if set but not executable.
  if [ -n "${BUN_BIN:-}" ]; then
    if [ -x "${BUN_BIN}" ]; then
      printf '%s' "${BUN_BIN}"; return 0
    fi
    printf '%s: BUN_BIN=%s is not executable\n' "${script}" "${BUN_BIN}" >&2
    return 1
  fi

  # bun installer convention: $BUN_INSTALL/bin/bun (default ~/.bun).
  if [ -n "${BUN_INSTALL:-}" ]; then
    candidate="${BUN_INSTALL}/bin/bun"
    if [ -x "${candidate}" ]; then
      printf '%s' "${candidate}"; return 0
    fi
  fi

  # Default from-source install location.
  candidate="${HOME}/.bun/bin/bun"
  if [ -x "${candidate}" ]; then
    printf '%s' "${candidate}"; return 0
  fi

  # PATH fallback (homebrew, system packages, custom installs).
  if candidate="$(command -v bun 2>/dev/null)"; then
    printf '%s' "${candidate}"; return 0
  fi

  printf '%s: bun not found. Set BUN_BIN to the bun binary path or install bun (https://bun.sh).\n' "${script}" >&2
  return 1
}
