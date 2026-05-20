// Cross-plugin reply phrasing. Centralized here so a rename of
// `config.json` (or the broader operator-facing terminology) only flips
// one place — first-party plugins import from here rather than each
// re-coining the same line.

// Refusal line for "you tried to mutate a tracked entry; only the
// gitignored overlay is dispatcher-writable". `labelStr` is the
// plugin's already-formatted entry id (e.g. `pr #5`, `repo org/r@main`)
// so the surrounding sentence stays uniform across plugins.
export function trackedRefusal(labelStr: string, action: string): string {
  return `${labelStr} in tracked config.json — hand-edit to ${action}`
}
