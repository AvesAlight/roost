# shellcheck shell=sh
# _lock-lib.sh — source this; do not execute directly.
#
# Sentinel lock primitives (O_EXCL-create based). For the full two-flavor rationale
# (sentinel vs data-bearing O_EXCL) see src/fs-lock.ts.
#
# acquire_dir_lock <path>      — atomic exclusive create; 0 on win, non-zero if held
# release_dir_lock <path>      — rm -rf the path; idempotent
# dir_lock_fresh <path> <ttl>  — true if the lock is younger than <ttl> minutes
# reclaim_stale_dir_lock <path> <ttl>
#                              — clear a lock already judged stale, race-safely
#
# The helpers keep their "dir" names, but the lock is a sentinel *file*:
# `mkdir` is not a safe claim primitive. Ubuntu 25.10+ ships uutils coreutils,
# whose mkdir lets two concurrent callers both exit 0 on the same path. The
# claim is instead a shell-builtin O_EXCL create (`set -C` + redirect), which
# never goes through an external binary. A lock directory left behind by an
# older version still reads as held, ages out by mtime, and is removed by
# release_dir_lock (rm -rf).

acquire_dir_lock() {
  (set -C; : > "$1") 2>/dev/null
}

# Uses rm -rf so a legacy lock directory is removed as well as a file.
release_dir_lock() {
  rm -rf "$1" 2>/dev/null || true
}

# Returns 0 (true) if the lock exists and its mtime is within the last
# <ttl_minutes> minutes. Returns 1 if stale or absent.
dir_lock_fresh() {
  [ -n "$(find "$1" -maxdepth 0 -mmin -"$2" 2>/dev/null)" ]
}

# Clear a lock the caller has judged stale. A bare rm races: between the
# staleness check and the rm, another claimant can clear the lock and
# re-claim it, and our rm would delete their fresh lock. So removal takes a
# short-lived reclaim token (<path>.reclaim, same O_EXCL create), re-checks
# staleness while holding it, and only then removes. Only the token holder
# removes, and a new lock can't be created while the stale one still exists,
# so the re-check can't be invalidated.
#
# Returns 0 when the path is clear for the caller to try acquire_dir_lock
# (acquire still arbitrates between racers). Returns 1 when the lock is held:
# it was re-claimed fresh, or another invocation holds the reclaim token. A
# token older than <ttl> was abandoned by a crashed holder and is dropped.
reclaim_stale_dir_lock() {
  _rsdl_tok="$1.reclaim"
  if ! acquire_dir_lock "$_rsdl_tok"; then
    dir_lock_fresh "$_rsdl_tok" "$2" || release_dir_lock "$_rsdl_tok"
    return 1
  fi
  if [ -e "$1" ]; then
    if dir_lock_fresh "$1" "$2"; then
      release_dir_lock "$_rsdl_tok"
      return 1
    fi
    # Only remove what we just saw. If the lock was absent, a claimant may
    # have created it since, and removing it would break their claim.
    release_dir_lock "$1"
  fi
  release_dir_lock "$_rsdl_tok"
  return 0
}
