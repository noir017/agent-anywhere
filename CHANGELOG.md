# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Fixed
- **Telegram forum topics: replies land in the topic that asked.** A topic message's inbound
  channel id was the bare `message_thread_id` (the adapter keeps the chat id in `guild.id`), so
  replies went to the group's General while the topic stayed silent. Inbound now builds the same
  `<chatId>:<topicId>` key outbound already decoded, on every inbound path (message, button,
  slash command).
- **Telegram private-chat topics (Bot API 9.4) work.** Topics inside a 1-on-1 DM all shared one
  session and were answered in the DM root: the adapter's private-chat branch never reads
  `message_thread_id`. It is read back from the raw update instead. General (thread 1) and
  ordinary reply chains (`message_thread_id` without `is_topic_message`) stay on the chat.
- **Buttons, replies and files reach the topic too.** `sendButtons`, `reply`, and the generic
  `deleteMessage` / `fetchHistory` / `sendFile` paths handed the whole `<chat>:<topic>` key to the
  Bot API as `chat_id` — silently posting to the DM root in a private chat, and failing with
  `400 chat not found` in a group (so an `ask` hung until it timed out). A profile can now declare
  `decodeChannelKey`, and satori-core decodes once for every generic outbound path; Slack's
  `<channel>:<thread_ts>` implements it too.
- **Telegram images, documents and voice notes reach the agent.** Every one was dropped with a
  single `TypeError: Invalid URL … '/photos/file_10.jpg'` in the log: adapter-telegram asks for
  the file by an API-relative path, and `@satorijs/core`'s `http/file` listener runs `new URL()` on
  it before plugin-http resolves it. A listener prepended to the same event resolves relative paths
  first, pinned by a contract test that reproduces the upstream bug. Behind it, the adapter hands
  over the bytes as a `data:` URL, which the downloader now accepts directly (size cap still
  enforced; there is no host for the SSRF guard to act on).
- **Feishu/Lark images and files reach the agent** instead of a "failed to download" line. The
  adapter addresses inbound media as `internal:lark/…` resource URLs, which the http(s)-only,
  SSRF-guarded downloader rightly refuses. A profile can now fetch its own media
  (`fetchAttachment`) through its authenticated client; Lark is the only one that needs to. The
  filename comes from the raw event, and an image's type is sniffed from its bytes, since Feishu
  declares neither where the adapter surfaces it.
- **A Feishu rich-text message is no longer ignored.** The adapter decodes no content for
  `msg_type: 'post'` — what a client sends whenever a message mixes formatting or embeds an image —
  so it reached the gateway empty and was dropped, even when it @-mentioned the bot. The profile
  rebuilds it, resolving `@` placeholders to real open_ids so mention detection still works.

### Changed
- **Telegram topic ids in config are now `<chatId>:<topicId>`.** That is the id a topic message
  routes under, so it is what `freeResponseChannels`, `ignoredChannels` and routing's
  `when.channelId` match against; a bare topic id written there before no longer matches. In
  `chat.channels` (the listen allowlist), the chat id alone covers all of that chat's topics.

## [0.3.2] - 2026-09-28

### Changed
- **Claude harness upgraded to `@agentclientprotocol/claude-agent-acp` 0.81.2** (from 0.76.0),
  with `@agentclientprotocol/sdk` 1.5.0 (from 1.4.0). The bundled Claude Code moves from 2.1.257
  to 2.1.280, which newer models such as `claude-opus-5-5` require — on 0.3.1 every turn with
  those models failed with "API Error: 400 Claude Code 2.1.257 does not support this model".
  ACP protocol version is unchanged (1); `initialize` + `session/new` re-verified against a real
  spawned adapter, `agentCapabilities.loadSession` is still advertised, and the two non-public SDK
  shapes (`AsyncQueue.values`, `ClientContext.attachSession`) are still present.

## [0.3.1] - 2026-09-11

### Fixed
- **`agent-anywhere --version` reported the wrong version**: the number was a string literal in
  `cli.ts`, but `npm version` only rewrites `package.json`, so 0.3.0 shipped still announcing
  0.2.0. The version is now read from `package.json` at startup and can no longer drift.


## [0.3.0] - 2026-09-11

