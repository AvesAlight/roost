# Roost

A Claude Code plugin to allow teams of agents (and humans!) to communicate over IRC.

Delivers
- A CLI for spawning new Claude code instances (see `bin/roost`)
- An MCP server to let Claude work with IRC and receive IRC messages (see `src/irc-server.ts`)
- A hook to proxy permissions requests over IRC (see `bin/irc-permission-prompt`; the permbot routing daemon runs in-process inside `src/irc-server.ts`)
- An orchestrator/dispatcher module for managing project workflows (see `src/orchestrator/`)

Rides ergo for IRCv3 (multiline, chathistory, message-tags). Uses Github issues and PRs for workflow.

## Authoring for unknown projects

The commands, skills, and agents this plugin ships (`prompts/`, `agents/`, `skills/`) get installed into projects we have no knowledge of. Don't bake assumptions about repo layout, package manager, scripts, or naming into them — language them generically, with fallbacks. Project-specific helpers (like `script/worktree`) are nice-to-have hints, not preconditions; describe the helper *and* the manual fallback.

## Agent frontmatter

Every agent in `agents/` should declare `permissionMode:` in its YAML frontmatter — `auto` for opus agents, `acceptEdits` (or `default`) for non-opus. Claude Code reads `permissionMode:` natively on project- and user-scope agents, so the wrapper deliberately does not parse it. The `--agent` path of `bin/roost spawn` omits `--permission-mode` entirely and relies on the frontmatter. If a new shipped agent needs a different mode, declare it in the file — don't add a special case to the wrapper.

The PreCompact hook (`bin/roost-compact-hook`) is opt-in via `--steer-compact` at spawn. When wired, it intercepts claude code's auto-compact (`trigger="auto"`), returns `{"decision":"block"}` to halt the directive-less default, then injects `/compact <directive>` into the tmux pane via backgrounded `tmux send-keys` — so the manual `/compact` re-fires PreCompact with `trigger="manual"` and `custom_instructions` populated, and the compactor runs with our directive. The directive is a single-line constant near the top of the hook script (one place to edit; covers the roost agent set generically — role, IRC nick, channels joined, in-flight issue/PR state, recent decisions, pending work). Long-running PM-class agents (lead-pm, associate-pm) pass `--steer-compact`; workers and reviewers don't (auto-compact rarely fires in their lifetime). The `docs/LEARNINGS.md` finding on auto-compact has the empirical investigation.

## Agent class heuristic

The role→flag heuristic for `--cache-ttl`, `--steer-compact`, and `--ask-irc` lives in the "Agent class guidance" block of `bin/roost`'s `spawn --help` output — that's the canonical source. Agent prompts (`agents/lead-pm.md`, `agents/associate-pm.md`), the roost skill, and `docs/LEARNINGS.md` §9 all point at it. Edit the `bin/roost` block if the trade-offs shift; the pointers don't need to move. Shipped artifacts (agent prompts, the skill) deliberately don't carry "edit here" instructions — they install into projects that aren't roost, where operators don't own the heuristic.

## Comments

In-tree comments (code and docs) must be timeless — no PR/issue/version refs (e.g. `(#276)`, `Issue #342`, `from #136`, `since v3`). Future readers encounter them without that context. Systems of record (commit messages, PR bodies, LEARNINGS.md, dated audit reports under `docs/audit-*`) keep their refs; in-tree comments don't.

## Code quality

```
bun run lint      # eslint src/ test/
bun run typecheck # tsc --noEmit
```

## Running tests

```
bun test
```

Requires ergo (IRCv3 server). Install with `bin/install-ergo` or set `ERGO_BIN` to the binary path. Tests skip gracefully if ergo isn't found.

**Never pipe `bun test` through `tail`, `head`, or `grep`.** The shell returns the *last* command's exit code, which is always 0 for those filters — so `bun test ... | tail -N` reports success even when bun failed. The pipe also buffers the entire run until exit, masking hangs. Use `script/run-and-tail` instead:

```
script/run-and-tail bun test [args...]
script/run-and-tail -n 100 bun test --filter mytest
```

The wrapper captures output to a tempfile, prints `exit=N`, then tails the last 50 lines (override with `-n N`). Options must come before the command. The exit code is the only honest signal.

**Bun-specific footgun:** when an unhandled promise rejection arrives from a test the runner has already abandoned, bun 1.2.20 deadlocks the runner (no subsequent test runs, process never exits). Any test helper that resolves/rejects via a `setTimeout(reject, ...)` race against the user's `await` will hit this if the user's await is ever aborted (test timeout, prior failure, etc.). Wrap such promises with `suppressLateRejection` from `test/helpers/tool.ts`: it pre-attaches a no-op `.catch()` so an abandoned rejection is silently absorbed, while a still-active `await` still throws normally. The existing wait-style helpers in `test/helpers/mcp-core.ts` and `test/helpers/peer.ts` already use it.

## Worktrees

