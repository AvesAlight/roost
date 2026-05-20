// Shared DM-grammar parsers. Each plugin's `parseCommand` picks one of these
// helpers, passes its claimed target keyword, and the helper does tokenization
// + shape disambiguation. Plugins own which targets they claim; the dispatcher
// stays grammar-agnostic.

const CHANNEL_RE = /^#[^\s,#]+$/

// Bare `<owner>/<repo>` — optional repo positional in the per-N grammar.
// Disambiguated from channels (start with `#`) and numbers (all digits) on shape.
const OWNER_REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/

// Full repo-shape spec — `org/r[@branch[:path]]`. Mirrors github-commits'
// state key so a daemon.log line copy-pastes into a DM.
const REPO_SPEC_RE = /^([A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*)(?:@([^:@\s]+))?(?::([^\s]+))?$/

// Reserved verbs — can't shadow as targets.
const VERBS = new Set(['watch', 'unwatch', 'help'])

export type Verb = 'watch' | 'unwatch'

// Returned to the dispatcher. `null` = not my shape, try next plugin.
// `error` = claimed-but-malformed; dispatcher aborts iteration (no other plugin
// gets a second crack at a line whose shape this plugin already owned).
export type ParseResult<T> =
  | { kind: 'ok'; cmd: T }
  | { kind: 'error'; message: string }

export interface PerNCommand {
  verb: Verb
  number: number
  repo: string | null
  channels: string[]
}

export interface PerRepoCommand {
  verb: Verb
  repo: string
  branch: string | null
  path: string | null
  channels: string[]
}

// Split a DM body into individual command lines. Newlines, semicolons, commas separate.
export function splitCommands(text: string): string[] {
  return text
    .split(/[\n;,]+/)
    .map(s => s.trim())
    .filter(Boolean)
}

// Tokenize a single line: lowercase verb + raw tail tokens.
// Returns null when the line doesn't start with watch/unwatch (so plugins
// short-circuit on lines they obviously don't own).
export function tokenizeVerbLine(line: string): { verb: Verb; tokens: string[] } | null {
  const tokens = line.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return null
  const verb = tokens[0].toLowerCase()
  if (verb !== 'watch' && verb !== 'unwatch') return null
  return { verb, tokens: tokens.slice(1) }
}

// Try to claim a per-N line for `target` (null = bare `watch <N>`). Returns:
//   - `null` if the line isn't watch/unwatch, or doesn't lead with this target,
//     or the spec token shape is repo-style (-> a per-repo plugin should claim).
//   - `{kind:'ok',cmd}` on a clean claim.
//   - `{kind:'error',msg}` when the line claimed this plugin's target but the
//     body fails validation (bad number, malformed channel, etc.).
export function tryClaimPerN(target: string | null, line: string): ParseResult<PerNCommand> | null {
  const parsed = tokenizeVerbLine(line)
  if (!parsed) return null
  const { verb, tokens } = parsed
  const targetMatch = matchTarget(target, tokens)
  if (targetMatch === null) return null
  const rest = tokens.slice(targetMatch)

  const specTok = rest[0]
  if (specTok === undefined) {
    // Verb + target with no spec — claim the shape, fail the body.
    return { kind: 'error', message: `${verb} requires an issue/PR number` }
  }
  // Repo-shape token here is not a per-N claim — a per-repo plugin owns it.
  if (REPO_SPEC_RE.test(specTok)) return null
  if (!/^\d+$/.test(specTok)) {
    return { kind: 'error', message: `${verb}: "${specTok}" is not a positive integer` }
  }
  const number = parseInt(specTok, 10)
  if (number <= 0) {
    return { kind: 'error', message: `${verb}: "${specTok}" is not a positive integer` }
  }

  let i = 1
  let repo: string | null = null
  if (rest[i] !== undefined && OWNER_REPO_RE.test(rest[i])) {
    repo = rest[i]
    i += 1
  }

  const channels = rest.slice(i)
  if (verb === 'unwatch') {
    if (channels.length) return { kind: 'error', message: 'unwatch takes no channel arguments' }
    return { kind: 'ok', cmd: { verb, number, repo, channels: [] } }
  }
  for (const c of channels) {
    if (!CHANNEL_RE.test(c)) {
      return { kind: 'error', message: `channels must match ${CHANNEL_RE.source}: got "${c}"` }
    }
  }
  return { kind: 'ok', cmd: { verb, number, repo, channels } }
}

// Try to claim a per-repo line for `target`. `target=null` accepts bare
// `watch <owner>/<repo>` — generic per-repo plugins can opt in.
export function tryClaimPerRepo(target: string | null, line: string): ParseResult<PerRepoCommand> | null {
  const parsed = tokenizeVerbLine(line)
  if (!parsed) return null
  const { verb, tokens } = parsed
  const targetMatch = matchTarget(target, tokens)
  if (targetMatch === null) return null
  const rest = tokens.slice(targetMatch)

  const specTok = rest[0]
  if (specTok === undefined) {
    return { kind: 'error', message: `${verb} requires an <owner>/<repo> spec` }
  }
  const m = specTok.match(REPO_SPEC_RE)
  if (!m) {
    // Numeric spec here is not a per-repo claim — a per-N plugin owns it.
    if (/^\d+$/.test(specTok)) return null
    return { kind: 'error', message: `${verb}: "${specTok}" is not a valid <owner>/<repo>[@<branch>[:<path>]] spec` }
  }

  const repo = m[1]
  const branch = m[2] ?? null
  const path = m[3] ?? null
  const channels = rest.slice(1)
  if (verb === 'unwatch') {
    if (channels.length) return { kind: 'error', message: 'unwatch takes no channel arguments' }
    return { kind: 'ok', cmd: { verb, repo, branch, path, channels: [] } }
  }
  for (const c of channels) {
    if (!CHANNEL_RE.test(c)) {
      return { kind: 'error', message: `channels must match ${CHANNEL_RE.source}: got "${c}"` }
    }
  }
  return { kind: 'ok', cmd: { verb, repo, branch, path, channels } }
}

// Returns the index of the first non-target token in `tokens`, or null when
// `target` is set but doesn't appear at position 0. `target=null` means the
// plugin claims bare verbs; we still reject a leading reserved verb so
// `watch unwatch 5` (almost certainly a typo) doesn't silently become target=unwatch.
function matchTarget(target: string | null, tokens: string[]): number | null {
  if (target === null) {
    const first = tokens[0]
    if (first === undefined) return 0
    // A first token that's a reserved verb is a typo — not our claim, not a
    // valid bare-target shape. Defer; the dispatcher will surface unknown.
    if (VERBS.has(first.toLowerCase())) return null
    // A target keyword (non-numeric, non-repo-shape, non-channel) is claimed
    // by some other plugin — we only own bare `watch <N>` or `watch <repo>`.
    if (!/^\d+$/.test(first) && !REPO_SPEC_RE.test(first) && !CHANNEL_RE.test(first)) {
      return null
    }
    return 0
  }
  if (tokens[0]?.toLowerCase() !== target) return null
  return 1
}
