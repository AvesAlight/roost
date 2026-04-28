# roost

A channel MCP that rides IRC. Independent Claude Code sessions join named
channels and exchange messages — replacing the Agent-tool team mechanism's
SendMessage with a topology a human operator can join from `irssi`.

Status: functional. ngircd local, six MCP tools, inbound channel
events with reassembly + JOIN/LEAVE pushes. See `ARCHITECTURE.md`
for how the team uses it; `docs/LEARNINGS.md` for the empirical
work that produced it (load-bearing assumptions, test log, finding
catalog).

## What you get

When a Claude Code session loads `roost-irc` as an MCP and connects:

- **Six MCP tools** for outbound IRC: `channel_message`, `direct_message`,
  `channel_join`, `channel_leave`, `channel_who`, `channel_history`.
- **Inbound IRC** arrives as `<channel source="roost-irc" ...>` events
  in the host session's context — same format channel notifications
  always take. Messages, JOIN/LEAVE/KICK, and NICK changes all push.
- **One nick per session** (configured at spawn). ngircd refuses
  collisions. A human `irssi` user against the same server sees
  everything in real time.

## Prerequisites

- macOS or Linux
- [bun](https://bun.sh) ≥ 1.0
- [ngircd](https://ngircd.barton.de) — `brew install ngircd`
- A Claude Code build with `--dangerously-load-development-channels`

## Setup (one-time)

```bash
cd ~/Dev/GoCarrot/roost
bun install
```

To make the `roost` Claude Code skill discoverable
(model-invokable from any session via `/roost` or the Skill tool),
symlink it into the user-global skills directory:

```bash
mkdir -p ~/.claude/skills
ln -sfn ~/Dev/GoCarrot/roost/skills/roost ~/.claude/skills/roost
```

Restart any running Claude session for it to appear in the
available-skills list.

## Running

### 1. Start ngircd

Project-local config; daemonizes; PID at `var/ngircd.pid`.

```bash
ngircd -f /Users/alex/Dev/GoCarrot/roost/etc/ngircd.conf
```

Verify it's up:

```bash
lsof -nP -iTCP:6667 -sTCP:LISTEN
```

To stop:

```bash
pkill -f 'ngircd.*roost/etc/ngircd.conf'
```

### 2. Launch a Claude session that joins the roost

Use the `bin/roost` wrapper — handles env vars, mcp-config path,
dev-channels prompt dismissal, tmux session naming:

```bash
~/Dev/GoCarrot/roost/bin/roost spawn worker-1987-A -c '#pr-1987'
~/Dev/GoCarrot/roost/bin/roost spawn watcher-A --model haiku
~/Dev/GoCarrot/roost/bin/roost list
~/Dev/GoCarrot/roost/bin/roost attach worker-1987-A
~/Dev/GoCarrot/roost/bin/roost shutdown worker-1987-A
~/Dev/GoCarrot/roost/bin/roost status
```

`spawn` accepts `-c|--channels`, `-m|--model`, `-s|--session`, and
`--mcp-config`. Default channel is `#roost`; default model is whatever
`claude` defaults to (Sonnet today).

To do it by hand without the wrapper:

```bash
ROOST_IRC_NICK=alex ROOST_IRC_CHANNELS='#roost' \
  claude \
    --mcp-config /Users/alex/Dev/GoCarrot/roost/mcp-config-irc.json \
    --dangerously-skip-permissions \
    --dangerously-load-development-channels server:roost-irc
```

On first launch (either path) you'll get a `1. I am using this for
local development / 2. Exit` prompt — hit Enter to accept. The MCP
loads, channel notifications register, the IRC client auto-joins your
channels. To resume an existing session, append `--resume <session-id>`
to the bare invocation.

### 3. Observe as a human (no Claude needed)

ngircd has zero auth — any IRC client against `127.0.0.1:6667` works:

```bash
brew install irssi   # or weechat
irssi -c 127.0.0.1 -n alex
# inside irssi:
/join #roost
```

## MCP tools

| Tool | Purpose |
|------|---------|
| `channel_message(channel, text)` | Post to a channel (e.g. `#roost`). Channel must already be joined. |
| `direct_message(nick, text)` | Private message to another nick. |
| `channel_join(channel)` | Join a channel. Returns when the JOIN is acknowledged (5s timeout). |
| `channel_leave(channel)` | PART a channel. |
| `channel_who(channel)` | List nicks present (populated from RPL_NAMREPLY + JOIN/PART/KICK/QUIT/NICK). |
| `channel_history(channel, limit?)` | Recent messages observed by this MCP since startup. Defaults to 20, capped at `ROOST_IRC_HISTORY` (default 50). |

Long messages from `channel_message` and `direct_message` are
automatically split into ≤300-byte chunks at natural boundaries
(sentence end, then whitespace) and reassembled by receiving roost-irc
MCPs into a single `<channel>` event. Non-roost observers (irssi) see
multiple plain PRIVMSGs.

## Channel events received

Inbound IRC arrives in the host session as channel notifications:

**Regular messages** (PRIVMSG to a channel or to you as DM):

```xml
<channel source="roost-irc" sender="alex" channel="#roost"
         isDirect="false" ts="2026-04-28T05:30:00.000Z" seq="42">
hello world
</channel>
```

If the message arrived as multiple PRIVMSGs reassembled within the
buffer window, you'll also see `buffered="true" chunkCount="N"`. DMs
have `isDirect="true"` and the `channel` attr is the sender's nick.

**Membership events** (JOIN, PART, KICK, NICK):

```xml
<channel source="roost-irc" sender="newcomer" channel="#roost"
         isDirect="false" ts="..." seq="..." event="join">
newcomer joined #roost
</channel>

<channel source="roost-irc" sender="someone" channel="#roost"
         isDirect="false" ts="..." seq="..." event="leave"
         reason="parted: bye">
someone left #roost (parted: bye)
</channel>

<channel source="roost-irc" sender="oldnick" channel="#roost"
         isDirect="false" ts="..." seq="..." event="nick" newNick="newnick">
oldnick is now known as newnick
</channel>
```

Self-events (your own JOIN/LEAVE/NICK) are suppressed.

## Environment variables

| Var | Default | Notes |
|-----|---------|-------|
| `ROOST_IRC_NICK` | (required) | The nick this session connects as. ngircd refuses collisions. |
| `ROOST_IRC_CHANNELS` | (none) | Comma-separated channels to auto-join at registration. |
| `ROOST_IRC_SERVER` | `127.0.0.1` | IRC server host. |
| `ROOST_IRC_PORT` | `6667` | IRC server port. |
| `ROOST_IRC_REALNAME` | same as nick | IRC realname (gecos). |
| `ROOST_IRC_HISTORY` | `50` | Per-channel ring-buffer size for `channel_history`. |

## Layout

```
roost/
├── src/
│   ├── irc-server.ts       The MCP. Run by mcp-config-irc.json.
│   ├── stub-server.ts      Test 1 stub (channel-cap smoke test, no IRC).
│   └── tools-only-stub.ts  Test 3 multi-MCP stub.
├── tests/
│   ├── irc-listener.ts          Standalone wire observer.
│   ├── test-reassembly.sh       End-to-end split/reassemble check.
│   ├── test4-irc-pingpong.sh    Two-session ping/pong.
│   ├── test{2,3}-*              Earlier test harnesses.
│   ├── analyze-jsonl.py         Cache-behavior analyzer for session JSONLs.
│   └── logs/                    Test artifacts (gitignored).
├── bin/roost               Wrapper command — spawn / shutdown / list /
│                           attach / tail / status.
├── skills/roost/SKILL.md   Claude Code skill that wraps the bin/roost
│                           command surface for model invocation.
├── etc/ngircd.conf         Localhost-only IRC server config.
├── var/                    Runtime state (PID file, gitignored).
├── mcp-config-irc.json     Use this for the IRC MCP.
├── mcp-config.json         Test 1 stub MCP (legacy).
├── ARCHITECTURE.md         How the team uses roost (channels, roles,
│                           routing, lifecycle, discipline).
├── docs/LEARNINGS.md       Load-bearing assumptions, test log,
│                           findings, hardening passes.
├── package.json / tsconfig.json / bun.lock
└── README.md
```

## Known limitations

- **ngircd-27 doesn't support IRCv3 message-tags.** We use receive-side
  buffering with natural-boundary splitting instead. Tagged PRIVMSGs
  are silently dropped by the server — confirmed via probe
  (`tests/probe-message-tags.ts`).
- **No worker spawn helper yet.** Each Claude session is launched
  manually with the full invocation above. Automation is in scope but
  not built.
- **`channel_history` is per-MCP-instance.** Restarting an MCP loses
  the buffer. Use IRC server logs (ngircd writes to its configured
  `Log` target) for durable history.
- **None of the previously-listed cache misses.** `alwaysLoad: true`
  is set on the roost-irc server in `mcp-config-irc.json`, so all
  six tools stay non-deferred. Empirical baseline-vs-alwaysLoad probe
  (2026-04-28) showed 0 `tools_changed` misses with the flag vs 2
  without (see `docs/LEARNINGS.md` Finding A).
