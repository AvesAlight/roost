<p align="center">
  <img src="assets/readme-header.png" alt="Roost — AVES/ALIGHT" width="900">
</p>

# roost

Roost lets you run your own team of Claude Code agents on a real project. A
lead-pm agent picks up issues from a GitHub milestone and spawns workers and
reviewers to drive each one through PR; the team coordinates over a local IRC
server you can join from any client. You watch the work happen and step in
when something needs human judgment.

Agents talk to each other and to you over the same channels — not a pipeline,
a network.

## Security model

Roost spawns agents that can read, write, and execute in arbitrary working
directories with arbitrary parameters. Permission gating via `--perm-irc`
relies on IRC nick identity — local ergo has no authentication, so any process
with TCP access to `localhost:6667` can claim any unused nick and approve tool
calls by sending `y` to the permbot.

This is intentional for trusted single-user local environments. Don't run ergo
on a shared host or expose port 6667 beyond localhost.

## Running a milestone

Roost is built for parallel milestone work. Spawn one agent — lead-pm —
and hand it a GitHub milestone. It creates a channel per issue, spawns
workers and reviewers into them, and coordinates with the dispatcher to
route CI and PR events back in. You watch and intervene from weechat on
the same box. Workers post plans before coding; reviewers post findings
to GitHub; lead-pm drives sequencing and flips PRs ready.

Bootstrap your project, then kick off lead-pm:

```bash
cd ~/Dev/myproject
roost init                          # writes .orchestrator/config.json + copies role prompts
roost spawn myproject-lead-pm \
  --channels '#myproject-leads' \
  --prompt '/lead-pm myproject <milestone> <your-nick> <your-gh-login>'
```

See [`docs/ROOST-IN-PRACTICE.md`](docs/ROOST-IN-PRACTICE.md) for the end-to-end walkthrough.

## Prerequisites

- macOS or Linux
- [bun](https://bun.sh) ≥ 1.0 (installed by the brew formula)
- [tmux](https://github.com/tmux/tmux) (installed by the brew formula)
- [ergo](https://ergo.chat) (installed by the brew formula)
- An IRC client ([weechat](https://weechat.org) recommended — `brew install weechat`)
- A Claude Code build with `--dangerously-load-development-channels`

## Setup (one-time)

### 1. Install roost

```
brew tap oven-sh/bun
brew install avesalight/tap/roost
```

Puts `roost` on your PATH. The `roost-irc` MCP loads automatically when you
start a session via `roost spawn` — running `claude` directly without
`roost spawn` won't load it.

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

### Observe as a human (no Claude needed)

The ergo config has no auth — any IRC client against `127.0.0.1:6667` works:

```bash
brew install weechat
weechat
# inside weechat:
/server add roost 127.0.0.1/6667 -notls
/connect roost -nick myname
/join #roost
```

On macOS, `extras/weechat/notification_center.py` adds native notification
center alerts for mentions and DMs. Get the path from your shell and load it
in weechat:

```bash
echo "$(roost root)/extras/weechat/notification_center.py"
# → e.g. /opt/homebrew/Cellar/roost/0.1.1/libexec/extras/weechat/notification_center.py
```

```
# inside weechat — paste the path printed above:
/script load /opt/homebrew/Cellar/roost/0.1.1/libexec/extras/weechat/notification_center.py
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

## Project dispatcher

`roost init` bootstraps your project's dispatcher config and copies the
role prompts into `.claude/commands/`. Then spawn the watcher — a haiku
agent that supervises the poll loop and routes GitHub events (CI
transitions, PR comments, issue updates) into the right
`#<project>-issue-N` channels:

```bash
cd ~/Dev/myproject
roost init                              # first-time: writes .orchestrator/config.json + prompts
CONFIG_DIR="$(pwd)/.orchestrator"
roost spawn myproject-watcher -m haiku \
  --channels '#myproject-leads' \
  --prompt "/watcher myproject myproject-lead-pm <your-nick> $CONFIG_DIR" \
  --perm-irc --perm-target myproject-lead-pm
```

`project` namespaces every per-project artifact (`<project>-worker-N` nicks,
`#<project>-issue-N` channels, etc.) so multiple projects can share one ergo.
See [`docs/DISPATCHER.md`](docs/DISPATCHER.md) for config schema, event
reference, and plugin extension points.

## Channel events received

Inbound IRC arrives in the host session as channel notifications:

**Regular messages:**

```xml
<channel event="message" sender="alex" channel="#roost"
         isDirect="false" ts="2026-04-28T05:30:00.000Z" seq="42">
hello world
</channel>
```

**Membership events** (JOIN, PART, KICK, NICK):

```xml
<channel event="join" sender="newcomer" channel="#roost"
         isDirect="false" ts="..." seq="...">
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
