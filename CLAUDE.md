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
