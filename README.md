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
- **Topics are first-class** — a Telegram topic, Slack thread or Discord thread is its own conversation, with its own agent; sticky per conversation, `/oc` to switch.
- **Persistent conversations** — survive restarts; reset via `/new`; scoped per thread, channel, user, or globally.
- **Small config** — five sections, typed credentials, `${VAR}` and `.env` expansion.

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
persist where the agent supports it; advertised slash commands become native
platform commands. `doctor` verifies every configured harness.

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
| Threads / auto-thread | ✓ | ✓ | ✓ | – | – | – | – | – |
| Buttons (`ask`) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | – |
| Slash commands | ✓ | ✓ | ✓ | – | – | – | – | – |

Markdown is rendered per platform; missing capabilities degrade gracefully (no
editing → chunked sends, no buttons → plain-text question). Slack, Lark, and
DingTalk connect over WebSocket by default — no public callback URL needed.

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