Use `script/worktree <branch> [--from <base>] [path]` to bootstrap a new worktree — it creates the sibling worktree, runs `bun install`, and copies `.claude/settings.local.json` from the main worktree so spawned workers don't hit a permission-prompt flood.

Use `script/teardown <branch> [--delete-branch]` to clean up a worktree after merge — fetches and ff-merges main, removes the worktree, and optionally deletes the local branch.

## Layout

```
roost/
├── .claude-plugin/
│   └── plugin.json         Plugin manifest.
├── .mcp.json               MCP server config (auto-loaded by plugin).
├── hooks/
│   └── hooks.json          Plugin hook config (PermissionRequest wired per-session via --perm-irc).
├── skills/roost/SKILL.md   Claude Code skill wrapping the roost command surface.
├── src/
│   └── irc-server.ts       The MCP server.
├── bin/
│   ├── roost               Wrapper: spawn / shutdown / list / attach / tail / status / root.
│   ├── roost-irc-server    PATH-resolvable launcher for the MCP server.
│   └── irc-permission-prompt  PermissionRequest hook (thin socket client, loaded per-session by --perm-irc).
├── etc/ergo.yaml           Sample ergo IRC server config.
├── extras/weechat/         Optional weechat notification script.
├── ARCHITECTURE.md         Channel topology, roles, routing, lifecycle.
├── docs/LEARNINGS.md       Load-bearing assumptions, findings, hardening passes.
└── package.json / tsconfig.json / bun.lock
```

## Plugin vs. project file layout

Roost is a Claude Code plugin. Hook scripts live in `bin/` inside the plugin root and are wired by `bin/roost` at spawn time (written to `${ROOST_DATA_DIR}/roost-settings.json` and passed via `--settings`). They are **not** configured in `.claude/settings.json` — that file is project-local and not part of the plugin. Same pattern as `bin/irc-permission-prompt`.

## Releasing

In this repo the APM owns the release mechanics. Lead-pm decides *when* to cut and *which* version; APM types the commands.

The dance:

1. Lead-pm mentions APM in `#roost-leads`: `<project>-apm cut vX.Y.Z`.
2. APM acks: `bump <old> → vX.Y.Z, branch maint/bump-version-X.Y.Z, PR + add <human>; go?` Lead confirms.
3. APM sets up the worktree, bumps `package.json`, commits, pushes the branch, opens the PR with `<gh-login>` as reviewer. The PR body should reference what's new since the previous tag (one or two bullet points is fine). Then DM `roost-dispatcher`: `watch pr <N>` so CI events relay to `#roost-leads`.
4. Human approves the bump PR (this is the safety gate — same as any PR).
5. APM acks: `bump approved + CI green, merge + tag vX.Y.Z + push tag?` Lead confirms.
6. APM merges the bump PR. DMs `roost-dispatcher`: `unwatch pr <N>` (mirrors the watch in step 3). Pulls main in the primary worktree, runs `git tag vX.Y.Z && git push origin vX.Y.Z`, then cleans up the bump worktree.
7. The tag fires `.github/workflows/release.yml` — creates the GitHub release and pushes a formula-bump commit directly to `main` on `AvesAlight/homebrew-tap` (no PR; the action commits straight to the tap repo).
8. The dispatcher announces the tap bump commit in `#roost-leads` when the `github-commits` plugin is configured with a watch entry for `AvesAlight/homebrew-tap` (`path: Formula/roost.rb`). When it isn't, APM falls back to polling manually: `gh api repos/AvesAlight/homebrew-tap/commits --jq '.[0].commit.message'` (or the web UI), and reports back in `#roost-leads`.
9. APM closes the milestone: `gh api -X PATCH /repos/<owner>/<repo>/milestones/<id> -f state=closed`, then reports confirmation in `#roost-leads`.
10. Operators on the box: `brew upgrade roost`, then restart any running dispatchers so they pick up new code (lead-pm flags this; not the APM's job).

The version bump and the tag are separate steps — the workflow only fires on tag push, and only tags that don't contain a hyphen (so `v1.0.0-rc1` is skipped).

What APM does NOT own: deciding when to release, deciding the version number, force-pushing tags, or pushing direct to main.

## Committing

When making a commit, ensure you include a human/claude interaction log. This is mandatory, and captures the human intent of actions you perform. Make the humans accountable.

```
## Human-Claude Interaction Log

### Human prompts (VERBATIM - include typos, informal language, COMPLETE text):
**Include EVERY prompt since last commit - even short ones, corrections, clarifications**
1. "[Copy-paste ENTIRE first prompt since last commit]"
   → Claude: [What Claude did in response]

2. "[Copy-paste ENTIRE second prompt - including [Request interrupted] if present]"
   → Claude: [How Claude adjusted]

[Continue numbering ALL prompts - don't skip any or judge importance]

```

Be sure to end your commit with Claude attribution

```
🤖 Generated with Claude Code
Co-Authored-By: Claude <noreply@anthropic.com>
```