### Added
- **Text command routing**: `routing.pipeline` rules with `when.command` now match the leading
  `/name` of plain message text, so command routing works on every platform — no native
  slash-command support needed (previously `when.command` could never match: the command field
  was never populated on the message path). A rule that matches via `command` consumes the
  prefix — the routed agent receives only the rest of the message — and a bare `/name` is
  acked with a usage hint instead of starting an empty turn. Commands matching no rule still
  pass through to the agent untouched (`/model` etc. keep working).

- **`harness: opencode` preset**: OpenCode via its native ACP mode (`opencode acp`, per the
  ACP registry's official launch spec). Requires the opencode CLI on PATH; auth reuses its
  own login state.

- **DingTalk (钉钉) platform** (`type: dingtalk`, via `@satorijs/adapter-dingtalk`): org-internal
  robot with Stream mode by default (outbound WebSocket — no public callback URL), or
  `protocol: http` for a classic webhook. Outbound messages are `sampleMarkdown`, with agent
  CommonMark pre-rendered to DingTalk's markdown subset (tables→bullets, block regrouping for
  the "single `\n` is not a line break" quirk) and sent past the adapter's escaping encoder.
  DMs and group chats both work (group messages reach a robot only when @-mentioned, which the
  mention gate honors). No edit/reaction/typing/buttons — streaming degrades to chunked sends,
  and `ask` is unavailable on this platform.

### Fixed
- **Long replies were truncated at the first chunk boundary** (Discord: 2000 chars): dense
  streaming edits hit the platform's per-message edit rate limit, and three consecutive failures
  degrade the StreamBuffer. The degraded finish then edited the primary message to chunk 1 and
  returned, silently dropping chunks 2..N — the daemon's sink provides no `delete()`, so every
  degradation landed on that path. The tail chunks are now sent, including when the primary edit
  itself fails. The primary is also no longer re-edited with identical content once the body
  outgrows one chunk, which is what burned the edit quota that caused the degradation.

- **noEdit platforms never delivered any reply** (DingTalk/QQ/LINE/WeCom — every platform without
  in-place message editing): the StreamBuffer's degraded path recorded mid-stream accumulations as
  "already delivered" without sending them, so the end-of-turn whole-send was skipped as
  "unchanged" and the agent's reply silently vanished. Masked in tests by the old non-empty
  streaming cursor (production streams with `cursor: ''`, making the mid-stream and final renders
  identical). The agent replied every time — the buffer just never flushed it.

- **`harness: codex` actually works now**: it spawned `codex acp`, but the codex CLI has no such
  subcommand — "acp" fell into the TUI, which dies headless with "stdin is not a terminal", so
  every turn failed with "ACP connection closed". The harness now spawns Zed's
  [codex-acp](https://www.npmjs.com/package/@zed-industries/codex-acp) adapter (a declared
  dependency, platform binary resolved directly); auth reuses the codex CLI's own login state.

### Changed
- **Claude harness upgraded to `@agentclientprotocol/claude-agent-acp` 0.76.0** (from 0.58.1),
  with `@agentclientprotocol/sdk` 1.4.0 (from 0.29.0). ACP protocol version is unchanged (1) and
  the handshake was re-verified end to end: `initialize` + `session/new` succeed and
  `agentCapabilities.loadSession` is still advertised, so persisted session resume keeps working.

- **Session keys are agent-qualified** (`<agentId>:<platform>:c:<channelId>` …): two agents
  addressed in the same channel/user/thread scope keep separate conversations instead of the
  first-created agent capturing the session forever. One-time effect on upgrade: previously
  persisted sessions (`sessions.json`) no longer match and those conversations start fresh.

## [0.2.0] - 2026-07-10

### Added
- **Config reference for agents** (`skill/references/config.md`): a complete, schema-accurate
  reference for `config.yaml` (per-platform credentials, routing, session scopes, `access.allowFrom`,
  and what is deliberately not configurable), so an agent can safely edit the gateway config when
  asked from inside the chat.
