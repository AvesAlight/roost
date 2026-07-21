// Cross-plugin reply phrasing — one rename of `config.json` flips here only.

// Short commit SHA for relay lines. Null-safe: callers relay CI/commit
// events where the SHA may be unavailable (e.g. pre-first-push snapshots).
export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : '?'
}

// Refusal line when a DM tries to mutate a tracked entry — only the gitignored
// overlay is dispatcher-writable.
export function trackedRefusal(labelStr: string, action: string): string {
  return `${labelStr} in tracked config.json — hand-edit to ${action}`
}

// Union `channels` into `entry.channels`, returning the watch reply line.
// Shared tail of every plugin's applyWatch "entry exists locally" branch.
export function addChannelsToEntry(
  entry: { channels?: string[] },
  channels: string[],
  labelStr: string,
): string {
  if (!channels.length) return `already watching ${labelStr}`
  const existing = new Set(entry.channels ?? [])
  const added: string[] = []
  for (const c of channels) if (!existing.has(c)) { existing.add(c); added.push(c) }
  if (!added.length) return `${labelStr} channels unchanged`
  entry.channels = [...existing]
  return `${labelStr} + ${added.join(' ')}`
}

// Shared `unwatch` logic: splice a local entry, refuse a tracked-only one,
// or report no-such-entry. (Watch is left per-plugin — a shared helper there
// just trades a copy of the local-slice ensure pattern for a thunk callback.)
export function applyUnwatchEntry<E>(
  mergedEntries: E[],
  localEntries: E[],
  match: (e: E) => boolean,
  labelStr: string,
): string {
  const localIdx = localEntries.findIndex(match)
  if (localIdx >= 0) {
    localEntries.splice(localIdx, 1)
    return `unwatched ${labelStr}`
  }
  if (mergedEntries.some(match)) return trackedRefusal(labelStr, 'remove')
  return `not watching ${labelStr}`
}
