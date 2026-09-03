# Agent Anywhere config file reference

Everything the operator can set lives in **one YAML file**. This document mirrors the
validation schema in the source (`src/config/schema.ts`, `src/platform/config-schemas.ts`);
keys not listed here do not exist — the loader rejects unknown or invalid fields with a
per-field error message, so don't invent keys.

## Location & lifecycle

- Active file: `$AGENT_ANYWHERE_CONFIG_FILE` if set (you inherit the daemon's env, so
  this is the file the daemon loaded); else `$AGENT_ANYWHERE_CONFIG_DIR/config.yaml`;
  else `~/.config/agent-anywhere/config.yaml`.
- Every string supports `${VAR}` expansion from the environment, and a `.env` file next
  to the config is loaded first — prefer `token: ${DISCORD_TOKEN}` + `.env` over pasting
  secrets into the YAML.
- After editing: run `agent-anywhere doctor` to validate (it aggregates *all* schema
  errors at once), then have the **user** restart the daemon — changes only apply on
  restart, and you must never restart it yourself (you are its child process).

## Top-level shape

```yaml
version: 1          # literal 1 (v0 single-`platform:` files are auto-migrated;
                    # `agent-anywhere doctor --migrate-config` rewrites the file)

platforms:          # map of instance-id -> platform entry; at least one required.
  discord-main:     # id: 1-32 chars [a-z0-9_-], starts alphanumeric. Routing and
    type: discord   #     access.allowFrom reference THIS id, not the type.
    token: ${DISCORD_TOKEN}
  telegram-bot:     # same type twice under different ids = multi-account
    type: telegram
    token: ${TELEGRAM_TOKEN}

agents:             # at least one
  - id: claude
    harness: claude
    cwd: ~/projects/main

routing:
  default: claude   # must reference an existing agents[].id
  pipeline: []      # ordered; first fully-matching rule wins

session:
  scope: per_thread    # per_thread | per_channel | per_user | shared

access:
  allowFrom: []     # identities "<instance-id>:<userId>"; EMPTY = anyone can drive
                    # a full-tool-access agent — fill this in shared deployments
```

## `platforms.<id>` — per-platform entries

Discriminated on `type`. Credential fields are required and validated at load.

```yaml
# Discord
type: discord
token: <bot token>
intents: 12345            # optional gateway-intents override; MUST keep MESSAGE_CONTENT
commandGuildId: <guildId> # optional: register slash commands per-guild (instant) vs global (~1h)

# Telegram
type: telegram
token: <bot token from BotFather>

# Slack
type: slack
appToken: xapp-...        # app-level token (Socket Mode)
botToken: xoxb-...        # bot OAuth token (send/reactions)
protocol: ws              # ws = Socket Mode (default, no public URL) | http = Events API
signing: <signing secret> # required when protocol: http

# Lark / Feishu
type: lark
appId: <App ID>
appSecret: <App Secret>
endpoint: feishu          # feishu (cn, default) | lark (global)
protocol: ws              # ws (default) | http (webhook; then selfUrl is required)
# http-only extras: selfUrl, path, encryptKey, verificationToken, verifyToken,
#                   verifySignature, host, port

# QQ
type: qq
appId: <AppID>
secret: <AppSecret>       # the clientSecret, NOT a platform token
botType: public           # public | private (required)
sandbox: false
intents: 12345            # optional; must include INTERACTIONS for button clicks
protocol: websocket       # websocket (default) | webhook

# LINE
type: line
token: <channel access token>
secret: <channel secret>
selfUrl: https://example.com   # required public URL; LINE POSTs to <selfUrl>/line
host: 127.0.0.1                # local listen host (default shown)
port: 8080                     # local listen port (default shown)

# WeCom
type: wecom
corpId: <CorpID>
agentId: <AgentID>
secret: <AppSecret>
token: <callback verification token>
aesKey: <EncodingAESKey>
selfUrl: https://example.com   # required; callback path is <selfUrl>/wecom
host: 127.0.0.1
port: 8080

# DingTalk
type: dingtalk
appkey: <AppKey / Client ID>
secret: <AppSecret / Client Secret>
agentId: 123456           # optional; only resolves the bot's display name/avatar
protocol: ws              # ws = Stream mode (default, no public URL) | http = webhook
# http-only extras: host, port (DingTalk POSTs to <public host>/dingtalk)
```

### Fields shared by every platform entry

```yaml
chat:                       # response gating for this instance
  channels: []              # listen allowlist; empty = all channels
  requireMention: true      # group channels need an @mention
  freeResponseChannels: []  # channels that respond without a mention
  ignoredChannels: []       # channels fully ignored
  allowBots: none           # respond to other bots: none | mentions | all
slash: true                 # register platform-native slash commands (where supported)
autoThread: off             # off | perTurn (open one thread per turn; thread-capable platforms)
threadAutoArchiveMinutes: 1440  # Discord accepts only 60 | 1440 | 4320 | 10080
```

