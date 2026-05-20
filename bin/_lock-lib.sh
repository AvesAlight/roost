# shellcheck shell=sh
# _lock-lib.sh — source this; do not execute directly.
#
# Sentinel lock primitives (mkdir-based). For the full two-flavor rationale
# (sentinel vs data-bearing O_EXCL) see src/fs-lock.ts.
#
# acquire_dir_lock <dir>       — atomic mkdir; 0 on win, non-zero on EEXIST
# release_dir_lock <dir>       — rm -rf the dir; idempotent
# dir_lock_fresh <dir> <ttl>  — true if dir is younger than <ttl> minutes

acquire_dir_lock() {
  mkdir "$1" 2>/dev/null
}

# Uses rm -rf for robustness. Sentinel lock dirs must stay empty — nothing
# should ever write into them. If something does, rm -rf silently removes it
# rather than surfacing the invariant break; add explicit checks at the call
# site if you need that guard.
release_dir_lock() {
  rm -rf "$1" 2>/dev/null || true
}

# Returns 0 (true) if the lock dir exists and its mtime is within the last
# <ttl_minutes> minutes. Returns 1 if stale or absent.
dir_lock_fresh() {
  [ -n "$(find "$1" -maxdepth 0 -mmin -"$2" -type d 2>/dev/null)" ]
}
