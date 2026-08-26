// Boot-time pin for the GitHub identity the dispatcher runs as.
//
// The dispatcher shells out to `gh` (see plugins/github/github-api.ts) with no
// account selection of its own — every call inherits whatever the box's
// *active* `gh` account happens to be at the moment it spawns. On a shared box
// that's whoever ran `gh auth switch` last, not necessarily the dispatcher's
// own bot account. `pinGhIdentity` resolves the configured login's own stored
// credential explicitly (`gh auth token -u <login>`, which works regardless of
// which account is "active"), confirms it with a live `gh api user` call, and
// then pins it into `process.env.GH_TOKEN` for the rest of this process's
// lifetime — every later `Bun.spawn(['gh', ...])` inherits `process.env` with
// no override, so once this is set the dispatcher is immune to a concurrent
// `gh auth switch` elsewhere on the box, not just whatever was active at the
// instant this check ran.
import type { OrchestratorConfig } from './config.js'
import type { PluginLogger } from './plugin.js'

export interface GhIdentityDeps {
  // Resolves the stored token for `login`. Default shells `gh auth token -u
  // <login>`. Throws when that login has no stored credential on this box.
  resolveToken?: (login: string) => Promise<string>
  // Confirms which login a token authenticates as. Default calls `gh api user`
  // with GH_TOKEN set to exactly this token — not the ambient environment —
  // so the check can't be laundered by a stale/wrong ambient GH_TOKEN.
  verifyLogin?: (token: string) => Promise<string>
}

async function runGh(args: string[], env?: Record<string, string | undefined>): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(['gh', ...args], { stdout: 'pipe', stderr: 'pipe', env })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const exitCode = await proc.exited
  return { stdout, stderr, exitCode }
}

async function defaultResolveToken(login: string): Promise<string> {
  const { stdout, stderr, exitCode } = await runGh(['auth', 'token', '-u', login])
  if (exitCode !== 0) {
    throw new Error(
      `gh-identity: no stored gh credential for login "${login}" (gh auth token -u ${login} failed: ${stderr.trim() || `exit ${exitCode}`}) —` +
      ` run \`gh auth login\` (or, if already logged in on another account, \`gh auth switch -u ${login}\` once) on this box for that account, then retry`
    )
  }
  const token = stdout.trim()
  if (!token) throw new Error(`gh-identity: gh auth token -u ${login} returned an empty token`)
  return token
}

async function defaultVerifyLogin(token: string): Promise<string> {
  // Full env inherited (gh needs HOME/GH_CONFIG_DIR/etc. to run at all) but
  // GH_TOKEN forced to exactly this token, overriding anything ambient — gh's
  // own precedence puts GH_TOKEN above the active-account keyring lookup, so
  // this call can't silently fall back to whatever account is ambiently
  // active (verified: `gh auth token -u <login>` itself ignores a bogus
  // ambient GH_TOKEN and still resolves the login's real stored token, so the
  // resolveToken step above is unaffected either way).
  const { stdout, stderr, exitCode } = await runGh(['api', 'user', '-q', '.login'], { ...process.env, GH_TOKEN: token })
  if (exitCode !== 0) {
    throw new Error(`gh-identity: gh api user failed while verifying the pinned credential (exit ${exitCode}): ${stderr.trim()}`)
  }
  const login = stdout.trim()
  if (!login) throw new Error('gh-identity: gh api user returned no login while verifying the pinned credential')
  return login
}

// Refuses to resolve (throws) rather than silently continuing whenever the
// configured identity can't be confirmed — a boot-time hard-fail is the whole
// point: it fires at the moment of use, unlike doc instructions that decay.
export async function pinGhIdentity(
  config: OrchestratorConfig,
  log: PluginLogger,
  deps: GhIdentityDeps = {},
): Promise<void> {
  const logins = config.agent_logins ?? []
  if (logins.length === 0) {
    log('gh-identity: agent_logins not configured — skipping boot identity pin (gh calls use whatever account is ambiently active)\n')
    return
  }
  if (logins.length > 1) {
    // agent_logins is documented as the set of logins whose comments get
    // tagged is_worker_reply — an author set, not an identity. Picking one
    // element to pin against by array order would re-point the dispatcher's
    // credential silently the next time that list changes, which is the exact
    // failure mode this function exists to prevent.
    throw new Error(
      `gh-identity: agent_logins has ${logins.length} entries (${logins.join(', ')}) — ambiguous dispatcher identity, ` +
      'pin it explicitly by leaving exactly one login in agent_logins (the dispatcher\'s own bot account)'
    )
  }
  const expectedLogin = logins[0]
  const resolveToken = deps.resolveToken ?? defaultResolveToken
  const verifyLogin = deps.verifyLogin ?? defaultVerifyLogin

  const token = await resolveToken(expectedLogin)
  const actualLogin = await verifyLogin(token)
  if (actualLogin !== expectedLogin) {
    throw new Error(
      `gh-identity: gh api user confirmed login "${actualLogin}", expected "${expectedLogin}" (from agent_logins) — refusing to start`
    )
  }

  process.env.GH_TOKEN = token
  log(`gh-identity: pinned gh identity to "${expectedLogin}" for this process\n`)
}
