<div align="center">

# Agent Anywhere

**Your coding agent, in every chat app.**

[![CI](https://github.com/noir017/agent-anywhere/actions/workflows/ci.yml/badge.svg)](https://github.com/noir017/agent-anywhere/actions/workflows/ci.yml)
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
 Lark ──────┤     │  routing · sessions  │◄─────►├─► codex
 QQ ────────┼────►│  streaming · access  │       ├─► opencode
 LINE ──────┤     └──────────▲───────────┘       ├─► agy
 WeCom ─────┤                │ unix socket       └─► custom
 DingTalk ──┤                └─ agent-anywhere CLI (send-file / ask / react …)
 Web UI ────┘  (a browser page the daemon serves itself — no bot, no account)
```

## Features

- **Eight platforms, one daemon** — Discord, Telegram, Slack, Lark, QQ, LINE, WeCom, DingTalk; multi-account supported.
- **Or no platform at all** — a built-in web UI: a plain dark chat page the daemon serves, behind one shared token. Nothing to register, no bot to create.
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
Set up https://github.com/noir017/agent-anywhere for me: install the CLI
(npm i -g agent-anywhere-cli) and its skill (npx skills add
https://github.com/noir017/agent-anywhere/tree/main/skill -g), then follow
the skill to configure and start it.
```

</details>

## Configuration

`~/.config/agent-anywhere/config.yaml`, or `--config <path>`:

```yaml
version: 1

platforms:                    # named instances; the key is the instance id
  discord-main:
    type: discord             # discord|telegram|slack|lark|qq|line|wecom|dingtalk|webui
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
| `codex` | `codex-acp` | [@agentclientprotocol/codex-acp](https://www.npmjs.com/package/@agentclientprotocol/codex-acp) (`npm i -g`) | Codex CLI's login |
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
instead. Streaming, tool bubbles, multi-turn context, post-restart resume, skills,
`/model`, `/context` and `/usage` all work as they do on the ACP harnesses. What
differs is how the last three are obtained, because agy publishes each somewhere
other than its session:

- **Its own slash commands run as separate processes.** In stream-json mode a
  CLI-answered slash (`/model`, `/usage`, `/credits`, …) aborts the whole session,
  so the daemon answers those eleven names with a one-shot `agy -p=/<name>` and
  never forwards them. Everything else — above all your **skills** — reaches the
  session and expands normally.
- **Context usage comes from agy's status line.** agy reports no token counts over
  its protocol, but it does hand a context snapshot to the `statusLine` command in
  `~/.gemini/antigravity-cli/settings.json`. On startup the daemon backs that file
  up once and points the setting at its own shim, which records the numbers for the
  footer and still draws a status line for your terminal. Set
  `AGENT_ANYWHERE_NO_AGY_STATUSLINE=1` to leave the setting alone and go without
  the numbers.
- **Skills** are read from `<cwd>/.agents/skills`, `~/.agents/skills`,
  `~/.gemini/antigravity-cli/skills`, `~/.gemini/skills` and
  `~/.gemini/config/skills`, so `/skills` lists them and `/<name> <request>` runs one.
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

| | Discord | Telegram | Slack | Lark | QQ | LINE | WeCom | DingTalk | Web UI |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| Streaming in-place edit | ✓ | ✓ | ✓ | ✓ | – | – | – | – | ✓ |
| Lifecycle reactions | ✓ | ✓ | ✓ | ✓ | ✓ | – | – | – | ✓ |
| Typing indicator | ✓ | ✓ | – | – | – | ✓ | – | – | ✓ |
| Native reply | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | – | ✓ |
| Threads / auto-thread | ✓ | ✓ | ✓ | ✓ | – | – | – | – | ✓ |
| Buttons (`ask`) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | – | ✓ |
| Slash commands | ✓ | ✓ | ✓ | – | – | – | – | – | ✓ |

Markdown is rendered per platform; missing capabilities degrade gracefully (no
editing → chunked sends, no buttons → plain-text question). Slack, Lark, and
DingTalk connect over WebSocket by default — no public callback URL needed.

### Web UI

A plain dark chat page the daemon serves itself. No bot to register, no account,
no upstream service — it is the fastest way to have a working gateway, and the
only one that works with no chat platform at all.

```yaml
platforms:
  web:
    type: webui
    token: ${AA_WEB_TOKEN}    # required: the shared secret the login page asks for
    host: 0.0.0.0             # default; 127.0.0.1 to keep it to an SSH tunnel
    port: 8787                # default
    title: Chat               # default; the browser tab's title

access:
  allowFrom: ["web:owner"]    # the identity is always <instance id>:owner
```

Open `http://<host>:8787`, enter the token, and you have the same conversation
every other platform gets: streaming replies, tool bubbles, the `/model`, `/cd`
and `/setting` button menus, `ask` questions, file upload and download.

**Topics.** A row of names across the top switches between parallel conversations,
the same way a Telegram forum topic or a Feishu 话题 does: each has its own agent
session and its own context, and each gets named automatically from what it turned
out to be about. `+` opens one; the agent can open one itself with
`agent-anywhere create-thread`, and write into one with `--channel main/<topic id>`.

**Built for a bad connection.** Replies are sent when they settle rather than on
every keystroke of the stream, everything on the wire is compressed, and a dropped
connection resumes from where it left off instead of re-downloading the
conversation. In a 30-second streamed answer that is 13 updates collapsed to 3, at
about a quarter of the bytes. Sends carry a nonce, so the page retries safely on a
link that drops them.

**A terminal, optionally.** Turned on, the chat header grows a `>_` button that
swaps the transcript for a real shell on the machine the daemon runs on — so you
can drive *any* coding-agent CLI, TUI and all, from the same page. The daemon does
not implement a terminal: it proxies, behind the same login, to a
[`ttyd`](https://github.com/tsl0922/ttyd) you run on a unix socket. Off unless you
ask for it.

```yaml
platforms:
  web:
    type: webui
    token: ${AA_WEB_TOKEN}
    terminal:
      enabled: true
      socket: ~/.config/agent-anywhere/webui-term-web.sock   # where your ttyd listens
```

```bash
# The other half, which is not this package's job to run. The wrapper should put the
# session in tmux — otherwise closing the tab kills whatever was running in it.
printf '#!/bin/sh\nexec tmux new -A -s "aa-$1"\n' > /usr/local/bin/aa-terminal.sh
chmod +x /usr/local/bin/aa-terminal.sh
ttyd -i ~/.config/agent-anywhere/webui-term-web.sock -b /term -W -a -O \
     -T xterm-256color /usr/local/bin/aa-terminal.sh
```

> [!WARNING]
> The default binds every interface and speaks plain HTTP, so the token is the
> only thing between your network and an agent with full tool access. Put a
> reverse proxy with TLS in front of it before exposing it beyond a network you
> control, or set `host: 127.0.0.1` and reach it over an SSH tunnel.
> If you do proxy it, turn response buffering **off** (`proxy_buffering off;` in
> nginx) — buffered server-sent events show nothing until the turn ends, and pass
> `Upgrade`/`Connection` through if you enable the terminal.
> Enabling the terminal moves that token from guarding *a conversation with an
> agent* to guarding *a shell*. Same ceiling, much shorter path.

Two things to expect: everyone who knows the token shares the one conversation,
and a daemon restart empties the page while the agent keeps its context — the
transcript lives in memory, the session does not.

## Chat commands

Registered as native slash commands where the platform supports them (Telegram,
Discord, Slack), and equally usable as plain text everywhere else.

| | |
|---|---|
| `/help` | everything below, for the agent currently answering |
| `/new`, `/clear` | start a fresh conversation (clears context) |
| `/stop` | stop the current turn, keeping the conversation |
| `/cd` | choose the directory this conversation works in — see below |
| `/title` | name this topic; it is named automatically otherwise — see below |
| `/setting` | change a saved setting in config.yaml — see below |
| `/cc`, `/oc`, `/cx`, `/gm`, `/agy` | one per configured harness — see below |
| `/compact`, `/context`, `/model`, `/usage`, `/doctor`, `/mcp`, `/init`, `/review` | a generic vocabulary, translated to each harness's own spelling |

An **agent command** is named after its harness — `/cc` claude, `/oc` opencode,
`/cx` codex, `/gm` gemini, `/agy` Antigravity. Only the harnesses you configure
are registered. It does two things:

```
/oc fix the failing test    →  switch this conversation to opencode, and ask it
/oc                         →  switch, then ask WHERE (a new conversation),
                               or list opencode's own commands (an ongoing one)
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

The bare form is also how you reach a harness's *own* commands
(`/customize-opencode`, and friends) — once the conversation is under way. They
are deliberately not registered globally: native slash is per-bot while agents
are per-conversation, so a merged menu could neither say who owned an entry nor
route it to them. A harness that reports no command list (`agy`) simply confirms
the switch.

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

## Choosing where the agent works

`agents[].cwd` says which directory an agent starts in. `/cd` says which
directory *this conversation* works in, so one topic can be about one project and
the next about another without touching config.yaml.

The list is the agent's own `cwd` plus the directories one level inside it — no
second place to declare projects, and a new one appears in the menu by existing
on disk. The root is always offered, so a conversation can get back out.

```
/cd                →  a button menu of the projects under the root
/cd quantlab       →  move there by substring, on every platform
```

The menu leads with the directories you actually use — a project's rank is how
often it has been chosen, with each past choice discounted by how long ago it was
(a fortnight half-life). A plain counter would leave last quarter's project on
top forever; a plain "most recent" would let one curious click displace the
project you have lived in all month. Anything never chosen keeps its alphabetical
place, and the root stays first as the way back out. This is remembered per
machine, not per conversation, so a brand-new topic gets the benefit of it
immediately.

A page holds as many directories as the platform can carry — twelve on Telegram,
Discord and Slack, which is one page for a typical workspace — so choosing is
usually a tap rather than a page turn.

You are asked the question at the two moments it is free: a bare agent command
(`/cc`, `/oc`, `/agy`) in a conversation that has never run, and right after
`/new`. An **ongoing** conversation is never interrupted with it — including one
whose agent process was reclaimed while idle, which resumes where it left off.

Moving **starts a fresh session** in the new directory, and the menu says so
before you tap. That is not a policy choice: a session is pinned to the directory
it was created in (ACP takes `cwd` at `session/new`, agy at spawn), so the move
cannot reach a process that is already running. Tapping the directory you are
already in (marked ●) costs nothing. The choice is recorded per conversation, so
it survives a restart and a `/new`, and applies to every agent that answers there.

## What the topic is called

A Telegram forum topic keeps whatever name it was created with for as long as it
exists, so a topic-per-task workflow becomes a column of names typed *before* any
of the work happened. So the gateway names it: the opening message is summarised
into a name, **once**.

The summary is asked for the moment the turn starts, not when it ends, and the
topic is renamed as soon as the answer comes back — a second or two in, while the
agent is still working. Waiting for the turn would mean waiting out the work
itself, and the topic column is least useful when it is stale about the thing
happening right now.

```
/title                  →  what this topic was last named, and by whom
/title ask 超时          →  name it yourself instead
/title auto             →  forget that name; the next message names it afresh
```

Once, deliberately. An earlier version followed the harness's own session title,
which is regenerated as a session moves on — so topic names drifted to whatever
had been discussed most recently, which is not what a name is for. You navigate
the topic column by memory of where things are, so a name that keeps moving costs
more than one that is slightly off. `platforms.<id>.autoRenameThread: false`
turns naming off entirely.

The summary comes from any OpenAI-compatible endpoint you point it at:

```yaml
title:
  llm:
    baseUrl: https://api.example.com/v1   # up to and including /v1
    apiKey: ${SOME_KEY}                   # ${VAR} expands from the .env sidecar
    model: gemini-3-flash-lite            # a flash-tier model is the right size
```

A flash-tier model answers in a second or two and costs ~60 tokens per
conversation — one call for the life of the topic, not one per turn. Leave
`title.llm` out and the name is the opening message cut to 40 characters, which
is a substring rather than a summary and reads like one. A call that fails takes
the same fallback, so naming never depends on the endpoint being up.

One limit worth knowing: Telegram offers no way to read a topic's current name
back, so a rename done in the Telegram UI is invisible here. It will not be
overwritten (nothing renames a named topic), but `/title` will report the name it
set rather than the one you see.

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
| live streaming | `stream.enabled` | `on`, `off` (default `off`) | immediately — the next reply |

```
/setting                       →  the whole screen, as buttons where they work
/setting idle                  →  what that one accepts, and its current value
/setting idle 4h               →  set it, on any platform
/setting model.cc opus         →  the model an agent starts its sessions with
```

Where buttons can be posted *and* replaced (Discord, Telegram, Slack, Lark) the
bare form opens a two-level menu — tap a setting, tap a value, and the screen
returns to the list with the new value on it. Everywhere else the same
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

## Asking you something

When the agent needs a decision it cannot make for you, it asks — as buttons, in the
chat, and it waits for the tap:

> **Which database should this project use?**
> **PostgreSQL** — you already run pgvector here, so reusing it costs nothing.
> **MySQL** — wider ecosystem, but there is no instance on this box yet.
>
> `[ PostgreSQL ]` `[ MySQL ]`

This is the model's own question tool, not a gateway feature bolted on top: the daemon
advertises ACP's `elicitation.form` capability, which is what unlocks Claude Code's
`AskUserQuestion` (the adapter keeps it disabled otherwise). Nothing is injected into the
prompt to make it work.

**When none of the options fit, just type the answer.** A message sent while a question is on
screen is recorded as the answer to that question instead of starting a new turn — so a form that
asks three things still asks all three, even if you answer the second one in your own words. Either
way the question is edited in place: the buttons come off and what you answered is written onto it.
`/stop` (or `/new`) calls the question off if you would rather not answer it at all.

Harnesses that do not implement elicitation — `opencode` and `dsh`, as of 1.18.27 and
0.1.2-rc.1 — keep the `ask` CLI in their hint instead, so their models can still put
buttons in front of you. Failing that, the model asks in plain text and ends its turn, and
you answer in the next message.

## Acting in the chat

Plain text streams back automatically, and the agent is told about exactly one thing it
cannot do that way:

```bash
agent-anywhere send-file ./report.pdf --caption "Q3 numbers"
```

The rest of the CLI is available to the agent but deliberately **not** advertised to it,
because a command list in the prompt costs attention before the model has read your first
word: `send-message`, `reply`, `edit-message`, `react`, `delete`, `fetch-messages`,
`create-thread`. Run `agent-anywhere --help` for the full set, and see
[`src/ipc/README.md`](src/ipc/README.md) for why each one is redundant.

If you want an agent to use them fluently, install the bundled
[skill](skill/SKILL.md) — it carries the full playbook and is loaded on demand rather
than injected every session:

```bash
npx skills add https://github.com/noir017/agent-anywhere/tree/main/skill -g
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

This project began as a fork of [l0ng-ai/agent-anywhere](https://github.com/l0ng-ai/agent-anywhere)
at `3d855f8`, and the original architecture — the platform profile seam in particular — is still
recognisable underneath. It has grown a long way past that point since. The upstream MIT copyright
notice is retained in [LICENSE](LICENSE), which covers both codebases.
