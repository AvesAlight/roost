# Roost

A Claude Code plugin to allow teams of agents (and humans!) to communicate over IRC.

Delivers
- A CLI for spawning new Claude code instances (see `bin/roost`)
- An MCP server to let Claude work with IRC and receive IRC messages (see `src/irc-server.ts`)
- A hook to proxy permissions requests over IRC (see `bin/irc-permission-prompt`; the permbot routing daemon runs in-process inside `src/irc-server.ts`)
- An orchestrator/dispatcher module for managing project workflows (see `src/orchestrator/`)

Rides ergo for IRCv3 (multiline, chathistory, message-tags). Uses Github issues and PRs for workflow.

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

**Never pipe `bun test` through `tail`, `head`, or `grep`.** The shell returns the *last* command's exit code, which is always 0 for those filters — so `bun test ... | tail -N` reports success even when bun failed. The pipe also buffers the entire run until exit, masking hangs. If you need to trim noisy output, write the full result to a file and read it: `bun test ... > /tmp/out 2>&1; echo "exit=$?"; tail -N /tmp/out`. The exit code is the only honest signal.

**Bun-specific footgun (issue #170, upstream report TBD):** when an unhandled promise rejection arrives from a test the runner has already abandoned, bun 1.2.20 deadlocks the runner (no subsequent test runs, process never exits). Any test helper that resolves/rejects via a `setTimeout(reject, ...)` race against the user's `await` will hit this if the user's await is ever aborted (test timeout, prior failure, etc.). Wrap such promises with `suppressLateRejection` from `test/helpers/tool.ts`: it pre-attaches a no-op `.catch()` so an abandoned rejection is silently absorbed, while a still-active `await` still throws normally. The existing wait-style helpers in `test/helpers/mcp-core.ts` and `test/helpers/peer.ts` already use it.

## Worktrees

Use `script/worktree <branch> [--from <base>] [path]` to bootstrap a new worktree — it creates the sibling worktree, runs `bun install`, and copies `.claude/settings.local.json` from the main worktree so spawned workers don't hit a permission-prompt flood.

## Previewing assets

IRC has no inline image preview, and human reviewers run weechat in tmux. When sharing a rendered asset, post the path as text and let the human view it with their OS tools (e.g. macOS Quick Look via `qlmanage -p path/to/file.png`).

The render → post path → human-views-externally → reply round-trip is the floor of working in this medium, congruent with the brand. Don't bolt new abstractions onto IRC to bridge it.

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