DMs always get a response regardless of `requireMention` (frozen behavior).

## `agents[]`

```yaml
- id: claude            # unique; referenced by routing
  harness: claude       # claude | gemini | codex | opencode | agy | custom
  command: /path/bin    # required only when harness: custom (any ACP-speaking executable)
  args: []              # extra CLI args appended to the harness command
                        # (harness-specific switches go here, e.g. claude's --setting-sources)
  cwd: ~/projects/main  # working dir; empty = auto workspace at ~/.agent-anywhere/agents/<id>
  model: <model-id>     # best-effort; whether it applies depends on the harness
  env:                  # env vars injected into the agent subprocess; ${VAR} expands
    ANTHROPIC_API_KEY: ${MY_KEY}
```

Notes:
- `harness: claude` with no API key reuses the machine's `claude /login` session.
- `harness: agy` (Google Antigravity CLI) is the one preset that does not speak ACP —
  it has no ACP mode — so it runs over agy's own headless `stream-json` protocol.
  Needs `agy` on PATH (`agy install`) and one interactive sign-in; headless runs never
  prompt. It launches with `--disable-slash-commands`, because in stream-json mode a
  CLI-answered slash (`/model`, `/usage`) aborts the whole session; pass
  `args: ["--disable-slash-commands=false"]` to opt back in. Every default flag is
  overridable via `args` (appended after the defaults; agy's parsing is last-wins).
- There is **no per-tool permission config**: the daemon auto-approves every tool
  request, so agents run with full tool access. The only gate is `access.allowFrom`.

## `routing`

First rule in `pipeline` whose `when` conditions **all** match wins; no match falls
through to `routing.default`. Referential integrity is checked at load: `use.agent`
must exist in `agents`, `when.platform` must be an existing platform **instance id**.

```yaml
routing:
  default: claude
  pipeline:
    - when:                     # all provided fields must match; omitted = no constraint
        platform: discord-main  # platform INSTANCE id (the platforms map key)
        serverId: "123"
        channelId: "456"
        userId: "789"
        chat: private           # private (DM) | group | thread
        isBot: false
        command: review         # leading /name of the message text (leading / optional here)
      use:
        agent: codex
        scope: per_user         # optional per-route session-scope override
```

`command` matches the leading `/name` of the message **text**, so it works on every
platform — no native slash-command support needed (native slash invocations arrive as
the same `/name input` text). When a rule matches via `command`, the router consumes
the prefix: the agent receives only the rest (`/cx fix it` → codex gets `fix it`).
Commands matching no rule pass through to the agent untouched (that's how agent-native
commands like `/model` keep working).

A `when.command` rule also **binds** the conversation to that agent: `/cx fix the
tests` routes to codex, and every plain message after it stays with codex until someone
types another `/<agent>`. Config chooses a conversation's *first* agent; the user
chooses it thereafter.

You do **not** need a rule to reach a configured harness by name. Each one already has a
built-in command — `/cc` claude, `/oc` opencode, `/cx` codex, `/gm` gemini, `/agy`
Antigravity (the full harness name is accepted too) — which selects the first configured
agent of that harness. A bare `/oc` binds and then lists that agent's own commands; on a
harness that reports none (`agy`) it just confirms the binding.

Write a `when.command` rule when you want something the built-ins cannot express: an
alias of your own, or pointing a name at a *second* agent of the same harness. A rule
matching on `command` outranks the built-in table.

Switching agents never discards context. Each conversation remembers every agent's own
session separately, so `/codex` → `/claude` → `/codex` resumes codex where it left off.
Only `/new` clears anything, and it clears the whole conversation.

## `session.scope`

What counts as one conversation (i.e. what shares an agent's context):

| value | one conversation per |
|---|---|
| `per_thread` | thread / Telegram topic / Slack thread — plus the channel root, separately (default) |
| `per_channel` | channel, with all its threads folded in |
| `per_user` | user, wherever they write |
| `shared` | whole deployment |

Conversations live for the daemon's lifetime; `/new` (sent in chat) clears one.

State lives in `<configDir>/conversations.json`: per conversation, the bound agent plus
each agent's own session id. A pre-0.3 `sessions.json` is migrated automatically on
first start, so in-flight work survives the upgrade.

## `access.allowFrom`

Identity format `"<platform-instance-id>:<userId>"`, e.g. `"discord-main:325041233"`.
Empty list = unrestricted, and the daemon only warns. Since agents run with full tool
access (Bash, file writes), an empty allowlist in a public channel means anyone there
can execute code on this machine — always fill it for shared deployments.

## Not configurable (don't add these)

Streaming/edit throttling, tool-bubble rendering, inbound merge windows, attachment
size limits, lifecycle reaction emojis, turn timeout, and the IPC socket path are
frozen in code (`EXPERIENCE` in `src/config/schema.ts`), not config surface. If the
user asks to tune them, explain it requires a code change, not a config edit.
