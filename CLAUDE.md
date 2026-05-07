# Roost

A Claude Code plugin to allow teams of agents (and humans!) to communicate over IRC.

Delivers
- A CLI for spawning new Claude code instances (see `bin/roost`)
- An MCP server to let Claude work with IRC and receive IRC messages (see `src/irc-server.ts`)
- A hook to proxy permissions requests over IRC (see `bin/irc-permission-prompt` and `bin/roost-permbot`)

Intended to ride ergo for IRCv3 (multiline and chathistory) support.

Uses Github issues and PRs for workflow and project management.

## Running tests

```
bun test
```

Requires ergo (IRCv3 server). Install with `bin/install-ergo` or set `ERGO_BIN` to the binary path. Tests skip gracefully if ergo isn't found.

**Never pipe `bun test` through `tail`, `head`, or `grep`.** The shell returns the *last* command's exit code, which is always 0 for those filters — so `bun test ... | tail -N` reports success even when bun failed. The pipe also buffers the entire run until exit, masking hangs. If you need to trim noisy output, write the full result to a file and read it: `bun test ... > /tmp/out 2>&1; echo "exit=$?"; tail -N /tmp/out`. The exit code is the only honest signal.

## Worktrees

Use `script/worktree <branch> [--from <base>] [path]` to bootstrap a new worktree — it creates the sibling worktree, runs `bun install`, and copies `.claude/settings.local.json` from the main worktree so spawned workers don't hit a permission-prompt flood.

## Plugin vs. project file layout

Roost is a Claude Code plugin. Hook scripts live in `bin/` inside the plugin root and are wired by `bin/roost` at spawn time (written to `${ROOST_DATA_DIR}/roost-settings.json` and passed via `--settings`). They are **not** configured in `.claude/settings.json` — that file is project-local and not part of the plugin. Same pattern as `bin/irc-permission-prompt` / `bin/roost-permbot`.

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
