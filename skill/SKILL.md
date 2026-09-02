---
name: agent-anywhere
description: >-
  Act on the IM conversation beyond a plain-text reply, for agents running inside the
  Agent Anywhere daemon. Use this whenever you need to: send a file or image into the
  chat; push a proactive notification (e.g. after a long task finishes); reply to,
  edit, delete, or react to a specific message; fetch chat history the user is
  referring to ("the one above", "that earlier link"); open a thread; or ask the user
  a blocking multiple-choice question with buttons and branch on the answer. Also use
  it when the user reports the gateway misbehaving or asks to change its settings —
  it covers diagnosing with `doctor` and editing the gateway config. Do NOT use it
  for an ordinary reply — your plain text output already streams back to the chat
  automatically.
---

# Agent Anywhere — acting in the chat

You are running inside the Agent Anywhere daemon, which bridges you to an IM platform
(Discord, Telegram, Slack, Lark, QQ, LINE, WeCom). Two channels exist:

1. **Your plain-text output** streams into the chat automatically, editing one message
   in place. Just answer normally — never use a command to send your answer text, or
   the user sees it twice.
2. **The `agent-anywhere` CLI** (already on PATH) performs everything text cannot:
   files, reactions, edits, history, threads, button questions. Run it with Bash.

Every command targets the conversation that triggered this turn by default — you never
need a channel id. Authentication is automatic via the `AGENT_ANYWHERE_TURN_TOKEN`
environment variable the daemon injected.

## Command reference

### Sending

```bash
agent-anywhere send-message "text"
agent-anywhere send-file <path> [--name <filename>] [--caption "caption"]
agent-anywhere reply <messageId> "text"
```

- `send-message` is for *extra* or *proactive* messages (a completion notice, a
  separate summary) — not your main answer, which streams automatically.
- `send-file` sends any file or image. Relative paths and `~` resolve against your
  working directory. `--name` overrides the displayed filename.
- `reply` is a platform-native quote-reply. On platforms without native replies it
  gracefully degrades to a plain send.
- All three print `messageId` on success — capture it if you plan to edit, react to,
  or delete that message later.

### Managing messages

```bash
agent-anywhere edit-message <messageId> "new text"
agent-anywhere react <messageId> <emoji>
agent-anywhere delete <messageId>
```

- `edit-message` rewrites a message *you* sent — ideal for updating a progress/status
  message in place instead of spamming new ones.
- `react` adds an emoji reaction; a lightweight acknowledgment ("seen", "done") that
  doesn't interrupt the conversation.

### Reading history

```bash
agent-anywhere fetch-messages [--limit 20] [--before <messageId>] [--fields <cols>]
```

Use this when the user references something outside your current context ("the file I
sent above", "what was that error again?"). Output is a TOON table on stdout:

```
count: 2
messages[2]{messageId,userId,content}:
  101,U42,"can you look at the log I sent?"
  100,U42,deploy failed again
```

- Default columns: `messageId,userId,content` (content truncated to 500 chars).
  Available: `messageId,userId,content,timestamp,quoteId,platform,channelId,attachments`.
- `--fields attachments` adds a separate `attachments[N]{messageId,type,url,name}`
  table — download a referenced image/file from its `url`. The output tells you when
  messages have attachments you didn't request.
- Page further back with `--before <the oldest messageId in the previous page>`.
- `count: 0` means the channel genuinely has no messages — don't retry with other flags.

### Threads

```bash
agent-anywhere create-thread <messageId> "thread name"
```

Prints `threadId`. To post into the thread, pass `--channel <threadId>` on subsequent
commands.

### Asking the user (blocking)

```bash
agent-anywhere ask "Deploy to production?" -o "Deploy" -o "Dry run" -o "Cancel" [--timeout 120000]
```

Sends a message with buttons and **blocks** until the user clicks or the timeout
(default 120 s) expires. stdout is the chosen label verbatim — branch on it directly:

- stdout `Deploy` → the user picked "Deploy".
- Empty stdout → timeout / no selection. Pick a sensible default yourself and say so;
  don't re-ask in a loop.

Prefer `ask` over ending your turn with an open question whenever the choice is a
small closed set: the user taps a button and your logic continues in the same turn.

## Output & errors

Every command writes TOON to **stdout** (never stderr), success and failure alike.
Failures set exit code 1 and look like:

```
error: "cannot reach the daemon (socket: …): connect ECONNREFUSED …"
help: Make sure `agent-anywhere start` is running, then retry.
```

- `unsupported operation: …` — the platform lacks this capability (editing, threads,
  or buttons vary by platform). Don't retry; fall back: send a new message instead of
  editing, ask in plain text instead of buttons.
- `AGENT_ANYWHERE_TURN_TOKEN is not set` — you are not inside a daemon-driven turn.
  This is abnormal; don't retry, just proceed without IM actions.

## Gateway diagnostics & configuration

When the user reports the gateway itself misbehaving ("Slack stopped responding",
"add my Telegram bot", "why can't the agent edit messages here?"), you can inspect
and adjust it — you run on the same machine as the daemon and inherit its environment:

```bash
agent-anywhere doctor
```

`doctor` is a read-only self-check: config validity, platform credentials, daemon
socket liveness, and agent harness reachability (`claude` / `gemini` / `codex` /
`agy` binaries, auth mode). Run it first and report what it finds — it is always safe.

- **Config file**: `~/.config/agent-anywhere/config.yaml` by default; if
  `AGENT_ANYWHERE_CONFIG_FILE` is set in your environment, that file is the active
  one (you see the same config the daemon loaded). Read or edit it directly when the
  user asks for changes — platforms, agents, routing, access control. **Before
  writing any config, read [references/config.md](references/config.md)** in this
  skill directory: it is the complete field reference (per-platform credentials,
  routing rules, session scopes, what is deliberately not configurable). After
  editing, validate with `agent-anywhere doctor`.
- **Changes need a daemon restart** to take effect — and you are a child process of
  that daemon. Never kill or restart it yourself (you would terminate mid-answer);
  make the edit, then tell the user to restart `agent-anywhere start` in their
  terminal.
- **`agent-anywhere setup`** is an interactive terminal wizard for the human
  operator. Don't run it — it blocks waiting for keyboard input you can't provide.
  Edit the config file instead.

## Conventions

- Omit `--channel` in the normal case; it defaults to the current conversation. Pass
  `--channel <id>` only for cross-channel pushes or posting into a thread.
- Quote text arguments for the shell; multi-line text is fine inside quotes.
- For long tasks, send one status message first, then `edit-message` it as you
  progress — one evolving message beats a stream of notifications.
