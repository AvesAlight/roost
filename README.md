# roost

A channel MCP that rides IRC. Independent Claude Code sessions join named
channels and exchange messages — replacing the Agent-tool team mechanism's
SendMessage with a topology a human operator can join from `irssi`.

Status: functional. Local ergo daemon (IRCv3 stack — multiline,
chathistory, message-tags, server-time, account-tag), six MCP tools,
inbound channel events with reassembly + JOIN/LEAVE pushes. See
`ARCHITECTURE.md` for how the team uses it; `docs/LEARNINGS.md` for
the empirical work that produced it (load-bearing assumptions, test
log, finding catalog).

## What you get

When a Claude Code session loads `roost-irc` as an MCP and connects:

- **Six MCP tools** for outbound IRC: `channel_message`, `direct_message`,
  `channel_join`, `channel_leave`, `channel_who`, `channel_history`.
- **Inbound IRC** arrives as `<channel source="roost-irc" ...>` events
  in the host session's context — same format channel notifications
  always take. Messages, JOIN/LEAVE/KICK, and NICK changes all push.
  The MCP is a plain IRCv3 client: messages from other agents, humans,
  and bots all arrive identically as normal IRC channel traffic. No
  special routing layer exists between any sender and the MCP.
- **One nick per session** (configured at spawn). Ergo refuses
  collisions. A human `irssi` user against the same server sees
  everything in real time.

## Prerequisites

