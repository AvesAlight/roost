// Shared DM-grammar parsers. Each plugin's `parseCommand` picks one of these
// helpers, passes its claimed target keyword, and the helper does tokenization
// + shape disambiguation. Plugins own which targets they claim; the dispatcher
// stays grammar-agnostic.

import type { ParseResult } from '../plugin.js'

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

export interface PerLinearIdCommand {
  verb: Verb
  identifier: string
  channels: string[]
}

// Linear identifier — uppercase team key, dash, positive integer. Strict by
// design: lowercase forms get a fixit so a typo doesn't silently land in a
// different plugin's slice.
const LINEAR_ID_RE = /^[A-Z]+-\d+$/
const LINEAR_ID_CI_RE = /^[A-Za-z]+-\d+$/

// Split a DM body into individual command lines. Newlines, semicolons, commas
// separate. Internal — exported so `dispatcher-dm-handler.ts` can import it
// from the same place plugins' parsers do; not re-exported via
// `plugin-api.ts` because plugin parsers receive a single already-split line.
export function splitCommands(text: string): string[] {
  return text
    .split(/[\n;,]+/)
    .map(s => s.trim())
    .filter(Boolean)
}

// Tokenize a single line: lowercase verb + raw tail tokens. Returns null
// when the line doesn't start with watch/unwatch so plugins short-circuit
// on lines they obviously don't own. Internal: plugins claim via tryClaimWatch.
function tokenizeVerbLine(line: string): { verb: Verb; tokens: string[] } | null {
  const tokens = line.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return null
  const verb = tokens[0].toLowerCase()
  if (verb !== 'watch' && verb !== 'unwatch') return null
  return { verb, tokens: tokens.slice(1) }
}

// What a spec matcher returns for the tokens after the target:
//   - `null` defers the line to another plugin (shape belongs elsewhere).
//   - `{error}` claims the line and fails it with that message.
//   - `{spec, consumed}` claims it; `consumed` tokens are the spec, the rest
//     are channels.
export type SpecMatch<S> = { spec: S; consumed: number } | { error: string } | null

export interface ClaimWatchOptions<S> {
  // Reply when the line is verb + target with nothing after it.
  missingSpec: (verb: Verb) => string
  // Called with the non-empty token list after the target.
  matchSpec: (rest: string[], verb: Verb) => SpecMatch<S>
}

export type WatchCommand<S> = { verb: Verb } & S & { channels: string[] }

// Generic watch/unwatch claim. Owns the shared grammar: verb, target keyword,
// the missing-spec error, `unwatch` taking no channels,
// and channel validation. The plugin supplies only its spec shape. Returns
// null when the line isn't ours, `{kind:'error'}` when claimed but malformed.
// `target` must be lowercase. `null` only claims bare `watch <N>` and
// `watch <owner>/<repo>`; a custom spec shape needs a keyword.
export function tryClaimWatch<S extends object>(
  target: string | null,
  line: string,
  opts: ClaimWatchOptions<S>,
): ParseResult<WatchCommand<S>> | null {
  const parsed = tokenizeVerbLine(line)
  if (!parsed) return null
  const { verb, tokens } = parsed
  const targetMatch = matchTarget(target, tokens)
  if (targetMatch === null) return null
  const rest = tokens.slice(targetMatch)
  if (rest.length === 0) return { kind: 'error', message: opts.missingSpec(verb) }

  const m = opts.matchSpec(rest, verb)
  if (m === null) return null
  if ('error' in m) return { kind: 'error', message: m.error }

  const channels = rest.slice(m.consumed)
  if (verb === 'unwatch') {
    if (channels.length) return { kind: 'error', message: 'unwatch takes no channel arguments' }
    return { kind: 'ok', cmd: { ...m.spec, verb, channels: [] } }
  }
  for (const c of channels) {
    if (!CHANNEL_RE.test(c)) {
      return { kind: 'error', message: `channels must match ${CHANNEL_RE.source}: got "${c}"` }
    }
  }
  return { kind: 'ok', cmd: { ...m.spec, verb, channels } }
}

// Try to claim a per-N line for `target` (null = bare `watch <N>`). Returns
// null when the spec token is repo-shaped — a per-repo plugin owns it.
export function tryClaimPerN(target: string | null, line: string): ParseResult<PerNCommand> | null {
  return tryClaimWatch<{ number: number; repo: string | null }>(target, line, {
    missingSpec: verb => `${verb} requires an issue/PR number or <owner>/<repo> spec`,
    matchSpec: (rest, verb) => {
      const specTok = rest[0]
      if (REPO_SPEC_RE.test(specTok)) return null
      const number = /^\d+$/.test(specTok) ? parseInt(specTok, 10) : 0
      if (number <= 0) {
        return { error: `${verb}: "${specTok}" is not a positive integer or <owner>/<repo> spec` }
      }
      if (rest[1] !== undefined && OWNER_REPO_RE.test(rest[1])) {
        return { spec: { number, repo: rest[1] }, consumed: 2 }
      }
      return { spec: { number, repo: null }, consumed: 1 }
    },
  })
}

