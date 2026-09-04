<div align="center">

# Agent Anywhere

**Your coding agent, in every chat app.**

[![CI](https://github.com/l0ng-ai/agent-anywhere/actions/workflows/ci.yml/badge.svg)](https://github.com/l0ng-ai/agent-anywhere/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/agent-anywhere-cli)](https://www.npmjs.com/package/agent-anywhere-cli)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

English | [简体中文](README.zh-CN.md)

</div>

A gateway daemon that connects chat platforms to your coding agent — Claude Code,
Codex, OpenCode (via the [Agent Client Protocol](https://agentclientprotocol.com)),
or Google's Antigravity CLI. Message the bot; the agent runs on your machine and
streams its answer into a single, live-edited message.

```text
 Discord ───┐
 Telegram ──┤     ┌──────────────────────┐
 Slack ─────┤     │        daemon        │       ┌─► claude
 Lark ──────┼────►│  routing · sessions  │◄─────►├─► codex
 QQ ────────┤     │  streaming · access  │       ├─► opencode
 LINE ──────┤     └──────────▲───────────┘       ├─► agy
 WeCom ─────┤                │ unix socket       └─► custom
 DingTalk ──┘                └─ agent-anywhere CLI (send-file / ask / react …)
```

## Features

- **Eight platforms, one daemon** — Discord, Telegram, Slack, Lark, QQ, LINE, WeCom, DingTalk; multi-account supported.
- **Any ACP agent, plus agy** — presets for Claude Code, Codex, OpenCode and Antigravity (`agy`), plus `custom`; route by platform, channel, user, or slash command.
- **Native streaming** — in-place edits, live tool-call bubbles, lifecycle reactions, interrupt on new message.
- **Chat actions** — the agent sends files, reacts, replies, opens threads, reads history, asks button questions.
- **Attachments** — inbound images and files are downloaded and handed to the agent.
- **Topics are first-class** — a Telegram topic, Feishu topic (话题), Slack thread or Discord thread is its own conversation, with its own agent; sticky per conversation, `/oc` to switch.
- **Persistent conversations** — survive restarts; reset via `/new`, interrupt a turn with `/stop`; scoped per thread, channel, user, or globally. Idle ones release their agent process and resume from it on the next message.
- **Small config** — five sections, typed credentials, `${VAR}` and `.env` expansion; `/setting` edits the handful of fields worth changing from chat.

## Quick start

```bash
npm install -g agent-anywhere-cli

agent-anywhere setup    # wizard: platform, credentials, agent
agent-anywhere doctor   # self-check
agent-anywhere start    # message your bot
```

`harness: claude` reuses this machine's `claude /login` session — no API key
needed for personal use.

<details>
<summary><strong>Or let your agent set it up</strong></summary>

Paste into Claude Code (or any coding agent):

```text
Set up https://github.com/l0ng-ai/agent-anywhere for me: install the CLI
(npm i -g agent-anywhere-cli) and its skill (npx skills add
https://github.com/l0ng-ai/agent-anywhere/tree/main/skill -g), then follow
the skill to configure and start it.
```

</details>

## Configuration

`~/.config/agent-anywhere/config.yaml`, or `--config <path>`:

```yaml
version: 1

platforms:                    # named instances; the key is the instance id
  discord-main:
    type: discord             # discord|telegram|slack|lark|qq|line|wecom|dingtalk
    token: ${DISCORD_TOKEN}   # every string supports ${VAR}
    chat:
      requireMention: true    # group channels need an @mention
  telegram-bot:               # same type twice = multi-account
    type: telegram
    token: ${TELEGRAM_TOKEN}

agents:                       # at least one; routing picks by id
  - id: claude
    harness: claude           # claude|codex|opencode|agy|custom
    cwd: ~/projects/main
  - id: codex
    harness: codex

routing:
  default: claude
  pipeline:                   # ordered; first match wins
    - when: { platform: telegram-bot }
      use: { agent: codex }
    - when: { command: codex } # "/codex fix the tests" → codex agent
      use: { agent: codex }

session:
  scope: per_thread           # per_thread|per_channel|per_user|shared
  idleTimeoutMs: 3600000      # stop an idle conversation's agent process after 1h; 0 = never

access:
  allowFrom: ["discord-main:123456"]   # <instanceId>:userId; empty = anyone
```

`${VAR}` expands from the environment plus a `<configDir>/.env` sidecar, so
the YAML can be committed.

> [!WARNING]
> Agents run with full tool access. An empty `access.allowFrom` lets anyone
> who can message the bot run commands on your machine — fill it in any
> shared deployment.

## Agents

| Harness | Launches | Extra install | Auth |
|---|---|---|---|
| `claude` | bundled [claude-agent-acp](https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp) | none | `claude /login` or `ANTHROPIC_API_KEY` |
| `codex` | bundled [codex-acp](https://www.npmjs.com/package/@zed-industries/codex-acp) | none | Codex CLI's login |
| `opencode` | `opencode acp` | OpenCode CLI | OpenCode's login |
| `agy` | `agy --input-format stream-json` | Antigravity CLI | `agy` Google sign-in (OS keyring) |
| `custom` | your `command` + `args` | any ACP executable | your agent's |

Each agent takes `cwd`, `env`, `args`, and a best-effort `model`. Sessions
persist where the agent supports it; the commands an agent advertises are
reachable through its own `/<agent>` menu rather than registered globally (see
[Chat commands](#chat-commands)). `doctor` verifies every configured harness.

### Antigravity (`agy`)

`agy` is the only preset that does not speak ACP — it has no ACP mode — so it is
driven over its own documented
[headless stream-json protocol](https://antigravity.google/docs/cli/headless/)
instead. Streaming, tool bubbles, multi-turn context and post-restart resume all
work the same as the ACP harnesses; two details differ:

- **Its own slash commands are disabled.** In stream-json mode a CLI-answered
  slash (`/model`, `/usage`) aborts the whole session, and chat users type `/…`
  constantly — so the daemon launches it with `--disable-slash-commands`, which
  turns such input into ordinary text. Pass
  `args: ["--disable-slash-commands=false"]` to opt back in.
- **`/new` starts a new conversation**, as with every harness. Interrupting a
  turn restarts the child and resumes the same conversation, so context survives.

Any of the daemon's default flags can be overridden through `args` (they are
appended after the defaults, and agy's flag parsing is last-wins).

> [!NOTE]
> Google's FAQ states that accessing Antigravity with third-party tools violates
> its Terms of Service and may lead to account suspension. This harness only
> calls agy's own official headless interface and never handles your credentials
> (sign-in stays entirely inside `agy`), but the daemon is still a non-Google
> client driving your account — decide accordingly.

## Platforms

| | Discord | Telegram | Slack | Lark | QQ | LINE | WeCom | DingTalk |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| Streaming in-place edit | ✓ | ✓ | ✓ | ✓ | – | – | – | – |
| Lifecycle reactions | ✓ | ✓ | ✓ | ✓ | ✓ | – | – | – |
| Typing indicator | ✓ | ✓ | – | – | – | ✓ | – | – |
| Native reply | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | – |
| Threads / auto-thread | ✓ | ✓ | ✓ | ✓ | – | – | – | – |
| Buttons (`ask`) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | – |
| Slash commands | ✓ | ✓ | ✓ | – | – | – | – | – |

Markdown is rendered per platform; missing capabilities degrade gracefully (no
editing → chunked sends, no buttons → plain-text question). Slack, Lark, and
DingTalk connect over WebSocket by default — no public callback URL needed.

## Chat commands

Registered as native slash commands where the platform supports them (Telegram,
Discord, Slack), and equally usable as plain text everywhere else.

| | |
|---|---|
| `/help` | everything below, for the agent currently answering |
| `/new`, `/clear` | start a fresh conversation (clears context) |
| `/stop` | stop the current turn, keeping the conversation |
| `/setting` | change a saved setting in config.yaml — see below |
| `/cc`, `/oc`, `/cx`, `/gm`, `/agy` | one per configured harness — see below |
| `/compact`, `/context`, `/model`, `/usage`, `/doctor`, `/mcp`, `/init`, `/review` | a generic vocabulary, translated to each harness's own spelling |

An **agent command** is named after its harness — `/cc` claude, `/oc` opencode,
`/cx` codex, `/gm` gemini, `/agy` Antigravity. Only the harnesses you configure
are registered. It does two things:

```
/oc fix the failing test    →  switch this conversation to opencode, and ask it
/oc                         →  switch, then list opencode's own commands as buttons
```

The binding is **sticky**: everything after `/oc` keeps going to opencode until
you name someone else, and switching back resumes that agent's own thread rather
than restarting it. The full harness name (`/opencode`) still works if you type
it — it is just not registered, so it costs no slot in the platform menu.

A name whose harness you have **not** configured (`/agy` with no `harness: agy`
agent) is answered with exactly that, and runs no turn — otherwise it reaches
whichever agent is bound still spelled `/agy …`, which reads it as one of its own
slash commands, finds nothing, and replies that a command ran and produced no
output.

The bare form is the only way to reach a harness's *own* commands
(`/customize-opencode`, and friends). They are deliberately not registered
globally: native slash is per-bot while agents are per-conversation, so a merged
menu could neither say who owned an entry nor route it to them. A harness that
reports no command list (`agy`) simply confirms the switch.

Generic commands are rewritten to the target harness's native spelling
(`/compact` → gemini's `/compress`), and a harness with no equivalent says so
instead of spending a turn on a prompt it will misread.

Two of them the gateway answers itself where the harness has no command for it,
because the capability is there over the protocol rather than as a slash:
`/context` prints the last usage the agent reported, and `/model` shows and
switches the model.

`/model` alone opens a **paginated button menu** of the models the agent offers,
starting on the page holding the current one; ◀ ▶ turn the page on the same
message, and tapping a model switches it for that conversation. On Discord,
Telegram, Slack and Lark, which is where a message's buttons can be replaced —
elsewhere it prints the same summary line as before. `/model <part of a name>`
switches by substring on every platform, listing the candidates when the query is
ambiguous rather than guessing. Both work on `opencode` and `claude`; neither
advertises a `/model` command, and both expose the selector over ACP.

## Changing settings from chat

`/setting` edits **config.yaml itself**, so a change outlives the conversation and
the daemon — the counterpart to `/model`, which overrides one conversation until
it is reset. The alternative it replaces is reaching the machine, editing YAML,
and restarting, which stops every resident agent.

| what | in config.yaml | accepts | takes effect |
|---|---|---|---|
| default agent | `routing.default` | any configured agent id | immediately |
| an agent's default model | `agents[].model` | that agent's reported models, any name, or `-` to clear | its next agent session (`/new` starts one) |
| idle reclaim window | `session.idleTimeoutMs` | `off`, `15m`, `4h`, … | immediately |
| conversation scope | `session.scope` | `per_thread`, `per_channel`, `per_user`, `shared` | after a restart |

```
/setting                       →  the whole screen, as buttons where they work
/setting idle                  →  what that one accepts, and its current value
/setting idle 4h               →  set it, on any platform
/setting model.cc opus         →  the model an agent starts its sessions with
```

Where buttons can be posted *and* replaced (Discord, Telegram, Slack, Lark) the
bare form opens a two-level menu — tap a setting, tap a value, and the screen
returns to the list with the new value on it. Everywhere else the same four
commands work as text. A long list of models is paged, and a name your harness
accepts but never advertised (`opusplan`) is taken as typed.

Each answer says **when** the change lands, because they differ: the scope is
written but not applied until a restart, since changing what counts as one
conversation while conversations are open would silently re-identify all of them.

The rest of the file stays hand-edited on purpose, and `/setting` says so by name
rather than pretending the key does not exist. `access.allowFrom` is the one worth
spelling out: one wrong value there locks you out of the very surface you would
use to fix it.

Writes go through the YAML document, so your comments, key order and `${VAR}`
templates survive untouched, and a change is validated against the whole config
before the file is written — `/setting` will not leave you a config.yaml that
fails to load on the next restart.

## Acting in the chat

Plain text streams back automatically. For everything else, the agent invokes
the same CLI; commands target the current conversation by default:

```bash
agent-anywhere send-file ./report.pdf --caption "Q3 numbers"
agent-anywhere react <messageId> <emoji>
agent-anywhere fetch-messages --limit 20
agent-anywhere create-thread <messageId> "debug session"
agent-anywhere ask "Deploy to production?" -o Deploy -o "Dry run" -o Cancel
```

`ask` blocks until the user taps a button and prints the chosen label. Also:
`send-message`, `reply`, `edit-message`, `delete`.

A per-turn hint lets any agent discover these commands; the bundled
[skill](skill/SKILL.md) provides the full playbook:

```bash
npx skills add https://github.com/l0ng-ai/agent-anywhere/tree/main/skill -g
```

## CLI

| Command | |
|---|---|
| `setup` | configuration wizard |
| `doctor` | self-check (default); `--migrate-config` upgrades v0 files |
| `start` | run the daemon |
| `<reverse-command>` | chat actions for the agent (above) |

All commands accept `-c, --config <path>` and print structured output to
stdout.

## Contributing

[AGENTS.md](AGENTS.md) holds the conventions, layering rules, and security invariants,
plus an index of the per-module docs ([config](src/config/README.md) ·
[core](src/core/README.md) · [platform](src/platform/README.md) ·
[daemon](src/daemon/README.md) · [ipc](src/ipc/README.md) ·
[commands](src/commands/README.md)). Start there before changing code.

## License

[MIT](LICENSE)