- **README "Agent skill" section** with a one-line install via
  [vercel-labs/skills](https://github.com/vercel-labs/skills):
  `npx skills add https://github.com/l0ng-ai/agent-anywhere/tree/main/skill -g`.

### Changed
- **Bundled skill rewritten** against the actual implementation: per-command output contracts
  (`messageId` returns, TOON examples, `count: 0` empty state), platform capability fallbacks
  (`reply` degrades to a plain send; `edit-message`/`create-thread`/`ask` fail with
  `unsupported operation`), error handling (`error:`/`help:` on stdout), and a new
  gateway-diagnostics section (`doctor`, config editing, why the agent must never restart
  the daemon it runs inside).
- README reordered install-first: Features → Quick start → Agent skill → Platforms → Configuration.

## [0.1.0] - 2026-07-10

### Changed (design)
- **Removed the per-agent `permission` policy.** The daemon is a headless ACP client and now
  auto-approves every tool call — agents always run with full tool access. Restricting tools, if
  wanted, is delegated to the harness (via `agents[].args`/`env`). The daemon's only access control
  is `access.allowFrom` (who may trigger an agent at all).

### Security
- **Access-control warning.** Because agents always have full tool access, an empty `access.allowFrom`
  means anyone who can message the bot can drive them. `agent-anywhere start` and `agent-anywhere doctor` now warn
  loudly on an empty allowlist (non-blocking); the setup wizard prompts for it.
- **SSRF: redirects are re-validated.** Attachment downloads follow redirects manually and re-run the
  private-address guard on every hop (previously a 3xx could bounce past the initial check).
- Proxy URLs are credential-redacted before logging; session tokens are compared in constant time.

### Changed (agent CLI / AXI)
- **Command surface tightened.** Removed `send-image` (it was a strict subset of `send-file` — both
  encode via `h.file`, so the image never inlined) and `typing` (the daemon already maintains a typing
  keep-alive for the whole turn, so a manual command was dead weight). Added `edit-message <id> <text>`
  so an agent can update a message it sent earlier (e.g. a progress line) in place.
- **`agent-anywhere` with no args now runs `doctor`** (read-only self-check), not `start` — a bare invocation
  shows live state instead of accidentally launching a daemon (AXI §8). `start` is now an explicit
  subcommand; `doctor` prints a `bin:`/`description` header (AXI §10). Start the daemon with `agent-anywhere start`.
- **`fetch-messages --fields attachments`** now emits a separate `attachments[]{messageId,type,url,name}`
  table so an agent can download referenced images/files by URL; a hint flags messages that have
  attachments when the column wasn't requested.
- **Reverse commands now speak [TOON](https://toonformat.dev/) on stdout** (via `@toon-format/toon`),
  not raw JSON — ~40% fewer tokens for the agent that reads them. Conversion happens only at the CLI
  output boundary (`commands/reverse.ts`); the daemon keeps speaking plain JSON over IPC.
- **`fetch-messages` output is now AXI-shaped**: a minimal default schema (`messageId,userId,content`),
  opt-in extra columns via `--fields` (validated; `attachments` renders as a count), per-row content
  truncation to 500 chars (with a count of how many were clipped), a `count` aggregate, paging/widening
  `help` hints, and a definitive empty state (`count: 0` + note) instead of an ambiguous `[]`.
- **Errors go to stdout, structured.** Reverse-command failures, unreachable-daemon hints, usage errors,
  and the top-level catch now emit a TOON `error:`/`help:` on stdout (commander's stderr is redirected),
  so the invoking agent can actually read and act on them. `create-thread`/`send-message`/`reply` etc.
  return actionable fields (`threadId` + a `--channel` hint; `messageId` for follow-ups).

### Added
- **Hung-agent watchdog** (`session.turnTimeoutMs`, default 10 min): aborts a turn after prolonged
  agent silence and reaps the subprocess, so a stuck agent can't pin a session forever.
- In-channel error notices: a failed turn now posts a readable reason, not just a ❌ reaction.
- Bot offline/disconnect/reconnect logging in the Satori adapter.
- Test coverage tooling (`npm run test:coverage` with thresholds), ESLint flat config (`npm run lint`),
  and a GitHub Actions CI workflow (typecheck + lint + test + coverage).
- Table-driven tests for the security-critical pure functions (SSRF guard, filename sanitizer,
  permission gate, IPC request parser, token registry) and the config security gate.
- `LICENSE` (MIT) and this changelog.

### Changed
- Removed dead type imports across platform profiles; tightened a few `let`→`const`.