// Try to claim a per-repo line for `target`. `target=null` accepts bare
// `watch <owner>/<repo>`. Returns null on a numeric spec — a per-N plugin owns it.
export function tryClaimPerRepo(target: string | null, line: string): ParseResult<PerRepoCommand> | null {
  return tryClaimWatch<{ repo: string; branch: string | null; path: string | null }>(target, line, {
    missingSpec: verb => `${verb} requires an <owner>/<repo> spec`,
    matchSpec: (rest, verb) => {
      const specTok = rest[0]
      const m = specTok.match(REPO_SPEC_RE)
      if (!m) {
        if (/^\d+$/.test(specTok)) return null
        return { error: `${verb}: "${specTok}" is not a valid <owner>/<repo>[@<branch>[:<path>]] spec` }
      }
      return { spec: { repo: m[1], branch: m[2] ?? null, path: m[3] ?? null }, consumed: 1 }
    },
  })
}

// Try to claim a per-Linear-ID line (target=`linear`, spec `^[A-Z]+-\d+$`).
export function tryClaimPerLinearId(line: string): ParseResult<PerLinearIdCommand> | null {
  return tryClaimWatch<{ identifier: string }>('linear', line, {
    missingSpec: verb => `${verb} linear requires an identifier (e.g. C-758)`,
    matchSpec: (rest, verb) => {
      const specTok = rest[0]
      if (LINEAR_ID_RE.test(specTok)) return { spec: { identifier: specTok }, consumed: 1 }
      if (LINEAR_ID_CI_RE.test(specTok)) {
        return { error: `${verb} linear: identifier "${specTok}" must be uppercase team key (try "${specTok.toUpperCase()}")` }
      }
      return { error: `${verb} linear: "${specTok}" is not a Linear identifier matching ${LINEAR_ID_RE.source}` }
    },
  })
}

export interface PerLinearTeamCommand {
  verb: Verb
  team: string
  project: string | null
  channels: string[]
}

// Quoted project filter — `project:"<name>"`. Quotes are required (not
// optional sugar) because Linear project names routinely contain spaces
// (e.g. "SDK 4.3.14"), which a plain whitespace tokenizer can't otherwise
// tell apart from channel/team tokens. Pulled out of the raw line *before*
// tokenizing so the quoted spaces never reach `tokenizeVerbLine`'s split.
const PROJECT_QUOTED_RE = /\bproject:"([^"]*)"/
const PROJECT_STRAY_RE = /^project:/i
const TEAM_RE = /^[A-Z]+$/

// Try to claim a per-Linear-team line for `target`. No shape-based defer —
// `linear-team` is an unambiguous keyword; no other plugin claims it.
//
// Known limitation, accepted as-is: a project name containing `,`/`;`/newline
// can't round-trip through a DM — `splitCommands` splits the message into
// per-line commands before this parser ever sees a line, so those characters
// never survive to reach the quoted-project regex below.
export function tryClaimPerLinearTeam(target: string, line: string): ParseResult<PerLinearTeamCommand> | null {
  // Strip the quoted project filter (if any) before tokenizing — its value may
  // contain spaces that a whitespace split would otherwise fragment.
  const quoted = line.match(PROJECT_QUOTED_RE)
  const strippedLine = quoted ? line.slice(0, quoted.index) + line.slice(quoted.index! + quoted[0].length) : line

  return tryClaimWatch<{ team: string; project: string | null }>(target, strippedLine, {
    missingSpec: verb => `${verb} requires a team key (e.g. C, MAR)`,
    matchSpec: (rest, verb) => {
      const specTok = rest[0]
      if (!TEAM_RE.test(specTok)) {
        return { error: `${verb}: "${specTok}" is not a valid team key — must be uppercase letters only (e.g. C, MAR)` }
      }
      // An unquoted or malformed `project:` token (e.g. `project:SDK`, or a
      // dropped closing quote) survives tokenizing as a stray token — fixit
      // rather than let it fall through to the generic channel-shape error.
      // An unquoted value with spaces only shows up here as its first token,
      // so point at the generic quoted form rather than echo a truncated guess.
      if (rest.slice(1).some(t => PROJECT_STRAY_RE.test(t))) {
        return { error: `${verb}: project filter must be quoted — try project:"<NAME>"` }
      }
      if (quoted && quoted[1] === '') {
        return { error: `${verb}: project filter must not be empty — project:"NAME"` }
      }
      return { spec: { team: specTok, project: quoted ? quoted[1] : null }, consumed: 1 }
    },
  })
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