- macOS or Linux
- [bun](https://bun.sh) ≥ 1.0
- An IRCv3 server on `127.0.0.1:6667`. [ergo](https://ergo.chat) is
  recommended — download a release from
  https://github.com/ergochat/ergo/releases and use `etc/ergo.yaml`
  as your starting config.
- A Claude Code build with `--dangerously-load-development-channels`

## Setup (one-time)

### 1. Install the plugin

```
/plugin marketplace add https://github.com/AlexSc/roost
/plugin install roost@roost
```

This puts `roost` and `irc-permission-prompt` on your PATH and
auto-loads the `roost-irc` MCP for every session.

After installing, pull dependencies:

```bash
cd "$(roost root)"
bun install
```

### 2. Start your IRC server

Roost needs an IRCv3 server on `127.0.0.1:6667`. With ergo, run it
from a working directory of your choice — relative paths in the config
(`logs/`, `ircd.db`, etc.) resolve from there:

```bash
mkdir -p ~/roost-ircd && cd ~/roost-ircd
nohup ergo run --conf "$(roost root)/etc/ergo.yaml" > /tmp/ergo.out 2>&1 &
```

Verify it's up:

```bash
lsof -nP -iTCP:6667 -sTCP:LISTEN
```

To stop:

```bash
pkill -f 'ergo run.*roost/etc/ergo.yaml'
```

## Running

### Launch a Claude session that joins the roost

```bash
roost spawn worker-1 -c '#my-channel' --cwd ~/Dev/myproject

roost spawn agent-2 \
  -c '#my-channel' \
  --cwd ~/Dev/myproject \
  --prompt-file /tmp/handoff.md \
  -- --chrome --system-prompt ' '

roost list
roost attach worker-1
roost shutdown worker-1
roost status
```

`spawn` accepts `-c|--channels`, `-m|--model`, `-s|--session`,
`--mcp-config`, `-p|--prompt-file`, `--cwd`, and `--` (everything
after forwards to claude verbatim). Default channel is `#roost`;
default model is `opus` (Opus 4.7 — required for `--permission-mode
auto`, which the wrapper always passes).

To do it by hand without the wrapper:

```bash
ROOST_IRC_NICK=myagent ROOST_IRC_CHANNELS='#roost' \
  claude --model opus \
    --permission-mode auto \
    --dangerously-load-development-channels server:plugin:roost:roost-irc
```

Without the plugin, pass `--mcp-config` and use `server:roost-irc`:

```bash
ROOST_IRC_NICK=myagent ROOST_IRC_CHANNELS='#roost' \
  claude --model opus \
    --permission-mode auto \
    --mcp-config "$(roost root)/.mcp.json" \
    --dangerously-load-development-channels server:roost-irc
```

On first launch you'll get a `1. I am using this for local development
/ 2. Exit` prompt — hit Enter to accept.

### Observe as a human (no Claude needed)

The spike ergo config has no auth — any IRC client against
`127.0.0.1:6667` works:

```bash
brew install irssi
irssi -c 127.0.0.1 -n myname
# inside irssi:
/join #roost
```

## IRC permission oversight (--perm-irc)

`--perm-irc` runs a permbot routing module inside the worker's MCP
process. The module holds a second IRC connection on a stable nick
`permbot-{worker}` and serializes the worker's PermissionRequest prompts as DMs to
`--perm-target` (required). The operator replies `y` / `n` / `yes` /
`no` / `allow` / `deny`; anything else or a 30s timeout falls through
to the terminal prompt.

Primary use case: an Opus orchestrator spawning a Sonnet or Haiku
worker. Non-Opus models can't use auto mode, so without oversight the
worker floods the terminal with permission prompts. With
`--perm-irc --perm-target <orchestrator>`, prompts come to the
orchestrator over IRC.

```bash
# Opus orchestrator gates a sonnet worker's tool calls:
roost spawn worker-123-A -c '#pr-123' -m sonnet \
  --perm-irc --perm-target orchestrator

# Human operator gates a haiku worker:
roost spawn scratch-h -c '#sandbox' -m haiku \
  --perm-irc --perm-target mynick
```

## MCP tools

| Tool | Purpose |
|------|---------|
| `channel_message(channel, text)` | Post to a channel. Channel must already be joined. |
| `direct_message(nick, text)` | Private message to another nick. |
| `channel_join(channel)` | Join a channel. Returns when JOIN is acknowledged (5s timeout). |
| `channel_leave(channel)` | PART a channel. |
| `channel_who(channel)` | List nicks present. |
| `channel_history(channel, limit?)` | Recent messages since MCP startup. Defaults to 20, capped at `ROOST_IRC_HISTORY` (default 50). |

Long messages use IRCv3 `draft/multiline` batches when the server
advertises the cap (ergo does). Against servers that don't, falls back
to ≤300-byte chunks reassembled by receiving roost-irc MCPs.

## Channel events received

Inbound IRC arrives in the host session as channel notifications:

**Regular messages:**

```xml
<channel source="roost-irc" sender="alex" channel="#roost"
         isDirect="false" ts="2026-04-28T05:30:00.000Z" seq="42">
hello world
</channel>
```

**Membership events** (JOIN, PART, KICK, NICK):

```xml
<channel source="roost-irc" sender="newcomer" channel="#roost"
         isDirect="false" ts="..." seq="..." event="join">
newcomer joined #roost
</channel>
```

Self-events (your own JOIN/LEAVE/NICK) are suppressed.

## Environment variables

| Var | Default | Notes |
|-----|---------|-------|
| `ROOST_IRC_NICK` | (required) | The nick this session connects as. Ergo refuses collisions. |
| `ROOST_IRC_CHANNELS` | (none) | Comma-separated channels to auto-join at registration. |
| `ROOST_IRC_SERVER` | `127.0.0.1` | IRC server host. |
| `ROOST_IRC_PORT` | `6667` | IRC server port. |
| `ROOST_IRC_REALNAME` | same as nick | IRC realname (gecos). |
| `ROOST_IRC_HISTORY` | `50` | Per-channel ring-buffer size for `channel_history`. |

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

## Testing

```bash
bun test
```

Requires ergo. Install it once with `bin/install-ergo`, or point `ERGO_BIN` at
an existing binary. Tests skip gracefully when ergo isn't found.

For coverage (line ≥ 85%, branch ≥ 75% globally):

```bash
bun test --coverage
```

Coverage includes `src/irc-server.ts` via the in-process tests
(`test/irc-server-inprocess.test.ts`).

## Known limitations

- **No SASL / nick reservation.** Any local process that connects can
  claim any unused nick. Acceptable for a single-user dev box; revisit
  before hosting multi-tenant work.
- **`channel_history` is per-MCP-instance.** Restarting an MCP loses
  the buffer. For durable history use ergo's audit log
  (`var/ergo/logs/audit.log`) or the IRCv3 `CHATHISTORY` command.
- **`alwaysLoad: true`** keeps all six tools non-deferred. Empirical
  baseline-vs-alwaysLoad probe (2026-04-28) showed 0 `tools_changed`
  misses with the flag vs 2 without (see `docs/LEARNINGS.md` Finding A).
