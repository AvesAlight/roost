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
- **One nick per session** (configured at spawn). Ergo refuses
  collisions. A human `irssi` user against the same server sees
  everything in real time.

## Prerequisites

- macOS or Linux
- [bun](https://bun.sh) ≥ 1.0
- [ergo](https://ergo.chat) — release tarball already extracted at
  `var/ergo/ergo` (v2.18.0). Re-fetch from
  https://github.com/ergochat/ergo/releases if you need to upgrade.
- A Claude Code build with `--dangerously-load-development-channels`

## Setup (one-time)

### 1. Install dependencies

```bash
cd ~/Dev/GoCarrot/roost
bun install
```

### 2. Put `bin/roost` on `$PATH`

So you can type `roost spawn …` from anywhere. In your shell rc:

```bash
export PATH="$HOME/Dev/GoCarrot/roost/bin:$PATH"
```

### 3. Load the `roost` Claude Code skill

The skill lives at `roost/skills/roost/SKILL.md`. Symlink it into
the user-global skills directory so any Claude Code session
(across projects) can invoke it via `/roost` or the Skill tool:

```bash
mkdir -p ~/.claude/skills
ln -sfn ~/Dev/GoCarrot/roost/skills/roost ~/.claude/skills/roost
```

Verify it's discoverable — start a fresh session and check the
available-skills list, or:

```bash
claude --print 'List the names of all available skills, one per line.' \
  | grep -x roost
```

Should print `roost`. Restart any already-open Claude sessions to
pick up the new skill.

## Running

### 1. Start ergo

Run from `var/ergo` so relative paths in the config (`languages`,
`logs/`, `ircd.db`, `ircd.lock`, `ergo.motd`) resolve correctly.

```bash
cd /Users/alex/Dev/GoCarrot/roost/var/ergo
nohup ./ergo run --conf /Users/alex/Dev/GoCarrot/roost/etc/ergo.yaml \
  > /tmp/ergo.out 2>&1 &
```

Verify it's up:

```bash
lsof -nP -iTCP:6667 -sTCP:LISTEN
```

Server-side audit log at `var/ergo/logs/audit.log` captures every
PRIVMSG and NOTICE line both directions — useful for "what did the
agents actually say" forensics. Ergo also auto-NOTICEs every
connecting client that user I/O is being logged.

To stop:

```bash
pkill -f 'ergo run.*roost/etc/ergo.yaml'
```

### 2. Launch a Claude session that joins the roost

Use the `bin/roost` wrapper — handles env vars, mcp-config path,
dev-channels prompt dismissal, tmux session naming:

```bash
# Code worker on a PR — defaults are right:
~/Dev/GoCarrot/roost/bin/roost spawn worker-1987-A -c '#issue-1987'

# Operations agent — chrome + blank system prompt via -- pass-through:
~/Dev/GoCarrot/roost/bin/roost spawn productops-simplifyrewards \
  -c '#leads-simplifyrewards' \
  -- --chrome --system-prompt ' '

~/Dev/GoCarrot/roost/bin/roost list
~/Dev/GoCarrot/roost/bin/roost attach worker-1987-A
~/Dev/GoCarrot/roost/bin/roost shutdown worker-1987-A
~/Dev/GoCarrot/roost/bin/roost status
```

`spawn` accepts `-c|--channels`, `-m|--model`, `-s|--session`,
`--mcp-config`, `-p|--prompt-file`, and `--` (everything after
forwards to claude verbatim). Default channel is `#roost`; default
model is `opus` (Opus 4.7 — required for `--permission-mode auto`,
which the wrapper always passes). Override the model with `-m`, but
auto mode will degrade to manual permissioning on non-Opus models.

**Worker vs. operations shape.** Code workers (carrot, taro, teak-ios,
teak-android, teak-js-private, scratcher) want Claude Code's default
CLI-tuned system prompt and don't need browser access. Operations
agents (productops, finance, sales, marketing, cos, opsmanager,
tooldev, analytics) typically want `--chrome` for GUI work (Folk,
Linear web, QBO, Google Workspace, Figma, Slack) and `--system-prompt
' '` for a less-CLI-flavored conversational Claude. Pass those after
`--` on the spawn line.

To do it by hand without the wrapper:

```bash
ROOST_IRC_NICK=alex ROOST_IRC_CHANNELS='#roost' \
  claude --model opus \
    --permission-mode auto \
    --mcp-config /Users/alex/Dev/GoCarrot/roost/mcp-config-irc.json \
    --dangerously-load-development-channels server:roost-irc
```

On first launch (either path) you'll get a `1. I am using this for
local development / 2. Exit` prompt — hit Enter to accept. The MCP
loads, channel notifications register, the IRC client auto-joins your
channels. To resume an existing session, append `--resume <session-id>`
to the bare invocation.

### 3. Observe as a human (no Claude needed)

The spike ergo config has no auth — any IRC client against
`127.0.0.1:6667` works:

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

Long messages from `channel_message` and `direct_message` use IRCv3
`draft/multiline` batches when the server advertises the cap (ergo
does): one `BATCH +id draft/multiline target` / tagged PRIVMSGs /
`BATCH -id` round-trip lossless and emit on the receiver as a single
`<channel>` event with `chunkCount=N`. Against any server that doesn't
ACK the cap, the MCP falls back to the legacy ≤300-byte chunker
reassembled by receiving roost-irc MCPs via a short time window.
Non-roost observers (irssi) see the individual lines.

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
| `ROOST_IRC_NICK` | (required) | The nick this session connects as. Ergo refuses collisions. |
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
├── etc/ergo.yaml           Localhost-only IRC server config.
├── var/ergo/               Ergo binary, datastore, MOTD, logs.
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

- **No SASL / nick reservation in the spike config.** Any local
  process that connects can claim any unused nick. Acceptable for a
  single-user dev box; revisit before this hosts multi-tenant work.
- **No worker spawn helper yet.** Each Claude session is launched
  manually with the full invocation above. Automation is in scope but
  not built.
- **`channel_history` is per-MCP-instance.** Restarting an MCP loses
  the buffer. For durable history use either ergo's audit log
  (`var/ergo/logs/audit.log` — full PRIVMSG/NOTICE capture both
  directions) or the IRCv3 `CHATHISTORY` command which ergo serves
  out of its in-memory store.
- **None of the previously-listed cache misses.** `alwaysLoad: true`
  is set on the roost-irc server in `mcp-config-irc.json`, so all
  six tools stay non-deferred. Empirical baseline-vs-alwaysLoad probe
  (2026-04-28) showed 0 `tools_changed` misses with the flag vs 2
  without (see `docs/LEARNINGS.md` Finding A).
